//! coflux-launcher: a small, rarely changing process that owns the runtime version pointer,
//! spawns `coflux-runtime`, decides probation / commit, rolls back a crash-looping or
//! pseudo-healthy candidate, falls back to the builtin runtime, and serves `runtime.sock` /
//! `runtime.lock` for the desktop app (plan 20261002-runtime-launcher-merge).
//!
//! Everything that changes per release (manifest and statement formats, sessiond, PTY environment
//! assembly, download and verification) lives in the runtime. PTYs live in `coflux-ptyd`; the
//! launcher never opens one and never starts ptyd. It only reads ptyd's session list to check that
//! a candidate took every live session over, and asks ptyd to end shells on the desktop's `stop`.
//!
//! SIGTERM = leave: kill the runtime and exit; shells stay in ptyd. `cofluxd restart` and a
//! launcher self-update on the desktop go through this path.

mod manager;
mod runtime_control;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use coflux_protocol::launcher::{LauncherReply, RuntimeToLauncher, LAUNCHER_SOCK_ENV, LAUNCHER_SOCK_NAME, MAX_LAUNCHER_LINE_BYTES};
use coflux_protocol::logln;
use coflux_protocol::ptyd::{PTYD_SOCK_ENV, PTYD_SOCK_NAME};
use coflux_protocol::release::ReleaseVersion;

use manager::{Manager, RuntimeSpec};

/// The launcher's own version, injected at build time from the release tag; `dev` locally.
/// Reported to the centre by the runtime as `supervisor_version`; the builtin runtime shipped
/// next to this binary carries the same tag and is identified by it.
const LAUNCHER_VERSION: &str = match option_env!("COFLUX_RELEASE_VERSION") {
    Some(v) => v,
    None => "dev",
};

/// `coflux-runtime` next to this binary (packaged and installed together).
fn sibling_runtime() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("coflux-runtime").to_string_lossy().into_owned()))
        .unwrap_or_default()
}

fn main() {
    let home = std::env::var("COFLUX_HOME")
        .unwrap_or_else(|_| format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let _ = std::fs::create_dir_all(&home);
    // The desktop app owns `runtime.sock`; it takes the exclusive lock first so an app update can
    // only re-attach to the running instance.
    let desktop = if std::env::var("COFLUX_RUNTIME_CONTROL").as_deref() == Ok("1") {
        Some(runtime_control::RuntimeControl::bind(&home).unwrap_or_else(|error| {
            eprintln!("无法启动 Coflux 本机运行组件：{error}");
            std::process::exit(1);
        }))
    } else {
        None
    };
    let _ = std::fs::write(format!("{home}/launcher-version"), format!("{LAUNCHER_VERSION}\n"));
    let ptyd_sock = std::env::var(PTYD_SOCK_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{home}/{PTYD_SOCK_NAME}"));
    let launcher_sock = std::env::var(LAUNCHER_SOCK_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{home}/{LAUNCHER_SOCK_NAME}"));
    // The health gate includes the runtime connecting to the centre and binding its gateway; the
    // default covers the runtime's 15 s connect timeout plus an ordinary handshake.
    let probation_ms: u64 = std::env::var("COFLUX_RUNTIME_PROBATION_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30_000);

    let runtime_cmd = std::env::var("COFLUX_RUNTIME_CMD")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(sibling_runtime);
    if runtime_cmd.is_empty() {
        logln!("[launcher] no runtime binary (no sibling coflux-runtime and COFLUX_RUNTIME_CMD unset)");
        std::process::exit(1);
    }
    let runtime_args: Vec<String> = std::env::var("COFLUX_RUNTIME_ARGS")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // A release builds launcher and builtin runtime together, so the compiled-in strict SemVer is
    // the builtin's identity and the anti-rollback starting point; dev/test keep "builtin". The
    // desktop names the staged directory it started us from through COFLUX_RUNTIME_ID.
    let builtin_version = if ReleaseVersion::parse(LAUNCHER_VERSION).is_ok() {
        LAUNCHER_VERSION.to_string()
    } else {
        "builtin".to_string()
    };
    let builtin_id = std::env::var("COFLUX_RUNTIME_ID")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| builtin_version.clone());
    let builtin = RuntimeSpec { id: builtin_id, version: builtin_version, cmd: runtime_cmd, args: runtime_args };

    // Extra registered versions (tests / operators).
    let mut known: HashMap<String, RuntimeSpec> = HashMap::new();
    if let Ok(raw) = std::env::var("COFLUX_RUNTIME_SPECS") {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) {
            for (id, v) in map {
                let cmd = v.get("cmd").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = v
                    .get("args")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if !cmd.is_empty() {
                    known.insert(id.clone(), RuntimeSpec { version: id.clone(), id, cmd, args });
                }
            }
        }
    }

    // Bind the private channel before the first spawn: the runtime connects to it at start.
    let _ = std::fs::remove_file(&launcher_sock);
    let listener = match UnixListener::bind(&launcher_sock) {
        Ok(l) => l,
        Err(e) => {
            logln!("[launcher] bind {launcher_sock}: {e}");
            std::process::exit(1);
        }
    };
    if let Err(error) = std::fs::set_permissions(&launcher_sock, std::fs::Permissions::from_mode(0o600)) {
        logln!("[launcher] chmod {launcher_sock}: {error}");
        let _ = std::fs::remove_file(&launcher_sock);
        std::process::exit(1);
    }

    let manager = Manager::new(
        builtin,
        known,
        home.clone(),
        Duration::from_millis(probation_ms),
        LAUNCHER_VERSION.to_string(),
        launcher_sock.clone(),
        ptyd_sock.clone(),
    );
    manager.start();
    if let Some(desktop) = desktop {
        desktop.serve(manager.clone(), ptyd_sock.clone(), launcher_sock.clone());
    }

    {
        let manager = manager.clone();
        let launcher_sock = launcher_sock.clone();
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT]) {
            thread::spawn(move || {
                if signals.forever().next().is_some() {
                    logln!("[launcher] shutdown (leave: terminals stay in ptyd)");
                    manager.shutdown();
                    let _ = std::fs::remove_file(&launcher_sock);
                    std::process::exit(0);
                }
            });
        }
    }
    logln!("[launcher] version={LAUNCHER_VERSION} listening {launcher_sock}");

    let generations = AtomicU64::new(0);
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        let generation = generations.fetch_add(1, Ordering::SeqCst) + 1;
        manager.runtime_connected(generation);
        let manager = manager.clone();
        thread::spawn(move || {
            serve_runtime(stream, &manager, generation);
            manager.runtime_disconnected(generation);
        });
    }
}

/// One runtime connection on the private channel: JSON lines in, one reply line per request.
fn serve_runtime(stream: UnixStream, manager: &Arc<Manager>, generation: u64) {
    let Ok(mut writer) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.len() > MAX_LAUNCHER_LINE_BYTES {
            logln!("[launcher] oversized request on generation={generation}; closing");
            break;
        }
        let reply = match serde_json::from_slice::<RuntimeToLauncher>(&line) {
            Ok(RuntimeToLauncher::Ready { nonce, sessions, gateway_port }) => {
                match manager.runtime_ready(generation, &nonce, &sessions, gateway_port) {
                    Ok(floor) => LauncherReply { ok: true, error: None, release_floor: floor, retry: false },
                    Err(refusal) => LauncherReply { ok: false, error: Some(refusal.message), release_floor: None, retry: refusal.retry },
                }
            }
            Ok(RuntimeToLauncher::Switch { version }) => match manager.switch(&version, true) {
                Ok(()) => LauncherReply { ok: true, error: None, release_floor: None, retry: false },
                Err(error) => {
                    logln!("[launcher] switch refused version={version}: {error}");
                    LauncherReply { ok: false, error: Some(error), release_floor: None, retry: false }
                }
            },
            Err(error) => LauncherReply { ok: false, error: Some(format!("invalid request: {error}")), release_floor: None, retry: false },
        };
        let Ok(mut bytes) = serde_json::to_vec(&reply) else { break };
        bytes.push(b'\n');
        if writer.write_all(&bytes).is_err() {
            break;
        }
    }
}
