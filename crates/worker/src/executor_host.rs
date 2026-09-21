//! The daemon's own executor host: a `node` child process running `@coflux/executor/host`.
//!
//! Before this, the executor only existed inside Coflux.app, so a machine with no desktop app had
//! no host at all and `coflux executor run` was refused on the spot. A daemon installed from npm
//! brought its own JS runtime along; this module is what uses it. The two absolute paths come from
//! the service unit `cofluxd` wrote (see `executor_host_command`), never from `PATH` — a launchd
//! job's `PATH` is not the user's, and picking up whichever node happens to be installed is how an
//! executor becomes unreproducible.
//!
//! The wire is inherited stdio carrying JSONL: exactly the messages the device channel carries for
//! Coflux.app, minus the envelope. The child never opens a socket, never authenticates and never
//! needs a device channel, which is why the ledger's `Principal::Local` gate can stay as strict as
//! it is.
//!
//! **A hot upgrade must not kill a running task.** The child is therefore spawned *without*
//! `kill_on_drop` — the opposite of the transport helper next door (`tailcat_ipc.rs`), and
//! deliberately so. When this worker exits, the child's stdin reaches EOF, it stops taking work and
//! waits for the tasks it already has to finish before exiting; a half-written file cannot be
//! un-written, so killing mid-task is strictly worse than losing track of the run. The successor
//! worker starts a fresh host, which waits on the package's own host lock until the draining one is
//! gone, so there is never a moment with two hosts on one workspace. Re-adopting the draining host
//! is not possible and would not help: a pipe dies with its parent, and the run records live in this
//! process's memory, which a hot upgrade discards anyway.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::device::DeviceRuntime;
use coflux_protocol::logln;

/// The channel id the ledger files the daemon's own host under. It is deliberately not a real
/// device channel: nothing looks it up in the channels table, and `DeviceRuntime` routes effects
/// carrying it to this module's stdin queue instead.
pub const LOCAL_CHANNEL_ID: &str = "local-executor-host";

/// Absolute path to the node runtime, written into the service unit by `cofluxd up`.
pub const NODE_ENV: &str = "COFLUX_EXECUTOR_NODE";
/// Absolute path to `@coflux/executor/host`, likewise.
pub const ENTRY_ENV: &str = "COFLUX_EXECUTOR_ENTRY";

/// Queue depth towards the child's stdin. Frames are small and rare (one per assignment, cancel or
/// ack); a full queue means the child stopped reading, which the exit watcher handles.
const OUTBOUND_QUEUE: usize = 64;
/// Cap on one JSONL line from the child. A report carries the executor's final reply.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// Restart backoff after the child exits, and its cap.
const RESTART_MIN: Duration = Duration::from_secs(5);
const RESTART_MAX: Duration = Duration::from_secs(60);
/// A child that lived at least this long is considered to have started successfully, so the backoff
/// resets rather than compounding over days of normal operation.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

/// Host -> worker.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Outbound {
    #[serde(rename_all = "camelCase")]
    Register {
        host_id: String,
        host_epoch: u64,
        capabilities: Vec<String>,
        ready: bool,
        #[serde(default)]
        not_ready_reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Report {
        run_id: String,
        state: String,
        #[serde(default)]
        note: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        changed_files: Vec<String>,
        #[serde(default)]
        error: String,
    },
    Log {
        message: String,
    },
}

/// Worker -> host. Mirrors `ExecutorHostInbound` in `packages/executor/src/host-protocol.ts`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inbound {
    #[serde(rename_all = "camelCase")]
    Registered {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        reconcile_run_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Assign {
        run_id: String,
        prompt: String,
        write: bool,
        workspace_id: String,
        workspace_root: String,
        submitted_at: f64,
    },
    #[serde(rename_all = "camelCase")]
    Cancel { run_id: String },
    #[serde(rename_all = "camelCase")]
    Ack { run_id: String },
}

/// The paths a host needs, or `None` when this daemon cannot host one.
///
/// Three reasons to answer `None`, all of them ordinary rather than errors:
///   - no runtime was recorded in the unit (the Coflux.app bundled daemon ships Rust and Go binaries
///     and no node — the desktop hosts on those machines);
///   - the paths are not absolute (a relative path in a launchd job resolves against `/`);
///   - this is not macOS. Every tool command is wrapped in `/usr/bin/sandbox-exec`, and there is no
///     Linux equivalent yet. Registering a host without one would have the SKILL promise the calling
///     agent a kernel boundary that does not exist.
pub fn executor_host_command() -> Option<(String, String)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let node = std::env::var(NODE_ENV).ok()?;
    let entry = std::env::var(ENTRY_ENV).ok()?;
    if !node.starts_with('/') || !entry.starts_with('/') {
        logln!("[executor] {NODE_ENV}/{ENTRY_ENV} 必须是绝对路径，本机不托管 executor");
        return None;
    }
    Some((node, entry))
}

/// Start supervising the daemon's executor host. Returns immediately; everything happens in
/// background tasks. Called once at worker startup.
pub fn supervise(device: Arc<DeviceRuntime>, node: String, entry: String, home: String) {
    tokio::spawn(async move {
        let mut backoff = RESTART_MIN;
        loop {
            let started = std::time::Instant::now();
            match run_once(&device, &node, &entry, &home).await {
                Ok(status) => logln!("[executor] host 进程退出（{status}），稍后重起"),
                Err(error) => logln!("[executor] host 启动失败：{error}"),
            }
            device.executor_local_host_gone();
            if started.elapsed() >= HEALTHY_AFTER {
                backoff = RESTART_MIN;
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RESTART_MAX);
        }
    });
}

/// One child's whole life. Returns when it exits.
async fn run_once(
    device: &Arc<DeviceRuntime>,
    node: &str,
    entry: &str,
    home: &str,
) -> Result<String, String> {
    let mut child = tokio::process::Command::new(node)
        .arg(entry)
        .env("COFLUX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Deliberately **not** kill_on_drop: see the module header. A hot upgrade closes this pipe
        // and the host drains; it must not take a half-written workspace with it.
        .spawn()
        .map_err(|error| format!("{node} {entry}: {error}"))?;

    let mut stdin = child.stdin.take().ok_or("host stdin 不可用")?;
    let stdout = child.stdout.take().ok_or("host stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("host stderr 不可用")?;

    let (tx, mut rx) = mpsc::channel::<String>(OUTBOUND_QUEUE);
    device.executor_local_host_attach(tx);

    // Frames towards the child.
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // The child's own diagnostics. It has no log file; this is where they land.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                logln!("[executor] {line}");
            }
        }
    });

    let mut lines = BufReader::with_capacity(64 * 1024, stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                logln!("[executor] 读 host stdout 失败：{error}");
                break;
            }
        };
        if line.len() > MAX_LINE_BYTES {
            logln!("[executor] host 帧超过长度上限，已丢弃");
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Outbound>(&line) {
            Ok(message) => consume(device, message),
            Err(error) => logln!("[executor] host 帧无法解析：{error}"),
        }
    }

    writer.abort();
    let status = child.wait().await.map_err(|error| error.to_string())?;
    Ok(status.to_string())
}

fn consume(device: &Arc<DeviceRuntime>, message: Outbound) {
    match message {
        Outbound::Register {
            host_id,
            host_epoch,
            capabilities,
            ready,
            not_ready_reason,
        } => {
            let outcome = device.executor_local_host_register(
                &host_id,
                host_epoch,
                &capabilities,
                ready,
                &not_ready_reason,
            );
            let registered = match outcome {
                Ok(outcome) => {
                    logln!("[executor] 本机 host 已登记（epoch={host_epoch}，ready={ready}）");
                    Inbound::Registered {
                        ok: true,
                        error: None,
                        reconcile_run_ids: outcome.reconcile_run_ids,
                    }
                }
                Err(error) => {
                    logln!("[executor] 本机 host 登记被拒：{error}");
                    Inbound::Registered {
                        ok: false,
                        error: Some(error),
                        reconcile_run_ids: Vec::new(),
                    }
                }
            };
            device.executor_local_host_send(&registered);
        }
        Outbound::Report {
            run_id,
            state,
            note,
            summary,
            changed_files,
            error,
        } => device.executor_local_host_report(
            &run_id,
            &state,
            &note,
            &summary,
            changed_files,
            &error,
        ),
        Outbound::Log { message } => logln!("[executor] {message}"),
    }
}
