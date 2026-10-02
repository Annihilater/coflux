//! Length-prefixed record framing shared by the daemon's local byte streams.
//!
//! A UDS has no message boundaries, so every record carries a 4-byte big-endian length prefix:
//! `[u32 BE length][payload]`. Used by the ptyd protocol ([`crate::ptyd`]), the screen helper
//! stream and the runtime's in-process sessiond bridge.

use serde::{Deserialize, Serialize};

use crate::{MAX_DEVICE_FRAME_BYTES, MAX_FRAME_ID_BYTES};

/// Hard upper bound of one record payload, shared by writer and parser.
pub const MAX_IPC_RECORD_BYTES: usize = MAX_DEVICE_FRAME_BYTES + 2 + MAX_FRAME_ID_BYTES;

/// Command state of a live shell as tracked by sessiond from coflux's own OSC 133 marks
/// (interactive-only terminal model). Mirrors `wire::TerminalCommandState`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStateInfo {
    /// At least one accepted mark arrived: the shell is instrumented and its prompt was drawn.
    pub integrated: bool,
    /// A command started (command-start mark) and has not finished yet.
    pub busy: bool,
    /// Monotonic count of commands started; 0 = none yet.
    pub command_seq: u64,
    /// Sequence of the last finished command (0 = none) and its exit status when known.
    pub finished_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordWriteError {
    RecordTooLarge { actual: usize, max: usize },
}

impl std::fmt::Display for RecordWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordTooLarge { actual, max } => {
                write!(formatter, "UDS record 长度 {actual} 超过上限 {max}")
            }
        }
    }
}

impl std::error::Error for RecordWriteError {}

/// 写一条带长度前缀的记录；发送侧不能制造解析侧必然拒绝的超长 record。
pub fn write_record(payload: &[u8]) -> Result<Vec<u8>, RecordWriteError> {
    if payload.len() > MAX_IPC_RECORD_BYTES {
        return Err(RecordWriteError::RecordTooLarge {
            actual: payload.len(),
            max: MAX_IPC_RECORD_BYTES,
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// 累积式分帧解析器：喂入任意字节块，凑齐一条记录就回调（镜像 TS RecordParser）。
#[derive(Default)]
pub struct RecordParser {
    buf: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordParseError {
    RecordTooLarge { declared: usize, max: usize },
}

impl std::fmt::Display for RecordParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordTooLarge { declared, max } => {
                write!(formatter, "UDS record 声明长度 {declared} 超过上限 {max}")
            }
        }
    }
}

impl std::error::Error for RecordParseError {}

impl RecordParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 追加一段字节，对凑齐的每条记录调用 `on_record`。
    pub fn push(
        &mut self,
        chunk: &[u8],
        mut on_record: impl FnMut(&[u8]),
    ) -> Result<(), RecordParseError> {
        self.buf.extend_from_slice(chunk);
        let mut pos = 0usize;
        while self.buf.len() - pos >= 4 {
            let len = u32::from_be_bytes([
                self.buf[pos],
                self.buf[pos + 1],
                self.buf[pos + 2],
                self.buf[pos + 3],
            ]) as usize;
            if len > MAX_IPC_RECORD_BYTES {
                self.buf.clear();
                return Err(RecordParseError::RecordTooLarge {
                    declared: len,
                    max: MAX_IPC_RECORD_BYTES,
                });
            }
            if self.buf.len() - pos < 4 + len {
                break;
            }
            on_record(&self.buf[pos + 4..pos + 4 + len]);
            pos += 4 + len;
        }
        if pos > 0 {
            self.buf.drain(0..pos);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_framing_across_chunk_boundaries() {
        let mut stream = Vec::new();
        stream.extend(write_record(b"hello").unwrap());
        stream.extend(write_record(b"world!!").unwrap());
        let mut parser = RecordParser::new();
        let mut got: Vec<Vec<u8>> = Vec::new();
        parser.push(&stream[..3], |r| got.push(r.to_vec())).unwrap();
        parser
            .push(&stream[3..9], |r| got.push(r.to_vec()))
            .unwrap();
        parser.push(&stream[9..], |r| got.push(r.to_vec())).unwrap();
        assert_eq!(got, vec![b"hello".to_vec(), b"world!!".to_vec()]);
    }

    #[test]
    fn oversized_record_is_rejected_and_parser_state_is_cleared() {
        let declared = MAX_IPC_RECORD_BYTES + 1;
        let mut parser = RecordParser::new();
        assert_eq!(
            parser.push(&(declared as u32).to_be_bytes(), |_| panic!(
                "an oversized record must not reach the callback"
            )),
            Err(RecordParseError::RecordTooLarge {
                declared,
                max: MAX_IPC_RECORD_BYTES
            })
        );
        let mut got = Vec::new();
        parser
            .push(&write_record(b"ok").unwrap(), |record| {
                got.push(record.to_vec())
            })
            .unwrap();
        assert_eq!(got, vec![b"ok".to_vec()]);
    }

    #[test]
    fn writer_uses_the_same_record_limit_as_parser() {
        let exact = vec![0u8; MAX_IPC_RECORD_BYTES];
        assert_eq!(
            write_record(&exact).unwrap().len(),
            MAX_IPC_RECORD_BYTES + 4
        );
        let oversized = vec![0u8; MAX_IPC_RECORD_BYTES + 1];
        assert_eq!(
            write_record(&oversized),
            Err(RecordWriteError::RecordTooLarge {
                actual: MAX_IPC_RECORD_BYTES + 1,
                max: MAX_IPC_RECORD_BYTES
            })
        );
    }

    #[test]
    fn command_state_serializes_camel_case() {
        let state = CommandStateInfo { integrated: true, busy: false, command_seq: 3, finished_seq: 3, exit_code: Some(0) };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains(r#""commandSeq":3"#));
        assert!(json.contains(r#""exitCode":0"#));
        let back: CommandStateInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back, state);
    }
}
