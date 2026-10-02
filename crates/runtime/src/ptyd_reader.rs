//! Pipelined ring reads for session recovery (plan 20261002-runtime-launcher-merge).
//!
//! `PtydClient::read` pays one request/reply round trip per chunk; rebuilding a session without
//! a checkpoint blob replays up to a whole 4 MiB ring and was measured at ~1.3 s per session,
//! dominated by those round trips rather than by VT parsing. ptyd answers the requests of one
//! connection strictly in order, so a client can keep several `read` requests in flight on a
//! dedicated connection and consume the replies in sequence. This uses only the v1 `read` op
//! exactly as advertised: no change to ptyd or its protocol.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use coflux_protocol::ptyd::{
    encode_ptyd_record, split_ptyd_payload, PtydMessage, PtydRequest, PtydRequestEnvelope,
    PTYD_MAX_READ_BYTES,
};
use coflux_protocol::RecordParser;

/// Read requests kept in flight; bounded well under ptyd's per-connection reply queue.
const WINDOW: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(30);

pub struct PipelinedReader {
    stream: UnixStream,
    parser: RecordParser,
    pending: VecDeque<(PtydMessage, Vec<u8>)>,
    next_id: u64,
}

impl PipelinedReader {
    /// Opens a dedicated connection and consumes the hello. `None` when ptyd cannot be reached
    /// or does not advertise `read`; callers then fall back to `PtydClient::read`.
    pub fn open(socket_path: &Path) -> Option<Self> {
        let stream = UnixStream::connect(socket_path).ok()?;
        stream.set_read_timeout(Some(TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(TIMEOUT)).ok()?;
        let mut reader = Self { stream, parser: RecordParser::new(), pending: VecDeque::new(), next_id: 0 };
        match reader.recv().ok()? {
            (PtydMessage::Hello { ops, .. }, _) if ops.iter().any(|op| op == "read") => Some(reader),
            _ => None,
        }
    }

    fn recv(&mut self) -> Result<(PtydMessage, Vec<u8>), String> {
        loop {
            if let Some(next) = self.pending.pop_front() {
                return Ok(next);
            }
            let mut buffer = [0u8; 65536];
            let count = self.stream.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                return Err("ptyd closed the read connection".into());
            }
            let mut records = Vec::new();
            self.parser
                .push(&buffer[..count], |payload| records.push(payload.to_vec()))
                .map_err(|error| error.to_string())?;
            for payload in records {
                let (header, raw) = split_ptyd_payload(&payload).ok_or("malformed ptyd record")?;
                let message: PtydMessage = serde_json::from_slice(header).map_err(|error| error.to_string())?;
                self.pending.push_back((message, raw.to_vec()));
            }
        }
    }

    fn send_read(&mut self, session_id: &str, from_offset: u64, max_bytes: u32) -> Result<u64, String> {
        self.next_id += 1;
        let id = self.next_id;
        let request = PtydRequest::Read { session_id: session_id.to_string(), from_offset, max_bytes };
        let record = encode_ptyd_record(&PtydRequestEnvelope { id, request }, &[]).map_err(|error| error.to_string())?;
        self.stream.write_all(&record).map_err(|error| error.to_string())?;
        Ok(id)
    }

    /// Reads `[from, to)` of a session's ring contiguously, feeding every chunk to `sink` in
    /// order. Up to `WINDOW` requests stay in flight. Any gap, error or short chunk aborts with
    /// an error; the caller then treats the session as degraded.
    pub fn read_range(
        &mut self,
        session_id: &str,
        from: u64,
        to: u64,
        mut sink: impl FnMut(&[u8]),
    ) -> Result<(), String> {
        let mut next_request = from;
        let mut expected_reply = from;
        let mut in_flight: VecDeque<(u64, u64, u32)> = VecDeque::new();
        while expected_reply < to {
            while in_flight.len() < WINDOW && next_request < to {
                let want = (to - next_request).min(u64::from(PTYD_MAX_READ_BYTES)) as u32;
                let id = self.send_read(session_id, next_request, want)?;
                in_flight.push_back((id, next_request, want));
                next_request += u64::from(want);
            }
            let (id, offset, want) = in_flight.pop_front().expect("window is non-empty while bytes remain");
            loop {
                let (message, raw) = self.recv()?;
                match message {
                    PtydMessage::Data { id: reply_id, from_offset, .. } if reply_id == id => {
                        if from_offset != offset || raw.len() != want as usize {
                            return Err(format!(
                                "ring read returned offset {from_offset} len {} for request offset {offset} len {want}",
                                raw.len()
                            ));
                        }
                        sink(&raw);
                        expected_reply = offset + u64::from(want);
                        break;
                    }
                    PtydMessage::Error { id: reply_id, code, message, .. } if reply_id == id => {
                        return Err(format!("ptyd refused read ({code}): {message}"));
                    }
                    _ => continue,
                }
            }
        }
        Ok(())
    }
}
