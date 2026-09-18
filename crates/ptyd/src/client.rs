//! ptyd 客户端（supervisor 侧）。
//!
//! 能力握手：连接建立即收到 hello，之后 [`PtydClient::supports`] 决定某个 op 是否可用；不可用的
//! op 直接返回 [`PtydError::Unsupported`]，调用方按"没有这项能力"继续，绝不硬失败。
//!
//! 连接形态：一条互斥的请求连接（回执按 id 匹配）+ 每个订阅一条独立连接（长期只收）+ 每个
//! 输入写者一条独立连接（`write` 会在 PTY 输入缓冲满时阻塞，不能占住请求连接）。

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use coflux_protocol::ipc::RecordParser;
use coflux_protocol::ptyd::{
    encode_ptyd_record, split_ptyd_payload, PtydCursorInfo, PtydMessage, PtydRequest,
    PtydRequestEnvelope, PtydResizeEntry, PtydSessionInfo, PtydStatusSession,
};
use serde::Serialize;

/// 请求连接上的等待上限：ptyd 对请求的回答是即时的，超时只可能是 ptyd 死了。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 订阅事件队列（条数）；满了让订阅线程停在 socket 读上，ptyd 侧随之停止读 PTY。
const SUBSCRIPTION_QUEUE_RECORDS: usize = 64;

#[derive(Debug)]
pub enum PtydError {
    Io(io::Error),
    Remote { code: String, message: String },
    Protocol(String),
    Unsupported(&'static str),
}

impl PtydError {
    pub fn code(&self) -> &str {
        match self {
            Self::Remote { code, .. } => code,
            Self::Io(_) => "io",
            Self::Protocol(_) => "protocol",
            Self::Unsupported(_) => "unsupported",
        }
    }
}

impl fmt::Display for PtydError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "ptyd 连接错误：{error}"),
            Self::Remote { code, message } => write!(formatter, "ptyd 拒绝（{code}）：{message}"),
            Self::Protocol(message) => write!(formatter, "ptyd 协议错误：{message}"),
            Self::Unsupported(op) => write!(formatter, "运行中的 ptyd 不提供 {op}"),
        }
    }
}

impl std::error::Error for PtydError {}

impl From<io::Error> for PtydError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone)]
pub struct PtydHello {
    pub protocol_version: u32,
    pub ops: HashSet<String>,
    pub identity: String,
    pub instance_id: String,
    pub pid: u32,
}

struct Connection {
    stream: UnixStream,
    parser: RecordParser,
    pending: VecDeque<(PtydMessage, Vec<u8>)>,
}

impl Connection {
    fn open(path: &Path, timeout: Option<Duration>) -> Result<(Self, PtydHello), PtydError> {
        let stream = UnixStream::connect(path)?;
        stream.set_read_timeout(timeout)?;
        stream.set_write_timeout(timeout)?;
        let mut connection = Self {
            stream,
            parser: RecordParser::new(),
            pending: VecDeque::new(),
        };
        match connection.recv()? {
            (PtydMessage::Hello { protocol_version, ops, identity, instance_id, pid }, _) => Ok((
                connection,
                PtydHello {
                    protocol_version,
                    ops: ops.into_iter().collect(),
                    identity,
                    instance_id,
                    pid,
                },
            )),
            _ => Err(PtydError::Protocol("连接的第一条记录不是 hello".into())),
        }
    }

    fn send<T: Serialize>(&mut self, header: &T, data: &[u8]) -> Result<(), PtydError> {
        let record = encode_ptyd_record(header, data).map_err(|error| PtydError::Protocol(error.to_string()))?;
        self.stream.write_all(&record)?;
        Ok(())
    }

    fn recv(&mut self) -> Result<(PtydMessage, Vec<u8>), PtydError> {
        loop {
            if let Some(next) = self.pending.pop_front() {
                return Ok(next);
            }
            let mut buffer = [0u8; 65536];
            let count = self.stream.read(&mut buffer)?;
            if count == 0 {
                return Err(PtydError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "ptyd 连接已关闭")));
            }
            let mut decoded = Vec::new();
            let mut malformed = None;
            self.parser
                .push(&buffer[..count], |payload| match split_ptyd_payload(payload) {
                    Some((header, data)) => match serde_json::from_slice::<PtydMessage>(header) {
                        Ok(message) => decoded.push((message, data.to_vec())),
                        // 新 ptyd 可能发出本客户端不认识的记录种类：忽略，不断连。
                        Err(_) => {}
                    },
                    None => malformed = Some("record 缺少 header"),
                })
                .map_err(|error| PtydError::Protocol(error.to_string()))?;
            if let Some(message) = malformed {
                return Err(PtydError::Protocol(message.into()));
            }
            self.pending.extend(decoded);
        }
    }
}

fn message_id(message: &PtydMessage) -> Option<u64> {
    match message {
        PtydMessage::Hello { .. } => None,
        PtydMessage::Ok { id }
        | PtydMessage::Error { id, .. }
        | PtydMessage::Opened { id, .. }
        | PtydMessage::Spawned { id, .. }
        | PtydMessage::Sessions { id, .. }
        | PtydMessage::Data { id, .. }
        | PtydMessage::Written { id, .. }
        | PtydMessage::BlobData { id, .. }
        | PtydMessage::ResizeLog { id, .. }
        | PtydMessage::CursorList { id, .. }
        | PtydMessage::Exited { id, .. }
        | PtydMessage::Status { id, .. } => Some(*id),
    }
}

/// 一次请求的往返：发送、按 id 等回执、把 `Error` 变成 `Err`。
fn round_trip(connection: &mut Connection, id: u64, request: PtydRequest, data: &[u8]) -> Result<(PtydMessage, Vec<u8>), PtydError> {
    connection.send(&PtydRequestEnvelope { id, request }, data)?;
    loop {
        let (message, raw) = connection.recv()?;
        if message_id(&message) != Some(id) {
            continue;
        }
        if let PtydMessage::Error { code, message, .. } = message {
            return Err(PtydError::Remote { code, message });
        }
        return Ok((message, raw));
    }
}

pub struct Written {
    pub applied_through_seq: u64,
    pub duplicate: bool,
}

pub struct PtydStatus {
    pub protocol_version: u32,
    pub identity: String,
    pub instance_id: String,
    pub pid: u32,
    pub sessions: Vec<PtydStatusSession>,
}

/// 订阅流上的事件。`Output` 的 `from_offset` 与上一条首尾相接（客户端可据此自检）。
#[derive(Debug)]
pub enum SubscriptionEvent {
    Output { from_offset: u64, data: Vec<u8> },
    Exited { exit_code: i32, final_offset: u64 },
}

/// 专用于一个写者线程的输入连接。
pub struct InputChannel {
    connection: Connection,
    next_id: u64,
}

impl InputChannel {
    pub fn write(&mut self, session_id: &str, client_instance_id: &str, input_seq: u64, data: &[u8]) -> Result<Written, PtydError> {
        self.next_id += 1;
        let request = PtydRequest::Write {
            session_id: session_id.to_string(),
            client_instance_id: client_instance_id.to_string(),
            input_seq,
        };
        match round_trip(&mut self.connection, self.next_id, request, data)? {
            (PtydMessage::Written { applied_through_seq, duplicate, .. }, _) => Ok(Written { applied_through_seq, duplicate }),
            _ => Err(PtydError::Protocol("write 的回执种类不对".into())),
        }
    }
}

pub struct PtydClient {
    path: PathBuf,
    hello: PtydHello,
    request: Mutex<Option<Connection>>,
    next_id: AtomicU64,
}

impl PtydClient {
    pub fn connect(path: impl Into<PathBuf>) -> Result<Arc<Self>, PtydError> {
        let path = path.into();
        let (connection, hello) = Connection::open(&path, Some(REQUEST_TIMEOUT))?;
        Ok(Arc::new(Self {
            path,
            hello,
            request: Mutex::new(Some(connection)),
            next_id: AtomicU64::new(0),
        }))
    }

    pub fn hello(&self) -> &PtydHello {
        &self.hello
    }

    pub fn socket_path(&self) -> &Path {
        &self.path
    }

    /// 运行中的 ptyd 是否宣告了该 op。
    pub fn supports(&self, op: &str) -> bool {
        self.hello.ops.contains(op)
    }

    fn require(&self, op: &'static str) -> Result<(), PtydError> {
        if self.supports(op) {
            Ok(())
        } else {
            Err(PtydError::Unsupported(op))
        }
    }

    fn call(&self, request: PtydRequest, data: &[u8]) -> Result<(PtydMessage, Vec<u8>), PtydError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut slot = self.request.lock().unwrap();
        if slot.is_none() {
            // 上一次 I/O 失败后重连；hello 里的能力以首次连接为准（同一个 ptyd 进程）。
            let (connection, _) = Connection::open(&self.path, Some(REQUEST_TIMEOUT))?;
            *slot = Some(connection);
        }
        let connection = slot.as_mut().expect("刚放进去的连接");
        match round_trip(connection, id, request, data) {
            Err(PtydError::Io(error)) => {
                *slot = None;
                Err(PtydError::Io(error))
            }
            other => other,
        }
    }

    pub fn open(&self, session_id: &str, rows: u16, cols: u16, label: &str) -> Result<String, PtydError> {
        self.require("open")?;
        let request = PtydRequest::Open {
            session_id: session_id.to_string(),
            rows,
            cols,
            label: label.to_string(),
        };
        match self.call(request, &[])? {
            (PtydMessage::Opened { tty, .. }, _) => Ok(tty),
            _ => Err(PtydError::Protocol("open 的回执种类不对".into())),
        }
    }

    pub fn spawn(&self, session_id: &str, argv: Vec<String>, env: Vec<(String, String)>, cwd: &str) -> Result<i32, PtydError> {
        self.require("spawn")?;
        let request = PtydRequest::Spawn {
            session_id: session_id.to_string(),
            argv,
            env,
            cwd: cwd.to_string(),
        };
        match self.call(request, &[])? {
            (PtydMessage::Spawned { pid, .. }, _) => Ok(pid),
            _ => Err(PtydError::Protocol("spawn 的回执种类不对".into())),
        }
    }

    pub fn list(&self) -> Result<Vec<PtydSessionInfo>, PtydError> {
        self.require("list")?;
        match self.call(PtydRequest::List, &[])? {
            (PtydMessage::Sessions { sessions, .. }, _) => Ok(sessions),
            _ => Err(PtydError::Protocol("list 的回执种类不对".into())),
        }
    }

    /// 同步读 ring；返回 `(实际起点, 字节)`。
    pub fn read(&self, session_id: &str, from_offset: u64, max_bytes: u32) -> Result<(u64, Vec<u8>), PtydError> {
        self.require("read")?;
        let request = PtydRequest::Read {
            session_id: session_id.to_string(),
            from_offset,
            max_bytes,
        };
        match self.call(request, &[])? {
            (PtydMessage::Data { from_offset, .. }, data) => Ok((from_offset, data)),
            _ => Err(PtydError::Protocol("read 的回执种类不对".into())),
        }
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), PtydError> {
        self.require("resize")?;
        let request = PtydRequest::Resize {
            session_id: session_id.to_string(),
            rows,
            cols,
        };
        self.call(request, &[]).map(|_| ())
    }

    pub fn checkpoint(&self, session_id: &str, offset: u64, blob: &[u8]) -> Result<(), PtydError> {
        self.require("checkpoint")?;
        let request = PtydRequest::Checkpoint {
            session_id: session_id.to_string(),
            offset,
        };
        self.call(request, blob).map(|_| ())
    }

    /// `Ok(None)` = 从未 checkpoint。
    pub fn blob(&self, session_id: &str) -> Result<Option<(u64, Vec<u8>)>, PtydError> {
        self.require("blob")?;
        let request = PtydRequest::Blob {
            session_id: session_id.to_string(),
        };
        match self.call(request, &[])? {
            (PtydMessage::BlobData { present, offset, .. }, data) => Ok(present.then_some((offset, data))),
            _ => Err(PtydError::Protocol("blob 的回执种类不对".into())),
        }
    }

    pub fn resizes(&self, session_id: &str) -> Result<Vec<PtydResizeEntry>, PtydError> {
        self.require("resizes")?;
        let request = PtydRequest::Resizes {
            session_id: session_id.to_string(),
        };
        match self.call(request, &[])? {
            (PtydMessage::ResizeLog { entries, .. }, _) => Ok(entries),
            _ => Err(PtydError::Protocol("resizes 的回执种类不对".into())),
        }
    }

    pub fn cursors(&self, session_id: &str) -> Result<Vec<PtydCursorInfo>, PtydError> {
        self.require("cursors")?;
        let request = PtydRequest::Cursors {
            session_id: session_id.to_string(),
        };
        match self.call(request, &[])? {
            (PtydMessage::CursorList { cursors, .. }, _) => Ok(cursors),
            _ => Err(PtydError::Protocol("cursors 的回执种类不对".into())),
        }
    }

    pub fn kill(&self, session_id: &str) -> Result<(), PtydError> {
        self.require("kill")?;
        let request = PtydRequest::Kill {
            session_id: session_id.to_string(),
        };
        self.call(request, &[]).map(|_| ())
    }

    pub fn remove(&self, session_id: &str) -> Result<(), PtydError> {
        self.require("remove")?;
        let request = PtydRequest::Remove {
            session_id: session_id.to_string(),
        };
        self.call(request, &[]).map(|_| ())
    }

    pub fn status(&self) -> Result<PtydStatus, PtydError> {
        self.require("status")?;
        match self.call(PtydRequest::Status, &[])? {
            (PtydMessage::Status { protocol_version, identity, instance_id, pid, sessions, .. }, _) => Ok(PtydStatus {
                protocol_version,
                identity,
                instance_id,
                pid,
                sessions,
            }),
            _ => Err(PtydError::Protocol("status 的回执种类不对".into())),
        }
    }

    pub fn shutdown(&self) -> Result<(), PtydError> {
        self.require("shutdown")?;
        let request = PtydRequest::Shutdown {
            instance_id: self.hello.instance_id.clone(),
        };
        self.call(request, &[]).map(|_| ())
    }

    /// 独立连接上的输入写者。
    pub fn input_channel(&self) -> Result<InputChannel, PtydError> {
        self.require("write")?;
        let (connection, _) = Connection::open(&self.path, None)?;
        Ok(InputChannel { connection, next_id: 0 })
    }

    /// 从 `from_offset` 起订阅：ptyd 先补发 ring 里的字节再实时推送。返回的接收端在连接断开
    /// 时关闭（`recv` 得到 Err）；`Exited` 之后不再有事件。
    pub fn subscribe(&self, session_id: &str, from_offset: u64) -> Result<Receiver<SubscriptionEvent>, PtydError> {
        self.require("subscribe")?;
        let (mut connection, _) = Connection::open(&self.path, None)?;
        let request = PtydRequest::Subscribe {
            session_id: session_id.to_string(),
            from_offset,
        };
        connection.send(&PtydRequestEnvelope { id: 1, request }, &[])?;
        match connection.recv()? {
            (PtydMessage::Ok { .. }, _) => {}
            (PtydMessage::Error { code, message, .. }, _) => return Err(PtydError::Remote { code, message }),
            _ => return Err(PtydError::Protocol("subscribe 的回执种类不对".into())),
        }
        let (sender, receiver) = sync_channel(SUBSCRIPTION_QUEUE_RECORDS);
        thread::spawn(move || loop {
            match connection.recv() {
                Ok((PtydMessage::Data { from_offset, .. }, data)) => {
                    if sender.send(SubscriptionEvent::Output { from_offset, data }).is_err() {
                        break;
                    }
                }
                Ok((PtydMessage::Exited { exit_code, final_offset, .. }, _)) => {
                    let _ = sender.send(SubscriptionEvent::Exited { exit_code, final_offset });
                    break;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        });
        Ok(receiver)
    }
}
