//! `coflux-launcher watch`: the self-managed service for hosts without launchd or systemd (a
//! container, WSL without systemd, an OpenRC host).
//!
//! The watcher is a supervision shell around two processes that already exist. It starts
//! `coflux-ptyd`, waits for its socket, then starts `coflux-launcher` in its normal mode; the
//! launcher still never starts ptyd. Both children run in their own sessions, so a Ctrl-C or a
//! terminal hangup reaches only the watcher, which alone decides whom to signal and in what order.
//!
//! - The launcher exits on its own: restarted with backoff; ptyd and the terminals are untouched.
//! - ptyd exits: the launcher is stopped too. Background mode restarts both with backoff;
//!   foreground mode (`--foreground`, used by `cofluxd run`) exits 1 so the outer supervisor
//!   (a container restart policy, s6, tmux) restarts everything.
//! - SIGTERM / SIGINT (and SIGHUP in foreground mode): SIGTERM the launcher (leave), then SIGTERM
//!   ptyd alone (ends the shells), exit 0.
//! - `watch.sock` (0600, same OS user) takes one JSON line per connection: `status`, `restart`
//!   (launcher only, no backoff, terminals stay), `restart-all` (ends terminals) and `stop`.
//!
//! One instance per `COFLUX_HOME`: `watch.lock` is held for the watcher's lifetime. Because the
//! children outlive a SIGKILLed watcher, a new watcher also looks for what the previous one left:
//! it adopts that ptyd (terminals survive), replaces that launcher, and refuses to start when a ptyd
//! or runtime it cannot account for serves this home. Exit code 3 means "refused".

use std::fs::{File, OpenOptions, Permissions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use coflux_protocol::logln;
use coflux_protocol::ptyd::PTYD_SOCK_NAME;
use serde_json::{json, Value};

/// Written into `watch.json`; cofluxd also looks for it inside the launcher binary to tell a
/// launcher that has `watch` from one that predates it, without running the binary.
pub const WATCH_PROTOCOL: &str = "coflux-watch/1";

/// The watcher refused to start: another service already owns this home.
pub const EXIT_REFUSED: i32 = 3;

const LOCK_FILE: &str = "watch.lock";
const SOCK_FILE: &str = "watch.sock";
const STATE_FILE: &str = "watch.json";
const RUNTIME_PID_FILE: &str = "runtime.pid";

/// How long ptyd gets to answer on its socket after it starts.
const PTYD_READY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the launcher gets to leave after SIGTERM before its process group is killed.
const LAUNCHER_STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long ptyd gets to end every shell after SIGTERM.
const PTYD_STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// A child that ran this long counts as healthy: its next crash starts the backoff over.
const HEALTHY_RUN: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(10);
/// How long a starting watcher waits for a predecessor that is just exiting to release the lock.
const LOCK_WAIT: Duration = Duration::from_secs(3);
const TICK: Duration = Duration::from_millis(200);
const MAX_REQUEST_BYTES: usize = 4096;

/// A supervised process: our own child, or a ptyd adopted from a watcher that was killed.
enum Proc {
    Child(Child),
    Adopted(i32),
}

impl Proc {
    fn pid(&self) -> i32 {
        match self {
            Proc::Child(child) => child.id() as i32,
            Proc::Adopted(pid) => *pid,
        }
    }

    /// `Some(description)` once the process is gone.
    fn exited(&mut self) -> Option<String> {
        match self {
            Proc::Child(child) => match child.try_wait() {
                Ok(Some(status)) => Some(status.to_string()),
                Ok(None) => None,
                Err(error) => Some(format!("wait failed: {error}")),
            },
            Proc::Adopted(pid) => (!pid_alive(*pid)).then(|| "exited".to_string()),
        }
    }

    fn signal(&self, signal: i32) {
        // SAFETY: plain kill(2) on a pid we own or adopted.
        unsafe {
            libc::kill(self.pid(), signal);
        }
    }

    /// Wait for the process to go, up to `timeout`. True when it is gone.
    fn wait_gone(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.exited().is_some() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

struct Supervised {
    proc: Proc,
    started: Instant,
}

/// Restart pacing for one child.
#[derive(Default)]
struct Backoff {
    failures: u32,
    next_at: Option<Instant>,
}

impl Backoff {
    fn crashed(&mut self, ran: Duration) -> Duration {
        if ran >= HEALTHY_RUN {
            self.failures = 0;
        }
        self.failures += 1;
        let delay = Duration::from_millis(500u64.saturating_mul(1u64 << (self.failures - 1).min(5))).min(MAX_BACKOFF);
        self.next_at = Some(Instant::now() + delay);
        delay
    }

    fn reset(&mut self) {
        self.failures = 0;
        self.next_at = None;
    }

    fn due(&self) -> bool {
        self.next_at.map_or(true, |at| Instant::now() >= at)
    }
}

enum Event {
    Signal(i32),
    Control(String, UnixStream),
}

struct Watcher {
    home: String,
    foreground: bool,
    ptyd_bin: PathBuf,
    launcher_bin: PathBuf,
    ptyd_sock: String,
    ptyd: Option<Supervised>,
    launcher: Option<Supervised>,
    ptyd_backoff: Backoff,
    launcher_backoff: Backoff,
    launcher_restarts: u32,
}

/// Entry point for `coflux-launcher watch [--foreground]`. Never returns.
pub fn run(args: &[String]) -> ! {
    let mut foreground = false;
    for arg in args {
        match arg.as_str() {
            "--foreground" => foreground = true,
            other => {
                eprintln!("coflux-launcher watch: unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let home = std::env::var("COFLUX_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    if let Err(error) = std::fs::create_dir_all(&home) {
        logln!("[watch] cannot create {home}: {error}");
        std::process::exit(1);
    }
    let _ = std::fs::set_permissions(&home, Permissions::from_mode(0o700));
    if !foreground {
        // Background mode must never die with the terminal that started it. cofluxd already
        // starts us in a new session; this covers a direct invocation.
        // SAFETY: setsid has no memory effects; failure (already a group leader) is harmless.
        unsafe {
            libc::setsid();
        }
    }

    let _lock = match acquire_lock(&home) {
        Ok(lock) => lock,
        Err(error) => {
            logln!("[watch] another Coflux service already runs for {home} ({error})");
            std::process::exit(EXIT_REFUSED);
        }
    };

    let bin_dir = bin_dir();
    let mut watcher = Watcher {
        ptyd_sock: format!("{home}/{PTYD_SOCK_NAME}"),
        home,
        foreground,
        ptyd_bin: bin_dir.join("coflux-ptyd"),
        launcher_bin: bin_dir.join("coflux-launcher"),
        ptyd: None,
        launcher: None,
        ptyd_backoff: Backoff::default(),
        launcher_backoff: Backoff::default(),
        launcher_restarts: 0,
    };

    // Signals first, so a SIGTERM during start-up is not lost.
    let (sender, events) = channel::<Event>();
    spawn_signal_thread(sender.clone(), foreground);

    if let Err(reason) = watcher.take_over_leftovers() {
        logln!("[watch] {reason}");
        std::process::exit(EXIT_REFUSED);
    }

    let sock_path = format!("{}/{SOCK_FILE}", watcher.home);
    let _ = std::fs::remove_file(&sock_path);
    let listener = match UnixListener::bind(&sock_path) {
        Ok(listener) => listener,
        Err(error) => {
            logln!("[watch] cannot listen on {sock_path}: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = std::fs::set_permissions(&sock_path, Permissions::from_mode(0o600)) {
        logln!("[watch] cannot restrict {sock_path}: {error}");
        let _ = std::fs::remove_file(&sock_path);
        std::process::exit(1);
    }
    spawn_control_thread(listener, sender);

    logln!(
        "[watch] started pid={} mode={} home={}",
        std::process::id(),
        if foreground { "foreground" } else { "background" },
        watcher.home
    );
    if watcher.ptyd.is_none() {
        watcher.start_ptyd();
    }
    if watcher.ptyd.is_some() {
        watcher.start_launcher();
    }
    watcher.write_state();

    loop {
        match events.recv_timeout(TICK) {
            Ok(Event::Signal(signal)) => {
                if signal == libc::SIGHUP && !foreground {
                    continue;
                }
                logln!("[watch] stopping on signal {signal}");
                watcher.stop_all();
                watcher.cleanup();
                std::process::exit(0);
            }
            Ok(Event::Control(op, stream)) => {
                if watcher.control(&op, stream) {
                    watcher.cleanup();
                    std::process::exit(0);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => thread::sleep(TICK),
        }
        watcher.tick();
    }
}

impl Watcher {
    /// One supervision pass: notice exits and start whatever is due.
    fn tick(&mut self) {
        let mut changed = false;
        if let Some(ptyd) = self.ptyd.as_mut() {
            if let Some(status) = ptyd.proc.exited() {
                let ran = ptyd.started.elapsed();
                self.ptyd = None;
                logln!("[watch] terminal host exited ({status}); stopping the service");
                self.stop_launcher();
                if self.foreground {
                    self.cleanup();
                    std::process::exit(1);
                }
                let delay = self.ptyd_backoff.crashed(ran);
                logln!("[watch] restarting in {}ms", delay.as_millis());
                changed = true;
            }
        }
        if let Some(launcher) = self.launcher.as_mut() {
            if let Some(status) = launcher.proc.exited() {
                let ran = launcher.started.elapsed();
                self.launcher = None;
                let delay = self.launcher_backoff.crashed(ran);
                self.launcher_restarts += 1;
                logln!("[watch] service process exited ({status}); restarting in {}ms, terminals kept", delay.as_millis());
                changed = true;
            }
        }
        if self.ptyd.is_none() && self.ptyd_backoff.due() {
            self.start_ptyd();
            changed = true;
        }
        if self.ptyd.is_some() && self.launcher.is_none() && self.launcher_backoff.due() {
            self.start_launcher();
            changed = true;
        }
        if changed {
            self.write_state();
        }
    }

    /// Handle one control request. True when the watcher must exit afterwards.
    fn control(&mut self, op: &str, mut stream: UnixStream) -> bool {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let mut exit = false;
        let reply = match op {
            "status" => self.status(),
            "restart" => {
                if self.ptyd.is_none() {
                    json!({"ok": false, "error": "the terminal host is not running"})
                } else {
                    logln!("[watch] restart requested; terminals kept");
                    self.stop_launcher();
                    self.launcher_backoff.reset();
                    self.start_launcher();
                    self.write_state();
                    if self.launcher.is_some() {
                        json!({"ok": true, "launcherPid": self.launcher.as_ref().map(|l| l.proc.pid())})
                    } else {
                        json!({"ok": false, "error": "the service could not be started; see the log"})
                    }
                }
            }
            "restart-all" => {
                logln!("[watch] full restart requested; terminals end");
                self.stop_all();
                self.ptyd_backoff.reset();
                self.launcher_backoff.reset();
                self.start_ptyd();
                if self.ptyd.is_some() {
                    self.start_launcher();
                }
                self.write_state();
                if self.launcher.is_some() {
                    json!({"ok": true})
                } else {
                    json!({"ok": false, "error": "the service could not be started; see the log"})
                }
            }
            "stop" => {
                logln!("[watch] stop requested");
                self.stop_all();
                exit = true;
                json!({"ok": true})
            }
            _ => json!({"ok": false, "error": "unsupported operation"}),
        };
        let _ = writeln!(stream, "{reply}");
        exit
    }

    fn status(&mut self) -> Value {
        let terminals = if self.ptyd.is_some() {
            crate::manager::ptyd_live_sessions(&self.ptyd_sock).ok().map(|sessions| sessions.len())
        } else {
            None
        };
        json!({
            "ok": true,
            "protocol": WATCH_PROTOCOL,
            "pid": std::process::id(),
            "mode": if self.foreground { "foreground" } else { "background" },
            "ptyd": {"running": self.ptyd.is_some(), "pid": self.ptyd.as_ref().map(|p| p.proc.pid())},
            "launcher": {
                "running": self.launcher.is_some(),
                "pid": self.launcher.as_ref().map(|l| l.proc.pid()),
                "upMs": self.launcher.as_ref().map(|l| l.started.elapsed().as_millis() as u64),
                "restarts": self.launcher_restarts,
            },
            "terminals": terminals,
        })
    }

    fn start_ptyd(&mut self) {
        let mut command = Command::new(&self.ptyd_bin);
        detach(&mut command);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                logln!("[watch] cannot start {}: {error}", self.ptyd_bin.display());
                self.ptyd_start_failed();
                return;
            }
        };
        let mut proc = Proc::Child(child);
        let deadline = Instant::now() + PTYD_READY_TIMEOUT;
        loop {
            if UnixStream::connect(&self.ptyd_sock).is_ok() {
                break;
            }
            if let Some(status) = proc.exited() {
                logln!("[watch] terminal host exited during start ({status})");
                self.ptyd_start_failed();
                return;
            }
            if Instant::now() >= deadline {
                logln!("[watch] terminal host did not answer within {}s; stopping it", PTYD_READY_TIMEOUT.as_secs());
                proc.signal(libc::SIGKILL);
                proc.wait_gone(Duration::from_secs(2));
                self.ptyd_start_failed();
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        logln!("[watch] terminal host started pid={}", proc.pid());
        self.ptyd = Some(Supervised { proc, started: Instant::now() });
    }

    /// ptyd could not be started. Foreground mode hands over to the outer supervisor by exiting 1;
    /// background mode retries with backoff.
    fn ptyd_start_failed(&mut self) {
        if self.foreground {
            self.stop_launcher();
            self.cleanup();
            std::process::exit(1);
        }
        let delay = self.ptyd_backoff.crashed(Duration::ZERO);
        logln!("[watch] retrying in {}ms", delay.as_millis());
    }

    fn start_launcher(&mut self) {
        let mut command = Command::new(&self.launcher_bin);
        detach(&mut command);
        match command.spawn() {
            Ok(child) => {
                logln!("[watch] service process started pid={}", child.id());
                self.launcher = Some(Supervised { proc: Proc::Child(child), started: Instant::now() });
            }
            Err(error) => {
                logln!("[watch] cannot start {}: {error}", self.launcher_bin.display());
                let delay = self.launcher_backoff.crashed(Duration::ZERO);
                logln!("[watch] retrying in {}ms", delay.as_millis());
            }
        }
    }

    /// SIGTERM the launcher (leave: the runtime goes, shells stay in ptyd). A launcher that does
    /// not leave in time loses its whole process group, runtime included.
    fn stop_launcher(&mut self) {
        let Some(mut launcher) = self.launcher.take() else { return };
        launcher.proc.signal(libc::SIGTERM);
        if !launcher.proc.wait_gone(LAUNCHER_STOP_TIMEOUT) {
            logln!("[watch] service process did not stop in time; killing it");
            // SAFETY: the launcher leads its own session, so its pid is its process group id.
            unsafe {
                libc::kill(-launcher.proc.pid(), libc::SIGKILL);
            }
            launcher.proc.wait_gone(Duration::from_secs(2));
        }
    }

    /// SIGTERM ptyd alone, never its process group: that is what ends every terminal.
    fn stop_ptyd(&mut self) {
        let Some(mut ptyd) = self.ptyd.take() else { return };
        ptyd.proc.signal(libc::SIGTERM);
        if !ptyd.proc.wait_gone(PTYD_STOP_TIMEOUT) {
            logln!("[watch] terminal host did not stop in time; killing it");
            ptyd.proc.signal(libc::SIGKILL);
            ptyd.proc.wait_gone(Duration::from_secs(2));
        }
    }

    fn stop_all(&mut self) {
        self.stop_launcher();
        self.stop_ptyd();
        self.write_state();
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_file(format!("{}/{SOCK_FILE}", self.home));
        let _ = std::fs::remove_file(format!("{}/{STATE_FILE}", self.home));
    }

    /// Record the pids a successor needs to adopt or replace, should this watcher be killed.
    fn write_state(&self) {
        let state = json!({
            "protocol": WATCH_PROTOCOL,
            "pid": std::process::id(),
            "mode": if self.foreground { "foreground" } else { "background" },
            "ptydPid": self.ptyd.as_ref().map(|p| p.proc.pid()),
            "launcherPid": self.launcher.as_ref().map(|l| l.proc.pid()),
        });
        let path = format!("{}/{STATE_FILE}", self.home);
        let temp = format!("{path}.{}.tmp", std::process::id());
        let written = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)
            .and_then(|mut file| file.write_all(format!("{state}\n").as_bytes()));
        if written.is_ok() {
            let _ = std::fs::rename(&temp, &path);
        } else {
            let _ = std::fs::remove_file(&temp);
        }
    }

    /// Account for processes a previous watcher left behind (it was SIGKILLed or OOM-killed and
    /// its children live on in their own sessions). Its ptyd is adopted so the terminals survive;
    /// its launcher is asked to leave and replaced. Anything serving this home that no watcher
    /// recorded belongs to another service, and starting next to it would orphan it: refuse.
    fn take_over_leftovers(&mut self) -> Result<(), String> {
        let previous: Value = std::fs::read_to_string(format!("{}/{STATE_FILE}", self.home))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let recorded = |key: &str| previous.get(key).and_then(Value::as_i64).map(|pid| pid as i32);
        let own = std::process::id() as i32;

        if let Some(pid) = recorded("launcherPid").filter(|pid| *pid != own) {
            if pid_alive(pid) && exe_name(pid).is_some_and(|name| name.starts_with("coflux-launcher")) {
                logln!("[watch] replacing the service process {pid} left by a previous run; terminals kept");
                let mut leftover = Proc::Adopted(pid);
                leftover.signal(libc::SIGTERM);
                if !leftover.wait_gone(LAUNCHER_STOP_TIMEOUT) {
                    // SAFETY: the launcher leads its own session; its pid is its process group id.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                    if !leftover.wait_gone(Duration::from_secs(2)) {
                        return Err(format!("the service process {pid} from a previous run does not stop"));
                    }
                }
            }
        }

        let runtime_pid = std::fs::read_to_string(format!("{}/{RUNTIME_PID_FILE}", self.home))
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok());
        if let Some(pid) = runtime_pid {
            if pid_alive(pid) && exe_name(pid).is_some_and(|name| name.starts_with("coflux-runtime")) {
                return Err(format!(
                    "another Coflux service already runs for {} (process {pid}); stop it first",
                    self.home
                ));
            }
        }

        if UnixStream::connect(&self.ptyd_sock).is_ok() {
            match recorded("ptydPid") {
                Some(pid) if pid_alive(pid) && exe_name(pid).is_some_and(|name| name.starts_with("coflux-ptyd")) => {
                    logln!("[watch] adopting the terminal host {pid} from a previous run");
                    self.ptyd = Some(Supervised { proc: Proc::Adopted(pid), started: Instant::now() });
                }
                _ => {
                    return Err(format!(
                        "terminals for {} are already served by another Coflux service; stop it first",
                        self.home
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Own session, no stdin, our stdout/stderr (daemon.log in background mode, the container's
/// output in foreground mode).
fn detach(command: &mut Command) {
    command.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    // SAFETY: setsid is async-signal-safe and touches no memory of the parent.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// The directory the watcher was invoked from (`~/.coflux/bin`), not the resolved release
/// directory: after `cofluxd update` a restart must pick up the binaries the entry points name.
fn bin_dir() -> PathBuf {
    let invoked = std::env::args().next().unwrap_or_default();
    if invoked.starts_with('/') {
        if let Some(parent) = Path::new(&invoked).parent() {
            return parent.to_path_buf();
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

fn acquire_lock(home: &str) -> std::io::Result<File> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(format!("{home}/{LOCK_FILE}"))?;
    let deadline = Instant::now() + LOCK_WAIT;
    // SAFETY: the fd is valid for the lifetime of `lock`.
    while unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EWOULDBLOCK) || Instant::now() >= deadline {
            return Err(error);
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(lock)
}

fn spawn_signal_thread(sender: Sender<Event>, foreground: bool) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) else {
        logln!("[watch] cannot install signal handlers");
        std::process::exit(1);
    };
    thread::spawn(move || {
        for signal in signals.forever() {
            if signal == SIGHUP && !foreground {
                continue;
            }
            if sender.send(Event::Signal(signal)).is_err() {
                break;
            }
        }
    });
}

fn spawn_control_thread(listener: UnixListener, sender: Sender<Event>) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let Ok(reader) = stream.try_clone() else { continue };
            let mut line = String::new();
            let read = BufReader::new(reader).take(MAX_REQUEST_BYTES as u64).read_line(&mut line);
            let op = match read {
                Ok(_) => serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|value| value.get("op").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default(),
                Err(_) => String::new(),
            };
            if sender.send(Event::Control(op, stream)).is_err() {
                break;
            }
        }
    });
}

fn pid_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only checks existence and permission.
    let exists = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    exists && !is_zombie(pid)
}

#[cfg(target_os = "linux")]
fn is_zombie(pid: i32) -> bool {
    // `/proc/<pid>/stat`: "pid (comm) S ..."; comm may contain spaces, so read after the last ')'.
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| stat.rsplit_once(')').map(|(_, rest)| rest.trim_start().starts_with('Z')))
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn is_zombie(_pid: i32) -> bool {
    false
}

/// The file name of a process's executable, used to confirm that a recorded pid still is the
/// process it was (pids are reused).
#[cfg(target_os = "linux")]
fn exe_name(pid: i32) -> Option<String> {
    let target = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let name = target.file_name()?.to_string_lossy().into_owned();
    Some(name.trim_end_matches(" (deleted)").to_string())
}

#[cfg(target_os = "macos")]
fn exe_name(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; 4096];
    // SAFETY: the buffer is valid for its full length.
    let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    let path = PathBuf::from(String::from_utf8_lossy(&buffer).into_owned());
    path.file_name().map(|name| name.to_string_lossy().into_owned())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exe_name(_pid: i32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_resets_after_a_healthy_run() {
        let mut backoff = Backoff::default();
        assert_eq!(backoff.crashed(Duration::ZERO), Duration::from_millis(500));
        assert_eq!(backoff.crashed(Duration::ZERO), Duration::from_millis(1000));
        assert_eq!(backoff.crashed(Duration::ZERO), Duration::from_millis(2000));
        for _ in 0..10 {
            assert!(backoff.crashed(Duration::ZERO) <= MAX_BACKOFF);
        }
        assert_eq!(backoff.crashed(HEALTHY_RUN), Duration::from_millis(500));
    }

    #[test]
    fn own_process_is_alive_and_named() {
        let own = std::process::id() as i32;
        assert!(pid_alive(own));
        assert!(!pid_alive(0));
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(exe_name(own).is_some());
    }
}
