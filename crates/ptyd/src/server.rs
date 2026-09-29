//! ptyd 服务端：session 表、每连接的收发线程、op 分派。
//!
//! 一个 session = 一个 PTY master + 一个 [`SessionFile`]（ring/blob/元数据）+ 一条阻塞 read
//! 线程 + 一组输入去重游标。supervisor 只是客户端：它断开、崩溃、被替换，session 都照常活着；
//! 它回来时按偏移订阅，ptyd 先补发 ring 里的字节再继续实时推送。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use coflux_protocol::ipc::RecordParser;
use coflux_protocol::logln;
use coflux_protocol::ptyd::{
    encode_ptyd_record, split_ptyd_payload, PtydCursorInfo, PtydMessage, PtydRequest,
    PtydRequestEnvelope, PtydSessionInfo, PtydStatusSession, PTYD_LOGICAL_CLIENT_LIMIT,
    PTYD_MAX_INPUT_BYTES, PTYD_MAX_LIVE_SESSIONS, PTYD_MAX_READ_BYTES, PTYD_PROTOCOL_VERSION,
    PTYD_SOCK_NAME, PTYD_V1_OPS, TERMINAL_DATA_DIR,
};
use rand_core::{OsRng, RngCore};

use crate::pty::{self, write_pty_input, MasterWriter};
use crate::ring::{self, SessionFile};

/// 每条连接的出站队列条数；订阅推送与请求回执共用，满了让 PTY 读线程阻塞（背压）。
const CONNECTION_QUEUE_RECORDS: usize = 256;
/// 订阅补发时的单条记录上限。
const REPLAY_RECORD_BYTES: usize = 64 * 1024;
/// 预算耗尽时读线程的等待步长：checkpoint 到达会立刻唤醒，这只是 kill 之类的兜底轮询。
const BUDGET_WAIT: Duration = Duration::from_millis(100);

pub struct PtydConfig {
    pub home: PathBuf,
    pub socket_path: PathBuf,
    /// 对外报告的二进制身份（`COFLUX_PTYD_ID`，或自身可执行文件的 sha256）。
    pub identity: String,
    /// 实际宣告并服务的 op；缺省全部 v1。黑盒用 `COFLUX_PTYD_TEST_OPS` 收窄来模拟旧 ptyd。
    pub ops: Vec<String>,
}

impl PtydConfig {
    pub fn for_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        Self {
            socket_path: home.join(PTYD_SOCK_NAME),
            home,
            identity: "in-process".to_string(),
            ops: PTYD_V1_OPS.iter().map(|op| (*op).to_string()).collect(),
        }
    }

    pub fn with_ops(mut self, ops: &[&str]) -> Self {
        self.ops = ops.iter().map(|op| (*op).to_string()).collect();
        self
    }
}

struct Cursor {
    seq: u64,
    data: Vec<u8>,
}

struct Subscriber {
    sender: SyncSender<Vec<u8>>,
    request_id: u64,
    connection: u64,
}

struct SessionInner {
    file: SessionFile,
    master: Option<RawFd>,
    slave: Option<RawFd>,
    pid: Option<i32>,
    tty: String,
    exit: Option<i32>,
    killed: bool,
    started_at_ms: u64,
    cursors: HashMap<String, Cursor>,
    subscriber: Option<Subscriber>,
}

struct Session {
    id: String,
    inner: Mutex<SessionInner>,
    /// 写 PTY 期间不持 `inner`（否则输出读不走、程序停在写、输入停在读——互相等死），用它串行化写者。
    write_lock: Mutex<()>,
    budget_changed: Condvar,
}

struct Inner {
    config: PtydConfig,
    data_dir: PathBuf,
    instance_id: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    _lock: File,
    shutdown: Mutex<bool>,
    shutdown_changed: Condvar,
    accepting: AtomicBool,
    next_connection: AtomicU64,
}

/// 运行中的 ptyd（库形态）。二进制 `main.rs` 只是 `start` + 等信号/`shutdown` op + `terminate`。
pub struct Ptyd {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// 把 `terminal-data` 排除在备份之外：macOS 设 Time Machine 排除属性，Linux 落 CACHEDIR.TAG。
fn exclude_from_backups(dir: &Path) {
    #[cfg(target_os = "macos")]
    {
        let Ok(path) = std::ffi::CString::new(dir.to_string_lossy().into_owned()) else {
            return;
        };
        let name = c"com.apple.metadata:com_apple_backup_excludeItem";
        let value = b"com.apple.backupd";
        // SAFETY: path/name 是 NUL 结尾字符串，value/size 描述同一段内存。
        unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr() as *const libc::c_void,
                value.len(),
                0,
                0,
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = std::fs::write(
            dir.join("CACHEDIR.TAG"),
            b"Signature: 8a477f597d28d172789f06886806bc55\n# coflux terminal-data: live terminal output; never back up.\n",
        );
    }
}

fn error_record(id: u64, code: &str, message: impl Into<String>) -> Vec<u8> {
    encode_ptyd_record(
        &PtydMessage::Error {
            id,
            code: code.to_string(),
            message: message.into(),
        },
        &[],
    )
    .unwrap_or_default()
}

fn record(message: &PtydMessage, data: &[u8]) -> Vec<u8> {
    encode_ptyd_record(message, data).unwrap_or_default()
}

type OpResult = Result<(), (&'static str, String)>;

fn op_name(request: &PtydRequest) -> &'static str {
    match request {
        PtydRequest::Open { .. } => "open",
        PtydRequest::Spawn { .. } => "spawn",
        PtydRequest::List => "list",
        PtydRequest::Subscribe { .. } => "subscribe",
        PtydRequest::Read { .. } => "read",
        PtydRequest::Write { .. } => "write",
        PtydRequest::Resize { .. } => "resize",
        PtydRequest::Checkpoint { .. } => "checkpoint",
        PtydRequest::Blob { .. } => "blob",
        PtydRequest::Resizes { .. } => "resizes",
        PtydRequest::Cursors { .. } => "cursors",
        PtydRequest::Kill { .. } => "kill",
        PtydRequest::Remove { .. } => "remove",
        PtydRequest::Status => "status",
        PtydRequest::Shutdown { .. } => "shutdown",
    }
}

impl Ptyd {
    /// 建目录（0700）、排除备份、拿独占锁、清扫残留 ring、绑定 0600 的 UDS，然后开始接受连接。
    pub fn start(config: PtydConfig) -> std::io::Result<Self> {
        std::fs::create_dir_all(&config.home)?;
        let data_dir = config.home.join(TERMINAL_DATA_DIR);
        std::fs::create_dir_all(&data_dir)?;
        std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))?;
        exclude_from_backups(&data_dir);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(data_dir.join(".ptyd.lock"))?;
        // SAFETY: fd 有效；LOCK_NB 让第二个 ptyd 立刻失败而不是排队。
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "另一个 coflux-ptyd 已在此 COFLUX_HOME 运行",
            ));
        }
        let swept = ring::sweep(&data_dir);
        if swept > 0 {
            logln!("[ptyd] 清扫上次残留的 ring 文件 {swept} 个");
        }
        match std::fs::remove_file(&config.socket_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(&config.socket_path)?;
        std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o600))?;
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        let inner = Arc::new(Inner {
            data_dir,
            instance_id: hex::encode(nonce),
            config,
            sessions: Mutex::new(HashMap::new()),
            _lock: lock,
            shutdown: Mutex::new(false),
            shutdown_changed: Condvar::new(),
            accepting: AtomicBool::new(true),
            next_connection: AtomicU64::new(0),
        });
        let accept = Arc::clone(&inner);
        thread::spawn(move || {
            for stream in listener.incoming() {
                if !accept.accepting.load(Ordering::Acquire) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let connection = accept.next_connection.fetch_add(1, Ordering::Relaxed) + 1;
                let inner = Arc::clone(&accept);
                thread::spawn(move || handle_connection(inner, stream, connection));
            }
        });
        Ok(Self { inner })
    }

    pub fn socket_path(&self) -> &Path {
        &self.inner.config.socket_path
    }

    pub fn instance_id(&self) -> &str {
        &self.inner.instance_id
    }

    /// 阻塞直到 `shutdown` op 或 [`Ptyd::request_shutdown`]。
    pub fn wait_for_shutdown(&self) {
        let mut requested = self.inner.shutdown.lock().unwrap();
        while !*requested {
            requested = self.inner.shutdown_changed.wait(requested).unwrap();
        }
    }

    pub fn request_shutdown(&self) {
        self.inner.request_shutdown();
    }

    /// 结束全部子进程、unlink 全部 ring 文件、删 socket。这是"停止本机终端"，不是 supervisor 替换。
    pub fn terminate(&self) {
        self.inner.accepting.store(false, Ordering::Release);
        let sessions: Vec<Arc<Session>> = self.inner.sessions.lock().unwrap().values().cloned().collect();
        for session in &sessions {
            let mut st = session.inner.lock().unwrap();
            st.killed = true;
            if let (Some(pid), None) = (st.pid, st.exit) {
                pty::kill(pid);
            }
            st.file.unlink();
            session.budget_changed.notify_all();
        }
        let _ = std::fs::remove_file(&self.inner.config.socket_path);
    }
}

impl Inner {
    fn request_shutdown(&self) {
        *self.shutdown.lock().unwrap() = true;
        self.shutdown_changed.notify_all();
    }

    fn session(&self, session_id: &str) -> Result<Arc<Session>, (&'static str, String)> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| ("session_not_found", format!("session {session_id} 不存在")))
    }

    fn hello(&self) -> PtydMessage {
        PtydMessage::Hello {
            protocol_version: PTYD_PROTOCOL_VERSION,
            ops: self.config.ops.clone(),
            identity: self.config.identity.clone(),
            instance_id: self.instance_id.clone(),
            pid: std::process::id(),
        }
    }

    fn open(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, rows: u16, cols: u16, label: String) -> OpResult {
        if session_id.is_empty() {
            return Err(("invalid_session_id", "session id 为空".into()));
        }
        let rows = rows.max(1);
        let cols = cols.max(1);
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&session_id) {
            return Err(("duplicate_session", "session id 已存在".into()));
        }
        if sessions.len() >= PTYD_MAX_LIVE_SESSIONS {
            return Err(("session_limit", format!("存活 session 已达上限 {PTYD_MAX_LIVE_SESSIONS}")));
        }
        let pair = pty::open(rows, cols).map_err(|error| ("openpty", error.to_string()))?;
        let file = match SessionFile::create(&self.data_dir, &session_id, rows, cols, &label) {
            Ok(file) => file,
            Err(error) => {
                pty::close(pair.master);
                pty::close(pair.slave);
                return Err(("ring_file", error.to_string()));
            }
        };
        let tty = pair.tty.clone();
        sessions.insert(
            session_id.clone(),
            Arc::new(Session {
                id: session_id,
                inner: Mutex::new(SessionInner {
                    file,
                    master: Some(pair.master),
                    slave: Some(pair.slave),
                    pid: None,
                    tty: tty.clone(),
                    exit: None,
                    killed: false,
                    started_at_ms: now_ms(),
                    cursors: HashMap::new(),
                    subscriber: None,
                }),
                write_lock: Mutex::new(()),
                budget_changed: Condvar::new(),
            }),
        );
        let _ = out.send(record(&PtydMessage::Opened { id, tty }, &[]));
        Ok(())
    }

    fn spawn(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, argv: Vec<String>, env: Vec<(String, String)>, cwd: String) -> OpResult {
        let session = self.session(&session_id)?;
        let pid = {
            let mut st = session.inner.lock().unwrap();
            if st.pid.is_some() {
                return Err(("already_spawned", "session 已 spawn".into()));
            }
            let Some(slave) = st.slave else {
                return Err(("not_open", "session 没有可用的 PTY".into()));
            };
            let pid = pty::spawn(slave, &argv, &env, &cwd).map_err(|error| ("spawn", error.to_string()))?;
            pty::close(slave);
            st.slave = None;
            st.pid = Some(pid);
            st.started_at_ms = now_ms();
            pid
        };
        let reader = Arc::clone(&session);
        thread::spawn(move || read_loop(reader));
        let _ = out.send(record(&PtydMessage::Spawned { id, pid }, &[]));
        Ok(())
    }

    fn list(&self, id: u64, out: &SyncSender<Vec<u8>>) -> OpResult {
        let handles: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        let mut sessions: Vec<PtydSessionInfo> = handles
            .iter()
            .map(|session| {
                let st = session.inner.lock().unwrap();
                PtydSessionInfo {
                    session_id: session.id.clone(),
                    pid: st.pid.unwrap_or(-1),
                    rows: st.file.rows(),
                    cols: st.file.cols(),
                    tty: st.tty.clone(),
                    label: st.file.label().to_string(),
                    ring_start: st.file.start(),
                    output_offset: st.file.end(),
                    checkpoint_offset: st.file.checkpoint(),
                    exit_code: st.exit,
                    started_at_ms: st.started_at_ms,
                }
            })
            .collect();
        sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        let _ = out.send(record(&PtydMessage::Sessions { id, sessions }, &[]));
        Ok(())
    }

    fn subscribe(&self, id: u64, connection: u64, out: &SyncSender<Vec<u8>>, session_id: String, from_offset: u64) -> OpResult {
        let session = self.session(&session_id)?;
        let mut st = session.inner.lock().unwrap();
        if from_offset > st.file.end() {
            return Err(("offset_ahead", format!("偏移 {from_offset} 超过当前输出末尾 {}", st.file.end())));
        }
        if from_offset < st.file.start() {
            return Err(("offset_evicted", format!("偏移 {from_offset} 早于 ring 起点 {}", st.file.start())));
        }
        // 先回 Ok，再补发 ring，再挂上实时订阅——全部在 session 锁内，顺序即偏移序。
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        let mut cursor = from_offset;
        while cursor < st.file.end() {
            let Some((at, data)) = st.file.read(cursor, REPLAY_RECORD_BYTES) else { break };
            if data.is_empty() {
                break;
            }
            cursor = at + data.len() as u64;
            let message = PtydMessage::Data { id, session_id: session_id.clone(), from_offset: at };
            if out.send(record(&message, &data)).is_err() {
                return Ok(());
            }
        }
        st.subscriber = Some(Subscriber { sender: out.clone(), request_id: id, connection });
        if let Some(exit_code) = st.exit {
            let message = PtydMessage::Exited { id, session_id, exit_code, final_offset: st.file.end() };
            let _ = out.send(record(&message, &[]));
        }
        Ok(())
    }

    fn read(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, from_offset: u64, max_bytes: u32) -> OpResult {
        let session = self.session(&session_id)?;
        let st = session.inner.lock().unwrap();
        let max = max_bytes.min(PTYD_MAX_READ_BYTES) as usize;
        match st.file.read(from_offset, max) {
            Some((at, data)) => {
                let _ = out.send(record(&PtydMessage::Data { id, session_id, from_offset: at }, &data));
                Ok(())
            }
            None if from_offset > st.file.end() => Err(("offset_ahead", format!("偏移 {from_offset} 超过当前输出末尾 {}", st.file.end()))),
            None => Err(("offset_evicted", format!("偏移 {from_offset} 早于 ring 起点 {}", st.file.start()))),
        }
    }

    fn write(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, client_instance_id: String, input_seq: u64, data: &[u8]) -> OpResult {
        if data.len() > PTYD_MAX_INPUT_BYTES {
            return Err(("input_too_large", format!("单条输入超过 {PTYD_MAX_INPUT_BYTES} 字节")));
        }
        if input_seq == 0 {
            return Err(("invalid_input_seq", "input sequence 必须从 1 开始".into()));
        }
        if client_instance_id.is_empty() {
            return Err(("invalid_client", "client instance id 为空".into()));
        }
        let session = self.session(&session_id)?;
        let master = {
            let st = session.inner.lock().unwrap();
            if st.exit.is_some() || st.pid.is_none() {
                return Err(("pty_closed", "session 已退出".into()));
            }
            match st.cursors.get(&client_instance_id) {
                Some(cursor) if input_seq <= cursor.seq => {
                    if input_seq == cursor.seq && cursor.data != data {
                        return Err(("input_seq_collision", "相同 input sequence 携带了不同 payload".into()));
                    }
                    let message = PtydMessage::Written { id, applied_through_seq: cursor.seq, duplicate: true };
                    let _ = out.send(record(&message, &[]));
                    return Ok(());
                }
                Some(cursor) => {
                    if input_seq != cursor.seq + 1 {
                        return Err(("input_seq_gap", format!("input sequence 不连续，期望 {}", cursor.seq + 1)));
                    }
                }
                None => {
                    if st.cursors.len() >= PTYD_LOGICAL_CLIENT_LIMIT {
                        return Err(("logical_client_limit", format!("session logical client identity 已达上限 {PTYD_LOGICAL_CLIENT_LIMIT}")));
                    }
                    if input_seq != 1 {
                        return Err(("input_seq_gap", "input sequence 不连续，期望 1".into()));
                    }
                }
            }
            match st.master {
                Some(master) => master,
                None => return Err(("pty_closed", "session 已关闭".into())),
            }
        };
        let _guard = session.write_lock.lock().unwrap();
        match write_pty_input(&mut MasterWriter(master), data) {
            Ok(()) => {
                let mut st = session.inner.lock().unwrap();
                st.cursors.insert(client_instance_id, Cursor { seq: input_seq, data: data.to_vec() });
                let message = PtydMessage::Written { id, applied_through_seq: input_seq, duplicate: false };
                let _ = out.send(record(&message, &[]));
                Ok(())
            }
            Err(failure) if failure.written == 0 && failure.error.raw_os_error() == Some(libc::EIO) => {
                Err(("pty_closed", format!("PTY 从属端已关闭：{}", failure.error)))
            }
            Err(failure) if failure.written == 0 => Err(("pty_write_failed", format!("PTY 写入失败：{}", failure.error))),
            Err(failure) => Err((
                "pty_write_partial",
                format!("PTY 仅写入 {}/{} 字节：{}", failure.written, data.len(), failure.error),
            )),
        }
    }

    fn resize(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, rows: u16, cols: u16) -> OpResult {
        let session = self.session(&session_id)?;
        let rows = rows.max(1);
        let cols = cols.max(1);
        let mut st = session.inner.lock().unwrap();
        if let (Some(master), None) = (st.master, st.exit) {
            if let Err(error) = pty::resize(master, rows, cols) {
                return Err(("resize", error.to_string()));
            }
        }
        st.file.push_resize(rows, cols);
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        Ok(())
    }

    fn checkpoint(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String, offset: u64, blob: &[u8]) -> OpResult {
        let session = self.session(&session_id)?;
        let mut st = session.inner.lock().unwrap();
        st.file
            .set_checkpoint(offset, blob)
            .map_err(|message| ("checkpoint_rejected", message.to_string()))?;
        drop(st);
        session.budget_changed.notify_all();
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        Ok(())
    }

    fn blob(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String) -> OpResult {
        let session = self.session(&session_id)?;
        let st = session.inner.lock().unwrap();
        let message = match st.file.blob() {
            Some((offset, blob)) => record(&PtydMessage::BlobData { id, present: true, offset }, blob),
            None => record(&PtydMessage::BlobData { id, present: false, offset: 0 }, &[]),
        };
        let _ = out.send(message);
        Ok(())
    }

    fn resizes(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String) -> OpResult {
        let session = self.session(&session_id)?;
        let st = session.inner.lock().unwrap();
        let entries = st.file.resizes().to_vec();
        let _ = out.send(record(&PtydMessage::ResizeLog { id, entries }, &[]));
        Ok(())
    }

    fn cursors(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String) -> OpResult {
        let session = self.session(&session_id)?;
        let st = session.inner.lock().unwrap();
        let mut cursors: Vec<PtydCursorInfo> = st
            .cursors
            .iter()
            .map(|(client_instance_id, cursor)| PtydCursorInfo {
                client_instance_id: client_instance_id.clone(),
                seq: cursor.seq,
                data_hex: hex::encode(&cursor.data),
            })
            .collect();
        cursors.sort_by(|a, b| a.client_instance_id.cmp(&b.client_instance_id));
        let _ = out.send(record(&PtydMessage::CursorList { id, cursors }, &[]));
        Ok(())
    }

    fn kill(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String) -> OpResult {
        let session = self.session(&session_id)?;
        let mut st = session.inner.lock().unwrap();
        st.killed = true;
        if let (Some(pid), None) = (st.pid, st.exit) {
            pty::kill(pid);
        }
        drop(st);
        session.budget_changed.notify_all();
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        Ok(())
    }

    fn remove(&self, id: u64, out: &SyncSender<Vec<u8>>, session_id: String) -> OpResult {
        let session = self.session(&session_id)?;
        {
            let st = session.inner.lock().unwrap();
            if st.pid.is_some() && st.exit.is_none() {
                return Err(("session_running", "session 仍在运行，先 kill".into()));
            }
        }
        let _guard = session.write_lock.lock().unwrap();
        let mut st = session.inner.lock().unwrap();
        if let Some(master) = st.master.take() {
            pty::close(master);
        }
        if let Some(slave) = st.slave.take() {
            pty::close(slave);
        }
        st.subscriber = None;
        st.file.unlink();
        drop(st);
        self.sessions.lock().unwrap().remove(&session_id);
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        Ok(())
    }

    fn status(&self, id: u64, out: &SyncSender<Vec<u8>>) -> OpResult {
        let handles: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        let mut sessions: Vec<PtydStatusSession> = handles
            .iter()
            .map(|session| {
                let st = session.inner.lock().unwrap();
                PtydStatusSession {
                    session_id: session.id.clone(),
                    pid: st.pid.unwrap_or(-1),
                    exited: st.exit.is_some() || st.pid.is_none(),
                }
            })
            .collect();
        sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        let message = PtydMessage::Status {
            id,
            protocol_version: PTYD_PROTOCOL_VERSION,
            identity: self.config.identity.clone(),
            instance_id: self.instance_id.clone(),
            pid: std::process::id(),
            sessions,
        };
        let _ = out.send(record(&message, &[]));
        Ok(())
    }

    fn shutdown(&self, id: u64, out: &SyncSender<Vec<u8>>, instance_id: String) -> OpResult {
        if instance_id != self.instance_id {
            return Err(("stale_instance", "instance id 不匹配".into()));
        }
        let _ = out.send(record(&PtydMessage::Ok { id }, &[]));
        self.request_shutdown();
        Ok(())
    }

    fn dispatch(&self, connection: u64, out: &SyncSender<Vec<u8>>, payload: &[u8]) {
        let Some((header, data)) = split_ptyd_payload(payload) else {
            let _ = out.send(error_record(0, "bad_request", "record 缺少 header"));
            return;
        };
        let id = serde_json::from_slice::<serde_json::Value>(header)
            .ok()
            .and_then(|value| value.get("id").and_then(serde_json::Value::as_u64))
            .unwrap_or(0);
        let envelope = match serde_json::from_slice::<PtydRequestEnvelope>(header) {
            Ok(envelope) => envelope,
            Err(error) => {
                let code = if error.to_string().contains("unknown variant") { "unknown_op" } else { "bad_request" };
                let _ = out.send(error_record(id, code, error.to_string()));
                return;
            }
        };
        let op = op_name(&envelope.request);
        if !self.config.ops.iter().any(|advertised| advertised == op) {
            let _ = out.send(error_record(id, "unknown_op", format!("本 ptyd 不提供 {op}")));
            return;
        }
        let result = match envelope.request {
            PtydRequest::Open { session_id, rows, cols, label } => self.open(id, out, session_id, rows, cols, label),
            PtydRequest::Spawn { session_id, argv, env, cwd } => self.spawn(id, out, session_id, argv, env, cwd),
            PtydRequest::List => self.list(id, out),
            PtydRequest::Subscribe { session_id, from_offset } => self.subscribe(id, connection, out, session_id, from_offset),
            PtydRequest::Read { session_id, from_offset, max_bytes } => self.read(id, out, session_id, from_offset, max_bytes),
            PtydRequest::Write { session_id, client_instance_id, input_seq } => {
                self.write(id, out, session_id, client_instance_id, input_seq, data)
            }
            PtydRequest::Resize { session_id, rows, cols } => self.resize(id, out, session_id, rows, cols),
            PtydRequest::Checkpoint { session_id, offset } => self.checkpoint(id, out, session_id, offset, data),
            PtydRequest::Blob { session_id } => self.blob(id, out, session_id),
            PtydRequest::Resizes { session_id } => self.resizes(id, out, session_id),
            PtydRequest::Cursors { session_id } => self.cursors(id, out, session_id),
            PtydRequest::Kill { session_id } => self.kill(id, out, session_id),
            PtydRequest::Remove { session_id } => self.remove(id, out, session_id),
            PtydRequest::Status => self.status(id, out),
            PtydRequest::Shutdown { instance_id } => self.shutdown(id, out, instance_id),
        };
        if let Err((code, message)) = result {
            let _ = out.send(error_record(id, code, message));
        }
    }

    fn drop_subscriptions_of(&self, connection: u64) {
        let handles: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();
        for session in handles {
            let mut st = session.inner.lock().unwrap();
            if st.subscriber.as_ref().is_some_and(|subscriber| subscriber.connection == connection) {
                st.subscriber = None;
            }
        }
    }
}

/// 每 session 一条阻塞读线程：读 → 按预算写 ring → 推给订阅者。有 checkpoint 之后预算为 0 就
/// **停止读**（不覆盖偏移 ≥ checkpoint 的字节），直到 checkpoint 前移或 session 被 kill；第一次
/// checkpoint 之前预算无限，环覆盖最旧字节、永不停读（见 `ring.rs` 顶部）。订阅者队列满时 `send`
/// 阻塞，同样是停止读。EOF/EIO 后 waitpid 拿真实退出码。
fn read_loop(session: Arc<Session>) {
    let (master, pid) = {
        let st = session.inner.lock().unwrap();
        match (st.master, st.pid) {
            (Some(master), Some(pid)) => (master, pid),
            _ => return,
        }
    };
    let mut buffer = vec![0u8; 8192];
    'reading: while let Some(count) = pty::read(master, &mut buffer) {
        let mut pending = 0usize;
        while pending < count {
            let step = {
                let mut st = session.inner.lock().unwrap();
                if st.killed {
                    break 'reading;
                }
                let budget = st.file.write_budget();
                if budget == 0 {
                    let (guard, _) = session.budget_changed.wait_timeout(st, BUDGET_WAIT).unwrap();
                    drop(guard);
                    None
                } else {
                    let take = budget.min(count - pending);
                    let from = st.file.append(&buffer[pending..pending + take]);
                    let subscriber = st
                        .subscriber
                        .as_ref()
                        .map(|subscriber| (subscriber.sender.clone(), subscriber.request_id, subscriber.connection));
                    Some((from, take, subscriber))
                }
            };
            let Some((from, take, subscriber)) = step else { continue };
            if let Some((sender, request_id, connection)) = subscriber {
                let message = PtydMessage::Data { id: request_id, session_id: session.id.clone(), from_offset: from };
                if sender.send(record(&message, &buffer[pending..pending + take])).is_err() {
                    let mut st = session.inner.lock().unwrap();
                    if st.subscriber.as_ref().is_some_and(|subscriber| subscriber.connection == connection) {
                        st.subscriber = None;
                    }
                }
            }
            pending += take;
        }
    }
    let exit_code = pty::wait(pid);
    let (subscriber, final_offset) = {
        let mut st = session.inner.lock().unwrap();
        st.exit = Some(exit_code);
        (
            st.subscriber.as_ref().map(|subscriber| (subscriber.sender.clone(), subscriber.request_id)),
            st.file.end(),
        )
    };
    session.budget_changed.notify_all();
    if let Some((sender, request_id)) = subscriber {
        let message = PtydMessage::Exited { id: request_id, session_id: session.id.clone(), exit_code, final_offset };
        let _ = sender.send(record(&message, &[]));
    }
}

fn handle_connection(inner: Arc<Inner>, mut stream: UnixStream, connection: u64) {
    let Ok(mut writer) = stream.try_clone() else { return };
    let (sender, receiver) = sync_channel::<Vec<u8>>(CONNECTION_QUEUE_RECORDS);
    thread::spawn(move || {
        for chunk in receiver {
            if writer.write_all(&chunk).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Both);
    });
    if sender.send(record(&inner.hello(), &[])).is_err() {
        return;
    }
    let mut parser = RecordParser::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let mut records: Vec<Vec<u8>> = Vec::new();
        if parser.push(&buffer[..count], |payload| records.push(payload.to_vec())).is_err() {
            break;
        }
        for payload in records {
            inner.dispatch(connection, &sender, &payload);
        }
    }
    inner.drop_subscriptions_of(connection);
    drop(sender);
    let _ = stream.shutdown(Shutdown::Both);
}
