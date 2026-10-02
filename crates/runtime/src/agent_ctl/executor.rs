//! The executor run ledger: the very small job table between `coflux executor run` and whichever
//! host this machine has.
//!
//! **The daemon does exactly three things on this path**: recognize the machine's single executor
//! host, push assignments to it, and store the states and terminal outcomes it reports for the CLI
//! to poll. Scheduling, the write lock, transcripts and model calls all live in the host — worker
//! memory is lost on hot upgrade (see the command-log index comment in `crates/worker/src/main.rs`),
//! so putting the job table here would put what most needs to survive in the place most likely to
//! vanish.
//!
//! There are two kinds of host and one implementation of them (`@coflux/executor`): a child process
//! this daemon starts itself when it has a JS runtime (`crates/worker/src/executor_host.rs`), and
//! Coflux.app arriving over a loopback device channel. [`HostAuthority`] is where the choice between
//! them is made, and the daemon's own host wins.
//!
//! **Failure boundaries (fixed; do not relax them)**:
//! - A lost link does not mean the host died. **Never re-dispatch a writer** — an expired lease
//!   does not prove the old writer stopped, and re-dispatching is a double write.
//! - After a host generation change (host restart / channel reconnect), go through **reconciliation**:
//!   the daemon names the runs it still has unfinished and the host re-reports each one. Anything not
//!   re-reported in time becomes `Unknown` (result unknown) — not a failure, and certainly not a rerun.
//! - When another host instance claims the slot, every unfinished run under the previous host
//!   becomes `Unknown` immediately: the new instance has no way to know whether the old one is still
//!   writing.
//!
//! This module is a pure state machine (it takes `now` rather than reading a clock, and does no I/O):
//! the caller receives [`Effect`]s and sends the frames itself.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use coflux_protocol::wire;
use prost::Message as _;

/// The capability name a host must declare when registering. Gated by name, with no version
/// comparison, following `apps/server/src/daemon-capabilities.ts`: old clients drop unknown payloads
/// silently, so having no gate would only leave the agent waiting for a timeout.
///
/// Both hosts read the same string from `EXECUTOR_HOST_CAPABILITY` in `packages/executor`, and
/// `packages/protocol/src/index.ts` carries a third copy for the desktop bridge. Changing one side
/// alone silently refuses every registration, which surfaces only as "this machine has no executor
/// host" on the agent's side; `packages/executor/src/capability.test.ts` pins all three.
pub const CAPABILITY_EXECUTOR_HOST: &str = "executor_host_v1";

/// The window a host gets to re-report after a disconnect or a generation change. Anything still
/// not re-reported when it closes becomes `Unknown`. 45s is the same order as the lease TTL: enough
/// for the app to reconnect once, without leaving the CLI waiting too long.
pub const RECONCILE_GRACE_MS: f64 = 45_000.0;
/// How long to wait for a host to accept after an assignment is pushed. When the host is present but
/// silent (a wedged main process), the run must not sit in queued forever.
pub const ASSIGN_ACK_MS: f64 = 30_000.0;
/// How many runs the ledger keeps. Past the cap, the oldest **finished** run is evicted first; when
/// they are all still running, new submissions are refused.
pub const MAX_RUNS: usize = 64;
/// Byte cap for one prompt: the executor's input is a task description, not a file channel.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;
/// Character cap for a run's resolved title (plan 20260929-executor-pip): it is a card title,
/// whether the agent wrote it or it fell back to the prompt's first line.
pub const MAX_TITLE_CHARS: usize = 120;
/// Byte cap for one run's transcript buffer. Past it the oldest fragments are dropped and the
/// backlog a late viewer receives starts with an explicit "earlier output omitted" marker. A
/// verbose build log must not grow a long-lived worker without limit.
pub const TRANSCRIPT_BUFFER_BYTES: usize = 1024 * 1024;
/// Largest backlog batch sent to a viewer in one device frame: far below the 30 MiB device frame
/// cap, which would tear the whole session lane down.
pub const TRANSCRIPT_BATCH_BYTES: usize = 256 * 1024;
/// Largest single fragment accepted from a host. The runner caps tool output to a few KB; an
/// assistant message is not capped there, but nothing legitimate is anywhere near this.
pub const MAX_FRAGMENT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    /// Registered and pushed to the host, with no acceptance receipt yet.
    Queued,
    /// The host accepted it.
    Accepted,
    /// The host reported it running.
    Running,
    /// Finished; `terminal` is always set.
    Done,
}

/// Terminal-state classification. A process exiting 0, or `prompt()` returning, **must not** be
/// taken for success on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Terminal {
    Succeeded,
    /// The host refused on the spot: write lock taken, no provider/model configured, concurrency cap
    /// reached, and so on. `note` carries the reason, written for the agent.
    Rejected,
    ModelError,
    ToolFailed,
    Cancelled,
    /// Result unknown: the host dropped or changed generation and never re-reported. **Never rerun
    /// automatically.**
    Unknown,
}

impl Terminal {
    /// The stable strings the CLI and the SKILL expose.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Rejected => "rejected",
            Self::ModelError => "model_error",
            Self::ToolFailed => "tool_failed",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }

    /// Only `Succeeded` counts as success; everything else must make the CLI exit non-zero.
    pub fn ok(self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

impl RunPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Done => "done",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RunRecord {
    pub run_id: String,
    pub submission_id: String,
    /// The caller's terminal (plan 20260929-executor-pip): the session that ran `coflux executor
    /// run` and the task it belongs to. The card is bound to this terminal, never to the run's
    /// workspace, which under plan 102 may differ from the terminal's owning workspace.
    pub session_id: String,
    pub task_id: String,
    /// Resolved at submit: the agent's `--title`, else the prompt's first line.
    pub title: String,
    pub workspace_id: String,
    pub workspace_root: String,
    pub write: bool,
    pub prompt: String,
    pub phase: RunPhase,
    pub terminal: Option<Terminal>,
    /// One in-flight sentence, or the reason for a refusal.
    pub note: String,
    pub summary: String,
    pub changed_files: Vec<String>,
    pub error: String,
    pub host_id: String,
    pub host_epoch: u64,
    pub cancel_requested: bool,
    pub created_at: f64,
    /// When the host first reported the run running; None until then.
    pub started_at: Option<f64>,
    pub updated_at: f64,
    /// Without a message from the host by this instant, the run becomes `Unknown`. None means no
    /// timer is running (the host is present and the run is going).
    pub deadline: Option<f64>,
}

impl RunRecord {
    pub fn done(&self) -> bool {
        self.phase == RunPhase::Done
    }
}

/// The title every consumer sees: the agent's own, trimmed and clamped, else the prompt's first
/// non-empty line, clamped the same way.
pub fn resolve_title(title: &str, prompt: &str) -> String {
    let candidate = title.trim();
    let candidate = if candidate.is_empty() {
        prompt
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
    } else {
        candidate
    };
    let mut resolved: String = candidate.chars().take(MAX_TITLE_CHARS).collect();
    if candidate.chars().count() > MAX_TITLE_CHARS {
        resolved.push('…');
    }
    resolved
}

/// One run's buffered transcript (plan 20260929-executor-pip): whole fragments, in seq order,
/// under [`TRANSCRIPT_BUFFER_BYTES`].
#[derive(Default)]
struct Transcript {
    fragments: VecDeque<wire::ExecutorTranscriptFragment>,
    bytes: usize,
    /// The last seq assigned; seqs are dense from 1.
    last_seq: u64,
    /// The highest seq evicted by the cap; 0 when nothing was ever dropped.
    dropped_through: u64,
}

impl Transcript {
    fn push(&mut self, mut fragment: wire::ExecutorTranscriptFragment) -> wire::ExecutorTranscriptFragment {
        self.last_seq += 1;
        fragment.seq = self.last_seq;
        self.bytes += fragment.encoded_len();
        self.fragments.push_back(fragment.clone());
        // Keep at least the newest fragment even if it alone exceeds the cap.
        while self.bytes > TRANSCRIPT_BUFFER_BYTES && self.fragments.len() > 1 {
            let Some(oldest) = self.fragments.pop_front() else {
                break;
            };
            self.bytes -= oldest.encoded_len();
            self.dropped_through = oldest.seq;
        }
        fragment
    }

    /// Fragments after `from_seq`, and whether something the viewer never saw was dropped.
    fn after(&self, from_seq: u64) -> (Vec<wire::ExecutorTranscriptFragment>, bool) {
        let fragments = self
            .fragments
            .iter()
            .filter(|fragment| fragment.seq > from_seq)
            .cloned()
            .collect();
        (fragments, self.dropped_through > from_seq)
    }
}

/// The terminal outcome a viewer is told when a run ends.
#[derive(Clone, Debug, PartialEq)]
pub struct RunEnd {
    pub terminal: Terminal,
    pub summary: String,
    pub error: String,
}

/// One `DeviceExecutorTranscript` frame towards a viewer: backlog, a live fragment, or the end.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptBatch {
    pub run_id: String,
    pub fragments: Vec<wire::ExecutorTranscriptFragment>,
    pub omitted: bool,
    pub end: Option<RunEnd>,
    /// The run's prompt, on the first batch answering a subscription only.
    pub prompt: String,
}

fn run_end(record: &RunRecord) -> Option<RunEnd> {
    record.terminal.map(|terminal| RunEnd {
        terminal,
        summary: record.summary.clone(),
        error: record.error.clone(),
    })
}

/// Which kind of host is claiming this machine's single executor slot.
///
/// Both kinds run the very same `@coflux/executor` package; the difference is who started it and
/// how its frames arrive. It matters because on a machine where both *could* host — an npm-installed
/// `cofluxd` with its own node, plus a running Coflux.app — exactly one must, and **which one is the
/// daemon's decision, made here**. Letting both register and sorting it out by epoch does not work:
/// a takeover declares the previous host's unfinished runs `Unknown`, so two eager hosts would clear
/// each other's tasks on every restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostAuthority {
    /// A host this daemon started itself, on the other end of inherited stdio. It wins.
    DaemonLocal,
    /// A host that arrived over a local loopback device channel — Coflux.app.
    Client,
}

#[derive(Clone, Debug)]
pub struct HostRecord {
    pub channel_id: String,
    pub authority: HostAuthority,
    pub host_id: String,
    pub epoch: u64,
    pub ready: bool,
    pub not_ready_reason: String,
}

/// The frames the ledger asks its caller to send. The ledger itself touches no I/O.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Assign { channel_id: String, run_id: String },
    Cancel { channel_id: String, run_id: String },
    ReportAck { channel_id: String, run_id: String },
    /// A transcript batch to a viewing device channel (plan 20260929-executor-pip).
    Transcript {
        channel_id: String,
        batch: TranscriptBatch,
    },
}

// `reconcile_deadline` is epoch milliseconds as f64, following the repository's existing convention
// (see `now_ms: f64` in local_auth.rs), and f64 has no Eq — hence PartialEq only, without Eq.
#[derive(Clone, Debug, PartialEq)]
pub struct RegisterOutcome {
    /// The runs the host must re-report one by one (reconnect reconciliation).
    pub reconcile_run_ids: Vec<String>,
    pub reconcile_deadline: f64,
}

#[derive(Default)]
pub struct ExecutorLedger {
    host: Option<HostRecord>,
    runs: BTreeMap<String, RunRecord>,
    by_submission: HashMap<String, String>,
    next_seq: u64,
    /// Per-run transcript buffers; an entry exists only while the run is unfinished and at least
    /// one fragment arrived. Dropped by [`settle`](Self::settle) once the run is done.
    transcripts: HashMap<String, Transcript>,
    /// run_id → the device channels following its transcript.
    viewers: HashMap<String, BTreeSet<String>>,
}

impl ExecutorLedger {
    pub fn host(&self) -> Option<&HostRecord> {
        self.host.as_ref()
    }

    pub fn run(&self, run_id: &str) -> Option<&RunRecord> {
        self.runs.get(run_id)
    }

    /// The metadata snapshot the center mirrors (plan 20260929-executor-pip): every unfinished run,
    /// in submit order. No prompt, no transcript.
    pub fn snapshot(&self) -> Vec<wire::ExecutorRunRef> {
        let host_id = self.host.as_ref().map(|host| host.host_id.as_str());
        let mut runs: Vec<wire::ExecutorRunRef> = self
            .runs
            .values()
            .filter(|record| !record.done())
            .map(|record| wire::ExecutorRunRef {
                run_id: record.run_id.clone(),
                session_id: record.session_id.clone(),
                task_id: record.task_id.clone(),
                title: record.title.clone(),
                write: record.write,
                phase: record.phase.as_str().to_string(),
                submitted_at: record.created_at,
                started_at: record.started_at.unwrap_or(0.0),
                host_lost: host_id != Some(record.host_id.as_str()),
            })
            .collect();
        runs.sort_by(|a, b| {
            a.submitted_at
                .total_cmp(&b.submitted_at)
                .then_with(|| a.run_id.cmp(&b.run_id))
        });
        runs
    }

    /* ------------------------- transcript (plan 20260929-executor-pip) ------------------------- */

    /// One fragment from the host currently holding the slot under `host_id`. Refused silently
    /// when the run is unknown, finished, or was assigned to another host. Returns the live pushes
    /// to every viewer of the run.
    pub fn append_fragment(
        &mut self,
        host_id: &str,
        run_id: &str,
        mut fragment: wire::ExecutorTranscriptFragment,
        now: f64,
    ) -> Vec<Effect> {
        let Some(record) = self.runs.get_mut(run_id) else {
            return Vec::new();
        };
        if record.host_id != host_id || record.done() {
            return Vec::new();
        }
        if fragment.encoded_len() > MAX_FRAGMENT_BYTES {
            return Vec::new();
        }
        record.updated_at = now;
        if fragment.at == 0.0 {
            fragment.at = now;
        }
        let stored = self
            .transcripts
            .entry(run_id.to_string())
            .or_default()
            .push(fragment);
        self.viewers
            .get(run_id)
            .map(|viewers| {
                viewers
                    .iter()
                    .map(|channel_id| Effect::Transcript {
                        channel_id: channel_id.clone(),
                        batch: TranscriptBatch {
                            run_id: run_id.to_string(),
                            fragments: vec![stored.clone()],
                            omitted: false,
                            end: None,
                            prompt: String::new(),
                        },
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A viewer follows `run_id` on `channel_id` from after `from_seq`: the backlog it has not
    /// seen (in batches under [`TRANSCRIPT_BATCH_BYTES`], the first carrying the omitted marker
    /// when the cap already dropped something it never saw), then live fragments until the run
    /// ends. A finished or unknown run answers with a single end batch and no registration.
    pub fn subscribe_transcript(&mut self, channel_id: &str, run_id: &str, from_seq: u64) -> Vec<Effect> {
        let batch = |fragments, omitted, end, prompt: &str| Effect::Transcript {
            channel_id: channel_id.to_string(),
            batch: TranscriptBatch {
                run_id: run_id.to_string(),
                fragments,
                omitted,
                end,
                prompt: prompt.to_string(),
            },
        };
        let Some(record) = self.runs.get(run_id) else {
            return vec![batch(
                Vec::new(),
                false,
                Some(RunEnd {
                    terminal: Terminal::Unknown,
                    summary: String::new(),
                    error: "this worker runtime has no record of the run".into(),
                }),
                "",
            )];
        };
        if record.done() {
            return vec![batch(Vec::new(), false, run_end(record), &record.prompt)];
        }
        let prompt = record.prompt.clone();
        self.viewers
            .entry(run_id.to_string())
            .or_default()
            .insert(channel_id.to_string());
        let (backlog, omitted) = self
            .transcripts
            .get(run_id)
            .map(|transcript| transcript.after(from_seq))
            .unwrap_or_default();
        let mut effects = Vec::new();
        let mut current: Vec<wire::ExecutorTranscriptFragment> = Vec::new();
        let mut current_bytes = 0usize;
        for fragment in backlog {
            let size = fragment.encoded_len();
            if !current.is_empty() && current_bytes + size > TRANSCRIPT_BATCH_BYTES {
                let first = effects.is_empty();
                effects.push(batch(
                    std::mem::take(&mut current),
                    omitted && first,
                    None,
                    if first { prompt.as_str() } else { "" },
                ));
                current_bytes = 0;
            }
            current_bytes += size;
            current.push(fragment);
        }
        // Always answer, even with nothing: the viewer learns the subscription was taken and that
        // nothing older exists (or was dropped), and gets the prompt.
        if !current.is_empty() || effects.is_empty() {
            let first = effects.is_empty();
            effects.push(batch(current, omitted && first, None, if first { prompt.as_str() } else { "" }));
        }
        effects
    }

    pub fn unsubscribe_transcript(&mut self, channel_id: &str, run_id: &str) {
        if let Some(viewers) = self.viewers.get_mut(run_id) {
            viewers.remove(channel_id);
            if viewers.is_empty() {
                self.viewers.remove(run_id);
            }
        }
    }

    /// Forget every subscription whose channel is not in `live` any more.
    pub fn retain_viewers(&mut self, live: impl Fn(&str) -> bool) {
        self.viewers.retain(|_, viewers| {
            viewers.retain(|channel_id| live(channel_id));
            !viewers.is_empty()
        });
    }

    /// Close out finished runs: every viewer of a run that reached a terminal state gets one end
    /// batch, and the run's buffer and subscriptions are dropped. Idempotent; call after every
    /// mutation (a report, a cancel, a sweep, a host change) so the end always reaches viewers.
    pub fn settle(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        let ended: Vec<String> = self
            .viewers
            .keys()
            .chain(self.transcripts.keys())
            .filter(|run_id| self.runs.get(*run_id).is_none_or(RunRecord::done))
            .cloned()
            .collect();
        for run_id in ended {
            self.transcripts.remove(&run_id);
            let Some(viewers) = self.viewers.remove(&run_id) else {
                continue;
            };
            let end = self.runs.get(&run_id).and_then(run_end).unwrap_or(RunEnd {
                terminal: Terminal::Unknown,
                summary: String::new(),
                error: "the run left the worker's ledger".into(),
            });
            for channel_id in viewers {
                effects.push(Effect::Transcript {
                    channel_id,
                    batch: TranscriptBatch {
                        run_id: run_id.clone(),
                        fragments: Vec::new(),
                        omitted: false,
                        end: Some(end.clone()),
                        prompt: String::new(),
                    },
                });
            }
        }
        effects
    }

    #[cfg(test)]
    fn transcript_bytes(&self, run_id: &str) -> Option<usize> {
        self.transcripts.get(run_id).map(|transcript| transcript.bytes)
    }

    /// Register or update the machine's executor host.
    ///
    /// A lower epoch for the same host_id is stale (a late registration from an old connection) and
    /// is refused outright. A different host_id takes over, and every unfinished run under the
    /// previous host becomes `Unknown` — the new instance has no way to know whether the old one is
    /// still writing.
    ///
    /// **The election lives here.** A daemon-hosted executor is authoritative: while one holds the
    /// slot, a client host is refused with a reason it can act on, rather than being allowed in and
    /// then fought over. A daemon host may still take over from a client one, because it is the
    /// answer the daemon would give if asked again.
    #[allow(clippy::too_many_arguments)]
    pub fn register_host(
        &mut self,
        channel_id: &str,
        authority: HostAuthority,
        host_id: &str,
        epoch: u64,
        capabilities: &[String],
        ready: bool,
        not_ready_reason: &str,
        now: f64,
    ) -> Result<RegisterOutcome, String> {
        if host_id.trim().is_empty() || epoch == 0 {
            return Err("executor host 身份无效（hostId/hostEpoch 必填）".into());
        }
        if !capabilities
            .iter()
            .any(|name| name == CAPABILITY_EXECUTOR_HOST)
        {
            return Err(format!(
                "executor host 未声明能力 {CAPABILITY_EXECUTOR_HOST}：请升级 Coflux.app 或 cofluxd"
            ));
        }
        if let Some(current) = &self.host {
            if current.authority == HostAuthority::DaemonLocal
                && authority != HostAuthority::DaemonLocal
                && current.host_id != host_id
            {
                return Err(
                    "本机 daemon 自己在托管 executor（cofluxd 装的 node 运行时），不接受第二个 host"
                        .into(),
                );
            }
            if current.host_id == host_id && epoch < current.epoch {
                return Err("executor host 登记已过期（更高 epoch 已在位）".into());
            }
            if current.host_id != host_id {
                self.fail_runs_of_other_host(host_id, now);
            }
        }
        self.host = Some(HostRecord {
            channel_id: channel_id.to_string(),
            authority,
            host_id: host_id.to_string(),
            epoch,
            ready,
            not_ready_reason: not_ready_reason.to_string(),
        });
        let deadline = now + RECONCILE_GRACE_MS;
        let mut reconcile_run_ids = Vec::new();
        for record in self.runs.values_mut() {
            if record.done() || record.host_id != host_id {
                continue;
            }
            record.host_epoch = epoch;
            record.deadline = Some(deadline);
            reconcile_run_ids.push(record.run_id.clone());
        }
        Ok(RegisterOutcome {
            reconcile_run_ids,
            reconcile_deadline: deadline,
        })
    }

    /// The host's channel is gone (the caller noticed it left the channels table). **No
    /// re-dispatch**, only a timer: if no new host re-reports before it expires, these runs become
    /// `Unknown`.
    pub fn host_channel_lost(&mut self, now: f64) {
        let Some(host) = self.host.take() else { return };
        let deadline = now + RECONCILE_GRACE_MS;
        for record in self.runs.values_mut() {
            if record.done() || record.host_id != host.host_id {
                continue;
            }
            record.deadline = Some(deadline);
            if record.note.is_empty() {
                record.note = "桌面 app 的连接中断，等待它重连后重报".into();
            }
        }
    }

    fn fail_runs_of_other_host(&mut self, new_host_id: &str, now: f64) {
        for record in self.runs.values_mut() {
            if record.done() || record.host_id == new_host_id {
                continue;
            }
            finish(
                record,
                Terminal::Unknown,
                "另一个 Coflux.app 实例接管了本机 executor，本任务结果未知（不会自动重跑）",
                now,
            );
        }
    }

    /// Settle expirations: any run past its deadline with no message becomes `Unknown`. Called before
    /// every read of or write to the ledger.
    pub fn sweep(&mut self, now: f64) {
        for record in self.runs.values_mut() {
            if record.done() {
                continue;
            }
            let Some(deadline) = record.deadline else {
                continue;
            };
            if now < deadline {
                continue;
            }
            finish(
                record,
                Terminal::Unknown,
                "桌面 app 没有在限期内回报本任务的状态，结果未知（不会自动重跑）",
                now,
            );
        }
    }

    /// Submit a run. The same submission_id arriving again returns the same run — this is what
    /// deduplicates the CLI's retry after a submission timeout.
    #[allow(clippy::too_many_arguments)]
    pub fn submit(
        &mut self,
        submission_id: &str,
        caller: &RunCaller,
        workspace_id: &str,
        workspace_root: &str,
        prompt: &str,
        write: bool,
        now: f64,
    ) -> Result<(String, Option<Effect>), String> {
        self.sweep(now);
        if submission_id.trim().is_empty() {
            return Err("executor.submit 缺 submissionId".into());
        }
        if caller.session_id.trim().is_empty() || caller.task_id.trim().is_empty() {
            return Err("executor.submit 缺少调用方终端坐标".into());
        }
        if prompt.trim().is_empty() {
            return Err("executor.submit 缺 prompt".into());
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(format!(
                "executor.submit prompt 超过 {MAX_PROMPT_BYTES} 字节上限"
            ));
        }
        if let Some(run_id) = self.by_submission.get(submission_id) {
            // A retry: return the existing runId and never dispatch twice (the executor has side
            // effects).
            return Ok((run_id.clone(), None));
        }
        let Some(host) = self.host.clone() else {
            return Err(
                "本机没有 executor host：macOS 上由 cofluxd 安装的 node 运行时或 Coflux.app 托管，\
                 确认其中之一在跑后重试（Linux 暂无沙箱，executor 尚未开放）"
                    .into(),
            );
        };
        if !host.ready {
            let reason = if host.not_ready_reason.trim().is_empty() {
                "Coflux.app 还没配置 executor 的模型：在 Coflux 设置页的 Executor 分区里选好 provider 与模型并填上 API key".to_string()
            } else {
                host.not_ready_reason.clone()
            };
            return Err(reason);
        }
        if workspace_root.trim().is_empty() {
            return Err("本工作区在 daemon 里没有已登记的本地路径，executor 无法确定边界".into());
        }
        self.evict_if_needed()?;
        self.next_seq = self.next_seq.saturating_add(1);
        let run_id = format!("run-{}-{}", std::process::id(), self.next_seq);
        let record = RunRecord {
            run_id: run_id.clone(),
            submission_id: submission_id.to_string(),
            session_id: caller.session_id.clone(),
            task_id: caller.task_id.clone(),
            title: resolve_title(&caller.title, prompt),
            workspace_id: workspace_id.to_string(),
            workspace_root: workspace_root.to_string(),
            write,
            prompt: prompt.to_string(),
            phase: RunPhase::Queued,
            terminal: None,
            note: String::new(),
            summary: String::new(),
            changed_files: Vec::new(),
            error: String::new(),
            host_id: host.host_id.clone(),
            host_epoch: host.epoch,
            cancel_requested: false,
            created_at: now,
            started_at: None,
            updated_at: now,
            deadline: Some(now + ASSIGN_ACK_MS),
        };
        self.by_submission
            .insert(submission_id.to_string(), run_id.clone());
        self.runs.insert(run_id.clone(), record);
        Ok((
            run_id.clone(),
            Some(Effect::Assign {
                channel_id: host.channel_id,
                run_id,
            }),
        ))
    }

    /// Cancel, idempotently. A run nobody accepted yet goes straight to `Cancelled` (with no taker,
    /// cancelling cannot cause a double write); an accepted one only gets a flag and a cancel frame,
    /// and the real terminal state still comes from the host.
    pub fn cancel(&mut self, run_id: &str, now: f64) -> Result<Option<Effect>, String> {
        self.sweep(now);
        let channel_id = self.host.as_ref().map(|host| host.channel_id.clone());
        let Some(record) = self.runs.get_mut(run_id) else {
            return Err("没有这条 executor 任务（runId 不对或已被淘汰）".into());
        };
        if record.done() {
            return Ok(None);
        }
        record.cancel_requested = true;
        record.updated_at = now;
        if record.phase == RunPhase::Queued {
            finish(record, Terminal::Cancelled, "提交后在接单前被取消", now);
            return Ok(None);
        }
        Ok(channel_id.map(|channel_id| Effect::Cancel {
            channel_id,
            run_id: run_id.to_string(),
        }))
    }

    /// Consume one report from the host. Returns the ack to send back; only terminal states are
    /// acked, because that ack is what lets the host drop its local copy.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_report(
        &mut self,
        host_id: &str,
        host_epoch: u64,
        run_id: &str,
        state: ReportState,
        note: &str,
        summary: &str,
        changed_files: Vec<String>,
        error: &str,
        now: f64,
    ) -> Option<Effect> {
        let channel_id = self.host.as_ref().map(|host| host.channel_id.clone());
        let record = self.runs.get_mut(run_id)?;
        if record.host_id != host_id || host_epoch < record.host_epoch {
            return None;
        }
        record.host_epoch = host_epoch;
        record.updated_at = now;
        if !note.is_empty() {
            record.note = note.to_string();
        }
        match state {
            ReportState::Accepted | ReportState::Running => {
                if record.done() {
                    // An in-flight report arriving after a terminal state: do not revive it, do not ack.
                    return None;
                }
                record.phase = if state == ReportState::Accepted {
                    RunPhase::Accepted
                } else {
                    if record.started_at.is_none() {
                        record.started_at = Some(now);
                    }
                    RunPhase::Running
                };
                // The host is alive and reporting, so clear the timer; it is re-armed on a disconnect
                // or a generation change.
                record.deadline = None;
                None
            }
            ReportState::Terminal(terminal) => {
                if !record.done() {
                    if !summary.is_empty() {
                        record.summary = summary.to_string();
                    }
                    if !changed_files.is_empty() {
                        record.changed_files = changed_files;
                    }
                    if !error.is_empty() {
                        record.error = error.to_string();
                    }
                    finish(record, terminal, note, now);
                }
                // Re-reporting the same terminal state still gets an ack: a lost ack makes the host
                // resend forever.
                channel_id.map(|channel_id| Effect::ReportAck {
                    channel_id,
                    run_id: run_id.to_string(),
                })
            }
        }
    }

    /// When the ledger is full, evict the oldest **finished** run first; if none can be freed, refuse
    /// the new submission rather than displacing a running task.
    fn evict_if_needed(&mut self) -> Result<(), String> {
        while self.runs.len() >= MAX_RUNS {
            let oldest = self
                .runs
                .values()
                .filter(|record| record.done())
                .min_by(|left, right| left.updated_at.total_cmp(&right.updated_at))
                .map(|record| (record.run_id.clone(), record.submission_id.clone()));
            let Some((run_id, submission_id)) = oldest else {
                return Err("executor 在跑的任务已达上限，等它们结束后再提交".into());
            };
            self.runs.remove(&run_id);
            self.by_submission.remove(&submission_id);
            self.transcripts.remove(&run_id);
            self.viewers.remove(&run_id);
        }
        Ok(())
    }
}

/// Who submitted a run (plan 20260929-executor-pip): the caller's terminal and the title it chose.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunCaller {
    pub session_id: String,
    pub task_id: String,
    /// `--title`; empty = fall back to the prompt's first line.
    pub title: String,
}

/// The state a host reports; the wire enum maps to it in [`report_state_from_wire`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportState {
    Accepted,
    Running,
    Terminal(Terminal),
}

/// The JSONL wire's state string -> a ledger state, for the daemon's own host.
///
/// The strings are the same ones [`Terminal::as_str`] produces and the CLI and SKILL expose, so the
/// two carriers cannot drift into different vocabularies. Anything unrecognized maps to None and the
/// report is dropped, exactly as an unknown protobuf enum value is.
pub fn report_state_from_str(value: &str) -> Option<ReportState> {
    match value {
        "accepted" => Some(ReportState::Accepted),
        "running" => Some(ReportState::Running),
        "succeeded" => Some(ReportState::Terminal(Terminal::Succeeded)),
        "rejected" => Some(ReportState::Terminal(Terminal::Rejected)),
        "model_error" => Some(ReportState::Terminal(Terminal::ModelError)),
        "tool_failed" => Some(ReportState::Terminal(Terminal::ToolFailed)),
        "cancelled" => Some(ReportState::Terminal(Terminal::Cancelled)),
        "unknown" => Some(ReportState::Terminal(Terminal::Unknown)),
        _ => None,
    }
}

/// The wire's `ExecutorRunState` -> a ledger state. Unknown values map to None rather than panicking.
pub fn report_state_from_wire(value: i32) -> Option<ReportState> {
    use coflux_protocol::wire::ExecutorRunState as Wire;
    match Wire::try_from(value).ok()? {
        Wire::Unspecified => None,
        Wire::Accepted => Some(ReportState::Accepted),
        Wire::Running => Some(ReportState::Running),
        Wire::Succeeded => Some(ReportState::Terminal(Terminal::Succeeded)),
        Wire::Rejected => Some(ReportState::Terminal(Terminal::Rejected)),
        Wire::ModelError => Some(ReportState::Terminal(Terminal::ModelError)),
        Wire::ToolFailed => Some(ReportState::Terminal(Terminal::ToolFailed)),
        Wire::Cancelled => Some(ReportState::Terminal(Terminal::Cancelled)),
        Wire::Unknown => Some(ReportState::Terminal(Terminal::Unknown)),
    }
}

fn finish(record: &mut RunRecord, terminal: Terminal, note: &str, now: f64) {
    record.phase = RunPhase::Done;
    record.terminal = Some(terminal);
    record.deadline = None;
    record.updated_at = now;
    if !note.is_empty() {
        record.note = note.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> Vec<String> {
        vec![CAPABILITY_EXECUTOR_HOST.to_string()]
    }

    fn caller() -> RunCaller {
        RunCaller {
            session_id: "session-1".into(),
            task_id: "task-1".into(),
            title: String::new(),
        }
    }

    fn assistant(text: &str) -> wire::ExecutorTranscriptFragment {
        wire::ExecutorTranscriptFragment {
            kind: wire::ExecutorFragmentKind::Assistant as i32,
            text: text.into(),
            ..Default::default()
        }
    }

    fn report(ledger: &mut ExecutorLedger, run_id: &str, state: ReportState, now: f64) {
        ledger.apply_report("host-a", 1, run_id, state, "", "", Vec::new(), "", now);
    }

    fn transcript_batches(effects: &[Effect]) -> Vec<(&str, &TranscriptBatch)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Transcript { channel_id, batch } => Some((channel_id.as_str(), batch)),
                _ => None,
            })
            .collect()
    }

    fn ledger_with_host(now: f64) -> ExecutorLedger {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-1", HostAuthority::Client, "host-a", 1, &caps(), true, "", now)
            .expect("登记成功");
        ledger
    }

    fn submit(ledger: &mut ExecutorLedger, submission: &str, write: bool, now: f64) -> String {
        ledger
            .submit(submission, &caller(), "ws-1", "/repo", "清掉 clippy 警告", write, now)
            .expect("提交成功")
            .0
    }

    #[test]
    fn host_must_declare_the_capability_by_name() {
        let mut ledger = ExecutorLedger::default();
        let refused = ledger
            .register_host("ch-1", HostAuthority::Client, "host-a", 1, &[], true, "", 0.0)
            .expect_err("缺能力名必须拒");
        assert!(refused.contains(CAPABILITY_EXECUTOR_HOST), "{refused}");
        assert!(ledger.host().is_none());
    }

    #[test]
    fn submitting_without_a_host_is_refused_readably_not_queued() {
        let mut ledger = ExecutorLedger::default();
        let refused = ledger
            .submit("sub-1", &caller(), "ws-1", "/repo", "干活", true, 0.0)
            .expect_err("没有 host 必须立刻拒");
        // The sentence reaches the calling agent verbatim, so it has to name both places a host can
        // come from — an npm-installed daemon and Coflux.app — not just the desktop app.
        assert!(refused.contains("cofluxd"), "{refused}");
        assert!(refused.contains("Coflux.app"), "{refused}");
    }

    /// The election: on a machine where both could host, the daemon's own host owns the slot and a
    /// client host is turned away with a reason rather than allowed in to fight over it.
    #[test]
    fn a_daemon_host_refuses_a_client_host_instead_of_being_taken_over() {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host(
                "local-executor",
                HostAuthority::DaemonLocal,
                "host-daemon",
                1,
                &caps(),
                true,
                "",
                0.0,
            )
            .expect("daemon host 登记成功");
        let refused = ledger
            .register_host(
                "ch-1",
                HostAuthority::Client,
                "host-desktop",
                1,
                &caps(),
                true,
                "",
                1.0,
            )
            .expect_err("daemon 在位时必须拒绝第二个 host");
        assert!(refused.contains("daemon"), "{refused}");
        let host = ledger.host().expect("daemon host 还在位");
        assert_eq!(host.host_id, "host-daemon");
        assert_eq!(host.authority, HostAuthority::DaemonLocal);
    }

    /// The same host re-registering (a configuration change bumps the epoch) is never the election;
    /// it must go through even though it arrives on the daemon-local slot.
    #[test]
    fn a_daemon_host_may_re_register_itself_under_a_higher_epoch() {
        let mut ledger = ExecutorLedger::default();
        for epoch in [1, 2] {
            ledger
                .register_host(
                    "local-executor",
                    HostAuthority::DaemonLocal,
                    "host-daemon",
                    epoch,
                    &caps(),
                    true,
                    "",
                    0.0,
                )
                .expect("同一 host 重新报到必须通过");
        }
        assert_eq!(ledger.host().expect("host 在位").epoch, 2);
    }

    /// A daemon host starting up on a machine whose desktop already registered takes the slot: it is
    /// the answer the daemon would give if asked again, so it is not a race.
    #[test]
    fn a_daemon_host_takes_over_from_a_client_host_and_the_old_runs_go_unknown() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger
            .register_host(
                "local-executor",
                HostAuthority::DaemonLocal,
                "host-daemon",
                1,
                &caps(),
                true,
                "",
                1.0,
            )
            .expect("daemon host 接管");
        assert_eq!(ledger.host().expect("host 在位").host_id, "host-daemon");
        assert_eq!(
            ledger.run(&run_id).expect("run 还在").terminal,
            Some(Terminal::Unknown),
            "接管方无从判断旧 host 是否还在写文件"
        );
    }

    #[test]
    fn unconfigured_host_is_refused_at_submit_time_with_its_own_reason() {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-1", HostAuthority::Client, "host-a", 1, &caps(), false, "去桌面配 provider", 0.0)
            .expect("登记成功");
        let refused = ledger
            .submit("sub-1", &caller(), "ws-1", "/repo", "干活", true, 0.0)
            .expect_err("未配置必须立刻拒");
        assert_eq!(refused, "去桌面配 provider");
    }

    #[test]
    fn same_submission_id_never_dispatches_twice() {
        let mut ledger = ledger_with_host(0.0);
        let (first, effect) = ledger
            .submit("sub-1", &caller(), "ws-1", "/repo", "干活", true, 0.0)
            .unwrap();
        assert_eq!(
            effect,
            Some(Effect::Assign {
                channel_id: "ch-1".into(),
                run_id: first.clone()
            })
        );
        let (second, effect) = ledger
            .submit("sub-1", &caller(), "ws-1", "/repo", "干活", true, 1.0)
            .unwrap();
        assert_eq!(second, first, "重投必须回同一条 run");
        assert_eq!(effect, None, "重投绝不二次派发");
    }

    #[test]
    fn a_queued_run_that_is_never_accepted_becomes_unknown_not_stuck() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.sweep(ASSIGN_ACK_MS - 1.0);
        assert_eq!(ledger.run(&run_id).unwrap().phase, RunPhase::Queued);
        ledger.sweep(ASSIGN_ACK_MS);
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Unknown));
        assert!(!record.terminal.unwrap().ok());
    }

    #[test]
    fn running_reports_clear_the_deadline_so_long_tasks_are_not_killed() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Running,
            "跑测试中",
            "",
            Vec::new(),
            "",
            1.0,
        );
        ledger.sweep(3_600_000.0);
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.phase, RunPhase::Running);
        assert_eq!(record.note, "跑测试中");
    }

    #[test]
    fn terminal_reports_are_acked_and_repeated_ones_are_acked_again() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        let ack = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "改完了",
            vec!["src/a.rs".into()],
            "",
            2.0,
        );
        assert_eq!(
            ack,
            Some(Effect::ReportAck {
                channel_id: "ch-1".into(),
                run_id: run_id.clone()
            })
        );
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Succeeded));
        assert_eq!(record.summary, "改完了");
        assert_eq!(record.changed_files, vec!["src/a.rs".to_string()]);
        // A lost ack makes the host resend the same terminal state: ack it again, and do not change
        // the outcome already recorded.
        let again = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "被覆盖的新文案",
            Vec::new(),
            "",
            3.0,
        );
        assert!(again.is_some());
        assert_eq!(ledger.run(&run_id).unwrap().summary, "改完了");
    }

    #[test]
    fn reconnecting_host_gets_a_reconcile_list_and_unreported_runs_fall_to_unknown() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Running,
            "",
            "",
            Vec::new(),
            "",
            1.0,
        );
        ledger.host_channel_lost(10.0);
        // Reconnect after a generation change: get the reconcile list.
        let outcome = ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 2, &caps(), true, "", 20.0)
            .expect("重连登记成功");
        assert_eq!(outcome.reconcile_run_ids, vec![run_id.clone()]);
        assert_eq!(outcome.reconcile_deadline, 20.0 + RECONCILE_GRACE_MS);
        // Not re-reported: unknown once the deadline passes, and **no re-dispatch** (no new Assign
        // effect).
        ledger.sweep(20.0 + RECONCILE_GRACE_MS);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Unknown)
        );
    }

    #[test]
    fn a_reconnected_host_that_reports_running_keeps_the_run_alive() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.host_channel_lost(10.0);
        ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 2, &caps(), true, "", 20.0)
            .unwrap();
        ledger.apply_report(
            "host-a",
            2,
            &run_id,
            ReportState::Running,
            "还在跑",
            "",
            Vec::new(),
            "",
            21.0,
        );
        ledger.sweep(20.0 + RECONCILE_GRACE_MS + 1.0);
        assert_eq!(ledger.run(&run_id).unwrap().phase, RunPhase::Running);
    }

    #[test]
    fn another_desktop_instance_never_inherits_the_old_hosts_runs() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger
            .register_host("ch-9", HostAuthority::Client, "host-b", 1, &caps(), true, "", 5.0)
            .expect("另一个实例可以接管 host");
        let record = ledger.run(&run_id).unwrap();
        assert_eq!(record.terminal, Some(Terminal::Unknown), "不得重派 writer");
        assert!(record.note.contains("结果未知"), "{}", record.note);
    }

    #[test]
    fn stale_epoch_registration_is_refused() {
        let mut ledger = ExecutorLedger::default();
        ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 5, &caps(), true, "", 0.0)
            .unwrap();
        let refused = ledger
            .register_host("ch-1", HostAuthority::Client, "host-a", 4, &caps(), true, "", 1.0)
            .expect_err("较低 epoch 是 stale");
        assert!(refused.contains("过期"), "{refused}");
        assert_eq!(ledger.host().unwrap().channel_id, "ch-2");
    }

    #[test]
    fn stale_epoch_reports_are_dropped() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 2, &caps(), true, "", 1.0)
            .unwrap();
        let ack = ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "旧代的终态",
            Vec::new(),
            "",
            2.0,
        );
        assert_eq!(ack, None);
        assert!(ledger.run(&run_id).unwrap().terminal.is_none());
    }

    #[test]
    fn cancel_is_idempotent_and_only_pushes_a_frame_once_accepted() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        // Not accepted yet: record cancelled locally, push no frame.
        assert_eq!(ledger.cancel(&run_id, 1.0).unwrap(), None);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Cancelled)
        );
        // Cancelling after a terminal state is a no-op.
        assert_eq!(ledger.cancel(&run_id, 2.0).unwrap(), None);

        let second = submit(&mut ledger, "sub-2", true, 3.0);
        ledger.apply_report(
            "host-a",
            1,
            &second,
            ReportState::Accepted,
            "",
            "",
            Vec::new(),
            "",
            4.0,
        );
        assert_eq!(
            ledger.cancel(&second, 5.0).unwrap(),
            Some(Effect::Cancel {
                channel_id: "ch-1".into(),
                run_id: second.clone()
            })
        );
        assert!(!ledger.run(&second).unwrap().done(), "终态仍由 host 报");
        // A repeated cancel only pushes the frame again; the state does not change.
        assert!(ledger.cancel(&second, 6.0).unwrap().is_some());
    }

    #[test]
    fn unknown_run_ids_and_oversized_prompts_are_refused() {
        let mut ledger = ledger_with_host(0.0);
        assert!(ledger.cancel("run-nope", 0.0).is_err());
        let long = "x".repeat(MAX_PROMPT_BYTES + 1);
        let refused = ledger
            .submit("sub-1", &caller(), "ws-1", "/repo", &long, true, 0.0)
            .expect_err("超长 prompt 必须拒");
        assert!(refused.contains("上限"), "{refused}");
        let refused = ledger
            .submit("sub-2", &caller(), "ws-1", "/repo", "   ", true, 0.0)
            .expect_err("空 prompt 必须拒");
        assert!(refused.contains("prompt"), "{refused}");
    }

    #[test]
    fn full_ledger_evicts_finished_runs_before_refusing() {
        let mut ledger = ledger_with_host(0.0);
        for index in 0..MAX_RUNS {
            let run_id = submit(&mut ledger, &format!("sub-{index}"), false, index as f64);
            ledger.apply_report(
                "host-a",
                1,
                &run_id,
                ReportState::Terminal(Terminal::Succeeded),
                "",
                "",
                Vec::new(),
                "",
                index as f64,
            );
        }
        // All finished: evict the oldest and let the new submission through as usual.
        let fresh = submit(&mut ledger, "sub-fresh", false, 1_000.0);
        assert!(ledger.run(&fresh).is_some());
        assert!(ledger.runs.len() <= MAX_RUNS);
    }

    #[test]
    fn terminal_names_are_stable_for_the_cli_and_skill() {
        assert_eq!(Terminal::Succeeded.as_str(), "succeeded");
        assert_eq!(Terminal::Rejected.as_str(), "rejected");
        assert_eq!(Terminal::ModelError.as_str(), "model_error");
        assert_eq!(Terminal::ToolFailed.as_str(), "tool_failed");
        assert_eq!(Terminal::Cancelled.as_str(), "cancelled");
        assert_eq!(Terminal::Unknown.as_str(), "unknown");
        assert!(Terminal::Succeeded.ok());
        for terminal in [
            Terminal::Rejected,
            Terminal::ModelError,
            Terminal::ToolFailed,
            Terminal::Cancelled,
            Terminal::Unknown,
        ] {
            assert!(!terminal.ok(), "{} 不该算成功", terminal.as_str());
        }
    }

    /* ---------------------- plan 20260929-executor-pip: card and transcript ---------------------- */

    #[test]
    fn a_run_carries_its_callers_terminal_and_a_resolved_title() {
        let mut ledger = ledger_with_host(0.0);
        let (with_title, _) = ledger
            .submit(
                "sub-1",
                &RunCaller {
                    session_id: "session-1".into(),
                    task_id: "task-1".into(),
                    title: "  Fix clippy  ".into(),
                },
                "ws-1",
                "/repo",
                "first line\nsecond line",
                false,
                0.0,
            )
            .unwrap();
        let record = ledger.run(&with_title).unwrap();
        assert_eq!(record.session_id, "session-1");
        assert_eq!(record.task_id, "task-1");
        assert_eq!(record.title, "Fix clippy");

        let (without, _) = ledger
            .submit("sub-2", &caller(), "ws-1", "/repo", "\n\n  first line  \nsecond", false, 1.0)
            .unwrap();
        assert_eq!(ledger.run(&without).unwrap().title, "first line");

        let long = "x".repeat(MAX_TITLE_CHARS + 50);
        assert_eq!(resolve_title(&long, "p").chars().count(), MAX_TITLE_CHARS + 1);
        assert!(resolve_title(&long, "p").ends_with('…'));

        let refused = ledger
            .submit("sub-3", &RunCaller::default(), "ws-1", "/repo", "p", false, 2.0)
            .expect_err("a run without a caller terminal has no card to bind to");
        assert!(refused.contains("终端"), "{refused}");
    }

    #[test]
    fn the_snapshot_lists_a_run_on_submit_and_drops_it_on_a_reported_terminal_state() {
        let mut ledger = ledger_with_host(0.0);
        assert!(ledger.snapshot().is_empty());
        let run_id = submit(&mut ledger, "sub-1", true, 5.0);
        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.len(), 1);
        let entry = &snapshot[0];
        assert_eq!(entry.run_id, run_id);
        assert_eq!(entry.session_id, "session-1");
        assert_eq!(entry.task_id, "task-1");
        assert_eq!(entry.title, "清掉 clippy 警告");
        assert!(entry.write);
        assert_eq!(entry.phase, "queued");
        assert_eq!(entry.submitted_at, 5.0);
        assert_eq!(entry.started_at, 0.0);
        assert!(!entry.host_lost);

        report(&mut ledger, &run_id, ReportState::Running, 7.0);
        let entry = &ledger.snapshot()[0];
        assert_eq!(entry.phase, "running");
        assert_eq!(entry.started_at, 7.0);

        // The host's channel dropping shows on the entry without ending the run.
        ledger.host_channel_lost(8.0);
        assert!(ledger.snapshot()[0].host_lost);
        ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 2, &caps(), true, "", 9.0)
            .unwrap();
        assert!(!ledger.snapshot()[0].host_lost);

        // The reconnected host reports under its new epoch.
        ledger.apply_report(
            "host-a",
            2,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "",
            Vec::new(),
            "",
            10.0,
        );
        assert!(ledger.snapshot().is_empty(), "a finished run leaves the snapshot");
    }

    #[test]
    fn the_snapshot_drops_a_run_the_sweep_turned_unknown() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        assert_eq!(ledger.snapshot().len(), 1);
        // Nobody polls: only the sweep runs, and the queued run's acceptance window closes.
        ledger.sweep(ASSIGN_ACK_MS);
        assert_eq!(
            ledger.run(&run_id).unwrap().terminal,
            Some(Terminal::Unknown)
        );
        assert!(ledger.snapshot().is_empty());
    }

    #[test]
    fn fragments_are_accepted_only_from_the_runs_host_including_after_it_reconnects() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        report(&mut ledger, &run_id, ReportState::Running, 1.0);
        // Another host id is not this run's host: refused, nothing buffered.
        ledger.append_fragment("host-b", &run_id, assistant("intruder"), 2.0);
        assert_eq!(ledger.transcript_bytes(&run_id), None);
        ledger.append_fragment("host-a", &run_id, assistant("one"), 3.0);
        assert!(ledger.transcript_bytes(&run_id).is_some());

        // The desktop reconnects under the same host_id on a new channel with a higher epoch and
        // keeps streaming.
        ledger.host_channel_lost(4.0);
        ledger
            .register_host("ch-2", HostAuthority::Client, "host-a", 2, &caps(), true, "", 5.0)
            .unwrap();
        ledger.append_fragment("host-a", &run_id, assistant("two"), 6.0);
        let effects = ledger.subscribe_transcript("viewer-1", &run_id, 0);
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 1);
        let texts: Vec<&str> = batches[0].1.fragments.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, vec!["one", "two"]);
        assert_eq!(batches[0].1.fragments[0].seq, 1);
        assert_eq!(batches[0].1.fragments[1].seq, 2);
        assert!(!batches[0].1.omitted);
        assert_eq!(batches[0].1.prompt, "清掉 clippy 警告", "the first batch carries the prompt");

        // A fragment for an unknown or finished run is dropped too.
        assert!(ledger.append_fragment("host-a", "run-nope", assistant("x"), 7.0).is_empty());
        ledger.apply_report(
            "host-a",
            2,
            &run_id,
            ReportState::Terminal(Terminal::Succeeded),
            "",
            "",
            Vec::new(),
            "",
            8.0,
        );
        assert!(ledger.run(&run_id).unwrap().done());
        assert!(ledger.append_fragment("host-a", &run_id, assistant("late"), 9.0).is_empty());
    }

    #[test]
    fn viewers_get_the_backlog_then_live_pushes_and_resume_by_seq() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        report(&mut ledger, &run_id, ReportState::Running, 1.0);
        ledger.append_fragment("host-a", &run_id, assistant("a"), 2.0);
        ledger.append_fragment("host-a", &run_id, assistant("b"), 3.0);

        // Backlog: everything after seq 0.
        let effects = ledger.subscribe_transcript("viewer-1", &run_id, 0);
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].0, "viewer-1");
        assert_eq!(batches[0].1.fragments.len(), 2);
        assert!(batches[0].1.end.is_none());

        // Live: each new fragment reaches the subscriber, with its seq.
        let live = ledger.append_fragment("host-a", &run_id, assistant("c"), 4.0);
        let batches = transcript_batches(&live);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1.fragments[0].seq, 3);
        assert_eq!(batches[0].1.fragments[0].text, "c");

        // Resume after a reconnect: only what came after the last seq the viewer has.
        ledger.retain_viewers(|_| false);
        ledger.append_fragment("host-a", &run_id, assistant("d"), 5.0);
        let effects = ledger.subscribe_transcript("viewer-2", &run_id, 3);
        let batches = transcript_batches(&effects);
        let texts: Vec<&str> = batches[0].1.fragments.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, vec!["d"]);
        assert!(!batches[0].1.omitted);

        // A subscription with nothing new still gets one (empty) answer.
        let effects = ledger.subscribe_transcript("viewer-3", &run_id, 4);
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].1.fragments.is_empty());

        // Unsubscribing stops the live pushes for that channel only.
        ledger.unsubscribe_transcript("viewer-2", &run_id);
        let live = ledger.append_fragment("host-a", &run_id, assistant("e"), 6.0);
        let channels: Vec<&str> = transcript_batches(&live).iter().map(|(c, _)| *c).collect();
        assert_eq!(channels, vec!["viewer-3"]);
    }

    #[test]
    fn the_buffer_cap_drops_the_oldest_fragments_and_the_backlog_says_so() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        report(&mut ledger, &run_id, ReportState::Running, 1.0);
        let big = "z".repeat(100 * 1024);
        let count = TRANSCRIPT_BUFFER_BYTES / (100 * 1024) + 3;
        for index in 0..count {
            ledger.append_fragment("host-a", &run_id, assistant(&big), 2.0 + index as f64);
        }
        let bytes = ledger.transcript_bytes(&run_id).unwrap();
        assert!(bytes <= TRANSCRIPT_BUFFER_BYTES, "{bytes} bytes kept");

        let effects = ledger.subscribe_transcript("viewer-1", &run_id, 0);
        let batches = transcript_batches(&effects);
        assert!(batches.len() > 1, "a 1 MiB backlog goes out in several batches");
        assert!(batches[0].1.omitted, "the first batch carries the omitted marker");
        assert!(batches[1..].iter().all(|(_, batch)| !batch.omitted));
        assert!(!batches[0].1.prompt.is_empty());
        assert!(batches[1..].iter().all(|(_, batch)| batch.prompt.is_empty()), "the prompt rides the first batch only");
        let first_seq = batches[0].1.fragments[0].seq;
        assert!(first_seq > 1, "the oldest fragments are gone");
        let last_seq = batches.last().unwrap().1.fragments.last().unwrap().seq;
        assert_eq!(last_seq, count as u64);
        for (_, batch) in &batches {
            let size: usize = batch.fragments.iter().map(|f| f.encoded_len()).sum();
            assert!(size <= TRANSCRIPT_BATCH_BYTES + 100 * 1024 + 64, "{size}");
        }

        // A viewer that already has everything up to the first retained seq sees no omission.
        let effects = ledger.subscribe_transcript("viewer-2", &run_id, first_seq - 1);
        assert!(!transcript_batches(&effects)[0].1.omitted);

        // One oversized fragment is refused outright rather than allowed to wedge the link.
        let huge = "h".repeat(MAX_FRAGMENT_BYTES + 1);
        assert!(ledger.append_fragment("host-a", &run_id, assistant(&huge), 99.0).is_empty());
    }

    #[test]
    fn settling_a_finished_run_ends_its_viewers_and_drops_the_buffer() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        report(&mut ledger, &run_id, ReportState::Running, 1.0);
        ledger.append_fragment("host-a", &run_id, assistant("work"), 2.0);
        ledger.subscribe_transcript("viewer-1", &run_id, 0);
        ledger.subscribe_transcript("viewer-2", &run_id, 0);
        assert!(ledger.settle().is_empty(), "nothing to settle while the run is live");

        ledger.apply_report(
            "host-a",
            1,
            &run_id,
            ReportState::Terminal(Terminal::ToolFailed),
            "",
            "partial",
            Vec::new(),
            "tests red",
            3.0,
        );
        let effects = ledger.settle();
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 2);
        for (_, batch) in &batches {
            assert!(batch.fragments.is_empty());
            assert_eq!(
                batch.end,
                Some(RunEnd {
                    terminal: Terminal::ToolFailed,
                    summary: "partial".into(),
                    error: "tests red".into(),
                })
            );
        }
        assert_eq!(ledger.transcript_bytes(&run_id), None, "the buffer is dropped");
        assert!(ledger.settle().is_empty(), "idempotent");

        // Subscribing after the end answers with the end at once and registers nothing.
        let effects = ledger.subscribe_transcript("viewer-3", &run_id, 0);
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1.end.as_ref().map(|end| end.terminal), Some(Terminal::ToolFailed));
        assert!(ledger.settle().is_empty());

        // And so does an unknown run.
        let effects = ledger.subscribe_transcript("viewer-3", "run-nope", 0);
        let batches = transcript_batches(&effects);
        assert_eq!(batches[0].1.end.as_ref().map(|end| end.terminal), Some(Terminal::Unknown));
    }

    #[test]
    fn a_sweep_produced_unknown_also_ends_the_viewers() {
        let mut ledger = ledger_with_host(0.0);
        let run_id = submit(&mut ledger, "sub-1", true, 0.0);
        ledger.subscribe_transcript("viewer-1", &run_id, 0);
        ledger.sweep(ASSIGN_ACK_MS);
        let effects = ledger.settle();
        let batches = transcript_batches(&effects);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1.end.as_ref().map(|end| end.terminal), Some(Terminal::Unknown));
    }

    #[test]
    fn wire_states_map_onto_the_ledger_and_unknown_values_are_ignored() {
        use coflux_protocol::wire::ExecutorRunState as Wire;
        assert_eq!(
            report_state_from_wire(Wire::Running as i32),
            Some(ReportState::Running)
        );
        assert_eq!(
            report_state_from_wire(Wire::ToolFailed as i32),
            Some(ReportState::Terminal(Terminal::ToolFailed))
        );
        assert_eq!(report_state_from_wire(Wire::Unspecified as i32), None);
        assert_eq!(report_state_from_wire(9999), None);
    }
}
