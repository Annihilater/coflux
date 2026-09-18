//! ptyd ↔ supervisor 本地协议（plan 20260918-ptyd-terminal-custody）。
//!
//! `coflux-ptyd` 是持有 PTY 的长生进程；supervisor 只是它的一个客户端。这里的类型是一份
//! **长期兼容契约**：新 supervisor 必须能与旧 ptyd 对话（否则 supervisor 升级又会结束终端，
//! 整个设计就白做了），旧 supervisor 也必须能与新 ptyd 对话（回滚）。因此：
//!
//! - 兼容机制是**能力握手**而不是版本号：ptyd 连接建立后先发 [`PtydMessage::Hello`]，里面列出
//!   它实际实现的 op 名；客户端把任何未列出的 op 当成"不可用能力"并在没有它的情况下继续，
//!   绝不在调用点硬失败。ptyd 对没列出的 op 一律回 `unknown_op`。
//! - v1 的 op 永不删除、永不改义；只能新增 op 与可缺省字段。
//!
//! 分帧：复用 [`crate::ipc`] 的 4 字节长度前缀 record；record payload 再分成
//! `[u32 BE header_len][header JSON][raw bytes]`，二进制数据（PTY 输出、输入、checkpoint blob）
//! 走 raw 段，不做 base64。

use serde::{Deserialize, Serialize};

use crate::ipc::{write_record, RecordWriteError};

/// 协议语义版本；只在不兼容改动时递增（能力握手才是日常兼容的载体）。
pub const PTYD_PROTOCOL_VERSION: u32 = 1;
/// ptyd 监听的 UDS 路径（缺省 `<COFLUX_HOME>/ptyd.sock`）。
pub const PTYD_SOCK_ENV: &str = "COFLUX_PTYD_SOCK";
/// 生命周期拥有者（桌面 app / cofluxd 生成的服务）交给 ptyd 的二进制身份；缺省 ptyd 对自身
/// 可执行文件做 sha256。ptyd **不**内嵌 release 版本，否则每个 tag 都会让"ptyd 没变"无法判定。
pub const PTYD_ID_ENV: &str = "COFLUX_PTYD_ID";
/// 黑盒专用：逗号分隔的 op 名，ptyd 只宣告（并只服务）这些 op，用来模拟旧 ptyd。
pub const PTYD_TEST_OPS_ENV: &str = "COFLUX_PTYD_TEST_OPS";
pub const PTYD_SOCK_NAME: &str = "ptyd.sock";
/// `<COFLUX_HOME>/terminal-data`：ring / blob 的 mmap 文件目录。原始终端输出第一次落盘就在这里，
/// 目录与文件 0600、session 结束即 unlink、启动清扫、排除备份、总量有界——都是产品决策的一部分。
pub const TERMINAL_DATA_DIR: &str = "terminal-data";
/// 每 session 输出 ring 容量。`output_seq` 本来就是字节计数器，ring 也按输出字节偏移索引，
/// 于是 `seq ≡ offset + 1`，重建出来的 supervisor 复现逐字节相同的序号。
pub const PTYD_RING_CAPACITY: u64 = 4 * 1024 * 1024;
/// checkpoint blob 容量（supervisor 的规范 snapshot + 未编码状态）。
pub const PTYD_BLOB_CAPACITY: usize = 2 * 1024 * 1024;
/// `open` 时随 session 存下的不透明标签（supervisor 放 task id / cwd / secret 等自己的元数据）。
pub const PTYD_LABEL_MAX_BYTES: usize = 4096;
/// 与 supervisor 的 MAX_LIVE_SESSIONS 同值：ring 总量由它 × 容量封顶。
pub const PTYD_MAX_LIVE_SESSIONS: usize = 128;
/// 单条输入上限（与 supervisor PTY_INPUT_QUEUE_BYTES 一致）。
pub const PTYD_MAX_INPUT_BYTES: usize = 1024 * 1024;
/// 单次 `read` 上限。
pub const PTYD_MAX_READ_BYTES: u32 = 1024 * 1024;
/// 每 session 的输入去重 identity 上限（与 sessiond LOGICAL_CLIENT_LIMIT 同值）：达到后拒绝新
/// identity，已登记的照常服务。
pub const PTYD_LOGICAL_CLIENT_LIMIT: usize = 256;
/// resize 日志保留条数；比 ring 起点更早的条目没有用处。
pub const PTYD_RESIZE_LOG_ENTRIES: usize = 256;

/// v1 的全部 op。ptyd 的 hello 按实现宣告；客户端按宣告决定能力。
pub const PTYD_V1_OPS: &[&str] = &[
    "open",
    "spawn",
    "list",
    "subscribe",
    "read",
    "write",
    "resize",
    "checkpoint",
    "blob",
    "resizes",
    "cursors",
    "kill",
    "remove",
    "status",
    "shutdown",
];

/// 客户端 → ptyd。header JSON 形如 `{"id":7,"op":"open",...}`；raw 段的含义见各 variant。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PtydRequest {
    /// 分配 PTY 与 ring 文件；`label` 是 supervisor 的不透明元数据，`list` 原样返回。
    /// 回 [`PtydMessage::Opened`]（含从属端设备路径，供 supervisor 注入 `SSH_TTY`）。
    Open {
        session_id: String,
        rows: u16,
        cols: u16,
        label: String,
    },
    /// 在已 open 的 session 上 fork/exec 一个**完全解析好**的 spec；ptyd 不解释其中任何一项。
    /// 回 [`PtydMessage::Spawned`]。
    Spawn {
        session_id: String,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
    },
    /// 回 [`PtydMessage::Sessions`]。
    List,
    /// 把本连接变成该 session 的输出流：先补发 ring 中 `[from_offset, end)`，再实时推送
    /// [`PtydMessage::Data`]；进程退出后推 [`PtydMessage::Exited`]。每 session 只有一个订阅者，
    /// 新订阅替换旧的。
    Subscribe { session_id: String, from_offset: u64 },
    /// 同步读 ring `[from_offset, min(end, from_offset + max_bytes))`；回 [`PtydMessage::Data`]。
    Read {
        session_id: String,
        from_offset: u64,
        max_bytes: u32,
    },
    /// raw 段 = 输入字节。按 `(session, client_instance_id)` 游标去重：重复 seq 回
    /// `duplicate`，同 seq 不同 payload 回 `input_seq_collision`，不连续回 `input_seq_gap`。
    /// 回 [`PtydMessage::Written`]。
    Write {
        session_id: String,
        client_instance_id: String,
        input_seq: u64,
    },
    /// TIOCSWINSZ，并把 `(当前输出偏移, rows, cols)` 记入 resize 日志。
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    /// raw 段 = 不透明 blob，描述输出偏移 `[0, offset)` 之前的全部状态。此后 ptyd 绝不覆盖
    /// 偏移 ≥ offset 的任何字节（宁可停止读 PTY）。
    Checkpoint { session_id: String, offset: u64 },
    /// 回 [`PtydMessage::BlobData`]。
    Blob { session_id: String },
    /// 回 [`PtydMessage::ResizeLog`]。
    Resizes { session_id: String },
    /// 回 [`PtydMessage::CursorList`]。
    Cursors { session_id: String },
    /// SIGKILL 子进程；退出事实由 reaper 记录，session 保留到 `remove`。
    Kill { session_id: String },
    /// 删除已退出（或尚未 spawn）的 session，unlink 其文件。仍在运行则回 `session_running`。
    Remove { session_id: String },
    /// 只读状态（桌面 app 在 supervisor 缺席期间也用它数终端）。回 [`PtydMessage::Status`]。
    Status,
    /// 结束全部子进程并退出（"停止本机终端"）。`instance_id` 必须与 hello 一致。
    Shutdown { instance_id: String },
}

/// 带请求 id 的 header。ptyd 对解析不出 op 的 header 仍按 id 回 `unknown_op`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtydRequestEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: PtydRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtydSessionInfo {
    pub session_id: String,
    /// 尚未 spawn 为 -1。
    pub pid: i32,
    pub rows: u16,
    pub cols: u16,
    pub tty: String,
    pub label: String,
    /// ring 当前保留的最早偏移（含）。
    pub ring_start: u64,
    /// 已产出的输出总字节数 = 下一个字节的偏移。
    pub output_offset: u64,
    /// 最近一次 checkpoint 的偏移；从未 checkpoint 为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_offset: Option<u64>,
    /// 子进程已退出时的退出码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtydResizeEntry {
    /// 生效时的输出偏移：偏移 < offset 的字节在旧尺寸下产生。
    pub offset: u64,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtydCursorInfo {
    pub client_instance_id: String,
    pub seq: u64,
    /// 最近一次写入 PTY 的 payload（hex），供 supervisor 重建 collision 判定。
    pub data_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtydStatusSession {
    pub session_id: String,
    pub pid: i32,
    pub exited: bool,
}

/// ptyd → 客户端。`id` 回带请求 id；订阅流里的 `Data` / `Exited` 带订阅请求的 id。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PtydMessage {
    /// 连接建立后 ptyd 发出的第一条记录。
    Hello {
        protocol_version: u32,
        ops: Vec<String>,
        identity: String,
        instance_id: String,
        pid: u32,
    },
    Ok {
        id: u64,
    },
    Error {
        id: u64,
        code: String,
        message: String,
    },
    Opened {
        id: u64,
        tty: String,
    },
    Spawned {
        id: u64,
        pid: i32,
    },
    Sessions {
        id: u64,
        sessions: Vec<PtydSessionInfo>,
    },
    /// raw 段 = 从 `from_offset` 起的连续输出字节。
    Data {
        id: u64,
        session_id: String,
        from_offset: u64,
    },
    Written {
        id: u64,
        applied_through_seq: u64,
        duplicate: bool,
    },
    /// raw 段 = blob；`present == false` 时 raw 为空、offset 为 0。
    BlobData {
        id: u64,
        present: bool,
        offset: u64,
    },
    ResizeLog {
        id: u64,
        entries: Vec<PtydResizeEntry>,
    },
    CursorList {
        id: u64,
        cursors: Vec<PtydCursorInfo>,
    },
    Exited {
        id: u64,
        session_id: String,
        exit_code: i32,
        final_offset: u64,
    },
    Status {
        id: u64,
        protocol_version: u32,
        identity: String,
        instance_id: String,
        pid: u32,
        sessions: Vec<PtydStatusSession>,
    },
}

/// 编一条 ptyd record：`[u32 总长][u32 header_len][header JSON][raw]`。
pub fn encode_ptyd_record<T: Serialize>(header: &T, data: &[u8]) -> Result<Vec<u8>, RecordWriteError> {
    let header = serde_json::to_vec(header).unwrap_or_default();
    let mut payload = Vec::with_capacity(4 + header.len() + data.len());
    payload.extend_from_slice(&(header.len() as u32).to_be_bytes());
    payload.extend_from_slice(&header);
    payload.extend_from_slice(data);
    write_record(&payload)
}

/// 把 record payload 拆成 `(header JSON, raw)`；畸形返回 None。
pub fn split_ptyd_payload(payload: &[u8]) -> Option<(&[u8], &[u8])> {
    if payload.len() < 4 {
        return None;
    }
    let header_len = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    if payload.len() - 4 < header_len {
        return None;
    }
    Some((&payload[4..4 + header_len], &payload[4 + header_len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ptyd_record_round_trips_header_and_raw_bytes() {
        let header = PtydRequestEnvelope {
            id: 9,
            request: PtydRequest::Write {
                session_id: "s".into(),
                client_instance_id: "c".into(),
                input_seq: 3,
            },
        };
        let record = encode_ptyd_record(&header, b"ls\r").unwrap();
        let declared = u32::from_be_bytes(record[..4].try_into().unwrap()) as usize;
        assert_eq!(declared, record.len() - 4);
        let (json, raw) = split_ptyd_payload(&record[4..]).unwrap();
        assert_eq!(raw, b"ls\r");
        let decoded: PtydRequestEnvelope = serde_json::from_slice(json).unwrap();
        assert_eq!(decoded.id, 9);
        assert!(matches!(decoded.request, PtydRequest::Write { input_seq: 3, .. }));
        let value: serde_json::Value = serde_json::from_slice(json).unwrap();
        assert_eq!(value["op"], "write", "header 用 op 字段做 tag，未知 op 仍可按 id 回错");
    }

    #[test]
    fn unknown_op_header_still_carries_its_id() {
        let raw = br#"{"id":42,"op":"teleport","session_id":"x"}"#;
        assert!(serde_json::from_slice::<PtydRequestEnvelope>(raw).is_err());
        let value: serde_json::Value = serde_json::from_slice(raw).unwrap();
        assert_eq!(value["id"].as_u64(), Some(42));
    }

    #[test]
    fn hello_lists_every_v1_op_by_name() {
        for op in PTYD_V1_OPS {
            let probe = format!(r#"{{"id":1,"op":"{op}"}}"#);
            // 只检查 tag 能被识别：缺字段的 variant 报的是字段错误而不是未知 variant。
            let error = serde_json::from_str::<PtydRequestEnvelope>(&probe)
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            assert!(
                !error.contains("unknown variant"),
                "v1 op {op} 必须是协议里的合法 variant：{error}"
            );
        }
    }
}
