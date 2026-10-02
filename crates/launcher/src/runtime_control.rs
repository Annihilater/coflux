//! The desktop app's local lifecycle channel (`runtime.sock` / `runtime.lock`), served by the
//! launcher so neither flips during a runtime swap. Enabled only when the app starts the launcher;
//! independent of the centre and of the runtime. The exclusive lock on the home prevents a second
//! managed instance; the 0600 UDS admits only the same OS user.
//!
//! Ops: `status` / `stop` (end every local terminal) / `leave` (replace the launcher itself:
//! terminals stay in ptyd) / `switch` (stage-and-switch to a local runtime: an administrator
//! action, not bound by the remote release floor).
use std::fs::{File, OpenOptions, Permissions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::time::Duration;

use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::json;

use crate::manager::{ptyd_kill_all, ptyd_live_sessions, Manager, RuntimeSpec};

/// How long a starting launcher waits for an exiting predecessor to release runtime.lock.
const LOCK_WAIT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    #[serde(default, rename = "instanceId")]
    instance_id: String,
    /// `switch`: the content-addressed id of the staged runtime, its binary and its version stamp.
    #[serde(default, rename = "runtimeId")]
    runtime_id: String,
    #[serde(default)]
    cmd: String,
    #[serde(default)]
    version: String,
}

pub struct RuntimeControl {
    _lock: File,
    listener: UnixListener,
    path: String,
    instance_id: String,
    launcher_id: String,
}

impl RuntimeControl {
    pub fn bind(home: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(home)?;
        std::fs::set_permissions(home, Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(format!("{home}/runtime.lock"))?;
        // A predecessor that just acknowledged `leave` removes runtime.sock before it exits, so the
        // app can launch us while that process still holds the lock. Wait a bounded moment for it to
        // go; a process that keeps the lock is a live instance and we must not start.
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EWOULDBLOCK) || std::time::Instant::now() >= deadline {
                return Err(error);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let path = format!("{home}/runtime.sock");
        match std::fs::remove_file(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, Permissions::from_mode(0o600))?;
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        Ok(Self {
            _lock: lock,
            listener,
            path,
            instance_id: hex::encode(nonce),
            launcher_id: std::env::var("COFLUX_LAUNCHER_ID").unwrap_or_default(),
        })
    }

    pub fn serve(self, manager: Arc<Manager>, ptyd_sock: String, launcher_sock: String) {
        std::thread::spawn(move || {
            // Keep the lock alive for the whole serving loop.
            let _lock = self._lock;
            for stream in self.listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let Ok(input) = stream.try_clone() else { continue };
                let mut reader = BufReader::new(input);
                let mut line = Vec::new();
                let mut valid = false;
                while line.len() <= 4096 {
                    let Ok(buf) = reader.fill_buf() else { break };
                    if buf.is_empty() {
                        break;
                    }
                    let n = buf.iter().position(|b| *b == b'\n').map_or(buf.len(), |i| i + 1);
                    if line.len() + n > 4096 {
                        break;
                    }
                    let ended = buf[n - 1] == b'\n';
                    line.extend_from_slice(&buf[..n]);
                    reader.consume(n);
                    if ended {
                        valid = true;
                        break;
                    }
                }
                let request = valid.then(|| serde_json::from_slice::<Request>(&line).ok()).flatten();
                let Some(request) = request else {
                    let _ = writeln!(stream, "{{\"ok\":false,\"error\":\"invalid request\"}}");
                    continue;
                };
                let current = request.instance_id == self.instance_id;
                let stopping = request.op == "stop" && current;
                let leaving = request.op == "leave" && current;
                let response = if request.op == "status" {
                    let snapshot = manager.snapshot();
                    let sessions: Vec<serde_json::Value> = ptyd_live_sessions(&ptyd_sock)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|id| json!({"id": id}))
                        .collect();
                    let last_switch = snapshot.last_switch.as_ref().map(|record| {
                        json!({"runtimeId": record.id, "state": record.state_name(), "reason": record.reason})
                    });
                    json!({"ok":true,"protocol":1,"instanceId":self.instance_id,
                        "launcher":true,"launcherId":self.launcher_id,"version":crate::LAUNCHER_VERSION,
                        "runtimeId":snapshot.runtime_id,"runtimeVersion":snapshot.runtime_version,
                        "pending":snapshot.pending,"healthy":snapshot.healthy,"lastSwitch":last_switch,
                        "custody":"ptyd","sessions":sessions})
                } else if request.op == "switch" && current {
                    let spec = RuntimeSpec {
                        id: request.runtime_id.clone(),
                        version: if request.version.is_empty() { request.runtime_id.clone() } else { request.version.clone() },
                        cmd: request.cmd.clone(),
                        args: vec![],
                    };
                    match manager.register(spec).and_then(|()| manager.switch(&request.runtime_id, false)) {
                        Ok(()) => json!({"ok":true}),
                        Err(error) => json!({"ok":false,"error":error}),
                    }
                } else if stopping {
                    // End every terminal: ask ptyd to kill each shell, then stop the runtime.
                    manager.shutdown();
                    match ptyd_kill_all(&ptyd_sock) {
                        Ok(killed) => coflux_protocol::logln!("[launcher] stop: ended {killed} terminal(s)"),
                        Err(error) => coflux_protocol::logln!("[launcher] stop: ptyd unreachable, terminals not ended: {error}"),
                    }
                    json!({"ok":true})
                } else if leaving {
                    manager.shutdown();
                    json!({"ok":true})
                } else {
                    json!({"ok":false,"error":"unsupported operation or stale instance"})
                };
                let _ = writeln!(stream, "{response}");
                if stopping || leaving {
                    let _ = std::fs::remove_file(&self.path);
                    let _ = std::fs::remove_file(&launcher_sock);
                    std::process::exit(0);
                }
            }
        });
    }
}
