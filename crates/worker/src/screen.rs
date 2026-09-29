//! Remote screen bridge (plan 20260929-remote-desktop): the worker's half of the 「屏幕」 tab.
//!
//! The controlled side is `coflux-screen`, a Swift helper shipped inside Coflux Desktop. This
//! module only (1) finds it, (2) keeps one connection to it over `$COFLUX_HOME/ipc/screen.sock`,
//! starting it detached when nothing answers, (3) forwards screen payloads between device channels
//! and that socket, tagged by channel id, and (4) tells the helper when a channel goes away. The
//! helper owns everything else: the session, its virtual display, the holder epoch and the orphan
//! grace, which is why a worker restart or hot upgrade reconnects to a live helper instead of
//! killing it (no `kill_on_drop`, own process group). The helper exits by itself once it has no
//! session and no worker connection.
//!
//! Where the helper lives arrives through [`HELPER_ENV`], set by the desktop runtime on the
//! supervisor and passed unchanged to every worker, including hot-upgraded ones running from
//! `~/.coflux/workers/<v>/` where no sibling binary exists. The capability `screen_v1` is
//! advertised only after the helper answered the versioned hello; the two halves upgrade
//! independently (the helper with the app, the worker hot).
//!
//! Budgets. The client bounds video with byte credit (drop-at-source in the helper); the worker
//! clamps the credit a lane may grant so that at most [`SCREEN_CHANNEL_RECORD_BUDGET`] chunks of
//! [`SCREEN_VIDEO_CHUNK_BYTES`] can be in flight — a quarter of the transport helper's shared
//! 256-record queue, the loopback tunnel's budget. Cursor and video frames are additionally
//! *droppable*: when a lane's sink already holds that many records they are discarded instead of
//! queued (the client re-requests a keyframe on a gap), so a saturated screen can never close the
//! terminal lanes sharing the device.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use coflux_protocol::logln;
use coflux_protocol::wire::{
    device_envelope, screen_helper_frame, DeviceEnvelope, ScreenHelperChannelClosed,
    ScreenHelperFrame, ScreenHelperHello, ScreenSessionEnded,
};
use coflux_protocol::{
    write_record, RecordParser, SCREEN_CHANNEL_RECORD_BUDGET, SCREEN_HELPER_PROTOCOL_VERSION,
    SCREEN_VIDEO_CHUNK_BYTES,
};
use prost::Message as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Notify};

/// Absolute path of the `coflux-screen` binary, set by Coflux Desktop on the runtime it starts.
pub const HELPER_ENV: &str = "COFLUX_SCREEN_HELPER";
/// The helper's socket, inside the worker's `$COFLUX_HOME/ipc` directory (0700).
pub const SOCKET_FILE: &str = "screen.sock";
/// Worker → helper frames waiting for the socket. Input events are small and frequent; a full
/// queue drops the frame rather than blocking a device channel.
const OUTBOUND_QUEUE: usize = 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// After starting the helper, how long to keep trying its socket.
const SPAWN_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SPAWN_CONNECT_INTERVAL: Duration = Duration::from_millis(100);
/// How long `start` waits for the first hello before the worker carries on without the
/// capability (it is advertised on the next server connection once the hello lands).
const FIRST_HELLO_WAIT: Duration = Duration::from_secs(6);
const RECONNECT_MIN: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);
/// The most video credit one lane may grant: the record budget in chunks.
pub const MAX_VIDEO_CREDIT_BYTES: u64 =
    (SCREEN_CHANNEL_RECORD_BUDGET * SCREEN_VIDEO_CHUNK_BYTES) as u64;

/// Where helper → client payloads go: the device runtime's channel sinks.
pub trait Outlet: Send + Sync {
    /// Queue `payload` on `channel_id`. `droppable` payloads (video chunks, cursor updates) may be
    /// discarded when the lane is backed up; the return value then still reports `true`. `false`
    /// means the channel is gone or refused the payload.
    fn deliver(&self, channel_id: &str, payload: device_envelope::Payload, droppable: bool) -> bool;
}

/// The helper binary this worker may start, when it is a macOS desktop runtime that shipped one.
pub fn helper_path() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let path = PathBuf::from(std::env::var(HELPER_ENV).ok()?);
    if !path.is_absolute() {
        logln!("[screen] {HELPER_ENV} must be an absolute path; remote screen disabled");
        return None;
    }
    Some(path)
}

/// Client-originated screen payloads: consumed by the bridge right after the scope gate, like
/// loopback frames (most carry no request_id).
pub fn is_screen_payload(payload: &device_envelope::Payload) -> bool {
    use device_envelope::Payload;
    matches!(
        payload,
        Payload::ScreenSessionOpen(_)
            | Payload::ScreenSessionClose(_)
            | Payload::ScreenSessionResize(_)
            | Payload::ScreenSessionPause(_)
            | Payload::ScreenSessionResume(_)
            | Payload::ScreenVideoAttach(_)
            | Payload::ScreenVideoCredit(_)
            | Payload::ScreenKeyframeRequest(_)
            | Payload::ScreenInput(_)
            | Payload::ScreenClipboardSet(_)
    )
}

/// Helper-originated payloads that may be dropped under backpressure without breaking the
/// session: the client re-requests a keyframe when video goes missing, and the cursor's next
/// update supersedes a lost one.
pub fn is_droppable_payload(payload: &device_envelope::Payload) -> bool {
    matches!(
        payload,
        device_envelope::Payload::ScreenVideoFrame(_) | device_envelope::Payload::ScreenCursor(_)
    )
}

/// One channel's hold on the helper: dropped with the channel entry, which is every removal path,
/// and then tells the helper the lane is gone. Dropping is synchronous and never takes a lock the
/// channels table might hold.
pub struct Hold {
    bridge: Arc<Bridge>,
    channel_id: String,
}

impl Drop for Hold {
    fn drop(&mut self) {
        self.bridge.release(&self.channel_id);
    }
}

pub struct Bridge {
    outbound: mpsc::Sender<ScreenHelperFrame>,
    /// The current connection answered the hello with a compatible version.
    ready: AtomicBool,
    /// channel_id → session_id, learned from the helper's own answers, so a lost helper can tell
    /// every holder its session ended.
    sessions: Mutex<HashMap<String, String>>,
    outlet: Mutex<Option<Arc<dyn Outlet>>>,
    first_attempt: Notify,
    first_attempt_done: AtomicBool,
}

impl Bridge {
    /// Connect (or start) the helper and keep the connection for the worker's life. Returns once
    /// the first hello attempt settled, or after [`FIRST_HELLO_WAIT`], so the first server
    /// handshake usually already carries the capability.
    pub async fn start(
        helper: PathBuf,
        home: String,
        worker_version: String,
        outlet: Arc<dyn Outlet>,
    ) -> Arc<Self> {
        let (bridge, rx) = Self::new(Some(outlet));
        tokio::spawn(bridge.clone().run(helper, home, worker_version, rx));
        let _ = tokio::time::timeout(FIRST_HELLO_WAIT, bridge.first_attempt.notified()).await;
        bridge
    }

    fn new(outlet: Option<Arc<dyn Outlet>>) -> (Arc<Self>, mpsc::Receiver<ScreenHelperFrame>) {
        let (tx, rx) = mpsc::channel(OUTBOUND_QUEUE);
        let bridge = Arc::new(Self {
            outbound: tx,
            ready: AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
            outlet: Mutex::new(outlet),
            first_attempt: Notify::new(),
            first_attempt_done: AtomicBool::new(false),
        });
        (bridge, rx)
    }

    /// The helper answered the hello on the live connection: the device advertises `screen_v1`.
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// A channel's hold, created on its first screen payload.
    pub fn hold(self: &Arc<Self>, channel_id: &str) -> Hold {
        Hold {
            bridge: self.clone(),
            channel_id: channel_id.to_string(),
        }
    }

    /// Forward a client payload (already scope-checked, channel_id set) to the helper. `false`
    /// when the helper is not connected or the queue is full.
    pub fn forward(&self, mut envelope: DeviceEnvelope) -> bool {
        if !self.ready() {
            return false;
        }
        if let Some(device_envelope::Payload::ScreenVideoAttach(attach)) = envelope.payload.as_mut() {
            attach.credit_bytes = clamp_credit(attach.credit_bytes);
        }
        let frame = ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::Envelope(envelope)),
        };
        match self.outbound.try_send(frame) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                logln!("[screen] helper queue full; dropping a client frame");
                // The lane is still fine: the client will retry or the next frame supersedes it.
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    fn release(&self, channel_id: &str) {
        self.sessions.lock().unwrap().remove(channel_id);
        let frame = ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::ChannelClosed(
                ScreenHelperChannelClosed {
                    channel_id: channel_id.to_string(),
                },
            )),
        };
        if self.outbound.try_send(frame).is_err() {
            logln!("[screen] could not tell the helper that lane {channel_id} closed");
        }
    }

    /// One helper → worker envelope: remember which lane holds which session, then deliver.
    fn deliver(&self, envelope: DeviceEnvelope) {
        let Some(payload) = envelope.payload else {
            return;
        };
        let channel_id = envelope.channel_id;
        match &payload {
            device_envelope::Payload::ScreenSessionOpened(opened) if opened.ok => {
                self.sessions
                    .lock()
                    .unwrap()
                    .insert(channel_id.clone(), opened.session_id.clone());
            }
            device_envelope::Payload::ScreenVideoAttached(attached) if attached.ok => {
                self.sessions
                    .lock()
                    .unwrap()
                    .insert(channel_id.clone(), attached.session_id.clone());
            }
            device_envelope::Payload::ScreenSessionClosed(_)
            | device_envelope::Payload::ScreenSessionDetached(_)
            | device_envelope::Payload::ScreenSessionEnded(_) => {
                self.sessions.lock().unwrap().remove(&channel_id);
            }
            _ => {}
        }
        let droppable = is_droppable_payload(&payload);
        let outlet = self.outlet.lock().unwrap().clone();
        let delivered = outlet.is_some_and(|outlet| outlet.deliver(&channel_id, payload, droppable));
        if !delivered {
            // The lane is gone (or refused the payload): the helper must not keep waiting on it.
            self.release(&channel_id);
        }
    }

    /// The helper connection ended: every lane that held a session learns it ended, so the tab
    /// shows the loss and reopens (the helper keeps the display for its grace, or is restarted).
    fn disconnected(&self) {
        self.ready.store(false, Ordering::Release);
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        let outlet = self.outlet.lock().unwrap().clone();
        let Some(outlet) = outlet else {
            return;
        };
        for (channel_id, session_id) in sessions {
            outlet.deliver(
                &channel_id,
                device_envelope::Payload::ScreenSessionEnded(ScreenSessionEnded {
                    session_id,
                    reason: "helper_disconnected".into(),
                }),
                false,
            );
        }
    }

    fn settle_first_attempt(&self) {
        if !self.first_attempt_done.swap(true, Ordering::AcqRel) {
            self.first_attempt.notify_waiters();
            self.first_attempt.notify_one();
        }
    }

    async fn run(
        self: Arc<Self>,
        helper: PathBuf,
        home: String,
        worker_version: String,
        mut rx: mpsc::Receiver<ScreenHelperFrame>,
    ) {
        let mut backoff = RECONNECT_MIN;
        loop {
            match connect_or_start(&helper, &home).await {
                Ok(stream) => {
                    let outcome = self.serve(stream, &mut rx, &worker_version).await;
                    let was_ready = self.ready();
                    self.disconnected();
                    self.settle_first_attempt();
                    match outcome {
                        Ok(()) => logln!("[screen] helper connection closed"),
                        Err(error) => logln!("[screen] helper connection failed: {error}"),
                    }
                    if was_ready {
                        backoff = RECONNECT_MIN;
                    }
                }
                Err(error) => {
                    self.settle_first_attempt();
                    logln!("[screen] helper unavailable: {error}");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RECONNECT_MAX);
        }
    }

    /// Hello, then pump both directions until either side goes away.
    async fn serve(
        &self,
        mut stream: UnixStream,
        rx: &mut mpsc::Receiver<ScreenHelperFrame>,
        worker_version: &str,
    ) -> Result<(), String> {
        let hello = ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::Hello(ScreenHelperHello {
                protocol_version: SCREEN_HELPER_PROTOCOL_VERSION,
                worker_version: worker_version.to_string(),
            })),
        };
        write_frame(&mut stream, &hello).await?;
        let mut parser = RecordParser::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut inbound: Vec<ScreenHelperFrame> = Vec::new();
        let mut greeted = false;
        let hello_deadline = tokio::time::Instant::now() + HELLO_TIMEOUT;
        loop {
            tokio::select! {
                read = stream.read(&mut buf) => {
                    let n = read.map_err(|error| error.to_string())?;
                    if n == 0 {
                        return if greeted { Ok(()) } else { Err("closed before hello".into()) };
                    }
                    parser
                        .push(&buf[..n], |record| {
                            match ScreenHelperFrame::decode(record) {
                                Ok(frame) => inbound.push(frame),
                                Err(error) => logln!("[screen] malformed helper frame: {error}"),
                            }
                        })
                        .map_err(|error| error.to_string())?;
                    for frame in inbound.drain(..) {
                        match frame.payload {
                            Some(screen_helper_frame::Payload::HelloAck(ack)) => {
                                if ack.protocol_version != SCREEN_HELPER_PROTOCOL_VERSION || !ack.ok {
                                    return Err(format!(
                                        "helper {} refused hello (protocol {}, ours {}): {}",
                                        ack.helper_version,
                                        ack.protocol_version,
                                        SCREEN_HELPER_PROTOCOL_VERSION,
                                        ack.error.unwrap_or_default()
                                    ));
                                }
                                let permissions = ack.permissions.unwrap_or_default();
                                logln!(
                                    "[screen] helper {} ready (screen recording {}, accessibility {}, session active {})",
                                    ack.helper_version,
                                    permissions.screen_recording,
                                    permissions.accessibility,
                                    ack.session_active
                                );
                                greeted = true;
                                self.ready.store(true, Ordering::Release);
                                self.settle_first_attempt();
                            }
                            Some(screen_helper_frame::Payload::Envelope(envelope)) if greeted => {
                                self.deliver(envelope);
                            }
                            Some(_) => {}
                            None => {}
                        }
                    }
                }
                frame = rx.recv(), if greeted => {
                    let Some(frame) = frame else {
                        return Ok(());
                    };
                    write_frame(&mut stream, &frame).await?;
                }
                _ = tokio::time::sleep_until(hello_deadline), if !greeted => {
                    return Err("hello timed out".into());
                }
            }
        }
    }
}

fn clamp_credit(credit: u64) -> u64 {
    credit.min(MAX_VIDEO_CREDIT_BYTES)
}

async fn write_frame(stream: &mut UnixStream, frame: &ScreenHelperFrame) -> Result<(), String> {
    let record = write_record(&frame.encode_to_vec()).map_err(|error| error.to_string())?;
    stream
        .write_all(&record)
        .await
        .map_err(|error| error.to_string())
}

/// Connect to a live helper, or start one and wait for its socket. The socket lives in the
/// worker's own 0700 `ipc` directory and only its owner (us) may answer on it.
async fn connect_or_start(helper: &Path, home: &str) -> Result<UnixStream, String> {
    let (directory, owner_uid) = crate::secret::socket::prepare_directory(home)?;
    let socket = directory.join(SOCKET_FILE);
    if let Ok(stream) = connect_as(&socket, owner_uid).await {
        return Ok(stream);
    }
    if !helper.is_file() {
        return Err(format!("{} is not a file", helper.display()));
    }
    // Detached on purpose: the helper must outlive this worker so a hot upgrade keeps the
    // virtual display. Its own process group keeps a supervisor group kill from reaching it;
    // stderr stays with the runtime log.
    let mut command = tokio::process::Command::new(helper);
    command
        .arg("--socket")
        .arg(&socket)
        .env("COFLUX_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", helper.display()))?;
    logln!(
        "[screen] started {} (pid {})",
        helper.display(),
        child.id().unwrap_or_default()
    );
    let deadline = tokio::time::Instant::now() + SPAWN_CONNECT_TIMEOUT;
    loop {
        if let Ok(stream) = connect_as(&socket, owner_uid).await {
            // Forget the child: it is not ours to reap or kill.
            drop(child);
            return Ok(stream);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("helper exited before listening: {status}"));
        }
        if tokio::time::Instant::now() >= deadline {
            drop(child);
            return Err("helper did not open its socket in time".into());
        }
        tokio::time::sleep(SPAWN_CONNECT_INTERVAL).await;
    }
}

async fn connect_as(socket: &Path, owner_uid: u32) -> Result<UnixStream, String> {
    let stream = tokio::time::timeout(Duration::from_millis(500), UnixStream::connect(socket))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|error| error.to_string())?;
    let credentials = stream.peer_cred().map_err(|error| error.to_string())?;
    if credentials.uid() != owner_uid {
        return Err("socket is answered by another user".into());
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use coflux_protocol::wire::{
        ScreenSessionOpened, ScreenVideoAttach, ScreenVideoAttached, ScreenVideoFrame,
    };
    use coflux_protocol::DEVICE_PROTOCOL_VERSION;

    #[derive(Default)]
    struct FakeOutlet {
        delivered: Mutex<Vec<(String, device_envelope::Payload, bool)>>,
        refuse: AtomicBool,
    }

    impl Outlet for FakeOutlet {
        fn deliver(&self, channel_id: &str, payload: device_envelope::Payload, droppable: bool) -> bool {
            if self.refuse.load(Ordering::Acquire) {
                return false;
            }
            self.delivered
                .lock()
                .unwrap()
                .push((channel_id.to_string(), payload, droppable));
            true
        }
    }

    fn envelope(channel_id: &str, payload: device_envelope::Payload) -> DeviceEnvelope {
        DeviceEnvelope {
            protocol_version: DEVICE_PROTOCOL_VERSION,
            channel_id: channel_id.into(),
            payload: Some(payload),
        }
    }

    fn ready_bridge(outlet: Arc<FakeOutlet>) -> (Arc<Bridge>, mpsc::Receiver<ScreenHelperFrame>) {
        let (bridge, rx) = Bridge::new(Some(outlet));
        bridge.ready.store(true, Ordering::Release);
        (bridge, rx)
    }

    #[test]
    fn client_screen_payloads_are_recognised_and_worker_ones_are_not() {
        use device_envelope::Payload;
        assert!(is_screen_payload(&Payload::ScreenSessionOpen(Default::default())));
        assert!(is_screen_payload(&Payload::ScreenVideoCredit(Default::default())));
        assert!(is_screen_payload(&Payload::ScreenInput(Default::default())));
        assert!(!is_screen_payload(&Payload::ScreenVideoFrame(Default::default())));
        assert!(!is_screen_payload(&Payload::ScreenSessionOpened(Default::default())));
        assert!(!is_screen_payload(&Payload::LoopbackOpen(Default::default())));
        assert!(is_droppable_payload(&Payload::ScreenVideoFrame(Default::default())));
        assert!(is_droppable_payload(&Payload::ScreenCursor(Default::default())));
        assert!(!is_droppable_payload(&Payload::ScreenSessionState(Default::default())));
        assert!(!is_droppable_payload(&Payload::ScreenClipboardChanged(Default::default())));
    }

    #[test]
    fn video_credit_is_clamped_to_the_record_budget() {
        assert_eq!(MAX_VIDEO_CREDIT_BYTES, 64 * 256 * 1024);
        assert_eq!(clamp_credit(1024), 1024);
        assert_eq!(clamp_credit(u64::MAX), MAX_VIDEO_CREDIT_BYTES);
        let outlet = Arc::new(FakeOutlet::default());
        let (bridge, mut rx) = ready_bridge(outlet);
        assert!(bridge.forward(envelope(
            "video",
            device_envelope::Payload::ScreenVideoAttach(ScreenVideoAttach {
                session_id: "s".into(),
                holder_epoch: 1,
                credit_bytes: u64::MAX,
            })
        )));
        let Some(ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::Envelope(forwarded)),
        }) = rx.try_recv().ok()
        else {
            panic!("the attach must reach the helper queue as an envelope");
        };
        assert_eq!(forwarded.channel_id, "video");
        let Some(device_envelope::Payload::ScreenVideoAttach(attach)) = forwarded.payload else {
            panic!("payload must stay an attach");
        };
        assert_eq!(attach.credit_bytes, MAX_VIDEO_CREDIT_BYTES);
    }

    #[test]
    fn forwarding_needs_a_greeted_helper() {
        let (bridge, _rx) = Bridge::new(Some(Arc::new(FakeOutlet::default())));
        assert!(!bridge.forward(envelope(
            "control",
            device_envelope::Payload::ScreenSessionOpen(Default::default())
        )));
    }

    #[test]
    fn dropping_a_hold_tells_the_helper_the_lane_closed() {
        let outlet = Arc::new(FakeOutlet::default());
        let (bridge, mut rx) = ready_bridge(outlet);
        bridge.deliver(envelope(
            "control",
            device_envelope::Payload::ScreenSessionOpened(ScreenSessionOpened {
                session_id: "s".into(),
                ok: true,
                ..Default::default()
            }),
        ));
        assert_eq!(bridge.sessions.lock().unwrap().get("control").map(String::as_str), Some("s"));
        let hold = bridge.hold("control");
        drop(hold);
        assert!(bridge.sessions.lock().unwrap().is_empty());
        let Some(ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::ChannelClosed(closed)),
        }) = rx.try_recv().ok()
        else {
            panic!("the helper must learn the lane closed");
        };
        assert_eq!(closed.channel_id, "control");
    }

    #[test]
    fn helper_frames_are_delivered_with_droppability_and_a_refused_lane_is_released() {
        let outlet = Arc::new(FakeOutlet::default());
        let (bridge, mut rx) = ready_bridge(outlet.clone());
        bridge.deliver(envelope(
            "video",
            device_envelope::Payload::ScreenVideoAttached(ScreenVideoAttached {
                session_id: "s".into(),
                ok: true,
                error: None,
            }),
        ));
        bridge.deliver(envelope(
            "video",
            device_envelope::Payload::ScreenVideoFrame(ScreenVideoFrame {
                session_id: "s".into(),
                frame_seq: 1,
                data: vec![1, 2, 3],
                last: true,
                ..Default::default()
            }),
        ));
        {
            let delivered = outlet.delivered.lock().unwrap();
            assert_eq!(delivered.len(), 2);
            assert!(!delivered[0].2, "attached is never droppable");
            assert!(delivered[1].2, "video is droppable");
        }
        assert!(rx.try_recv().is_err(), "a delivered frame releases nothing");

        outlet.refuse.store(true, Ordering::Release);
        bridge.deliver(envelope(
            "video",
            device_envelope::Payload::ScreenSessionState(Default::default()),
        ));
        let Some(ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::ChannelClosed(closed)),
        }) = rx.try_recv().ok()
        else {
            panic!("a lane that refuses a frame is released to the helper");
        };
        assert_eq!(closed.channel_id, "video");
        assert!(bridge.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn losing_the_helper_ends_every_held_session_and_drops_readiness() {
        let outlet = Arc::new(FakeOutlet::default());
        let (bridge, _rx) = ready_bridge(outlet.clone());
        bridge.deliver(envelope(
            "control",
            device_envelope::Payload::ScreenSessionOpened(ScreenSessionOpened {
                session_id: "s".into(),
                ok: true,
                ..Default::default()
            }),
        ));
        outlet.delivered.lock().unwrap().clear();
        bridge.disconnected();
        assert!(!bridge.ready());
        let delivered = outlet.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, "control");
        let device_envelope::Payload::ScreenSessionEnded(ended) = &delivered[0].1 else {
            panic!("holders learn their session ended");
        };
        assert_eq!(ended.session_id, "s");
        assert_eq!(ended.reason, "helper_disconnected");
        assert!(!delivered[0].2);
    }

    #[tokio::test]
    async fn hello_round_trip_over_a_socket_pair_marks_the_bridge_ready() {
        let (worker_side, mut helper_side) = UnixStream::pair().unwrap();
        let outlet = Arc::new(FakeOutlet::default());
        let (bridge, mut rx) = Bridge::new(Some(outlet.clone()));
        let served = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.serve(worker_side, &mut rx, "builtin").await })
        };
        // The helper reads the hello…
        let mut parser = RecordParser::new();
        let mut buf = [0u8; 4096];
        let mut hello = None;
        while hello.is_none() {
            let n = helper_side.read(&mut buf).await.unwrap();
            assert!(n > 0);
            parser
                .push(&buf[..n], |record| {
                    hello = Some(ScreenHelperFrame::decode(record).unwrap());
                })
                .unwrap();
        }
        let Some(screen_helper_frame::Payload::Hello(hello)) = hello.unwrap().payload else {
            panic!("the worker speaks first with a hello");
        };
        assert_eq!(hello.protocol_version, SCREEN_HELPER_PROTOCOL_VERSION);
        assert_eq!(hello.worker_version, "builtin");
        // …answers it, then pushes one envelope for a lane.
        let ack = ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::HelloAck(
                coflux_protocol::wire::ScreenHelperHelloAck {
                    protocol_version: SCREEN_HELPER_PROTOCOL_VERSION,
                    helper_version: "test".into(),
                    ok: true,
                    error: None,
                    permissions: None,
                    session_active: false,
                },
            )),
        };
        helper_side
            .write_all(&write_record(&ack.encode_to_vec()).unwrap())
            .await
            .unwrap();
        let state = ScreenHelperFrame {
            payload: Some(screen_helper_frame::Payload::Envelope(envelope(
                "control",
                device_envelope::Payload::ScreenSessionState(Default::default()),
            ))),
        };
        helper_side
            .write_all(&write_record(&state.encode_to_vec()).unwrap())
            .await
            .unwrap();
        for _ in 0..100 {
            if !outlet.delivered.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(bridge.ready());
        assert_eq!(outlet.delivered.lock().unwrap().len(), 1);
        drop(helper_side);
        assert_eq!(served.await.unwrap(), Ok(()));
    }
}
