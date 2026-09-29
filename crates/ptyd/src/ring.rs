//! 每 session 一个 `mmap(MAP_SHARED)` 文件：`[header][ring][blob]`。
//!
//! 这是原始终端输出第一次落到磁盘上——密码、token，凡是在终端里出现过的都在里面，只要
//! session 还活着。所以下面这些不是实现细节而是决策的一部分：目录与文件 0600、session 结束
//! 立刻 unlink、上次崩溃留下的文件在 ptyd 启动时清扫、总量由 `PTYD_MAX_LIVE_SESSIONS × 容量`
//! 封顶（按存活 session 计，不按历史 session 累积）、目录排除在备份之外。放松任何一条都是
//! 改产品决策，不是重构。
//!
//! ring 按**输出字节偏移**索引：偏移 `o` 的字节放在 `ring[o % CAP]`。它保留 `[start, end)`，
//! `start = max(0, end - CAP)`。**一旦有了 checkpoint**，就永不覆盖偏移 ≥ 最近一次 checkpoint 偏移 X
//! 的字节：写入预算 = `X + CAP - end`，预算耗尽时调用方停止读 PTY（内核 PTY 缓冲填满后 shell 自己
//! 暂停，与今天 supervisor 有界队列的背压完全一致）。**第一次 checkpoint 之前**（以及在从不宣告
//! checkpoint op 的 ptyd 上）它就是一个普通的环：覆盖最旧的字节，绝不停读——把 X 缺省成 0 会让
//! 没有 checkpoint 的 session 在写满一环后预算永远为 0、读线程永远停住，终端为了"忠实重建"而
//! 永久冻结，比它要避免的那点保真度损失糟得多。能用的终端优先于忠实重建；没有 checkpoint 的
//! 恢复从 ring 起点回放、接受模态状态丢失。

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use coflux_protocol::ptyd::{
    PtydResizeEntry, PTYD_BLOB_CAPACITY, PTYD_LABEL_MAX_BYTES, PTYD_RESIZE_LOG_ENTRIES,
    PTYD_RING_CAPACITY,
};
use sha2::{Digest, Sha256};

const HEADER_BYTES: usize = 16 * 1024;
const MAGIC: &[u8; 8] = b"CFPTYRNG";
const LAYOUT_VERSION: u32 = 1;
const OFF_VERSION: usize = 8;
const OFF_ROWS: usize = 12;
const OFF_COLS: usize = 14;
const OFF_END: usize = 16;
const OFF_CHECKPOINT: usize = 24;
const OFF_BLOB_LEN: usize = 32;
const OFF_LABEL_LEN: usize = 36;
const OFF_RESIZE_COUNT: usize = 40;
const OFF_HAS_CHECKPOINT: usize = 44;
const OFF_LABEL: usize = 64;
const OFF_RESIZES: usize = OFF_LABEL + PTYD_LABEL_MAX_BYTES;
const RESIZE_ENTRY_BYTES: usize = 16;
const RING_CAPACITY: usize = PTYD_RING_CAPACITY as usize;
const RING_OFFSET: usize = HEADER_BYTES;
const BLOB_OFFSET: usize = RING_OFFSET + RING_CAPACITY;
const FILE_BYTES: usize = BLOB_OFFSET + PTYD_BLOB_CAPACITY;
pub const RING_FILE_SUFFIX: &str = ".ring";

const _: () = assert!(OFF_RESIZES + PTYD_RESIZE_LOG_ENTRIES * RESIZE_ENTRY_BYTES <= HEADER_BYTES);

struct Mapping {
    ptr: *mut u8,
    len: usize,
}

// SAFETY: 映射只被持有它的 SessionFile 访问，而 SessionFile 总在 session 的 mutex 之内使用。
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    fn create(file: &File, len: usize) -> io::Result<Self> {
        // SAFETY: fd 有效且文件已 set_len 到 len；MAP_SHARED 让写入直达文件页缓存。
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            ptr: ptr as *mut u8,
            len,
        })
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: ptr/len 来自成功的 mmap，映射在 Drop 之前始终有效。
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        // SAFETY: 同上；&mut self 保证独占。
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: 与 mmap 配对；之后不再触碰 ptr。
        unsafe {
            libc::munmap(self.ptr as *mut libc::c_void, self.len);
        }
    }
}

/// 一个 session 的 ring + blob + 元数据。
pub struct SessionFile {
    path: PathBuf,
    map: Mapping,
    end: u64,
    checkpoint: Option<u64>,
    blob_len: usize,
    rows: u16,
    cols: u16,
    label: String,
    resizes: Vec<PtydResizeEntry>,
}

/// session id 是外部给的字符串；文件名只用它的摘要，不让 id 里的任何字符进路径。
pub fn file_name_for(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    format!("s-{}{RING_FILE_SUFFIX}", hex::encode(&digest[..16]))
}

impl SessionFile {
    pub fn create(
        dir: &Path,
        session_id: &str,
        rows: u16,
        cols: u16,
        label: &str,
    ) -> io::Result<Self> {
        if label.len() > PTYD_LABEL_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("label 超过 {PTYD_LABEL_MAX_BYTES} 字节"),
            ));
        }
        let path = dir.join(file_name_for(session_id));
        // O_EXCL：同 id 的残留文件说明状态不一致，宁可失败也不接手别人的内容。
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)?;
        let created = (|| -> io::Result<Self> {
            file.set_len(FILE_BYTES as u64)?;
            let mut map = Mapping::create(&file, FILE_BYTES)?;
            let bytes = map.bytes_mut();
            bytes[..8].copy_from_slice(MAGIC);
            bytes[OFF_VERSION..OFF_VERSION + 4].copy_from_slice(&LAYOUT_VERSION.to_le_bytes());
            bytes[OFF_ROWS..OFF_ROWS + 2].copy_from_slice(&rows.to_le_bytes());
            bytes[OFF_COLS..OFF_COLS + 2].copy_from_slice(&cols.to_le_bytes());
            bytes[OFF_LABEL_LEN..OFF_LABEL_LEN + 4]
                .copy_from_slice(&(label.len() as u32).to_le_bytes());
            bytes[OFF_LABEL..OFF_LABEL + label.len()].copy_from_slice(label.as_bytes());
            Ok(Self {
                path: path.clone(),
                map,
                end: 0,
                checkpoint: None,
                blob_len: 0,
                rows,
                cols,
                label: label.to_string(),
                resizes: Vec::new(),
            })
        })();
        if created.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        created
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn start(&self) -> u64 {
        self.end.saturating_sub(PTYD_RING_CAPACITY)
    }

    pub fn checkpoint(&self) -> Option<u64> {
        self.checkpoint
    }

    pub fn rows(&self) -> u16 {
        self.rows
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn resizes(&self) -> &[PtydResizeEntry] {
        &self.resizes
    }

    /// 还能追加多少字节而不覆盖偏移 ≥ X 的内容。没有 checkpoint 就没有 X：普通环，随便写。
    pub fn write_budget(&self) -> usize {
        let Some(floor) = self.checkpoint else {
            return usize::MAX;
        };
        usize::try_from((floor + PTYD_RING_CAPACITY).saturating_sub(self.end)).unwrap_or(usize::MAX)
    }

    /// 追加输出；调用方必须先按 `write_budget` 截断。返回写入前的偏移。
    pub fn append(&mut self, data: &[u8]) -> u64 {
        debug_assert!(data.len() <= self.write_budget());
        let from = self.end;
        let mut written = 0;
        while written < data.len() {
            let position = ((from + written as u64) % PTYD_RING_CAPACITY) as usize;
            let chunk = (RING_CAPACITY - position).min(data.len() - written);
            let bytes = self.map.bytes_mut();
            bytes[RING_OFFSET + position..RING_OFFSET + position + chunk]
                .copy_from_slice(&data[written..written + chunk]);
            written += chunk;
        }
        self.end += data.len() as u64;
        let end = self.end;
        self.map.bytes_mut()[OFF_END..OFF_END + 8].copy_from_slice(&end.to_le_bytes());
        from
    }

    /// 读 `[from, min(end, from + max))`；`from` 早于 ring 起点时返回 None（已被淘汰）。
    pub fn read(&self, from: u64, max: usize) -> Option<(u64, Vec<u8>)> {
        if from < self.start() || from > self.end {
            return None;
        }
        let to = self.end.min(from.saturating_add(max as u64));
        let length = (to - from) as usize;
        let mut out = Vec::with_capacity(length);
        let bytes = self.map.bytes();
        let mut copied = 0;
        while copied < length {
            let position = ((from + copied as u64) % PTYD_RING_CAPACITY) as usize;
            let chunk = (RING_CAPACITY - position).min(length - copied);
            out.extend_from_slice(&bytes[RING_OFFSET + position..RING_OFFSET + position + chunk]);
            copied += chunk;
        }
        Some((from, out))
    }

    /// 记录 checkpoint：blob 描述 `[0, offset)`，此后 ring 起点永不越过 offset。
    pub fn set_checkpoint(&mut self, offset: u64, blob: &[u8]) -> Result<(), &'static str> {
        if blob.len() > PTYD_BLOB_CAPACITY {
            return Err("checkpoint blob 超过容量");
        }
        if offset < self.start() || offset > self.end {
            return Err("checkpoint 偏移不在 ring 保留范围内");
        }
        let bytes = self.map.bytes_mut();
        bytes[BLOB_OFFSET..BLOB_OFFSET + blob.len()].copy_from_slice(blob);
        bytes[OFF_BLOB_LEN..OFF_BLOB_LEN + 4].copy_from_slice(&(blob.len() as u32).to_le_bytes());
        bytes[OFF_CHECKPOINT..OFF_CHECKPOINT + 8].copy_from_slice(&offset.to_le_bytes());
        bytes[OFF_HAS_CHECKPOINT] = 1;
        self.checkpoint = Some(offset);
        self.blob_len = blob.len();
        Ok(())
    }

    pub fn blob(&self) -> Option<(u64, &[u8])> {
        let offset = self.checkpoint?;
        Some((
            offset,
            &self.map.bytes()[BLOB_OFFSET..BLOB_OFFSET + self.blob_len],
        ))
    }

    /// 尺寸变更：记入日志（超过条数淘汰最旧）并更新当前尺寸。
    pub fn push_resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        if self.resizes.len() >= PTYD_RESIZE_LOG_ENTRIES {
            self.resizes.remove(0);
        }
        self.resizes.push(PtydResizeEntry {
            offset: self.end,
            rows,
            cols,
        });
        let count = self.resizes.len();
        let mut encoded = Vec::with_capacity(count * RESIZE_ENTRY_BYTES);
        for entry in &self.resizes {
            encoded.extend_from_slice(&entry.offset.to_le_bytes());
            encoded.extend_from_slice(&entry.rows.to_le_bytes());
            encoded.extend_from_slice(&entry.cols.to_le_bytes());
            encoded.extend_from_slice(&[0u8; 4]);
        }
        let bytes = self.map.bytes_mut();
        bytes[OFF_ROWS..OFF_ROWS + 2].copy_from_slice(&rows.to_le_bytes());
        bytes[OFF_COLS..OFF_COLS + 2].copy_from_slice(&cols.to_le_bytes());
        bytes[OFF_RESIZE_COUNT..OFF_RESIZE_COUNT + 4].copy_from_slice(&(count as u32).to_le_bytes());
        bytes[OFF_RESIZES..OFF_RESIZES + encoded.len()].copy_from_slice(&encoded);
    }

    /// session 结束：立刻 unlink（映射本身随 drop 解除；已 unlink 的页只活到 munmap）。
    pub fn unlink(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 启动清扫：上一次 ptyd 被 kill / 崩溃时留下的 ring 文件全部删除——里面的输出属于已经不存在
/// 的进程，谁也读不了了。只删本模块命名的 `*.ring`，目录里其它文件（桌面版把它当 TMPDIR）不动。
pub fn sweep(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with("s-") && name.ends_with(RING_FILE_SUFFIX) {
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("coflux-ring-{name}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn ring_reads_by_offset_after_wrapping() {
        let dir = temp_dir("wrap");
        let mut file = SessionFile::create(&dir, "session", 24, 80, "").unwrap();
        // 没有 checkpoint：普通环，写多少都不停，最旧的字节被覆盖。
        let chunk: Vec<u8> = (0..=255u8).cycle().take(1024 * 1024).collect();
        file.append(&chunk);
        let mut total = file.end();
        for round in 0..6u8 {
            let data = vec![b'a' + round; 1024 * 1024];
            assert_eq!(file.write_budget(), usize::MAX, "第一次 checkpoint 之前预算无限");
            file.append(&data);
            total += data.len() as u64;
        }
        assert_eq!(file.end(), total);
        assert_eq!(file.start(), total - PTYD_RING_CAPACITY);
        // 最后一轮的 1 MiB 落在环绕之后：按偏移读回必须逐字节相同。
        let from = total - 1024 * 1024;
        let (at, bytes) = file.read(from, 1024 * 1024).unwrap();
        assert_eq!(at, from);
        assert!(bytes.iter().all(|byte| *byte == b'a' + 5));
        // 跨环绕边界的读：末尾两轮拼起来。
        let (_, two) = file.read(total - 2 * 1024 * 1024, 2 * 1024 * 1024).unwrap();
        assert_eq!(two[..1024 * 1024], vec![b'a' + 4; 1024 * 1024][..]);
        assert_eq!(two[1024 * 1024..], vec![b'a' + 5; 1024 * 1024][..]);
        assert!(file.read(file.start() - 1, 16).is_none(), "早于 ring 起点的偏移已淘汰");
        file.unlink();
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_budget_never_crosses_the_checkpoint_offset() {
        let dir = temp_dir("budget");
        let mut file = SessionFile::create(&dir, "session", 24, 80, "").unwrap();
        assert_eq!(file.write_budget(), usize::MAX, "无 checkpoint 时没有 X：普通环");
        // 先写超过一环：没有 checkpoint 时照常环绕，起点跟着末尾走。
        file.append(&vec![0u8; 5 * 1024 * 1024]);
        assert_eq!(file.start(), 1024 * 1024);
        assert_eq!(file.write_budget(), usize::MAX);
        file.set_checkpoint(1024 * 1024 + 1, b"x").unwrap();
        // 保留 [1 MiB + 1, ...)：还能写 1 byte 就会盖掉那个字节之后……精确到字节。
        assert_eq!(file.write_budget(), 1);
        file.append(&[0u8]);
        assert_eq!(file.write_budget(), 0);
        assert_eq!(file.start(), 1024 * 1024 + 1);
        file.set_checkpoint(file.end(), b"y").unwrap();
        assert_eq!(file.write_budget() as u64, PTYD_RING_CAPACITY);
        assert_eq!(file.blob().map(|(offset, blob)| (offset, blob.to_vec())), Some((file.end(), b"y".to_vec())));
        file.unlink();
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checkpoint_offset_cannot_point_below_the_ring_start() {
        let dir = temp_dir("floor");
        let mut file = SessionFile::create(&dir, "session", 24, 80, "").unwrap();
        file.append(&vec![0u8; 3 * 1024 * 1024]);
        file.set_checkpoint(1024 * 1024, b"x").unwrap();
        // 保留 [1 MiB, ...)：还能写 2 MiB，再多就会盖掉偏移 1 MiB 处的字节。
        assert_eq!(file.write_budget(), 2 * 1024 * 1024);
        file.append(&vec![0u8; 2 * 1024 * 1024]);
        assert_eq!(file.write_budget(), 0);
        assert_eq!(file.start(), 1024 * 1024);
        assert!(file.set_checkpoint(1024 * 1024 - 1, b"x").is_err(), "checkpoint 不能指向已淘汰的偏移");
        assert!(file.set_checkpoint(file.end() + 1, b"x").is_err(), "checkpoint 不能指向尚未产生的偏移");
        file.unlink();
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn files_are_private_unlinked_on_remove_and_swept_at_startup() {
        let dir = temp_dir("sweep");
        let file = SessionFile::create(&dir, "session", 24, 80, "label").unwrap();
        let path = file.path().to_path_buf();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "ring 文件必须 0600");
        file.unlink();
        drop(file);
        assert!(!path.exists(), "session 结束即 unlink");

        // 模拟上一次 ptyd 被 kill：留下两个 ring 文件与一个无关文件。
        std::fs::write(dir.join("s-deadbeef.ring"), b"stale").unwrap();
        std::fs::write(dir.join("s-cafebabe.ring"), b"stale").unwrap();
        std::fs::write(dir.join("unrelated.tmp"), b"keep").unwrap();
        assert_eq!(sweep(&dir), 2);
        assert!(!dir.join("s-deadbeef.ring").exists());
        assert!(dir.join("unrelated.tmp").exists(), "只清 ring 文件，不动目录里的其它东西");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resize_log_records_the_output_offset_at_each_change() {
        let dir = temp_dir("resize");
        let mut file = SessionFile::create(&dir, "session", 24, 80, "").unwrap();
        file.append(b"hello");
        file.push_resize(30, 100);
        file.append(b"world!");
        file.push_resize(10, 40);
        assert_eq!(
            file.resizes(),
            &[
                PtydResizeEntry { offset: 5, rows: 30, cols: 100 },
                PtydResizeEntry { offset: 11, rows: 10, cols: 40 },
            ]
        );
        assert_eq!((file.rows(), file.cols()), (10, 40));
        for _ in 0..(PTYD_RESIZE_LOG_ENTRIES + 3) {
            file.push_resize(5, 5);
        }
        assert_eq!(file.resizes().len(), PTYD_RESIZE_LOG_ENTRIES, "日志有界");
        file.unlink();
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
