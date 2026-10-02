//! Runtime lifecycle: spawn, monitor, restart, version switch with probation and rollback,
//! builtin fallback. One monitor thread polls `try_wait` every 100 ms (keeping the `Child` here
//! so it can be killed).
//!
//! Probation is decided from what the launcher checks itself (plan
//! 20261002-runtime-launcher-merge): the candidate's echo of the per-spawn nonce, ptyd's own
//! session list against the set the candidate reports as rebuilt, and a TCP connect to the
//! gateway port it reports. A self-reported "ready" alone never commits; alive-but-silent, a
//! wrong nonce, a session not taken over, a gateway that does not listen, or a crash past the
//! budget all end in rollback to the previous version (or the builtin).

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use coflux_protocol::launcher::{
    LAUNCHER_ENV, LAUNCHER_NONCE_ENV, LAUNCHER_SOCK_ENV, LAUNCHER_VERSION_ENV, RUNTIME_VERSION_ENV,
};
use coflux_protocol::logln;
use coflux_protocol::release::{validate_version, ReleaseVersion, MAX_VERSION_BYTES};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

const MAX_PENDING_CRASHES: u32 = 2;
/// Version store under `COFLUX_HOME` (the runtime installs releases here).
const RUNTIME_STORE_DIR: &str = "runtimes";
const RUNTIME_BINARY: &str = "coflux-runtime";
const ACTIVE_MARKER: &str = "runtime.active";
const RELEASE_FLOOR_MARKER: &str = "runtime.release-floor";
const GATEWAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A runnable runtime. `id` is the registry key and what the pointer stores (a release tag, a
/// desktop content-addressed runtime id, or a test registry name); `version` is what the runtime
/// is told it runs as and reports to the centre.
#[derive(Clone, Debug)]
pub struct RuntimeSpec {
    pub id: String,
    pub version: String,
    pub cmd: String,
    pub args: Vec<String>,
}

/// Why `ready` was not accepted.
pub struct HealthRefusal {
    pub message: String,
    /// The condition may clear on its own (a session created while the report was in flight).
    pub retry: bool,
}

/// Outcome of the most recent switch, reported on `runtime.sock` so the desktop decides from
/// launcher state instead of catching a candidate in flight between two polls. Keyed by the
/// candidate's id and reset to `Pending` the moment a new switch to that id begins, so a stale
/// outcome from an earlier attempt is never read as this one's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwitchState {
    Pending,
    Healthy,
    Committed,
    RolledBack,
}

#[derive(Clone, Debug)]
pub struct SwitchRecord {
    pub id: String,
    pub state: SwitchState,
    pub reason: Option<String>,
}

impl SwitchRecord {
    pub fn state_name(&self) -> &'static str {
        match self.state {
            SwitchState::Pending => "pending",
            SwitchState::Healthy => "healthy",
            SwitchState::Committed => "committed",
            SwitchState::RolledBack => "rolledBack",
        }
    }
}

/// What `runtime.sock` reports.
pub struct Snapshot {
    pub runtime_id: String,
    pub runtime_version: String,
    pub pending: bool,
    pub healthy: bool,
    pub last_switch: Option<SwitchRecord>,
}

struct State {
    known: HashMap<String, RuntimeSpec>,
    active: RuntimeSpec,
    pending: Option<RuntimeSpec>,
    /// Verified remote release under probation; enters the floor only on commit.
    pending_release: Option<ReleaseVersion>,
    /// Monotonic high-water mark of committed signed releases; remote candidates at or below
    /// it (strict SemVer precedence) are refused. Administrator switches are not bound by it.
    committed_release_floor: Option<ReleaseVersion>,
    /// false: the floor marker was unreadable or could not be persisted; remote switches fail
    /// closed until a commit persists it.
    release_floor_durable: bool,
    /// Only during start-up recovery: a persisted active that fails re-observation falls back
    /// to the builtin, not to a retry of the same file.
    pending_fallback: Option<RuntimeSpec>,
    child: Option<Child>,
    running_id: String,
    restarts: u32,
    pending_crashes: u32,
    /// The current pending process passed every launcher-side check.
    pending_healthy: bool,
    /// The channel connection accepted after the pending spawn and still current; an old
    /// process's connection can never vouch for the candidate.
    pending_connection_generation: Option<u64>,
    /// Nonce handed to the most recent spawn through the environment.
    spawn_nonce: String,
    pending_termination_requested: bool,
    started_at: Instant,
    next_spawn_at: Instant,
    shutting_down: bool,
    last_switch: Option<SwitchRecord>,
}

pub struct Manager {
    home: String,
    probation: Duration,
    launcher_version: String,
    launcher_sock: String,
    ptyd_sock: String,
    state: Mutex<State>,
}

impl Manager {
    pub fn new(
        builtin: RuntimeSpec,
        mut known: HashMap<String, RuntimeSpec>,
        home: String,
        probation: Duration,
        launcher_version: String,
        launcher_sock: String,
        ptyd_sock: String,
    ) -> Arc<Self> {
        known.insert(builtin.id.clone(), builtin.clone());
        let recovered = Self::recover_active(&home, &builtin, &known);
        // An update replaces the launcher and its builtin runtime in place but leaves the old
        // pointer behind: a newer builtin release must win, or the floor advanced by the builtin
        // would forever refuse the version actually running.
        let recovered = match ReleaseVersion::parse(&builtin.version) {
            Ok(builtin_release) => recovered.filter(|spec| {
                let keep = ReleaseVersion::parse(&spec.version)
                    .map(|active_release| active_release.is_newer_than(&builtin_release))
                    .unwrap_or(true);
                if !keep {
                    logln!(
                        "[launcher] builtin runtime version={} is not older than the persisted active={}; using the builtin",
                        builtin.version, spec.id
                    );
                }
                keep
            }),
            Err(_) => recovered,
        };
        if let Some(spec) = &recovered {
            logln!("[launcher] recovered committed runtime id={}, re-observing before use", spec.id);
            known.insert(spec.id.clone(), spec.clone());
        }
        let active = recovered.clone().unwrap_or_else(|| builtin.clone());
        let pending_fallback = recovered.as_ref().map(|_| builtin.clone());
        let (mut committed_release_floor, mut release_floor_durable) = match load_release_floor(&home) {
            Ok(floor) => (floor, true),
            Err(error) => {
                logln!("[launcher] release floor unreadable, remote switches fail closed; rebuilding from builtin/active: {error}");
                (None, false)
            }
        };
        for version in [&builtin.version, &active.version] {
            if let Ok(candidate) = ReleaseVersion::parse(version) {
                committed_release_floor = Some(match committed_release_floor.take() {
                    Some(current) => current.max(candidate),
                    None => candidate,
                });
            }
        }
        if let Some(floor) = &committed_release_floor {
            match persist_marker(&home, RELEASE_FLOOR_MARKER, floor.as_str()) {
                Ok(()) => release_floor_durable = true,
                Err(error) => {
                    release_floor_durable = false;
                    logln!("[launcher] could not persist release floor={}; remote switches disabled: {error}", floor.as_str());
                }
            }
        }
        let now = Instant::now();
        Arc::new(Self {
            home,
            probation,
            launcher_version,
            launcher_sock,
            ptyd_sock,
            state: Mutex::new(State {
                known,
                running_id: active.id.clone(),
                active,
                // A persisted active is re-observed as pending first: a damaged or pseudo-healthy
                // file falls back to the builtin instead of leaving the device offline.
                pending: recovered,
                pending_release: None,
                committed_release_floor,
                release_floor_durable,
                pending_fallback,
                child: None,
                restarts: 0,
                pending_crashes: 0,
                pending_healthy: false,
                pending_connection_generation: None,
                spawn_nonce: String::new(),
                pending_termination_requested: false,
                started_at: now,
                next_spawn_at: now,
                shutting_down: false,
                last_switch: None,
            }),
        })
    }

    fn record_switch(st: &mut State, id: &str, state: SwitchState, reason: Option<String>) {
        st.last_switch = Some(SwitchRecord { id: id.to_string(), state, reason });
    }

    fn recover_active(home: &str, builtin: &RuntimeSpec, known: &HashMap<String, RuntimeSpec>) -> Option<RuntimeSpec> {
        let marker = Path::new(home).join(ACTIVE_MARKER);
        let metadata = match std::fs::symlink_metadata(&marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                logln!("[launcher] {ACTIVE_MARKER} unreadable, falling back to builtin: {error}");
                return None;
            }
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 {
            logln!("[launcher] {ACTIVE_MARKER} is not a safe regular file, falling back to builtin");
            return None;
        }
        let id = match std::fs::read_to_string(&marker) {
            Ok(value) => value.trim().to_string(),
            Err(error) => {
                logln!("[launcher] {ACTIVE_MARKER} unreadable, falling back to builtin: {error}");
                return None;
            }
        };
        if id == builtin.id {
            return None;
        }
        if let Some(spec) = known.get(&id) {
            return Some(spec.clone());
        }
        match installed_runtime(home, &id) {
            Ok(spec) => Some(spec),
            Err(error) => {
                logln!("[launcher] {ACTIVE_MARKER}={id} is not recoverable, falling back to builtin: {error}");
                None
            }
        }
    }

    fn write_active(&self, id: &str) -> bool {
        match persist_marker(&self.home, ACTIVE_MARKER, id) {
            Ok(()) => true,
            Err(error) => {
                logln!("[launcher] could not persist {ACTIVE_MARKER}={id}: {error}");
                false
            }
        }
    }

    fn ensure_release_is_newer(st: &State, candidate: &ReleaseVersion) -> Result<(), String> {
        if !st.release_floor_durable {
            return Err("release floor is not durable; remote switches fail closed".to_string());
        }
        if let Some(floor) = &st.committed_release_floor {
            if !candidate.is_newer_than(floor) {
                return Err(format!(
                    "refusing downgrade/replay of release {}: committed floor is {}",
                    candidate.as_str(),
                    floor.as_str()
                ));
            }
        }
        if let Some(pending) = &st.pending_release {
            if !candidate.is_newer_than(pending) {
                return Err(format!(
                    "refusing downgrade/replay of release {}: observing pending {}",
                    candidate.as_str(),
                    pending.as_str()
                ));
            }
        }
        Ok(())
    }

    fn current_spec(st: &State) -> RuntimeSpec {
        st.pending.clone().unwrap_or_else(|| st.active.clone())
    }

    fn pending_running(st: &State) -> bool {
        st.child.is_some() && matches!(&st.pending, Some(p) if p.id == st.running_id)
    }

    fn try_commit_pending(&self, st: &mut State) {
        if !st.pending_healthy {
            return;
        }
        let Some(pending) = st.pending.clone() else {
            return;
        };
        let pending_release = st.pending_release.clone();
        // Persist active first, then the floor; a crash in between rebuilds the floor from the
        // safely recovered active at the next start. A floor that cannot be persisted keeps the
        // candidate pending (retried every 100 ms) and disables remote switches meanwhile.
        let active_persisted = self.write_active(&pending.id);
        let floor_persisted = active_persisted
            && pending_release
                .as_ref()
                .is_none_or(|release| match persist_marker(&self.home, RELEASE_FLOOR_MARKER, release.as_str()) {
                    Ok(()) => true,
                    Err(error) => {
                        logln!("[launcher] could not persist {RELEASE_FLOOR_MARKER}={}: {error}", release.as_str());
                        false
                    }
                });
        if active_persisted && !floor_persisted {
            st.release_floor_durable = false;
        }
        if !active_persisted || !floor_persisted {
            return;
        }
        st.pending = None;
        st.pending_release = None;
        st.pending_fallback = None;
        if let Some(release) = pending_release {
            st.committed_release_floor = Some(
                st.committed_release_floor
                    .take()
                    .map_or(release.clone(), |floor| floor.max(release)),
            );
            st.release_floor_durable = true;
        }
        logln!("[launcher] runtime switch committed id={} version={}", pending.id, pending.version);
        Self::record_switch(st, &pending.id, SwitchState::Committed, None);
        st.active = pending;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_termination_requested = false;
        st.restarts = 0;
    }

    fn rollback_pending(&self, st: &mut State, from: &str, reason: &str) {
        let fallback = st.pending_fallback.take().unwrap_or_else(|| st.active.clone());
        logln!("[launcher] runtime rollback from={from} to={}: {reason}", fallback.id);
        Self::record_switch(st, from, SwitchState::RolledBack, Some(reason.to_string()));
        st.pending = None;
        st.pending_release = None;
        st.active = fallback;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_termination_requested = false;
        self.write_active(&st.active.id);
    }

    fn spawn(&self, st: &mut State) {
        let spec = Self::current_spec(st);
        let is_pending = matches!(&st.pending, Some(p) if p.id == spec.id);
        if is_pending {
            // Every process must pass the checks itself; the previous attempt's health is void.
            st.pending_healthy = false;
            st.pending_connection_generation = None;
            st.pending_termination_requested = false;
        }
        let mut nonce = [0u8; 16];
        OsRng.fill_bytes(&mut nonce);
        st.spawn_nonce = hex::encode(nonce);
        let mut cmd = Command::new(&spec.cmd);
        cmd.args(&spec.args)
            // The launcher's own environment (COFLUX_HOME, TMPDIR, the plugin dir, the screen
            // helper, the desktop marker, a test public key) is inherited by every runtime,
            // centre-pushed ones from the store included.
            .env(LAUNCHER_SOCK_ENV, &self.launcher_sock)
            .env(LAUNCHER_NONCE_ENV, &st.spawn_nonce)
            .env(LAUNCHER_ENV, "1")
            .env("COFLUX_TRANSPORT_PAIR", "1")
            .env(
                "COFLUX_TRANSPORT_REQUIRED",
                if Path::new(&spec.cmd)
                    .parent()
                    .is_some_and(|dir| dir.join("transport-pair.json").exists())
                {
                    "1"
                } else {
                    "0"
                },
            )
            .env(
                "COFLUX_TRANSPORT_PROBATION_MS",
                if is_pending { self.probation.as_millis().to_string() } else { "0".into() },
            )
            .env(RUNTIME_VERSION_ENV, &spec.version)
            .env(LAUNCHER_VERSION_ENV, &self.launcher_version)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match cmd.spawn() {
            Ok(child) => {
                st.running_id = spec.id.clone();
                st.started_at = Instant::now();
                st.child = Some(child);
                logln!("[launcher] runtime spawned id={} version={}", spec.id, spec.version);
            }
            Err(e) => {
                logln!("[launcher] runtime spawn error id={}: {e}", spec.id);
                // A candidate that cannot even start counts against the crash budget, or the
                // launcher would retry the same broken file forever.
                if is_pending {
                    st.pending_crashes += 1;
                    if st.pending_crashes >= MAX_PENDING_CRASHES {
                        logln!("[launcher] pending runtime cannot start id={}", spec.id);
                        self.rollback_pending(st, &spec.id, &format!("cannot start: {e}"));
                    }
                }
                st.next_spawn_at = Instant::now() + Duration::from_millis(500);
            }
        }
    }

    /// The monitor loop (own thread).
    pub fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        thread::spawn(move || {
            {
                let mut st = this.state.lock().unwrap();
                // A recovered version sits in pending; the marker keeps pointing at it and only
                // flips back to the builtin when re-observation fails.
                let id = Self::current_spec(&st).id;
                this.write_active(&id);
                this.spawn(&mut st);
            }
            loop {
                thread::sleep(Duration::from_millis(100));
                let mut st = this.state.lock().unwrap();
                if st.shutting_down {
                    break;
                }
                let exited = matches!(st.child.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_))));
                if exited {
                    st.child = None;
                    let exited_id = st.running_id.clone();
                    let is_pending = matches!(&st.pending, Some(p) if p.id == exited_id);
                    if is_pending {
                        st.pending_crashes += 1;
                        let crashes = st.pending_crashes;
                        logln!("[launcher] pending runtime exited id={exited_id} crashes={crashes}");
                        if crashes >= MAX_PENDING_CRASHES {
                            logln!("[launcher] pending runtime crash-looping id={exited_id}");
                            let reason = match st.last_switch.as_ref().and_then(|record| record.reason.clone()) {
                                Some(refusal) if st.pending_termination_requested => refusal,
                                _ => "exited repeatedly during probation".to_string(),
                            };
                            this.rollback_pending(&mut st, &exited_id, &reason);
                        }
                        st.next_spawn_at = Instant::now() + Duration::from_millis(300);
                    } else {
                        if st.started_at.elapsed() > Duration::from_secs(10) {
                            st.restarts = 0;
                        }
                        st.restarts += 1;
                        let delay = std::cmp::min(5000, 200 * st.restarts as u64);
                        logln!("[launcher] runtime exited id={exited_id}, restarting in {delay}ms");
                        st.next_spawn_at = Instant::now() + Duration::from_millis(delay);
                    }
                }

                // Probation: a candidate that stayed alive but never passed the checks within the
                // window is terminated and counted against the crash budget.
                if Self::pending_running(&st) && st.started_at.elapsed() >= this.probation {
                    if st.pending_healthy {
                        this.try_commit_pending(&mut st);
                    } else if !st.pending_termination_requested {
                        logln!(
                            "[launcher] pending runtime did not pass health checks within probation, terminating id={}",
                            st.running_id
                        );
                        if let Some(child) = st.child.as_mut() {
                            let _ = child.kill();
                        }
                        st.pending_termination_requested = true;
                        // Remember why, so the eventual rollback reports the health refusal
                        // rather than a bare crash count.
                        let running_id = st.running_id.clone();
                        if let Some(record) = st.last_switch.as_mut().filter(|record| record.id == running_id) {
                            record.reason.get_or_insert_with(|| "did not pass the launcher's health checks within probation".to_string());
                        }
                    }
                }

                if st.child.is_none() && !st.shutting_down && Instant::now() >= st.next_spawn_at {
                    this.spawn(&mut st);
                }
            }
        });
    }

    /// A new connection on the private channel. Only a connection accepted after the pending
    /// spawn can carry its health signal.
    pub fn runtime_connected(&self, generation: u64) {
        let mut st = self.state.lock().unwrap();
        if Self::pending_running(&st) {
            st.pending_connection_generation = Some(generation);
            st.pending_healthy = false;
        }
    }

    /// Losing the connection during probation revokes health; the process must report again.
    pub fn runtime_disconnected(&self, generation: u64) {
        let mut st = self.state.lock().unwrap();
        if st.pending_connection_generation == Some(generation) {
            st.pending_connection_generation = None;
            st.pending_healthy = false;
        }
    }

    /// Log a health refusal and keep it on the pending switch record, where it becomes the
    /// rollback reason. Takes the state lock: callers must not hold it.
    fn note_refusal(&self, refusal: &HealthRefusal) {
        logln!("[launcher] ready refused: {}", refusal.message);
        let mut st = self.state.lock().unwrap();
        if let Some(record) = st.last_switch.as_mut().filter(|record| record.state == SwitchState::Pending) {
            record.reason = Some(refusal.message.clone());
        }
    }

    /// `ready` from the runtime on connection `generation`. For the active runtime this only
    /// returns the floor; for a pending one the launcher verifies nonce, ptyd takeover and the
    /// gateway port itself before it counts the process healthy.
    pub fn runtime_ready(
        &self,
        generation: u64,
        nonce: &str,
        sessions: &[String],
        gateway_port: Option<u16>,
    ) -> Result<Option<String>, HealthRefusal> {
        // Refusals are decided first and recorded afterwards: `note_refusal` takes the state
        // lock, so it must never run from a scope that already holds it (std's Mutex is not
        // reentrant; a stale connection's `ready` would otherwise wedge the launcher for good).
        let refuse = |message: String, retry: bool| -> Result<Option<String>, HealthRefusal> {
            let refusal = HealthRefusal { message, retry };
            self.note_refusal(&refusal);
            Err(refusal)
        };
        // Decide under the guard, then drop it before recording anything.
        let decision: Result<(String, Option<String>), Result<Option<String>, HealthRefusal>> = {
            let st = self.state.lock().unwrap();
            let floor = st.committed_release_floor.as_ref().map(|f| f.as_str().to_string());
            if !Self::pending_running(&st) {
                Err(Ok(floor))
            } else if st.pending_connection_generation != Some(generation) {
                Err(Err(HealthRefusal { message: "ready arrived on a connection that is not the candidate's".into(), retry: false }))
            } else if st.pending_termination_requested {
                Err(Err(HealthRefusal { message: "candidate is being terminated".into(), retry: false }))
            } else {
                Ok((st.spawn_nonce.clone(), floor))
            }
        };
        let (expected_nonce, floor) = match decision {
            Ok(values) => values,
            Err(Ok(floor)) => return Ok(floor),
            Err(Err(refusal)) => return refuse(refusal.message, refusal.retry),
        };
        if nonce.is_empty() || nonce != expected_nonce {
            return refuse("nonce does not match this spawn".into(), false);
        }
        // Independent check (a): every live session ptyd holds is among the reported ones.
        let live = match ptyd_live_sessions(&self.ptyd_sock) {
            Ok(live) => live,
            Err(error) => return refuse(format!("ptyd session list unavailable: {error}"), true),
        };
        let reported: HashSet<&str> = sessions.iter().map(String::as_str).collect();
        let missing: Vec<&String> = live.iter().filter(|id| !reported.contains(id.as_str())).collect();
        if !missing.is_empty() {
            return refuse(format!("{} live ptyd session(s) not taken over: {:?}", missing.len(), missing), true);
        }
        // Independent check (b): the gateway port accepts a connection.
        let Some(port) = gateway_port else {
            return refuse("runtime reports no gateway port".into(), false);
        };
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if let Err(error) = std::net::TcpStream::connect_timeout(&address, GATEWAY_CONNECT_TIMEOUT) {
            return refuse(format!("gateway port {port} refused a connection: {error}"), true);
        }
        let mut st = self.state.lock().unwrap();
        if Self::pending_running(&st)
            && st.pending_connection_generation == Some(generation)
            && st.spawn_nonce == nonce
            && !st.pending_termination_requested
        {
            st.pending_healthy = true;
            let id = st.running_id.clone();
            Self::record_switch(&mut st, &id, SwitchState::Healthy, None);
            logln!(
                "[launcher] pending runtime healthy id={id} generation={generation} sessions={} gateway={port}",
                live.len()
            );
        }
        Ok(floor)
    }

    /// Switch to `id`. `remote` = the request arrived over the private channel: a SemVer version
    /// is then bound by the release floor and a successful probation advances it. Administrator
    /// switches (`runtime.sock`) register a spec first (`register`) and are never floor-bound.
    pub fn switch(&self, id: &str, remote: bool) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        let spec = match st.known.get(id) {
            Some(spec) => spec.clone(),
            None if remote => installed_runtime(&self.home, id)?,
            None => return Err(format!("unknown runtime {id}")),
        };
        let release = match (remote, ReleaseVersion::parse(&spec.version)) {
            (true, Ok(release)) => {
                Self::ensure_release_is_newer(&st, &release)?;
                Some(release)
            }
            (true, Err(_)) if !st.known.contains_key(id) => {
                return Err(format!("remote switch to a non-release version {id} is not allowed"));
            }
            _ => None,
        };
        st.known.insert(spec.id.clone(), spec.clone());
        self.begin_switch(&mut st, spec, release)
    }

    /// Register a locally known runtime (desktop staging directory, test registry).
    pub fn register(&self, spec: RuntimeSpec) -> Result<(), String> {
        validate_version(&spec.id)?;
        let metadata = std::fs::symlink_metadata(&spec.cmd).map_err(|error| format!("{}: {error}", spec.cmd))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!("{} is not an executable regular file", spec.cmd));
        }
        self.state.lock().unwrap().known.insert(spec.id.clone(), spec);
        Ok(())
    }

    fn begin_switch(&self, st: &mut State, spec: RuntimeSpec, release: Option<ReleaseVersion>) -> Result<(), String> {
        if st.shutting_down {
            return Err("launcher is shutting down".into());
        }
        if spec.id == st.active.id && st.pending.is_none() {
            logln!("[launcher] already on runtime {}", spec.id);
            return Ok(());
        }
        if st.pending.as_ref().is_some_and(|pending| pending.id == spec.id) {
            logln!("[launcher] already observing runtime {}", spec.id);
            return Ok(());
        }
        // A recovered runtime that has not passed probation never becomes the new candidate's
        // fallback: the fallback stays the builtin.
        logln!("[launcher] switching runtime from={} to={}", st.active.id, spec.id);
        Self::record_switch(st, &spec.id, SwitchState::Pending, None);
        st.pending = Some(spec);
        st.pending_release = release;
        st.pending_crashes = 0;
        st.pending_healthy = false;
        st.pending_connection_generation = None;
        st.pending_termination_requested = false;
        if let Some(child) = st.child.as_mut() {
            let _ = child.kill(); // the monitor respawns from current_spec() (= pending)
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let st = self.state.lock().unwrap();
        let spec = Self::current_spec(&st);
        Snapshot {
            runtime_id: spec.id,
            runtime_version: spec.version,
            pending: st.pending.is_some(),
            healthy: st.pending.is_none() || st.pending_healthy,
            last_switch: st.last_switch.clone(),
        }
    }

    /// Kill the runtime and stop respawning (leave: terminals stay in ptyd).
    pub fn shutdown(&self) {
        let mut st = self.state.lock().unwrap();
        st.shutting_down = true;
        if let Some(child) = st.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// ptyd's own view of its live sessions (read-only `list`).
pub fn ptyd_live_sessions(socket_path: &str) -> Result<Vec<String>, String> {
    let client = coflux_ptyd::PtydClient::connect(socket_path).map_err(|error| error.to_string())?;
    let infos = client.list().map_err(|error| error.to_string())?;
    Ok(infos
        .into_iter()
        .filter(|info| info.exit_code.is_none() && info.pid > 0)
        .map(|info| info.session_id)
        .collect())
}

/// End every shell ptyd holds (the `stop` op): this, not a runtime exit, is what ends terminals.
pub fn ptyd_kill_all(socket_path: &str) -> Result<usize, String> {
    let client = coflux_ptyd::PtydClient::connect(socket_path).map_err(|error| error.to_string())?;
    let infos = client.list().map_err(|error| error.to_string())?;
    let mut killed = 0;
    for info in infos {
        if info.exit_code.is_none() && client.kill(&info.session_id).is_ok() {
            killed += 1;
        }
    }
    Ok(killed)
}

fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

/// Markers are written as a same-directory temporary file + fsync + rename, so a crash never
/// leaves an empty pointer.
fn persist_marker(home: &str, name: &str, value: &str) -> Result<(), String> {
    let home = Path::new(home);
    let final_path = home.join(name);
    let mut temp_path = PathBuf::new();
    let mut file = None;
    for _ in 0..32 {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        temp_path = home.join(format!(".{name}.{}.{id}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp_path) {
            Ok(created) => {
                file = Some(created);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create {}: {error}", temp_path.display())),
        }
    }
    let Some(mut file) = file else {
        return Err(format!("no unique temporary file for {name}"));
    };
    let result = (|| {
        file.write_all(value.as_bytes()).map_err(|error| format!("write {name}: {error}"))?;
        file.sync_all().map_err(|error| format!("sync {name}: {error}"))?;
        drop(file);
        std::fs::rename(&temp_path, &final_path).map_err(|error| format!("rename {name}: {error}"))?;
        sync_dir(home)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// The floor needs no signature: it only resists remote replay, and whoever can edit
/// `COFLUX_HOME` is outside the threat model. Symlinks, oversized or non-SemVer markers are
/// still errors, so corruption fails closed instead of opening the door.
fn load_release_floor(home: &str) -> Result<Option<ReleaseVersion>, String> {
    let path = Path::new(home).join(RELEASE_FLOOR_MARKER);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("stat {}: {error}", path.display())),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_VERSION_BYTES as u64 {
        return Err(format!("{} has an invalid length", path.display()));
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    ReleaseVersion::parse(raw.trim()).map(Some)
}

/// A runtime installed by a runtime process into the store: real, non-symlink, non-empty,
/// executable, and a paired companion whose marker digests still match.
pub fn installed_runtime(home: &str, version: &str) -> Result<RuntimeSpec, String> {
    validate_version(version)?;
    let store = Path::new(home).join(RUNTIME_STORE_DIR);
    let version_dir = store.join(version);
    for dir in [&store, &version_dir] {
        let metadata = std::fs::symlink_metadata(dir).map_err(|error| format!("stat {}: {error}", dir.display()))?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(format!("{} is not a real directory", dir.display()));
        }
    }
    let path = version_dir.join(RUNTIME_BINARY);
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| format!("stat {}: {error}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!("{} is not a recoverable runtime file", path.display()));
    }
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("{} is not executable", path.display()));
    }
    let pair = version_dir.join("transport-pair.json");
    if pair.exists() {
        let stat = std::fs::symlink_metadata(&pair).map_err(|_| "pair metadata missing")?;
        if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 32768 {
            return Err("invalid pair metadata".into());
        }
        let marker: serde_json::Value =
            serde_json::from_reader(File::open(&pair).map_err(|_| "pair metadata unreadable")?)
                .map_err(|_| "invalid pair metadata")?;
        let companion = version_dir.join("coflux-transport");
        let companion_stat = std::fs::symlink_metadata(&companion).map_err(|_| "transport file missing")?;
        let expected_size = marker["transport"]["size"].as_u64().ok_or("invalid companion metadata")?;
        let expected_sha = marker["transport"]["sha256"].as_str().ok_or("invalid companion metadata")?;
        if !companion_stat.is_file()
            || companion_stat.file_type().is_symlink()
            || companion_stat.len() != expected_size
            || companion_stat.permissions().mode() & 0o111 == 0
        {
            return Err("invalid transport file".into());
        }
        let data = std::fs::read(&companion).map_err(|_| "transport file unreadable")?;
        if hex::encode(Sha256::digest(&data)) != expected_sha.to_lowercase() {
            return Err("transport file digest mismatch".into());
        }
        let bytes = std::fs::read(&path).map_err(|_| "runtime unreadable")?;
        if marker["runtimeSha256"].as_str() != Some(hex::encode(Sha256::digest(&bytes)).as_str()) {
            return Err("paired runtime digest mismatch".into());
        }
    }
    Ok(RuntimeSpec {
        id: version.to_string(),
        version: version.to_string(),
        cmd: path.to_string_lossy().into_owned(),
        args: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_home(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("coflux-launcher-{name}-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        path
    }

    fn builtin() -> RuntimeSpec {
        RuntimeSpec { id: "builtin".into(), version: "builtin".into(), cmd: "/bin/sh".into(), args: vec![] }
    }

    fn manager(home: &Path, builtin: RuntimeSpec, known: HashMap<String, RuntimeSpec>) -> Arc<Manager> {
        Manager::new(
            builtin,
            known,
            home.to_string_lossy().into_owned(),
            Duration::from_secs(1),
            "test".into(),
            home.join("launcher.sock").to_string_lossy().into_owned(),
            home.join("ptyd.sock").to_string_lossy().into_owned(),
        )
    }

    fn install(home: &Path, version: &str, mode: u32) -> PathBuf {
        let dir = home.join("runtimes").join(version);
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join(RUNTIME_BINARY);
        std::fs::write(&binary, b"runtime").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(mode)).unwrap();
        binary
    }

    #[test]
    fn restart_recovers_installed_active_as_observed_candidate() {
        let home = test_home("restore");
        let binary = install(&home, "v3.0.0", 0o755);
        std::fs::write(home.join(ACTIVE_MARKER), b"v3.0.0").unwrap();
        let manager = manager(&home, builtin(), HashMap::new());
        let state = manager.state.lock().unwrap();
        assert_eq!(state.active.id, "v3.0.0");
        assert_eq!(state.pending_fallback.as_ref().map(|s| s.id.as_str()), Some("builtin"));
        assert_eq!(state.pending.as_ref().map(|s| s.cmd.as_str()), Some(binary.to_str().unwrap()));
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn restart_rejects_unusable_persisted_runtime_and_falls_back_builtin() {
        let home = test_home("fallback");
        install(&home, "v-bad", 0o644);
        std::fs::write(home.join(ACTIVE_MARKER), b"v-bad").unwrap();
        let manager = manager(&home, builtin(), HashMap::new());
        let state = manager.state.lock().unwrap();
        assert_eq!(state.active.id, "builtin");
        assert!(state.pending.is_none());
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn ready_requires_the_candidate_connection_and_the_spawn_nonce() {
        let home = test_home("health");
        let manager = manager(&home, builtin(), HashMap::new());
        {
            let mut state = manager.state.lock().unwrap();
            state.pending = Some(RuntimeSpec { id: "candidate".into(), version: "candidate".into(), cmd: "/bin/sh".into(), args: vec![] });
            state.running_id = "candidate".into();
            state.spawn_nonce = "expected".into();
            state.child = Some(Command::new("/bin/sh").args(["-c", "sleep 5"]).spawn().unwrap());
        }
        manager.runtime_connected(12);
        assert!(manager.runtime_ready(11, "expected", &[], None).is_err(), "an older connection cannot vouch");
        assert!(manager.runtime_ready(12, "blind", &[], None).is_err(), "a wrong nonce never passes");
        // The right nonce on the right connection still fails here: no ptyd answers in this test.
        let refusal = manager.runtime_ready(12, "expected", &[], Some(1)).err().expect("ptyd unavailable");
        assert!(refusal.retry);
        assert!(!manager.state.lock().unwrap().pending_healthy);
        manager.runtime_disconnected(12);
        let mut state = manager.state.lock().unwrap();
        let mut child = state.child.take().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn builtin_semver_seeds_durable_floor_and_remote_switch_rejects_downgrade_or_replay() {
        let home = test_home("floor");
        let builtin = RuntimeSpec { id: "v3.0.0".into(), version: "v3.0.0".into(), cmd: "/bin/sh".into(), args: vec![] };
        let manager = manager(&home, builtin, HashMap::new());
        assert_eq!(std::fs::read_to_string(home.join(RELEASE_FLOOR_MARKER)).unwrap(), "v3.0.0");
        install(&home, "v2.9.9", 0o755);
        install(&home, "v3.0.0", 0o755);
        install(&home, "v3.0.1", 0o755);
        assert!(manager.switch("v2.9.9", true).is_err(), "a downgrade is refused by the floor");
        assert!(manager.switch("v3.0.0", true).is_err(), "equal precedence to the committed floor is a replay");
        assert!(manager.switch("v3.0.1", true).is_ok());
        let state = manager.state.lock().unwrap();
        assert_eq!(state.pending.as_ref().map(|s| s.id.as_str()), Some("v3.0.1"));
        assert_eq!(state.pending_release.as_ref().map(ReleaseVersion::as_str), Some("v3.0.1"));
        assert_eq!(state.last_switch.as_ref().map(|r| (r.id.as_str(), r.state.clone())), Some(("v3.0.1", SwitchState::Pending)));
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn administrator_switch_is_not_floor_bound_and_remote_unknown_non_release_is_refused() {
        let home = test_home("admin");
        let builtin = RuntimeSpec { id: "v3.0.0".into(), version: "v3.0.0".into(), cmd: "/bin/sh".into(), args: vec![] };
        let manager = manager(&home, builtin, HashMap::new());
        assert!(manager.switch("canary", true).is_err(), "remote switch to an unregistered non-release id");
        manager
            .register(RuntimeSpec { id: "canary".into(), version: "v2.0.0".into(), cmd: "/bin/sh".into(), args: vec![] })
            .unwrap();
        assert!(manager.switch("canary", false).is_ok(), "an administrator may switch to an older version");
        let state = manager.state.lock().unwrap();
        assert_eq!(state.pending.as_ref().map(|s| s.id.as_str()), Some("canary"));
        assert!(state.pending_release.is_none(), "a local switch never advances the floor");
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn uncommitted_recovered_runtime_never_becomes_new_candidate_fallback() {
        let home = test_home("recovered-fallback");
        install(&home, "recovered", 0o755);
        std::fs::write(home.join(ACTIVE_MARKER), b"recovered").unwrap();
        let manager = manager(&home, builtin(), HashMap::new());
        let mut state = manager.state.lock().unwrap();
        manager
            .begin_switch(&mut state, RuntimeSpec { id: "candidate".into(), version: "candidate".into(), cmd: "/bin/false".into(), args: vec![] }, None)
            .unwrap();
        assert_eq!(state.pending_fallback.as_ref().map(|s| s.id.as_str()), Some("builtin"));
        manager.rollback_pending(&mut state, "candidate", "exited repeatedly during probation");
        assert_eq!(state.active.id, "builtin");
        assert_eq!(std::fs::read_to_string(home.join(ACTIVE_MARKER)).unwrap(), "builtin");
        let record = state.last_switch.as_ref().unwrap();
        assert_eq!((record.id.as_str(), record.state.clone()), ("candidate", SwitchState::RolledBack));
        assert!(record.reason.as_deref().is_some_and(|reason| reason.contains("exited repeatedly")));
        drop(state);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn floor_persist_failure_keeps_pending_and_disables_remote_switches() {
        let home = test_home("floor-persist");
        let manager = manager(&home, builtin(), HashMap::new());
        install(&home, "v1.0.0", 0o755);
        manager.switch("v1.0.0", true).unwrap();
        let floor_path = home.join(RELEASE_FLOOR_MARKER);
        std::fs::create_dir(&floor_path).unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            state.pending_healthy = true;
            manager.try_commit_pending(&mut state);
            assert!(!state.release_floor_durable);
            assert_eq!(state.active.id, "builtin");
            assert_eq!(state.pending.as_ref().map(|s| s.id.as_str()), Some("v1.0.0"));
            assert!(state.committed_release_floor.is_none());
        }
        assert_eq!(std::fs::read_to_string(home.join(ACTIVE_MARKER)).unwrap(), "v1.0.0");
        install(&home, "v2.0.0", 0o755);
        assert!(manager.switch("v2.0.0", true).is_err(), "fail closed while the floor is not durable");
        std::fs::remove_dir(&floor_path).unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            manager.try_commit_pending(&mut state);
            assert!(state.release_floor_durable);
            assert!(state.pending.is_none());
            assert_eq!(state.active.id, "v1.0.0");
            assert_eq!(state.committed_release_floor.as_ref().map(ReleaseVersion::as_str), Some("v1.0.0"));
            assert_eq!(state.last_switch.as_ref().map(|r| r.state.clone()), Some(SwitchState::Committed));
        }
        assert_eq!(std::fs::read_to_string(&floor_path).unwrap(), "v1.0.0");
        std::fs::remove_dir_all(home).unwrap();
    }
}
