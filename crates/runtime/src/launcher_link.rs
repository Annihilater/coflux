//! The runtime's end of the private launcher channel (`coflux_protocol::launcher`).
//!
//! One persistent connection: the launcher ties its health bookkeeping to the connection that
//! carried the nonce echo, and a dropped connection revokes a candidate's health. Requests are
//! sequential JSON lines; a failed write or read drops the stream and the next request
//! reconnects, which the launcher sees as a new generation.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::launcher::{
    LauncherReply, RuntimeToLauncher, LAUNCHER_NONCE_ENV, LAUNCHER_SOCK_ENV, MAX_LAUNCHER_LINE_BYTES,
};
use coflux_protocol::logln;
use coflux_protocol::release::ReleaseVersion;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// `ready` is re-reported while the launcher answers `retry` (a session created while the
/// report was in flight); bounded so a launcher that never agrees cannot spin forever.
const READY_ATTEMPTS: usize = 20;

pub struct LauncherLink {
    path: String,
    nonce: String,
    stream: Mutex<Option<BufReader<UnixStream>>>,
    release_floor: Mutex<Option<ReleaseVersion>>,
}

impl LauncherLink {
    /// `None` when this runtime was not started by a launcher: it then never switches versions
    /// and advertises no launcher capability.
    pub fn from_env() -> Option<Arc<Self>> {
        let path = std::env::var(LAUNCHER_SOCK_ENV).ok().filter(|value| !value.is_empty())?;
        let nonce = std::env::var(LAUNCHER_NONCE_ENV).unwrap_or_default();
        Some(Arc::new(Self {
            path,
            nonce,
            stream: Mutex::new(None),
            release_floor: Mutex::new(None),
        }))
    }

    pub fn release_floor(&self) -> Option<ReleaseVersion> {
        self.release_floor.lock().unwrap().clone()
    }

    fn request(&self, message: &RuntimeToLauncher) -> Result<LauncherReply, String> {
        let mut slot = self.stream.lock().unwrap();
        if slot.is_none() {
            let stream = UnixStream::connect(&self.path)
                .map_err(|error| format!("connect {}: {error}", self.path))?;
            stream.set_read_timeout(Some(REQUEST_TIMEOUT)).map_err(|error| error.to_string())?;
            stream.set_write_timeout(Some(REQUEST_TIMEOUT)).map_err(|error| error.to_string())?;
            *slot = Some(BufReader::new(stream));
        }
        let reader = slot.as_mut().expect("just connected");
        let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        let outcome = (|| -> Result<LauncherReply, String> {
            reader
                .get_mut()
                .write_all(&line)
                .map_err(|error| format!("write: {error}"))?;
            let mut reply = Vec::new();
            let read = reader
                .read_until(b'\n', &mut reply)
                .map_err(|error| format!("read: {error}"))?;
            if read == 0 {
                return Err("launcher closed the channel".into());
            }
            if reply.len() > MAX_LAUNCHER_LINE_BYTES {
                return Err("launcher reply too large".into());
            }
            serde_json::from_slice::<LauncherReply>(&reply).map_err(|error| format!("reply: {error}"))
        })();
        if outcome.is_err() {
            *slot = None;
        }
        outcome
    }

    /// Report "rebuilt and serving": the nonce from the environment, the live session ids and
    /// the gateway port. Re-reported while the launcher asks for a retry.
    pub fn report_ready(
        &self,
        sessions: impl Fn() -> Vec<String>,
        gateway_port: Option<u16>,
    ) -> Result<(), String> {
        let mut last = String::from("no attempt");
        for _ in 0..READY_ATTEMPTS {
            let reply = self.request(&RuntimeToLauncher::Ready {
                nonce: self.nonce.clone(),
                sessions: sessions(),
                gateway_port,
            })?;
            if reply.ok {
                if let Some(floor) = reply.release_floor.as_deref() {
                    match ReleaseVersion::parse(floor) {
                        Ok(parsed) => *self.release_floor.lock().unwrap() = Some(parsed),
                        Err(error) => logln!("[runtime] launcher reported an unparsable release floor {floor}: {error}"),
                    }
                }
                return Ok(());
            }
            last = reply.error.unwrap_or_else(|| "launcher refused ready".into());
            if !reply.retry {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Err(last)
    }

    /// Ask the launcher to switch to `version` (installed in the store, or registered with it).
    pub fn switch(&self, version: &str) -> Result<(), String> {
        let reply = self.request(&RuntimeToLauncher::Switch { version: version.to_string() })?;
        if reply.ok {
            Ok(())
        } else {
            Err(reply.error.unwrap_or_else(|| "launcher refused the switch".into()))
        }
    }
}
