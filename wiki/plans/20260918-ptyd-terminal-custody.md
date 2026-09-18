# Plan 20260918-ptyd-terminal-custody: upgrading the supervisor stops ending local terminals

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 776bf3f4..HEAD -- crates/supervisor crates/protocol Cargo.toml apps/desktop/src/main apps/desktop/scripts/stage-daemon.mjs apps/desktop/electron-builder.yml packages/cli/cofluxd.mjs scripts/release-sign.mjs tests/src/harness.mjs tests/package.json .github/workflows docs/hot-upgrade-design.md packages/client/src/device-router.ts`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: feature
- Execution: subagent(fable) — departure check, 2026-09-18
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — run 2026-09-18; findings folded in below
- Workspace: isolated — cut from the main worktree at plan time
- Planned at: `776bf3f4`, 2026-09-18

## Requirement

Replacing the supervisor binary today kills every local terminal. The PTY
master fds, the parent-child relationship with each shell, and the whole
VT/history/sequence authority all live in the supervisor's process memory
(`crates/supervisor/src/sessions.rs`, `crates/supervisor/src/sessiond.rs`), so
a new process starts from nothing. `docs/hot-upgrade-design.md` §4 states this
as a design limit: the worker is hot-swappable, the supervisor is not. The
desktop surfaces it as a confirmation reading
「重启本机终端？会结束本机 N 个正在运行的终端及其中的程序。」
(`apps/desktop/src/renderer/components/workbench/daemon-view.ts:117`), and the
user hits it on essentially every release.

**When this is done**, a long-lived `coflux-ptyd` process owns the PTYs, and
replacing the supervisor is an ordinary stop/start that leaves terminals
running, their screens intact and their scrollback intact.

### Product conclusions (settled in exploration; do not reopen)

- **Updating the runtime no longer asks for confirmation** when only the
  supervisor changes. Terminals are kept — processes still running, screen
  contents and scrollback intact.
- **A brief pause is expected and acceptable** while the replacement supervisor
  replays. Output produced during the pause is not lost (ptyd keeps reading,
  and stops reading rather than overwriting — see the backpressure decision).
  Input typed during the pause is buffered by the client and replayed.
- **The device goes briefly offline at the center** (seconds) because the worker
  restarts with the supervisor. Accepted.
- **A failed update rolls back by itself**: the previous supervisor directory is
  still on disk, it is started again, terminals never move, and the panel
  reports that the update could not be applied.
- **Stopping local terminals, quitting the app and logging out still confirm** —
  those genuinely end terminals.
- **A supervisor crash now recovers by itself** instead of parking the panel at
  「已停止」 waiting for a manual start.
- **When the ptyd binary itself changes, terminals cannot be preserved.** That
  update is offered as its own action, it confirms, and it says plainly that
  terminals will end. It must never be silently folded into the ordinary
  supervisor update.
- **One last painful upgrade**: the currently running supervisor predates ptyd
  and cannot hand its PTYs to anyone, so the release that introduces ptyd still
  ends terminals once. Every supervisor-only upgrade after it does not. Say this
  in the release notes; do not try to engineer around it.
- **Machines installed by an older npm `cofluxd` have no terminals until
  `cofluxd` is updated.** The supervisor refuses to run without ptyd and names
  updating `cofluxd` as the fix. This is a deliberate trade for a single
  ownership path; it must be stated in the release notes.
- **Consumer-visible acceptance**: run `top` in a terminal, trigger a runtime
  update, and `top` is still running with its screen intact and still accepts
  input; run a script printing an incrementing counter and the sequence has no
  hole across the update.

## Decisions & tradeoffs

- **PTY custody moves into a separate long-lived process, `coflux-ptyd`,
  whose lifetime is independent of the supervisor's.** Rejected: re-executing
  the supervisor in place (`execve` self-replacement). On macOS `execve` returns
  success *before* dyld loads the new image, so a missing dylib, a too-new
  `LC_BUILD_VERSION` or an AMFI signature rejection kills the process with no
  way back and orphans every shell; AMFI on the bundled daemon is the
  repository's largest unverified assumption. Rejected: ptyd sharing the
  supervisor's lifetime — the supervisor exits on every upgrade, and the
  service managers tear down by process group (launchd) or cgroup (systemd
  `KillMode=control-group`), which is exactly the event ptyd must survive.
  Based on: `crates/supervisor/src/main.rs:222-240` (the supervisor's SIGTERM
  path kills its registered worker and every PTY, then exits),
  `docs/hot-upgrade-design.md` §4.

- **ptyd is started only by whoever owns the runtime lifecycle — the desktop app
  as a sibling of the supervisor, or the service that `cofluxd` generates. The
  supervisor never starts ptyd.** When ptyd is absent the supervisor fails to
  start and says so in a way the operator can act on ("update cofluxd"), rather
  than papering over it. Rejected: letting the supervisor spawn a detached ptyd
  when it cannot find one — it keeps one machine class working but gives ptyd a
  second, rarely exercised startup path and blurs the ownership this whole
  design rests on. **Accepted consequence** (user decision, 2026-09-18): a
  machine installed by an older npm `cofluxd` has no ptyd and therefore no
  working terminals until `cofluxd` is updated, so ptyd must join the installer's
  component table and the failure message must name that as the fix. Based on:
  `packages/cli/cofluxd.mjs:354-359`.

- **ptyd owns the PTY completely; the supervisor holds no PTY file descriptor
  at all.** ptyd spawns the shell (so it is the parent and `waitpid` yields a
  real exit code), runs the read loop, performs the writes, issues TIOCSWINSZ,
  and reaps. The two processes exchange ordinary UDS messages only. The
  supervisor's remaining needs are served through that protocol: the spawn
  reply carries the slave device path the supervisor injects as `SSH_TTY`
  (today `crates/supervisor/src/sessions.rs:149-170`), and resize requests go
  to ptyd instead of a local ioctl (today `:1453`). Rejected: passing the master
  fd to the supervisor over `SCM_RIGHTS` — a PTY master is not a broadcast
  channel, so whichever process reads consumes the bytes; with the supervisor
  reading, ptyd cannot maintain the ring, and without the ring a supervisor
  crash loses the screen even though the shell survives. Based on:
  `crates/supervisor/src/sessions.rs:1386-1387` (exit codes come from
  `child.try_wait()`), `:149-170`, `:1453`.

- **The ring is indexed by output byte offset, and the wire sequence is that
  offset.** `output_seq` is already a byte counter, not a message counter:
  `from_seq = output_seq + 1; output_seq += bytes.len()`. So a ring indexed the
  same way makes `seq ≡ ring offset` identically, with no mapping table and no
  reconciliation, and a rebuilt supervisor reproduces byte-identical sequence
  numbers — which is what keeps every client's `resume_from_seq` meaningful
  across the replacement. Ring capacity: 4 MiB per session. Based on:
  `crates/supervisor/src/sessiond.rs:433-437`.

- **The ring, the cursors and the checkpoint blob live in `mmap(MAP_SHARED)`
  files under `COFLUX_HOME/terminal-data`, and because that puts raw terminal
  output on disk for the first time, the protections are part of the decision,
  not an implementation detail**: the directory and every file are `0600`, each
  session's backing file is unlinked as soon as the session ends, stale files
  left by a crash are swept at ptyd startup, the total is bounded by
  `MAX_LIVE_SESSIONS` × the ring size rather than growing per historical
  session, and the directory is excluded from backups (on macOS by setting the
  exclusion attribute on the directory). Rejected: POSIX shared memory
  (`shm_open`), which would keep the bytes off disk — the user chose files for
  the simpler implementation and the straightforward path to a future in-place
  ptyd upgrade, having been told what goes on disk. **This is a real change in
  what the product persists**: anything that ever appeared in a terminal,
  passwords and tokens included, is in these files while the session lives.
  Treat any weakening of the protections above as a change to a user decision,
  not a refactor. (user decision, 2026-09-18)

- **Periodic checkpoints are mandatory, not an optimisation.** Replaying a
  wrapped ring starts mid-stream, and while a truncated escape sequence costs
  exactly one sequence (vte prints the tail as text and resynchronises at the
  next ESC), the *modal* state established before the ring's oldest byte is
  lost without bound: `?1049h`, mouse modes, bracketed paste, DECSTBM, charset.
  Worst case the rebuilt supervisor parses full-screen TUI frames into the
  normal grid, poisoning history, never capturing `normal_before_alt`, and
  later leaving an alt screen it never entered. That is *worse* than today's
  gap path, where the supervisor's own state is always correct. So the
  supervisor writes a checkpoint to ptyd every time it has produced ≥ half the
  ring capacity: the canonical snapshot (`crates/supervisor/src/sessiond.rs:459`)
  plus the state the snapshot does not encode — title, `CommandStateInfo`,
  `output_seq`, `normal_before_alt`, rows and cols — as an opaque blob tagged
  with the offset X it describes. Recovery feeds the blob, then `ring[X+1..]`.
  Rejected: replay-only recovery. Based on:
  `crates/supervisor/src/sessiond.rs:342-359`, `:459`.

- **ptyd never overwrites a byte at an offset ≥ the last checkpoint offset X.
  When the ring would have to overwrite one, ptyd stops reading the PTY — and
  this holds whether or not a subscriber is attached.** This is what makes the
  checkpoint guarantee real: the ring must always cover `[X, now]`, so that
  replay never begins at a wrapped boundary. The supervisor is absent for the
  whole of a replacement, so a rule phrased only in terms of a lagging
  subscriber would let a busy shell (`yes`, a build) overwrite past X within
  milliseconds and tear a hole between the blob and the ring — reintroducing
  exactly the unbounded modal-state loss the checkpoint exists to prevent, and
  breaking both "output during the pause is not lost" and the contiguous-sequence
  criterion. Stopping the read instead lets the kernel PTY buffer fill and the
  shell pause itself, which is the behaviour the system already has today (the
  read thread blocks on a bounded channel, `crates/supervisor/src/sessions.rs:201`),
  and the budget before that happens is half a ring. A lagging *attached*
  subscriber is an additional reason to stop reading, not the primary one. The
  rule in `docs/hot-upgrade-design.md` that a transport may never pause all PTYs
  governs the *worker*; the supervisor is the authority and already paces the
  PTY today. Based on: `crates/supervisor/src/sessions.rs:94-100`, `:195-201`.
  *(revised on advisor review)*

- **A checkpoint offset is only eligible when the parser is provably between
  sequences, which the implementation must decide, not estimate.** If X lands
  inside an OSC 133 mark, replay prints the tail — the parameter is
  `coflux=<secret>` — as ordinary text into the screen and scrollback, exposing
  the session's mark secret, which is the value the OSC capture matches on.
  vte 0.15 does not expose its parser state, and `DecModeScanner` today tracks
  only ESC/CSI, so the scanner must be extended to also track the string states
  (OSC, DCS, APC, PM, SOS) and the ESC-intermediate state, and to expose a
  predicate meaning "a split here is safe". A checkpoint is taken only when
  that predicate holds; PTY quiescence may gate *when* the supervisor bothers to
  check, but is never sufficient on its own — a shell can emit one OSC in two
  `write(2)` calls separated by more than the coalescing window, so a
  quiescence-only rule would place X inside that OSC. Rejected: treating
  quiescence as the boundary condition. Based on:
  `crates/supervisor/src/sessiond.rs:226` (`MARK_SECRET_PARAM = b"coflux="`),
  `:261`, `:33-49`, `crates/supervisor/src/sessions.rs:104-138`, `:195`.
  *(revised on advisor review)*

- **ptyd records a resize log of `(offset, rows, cols)` and recovery applies it
  at the matching offsets.** Today a resize re-flows from the snapshot at the
  moment it happens (`crates/supervisor/src/sessiond.rs:477`) while vt100's own
  `set_size` truncates; feeding bytes produced under an old width straight into
  a parser already at the final size yields different wrapping, scrollback and
  cursor position than the supervisor that died. ptyd issues TIOCSWINSZ, so it
  is the only component that can record this faithfully. Rejected: replaying
  into a parser created at the final size — `output_seq` would agree while the
  screen silently disagreed. Based on: `crates/supervisor/src/sessiond.rs:477`.

- **`deltas_after` slices by byte offset instead of requiring a whole-frame
  boundary.** It currently only answers when `from_seq` falls exactly on a batch
  boundary and otherwise forces an atomic snapshot; replay re-batches the stream
  differently, so every client's resume would degrade into a full redraw. Since
  seq is a byte offset, slicing inside a retained delta is well defined. The
  same change lets `DevicePtyGap.available_seq` report the ring start instead of
  the 512 KB retransmit ceiling, which makes resume deeper than it is today.
  Based on: `crates/supervisor/src/sessiond.rs:565-584`, `:354`.

- **The ptyd UDS protocol is a long-term compatibility contract, and the
  mechanism is a capability handshake, not just a version number.** This is the
  decision the whole plan's value rests on — if a supervisor upgrade could
  require a matching ptyd, the upgrade would end terminals again and nothing
  was gained. Concretely: ptyd's hello advertises `{protocol_version, ops: [...]}`;
  a supervisor treats any op the running ptyd did not advertise as an
  unavailable capability and continues without that feature rather than failing
  at the call site; and **ptyd never removes or changes the meaning of a v1 op**,
  so rolling back to an older supervisor also works. Rejected: a bare version
  number with unknown-field tolerance — an executor can satisfy that while still
  hard-failing the first time it calls an op the old ptyd lacks. Only a genuine
  incompatibility may demand a ptyd restart, and that path must tell the user
  plainly that terminals will end. *(revised on advisor review)*

- **The checkpoint blob is opaque to ptyd, versioned by the supervisor, and a
  blob the running supervisor cannot parse degrades instead of failing.** A new
  supervisor must read the blob written by the previous one; when it cannot, it
  falls back to replaying the ring alone (accepting the modal-state loss
  described above) and never aborts recovery.

- **Recovery is per session: one session failing to rebuild must not affect any
  other.** A session whose blob and ring are both unusable comes back as a
  degraded session (client sees a gap or a full redraw) or, at worst, as a
  tombstone — never as a reason for the supervisor to exit. Rejected: treating
  recovery as all-or-nothing.

- **Stopping the supervisor to replace it is a different operation from stopping
  the runtime, and the two must not share a code path.** Today
  `runtime_control.rs`'s `stop` op runs `manager.shutdown()` then
  `sessions.shutdown()`, which kills every shell, and the replacement flow must
  not reuse it: the supervisor needs a leave-sessions exit that detaches from
  ptyd and exits while the shells keep running. `stop` keeps its present meaning
  — end everything — and under ptyd it ends the shells by asking ptyd to kill
  them. Rejected: reusing `stop` for the replacement. Based on:
  `crates/supervisor/src/runtime_control.rs:110-118`,
  `crates/supervisor/src/sessions.rs:2181-2187`. *(revised on advisor review)*

- **The desktop's "runtime is live" and "how many terminals" facts come from
  ptyd, not only from the supervisor.** `derive()` reads
  `runtime.sessions.length` from the supervisor's runtime socket, which returns
  nothing while the supervisor is absent; without a second source the panel
  would flip to 「已停止」 during every update and invite the user to start a
  competing instance. ptyd therefore serves a read-only status (session list and
  its own identity) that the desktop can consult independently. Based on:
  `apps/desktop/src/main/daemon-manager.ts:104-107`,
  `apps/desktop/src/main/desktop-runtime.ts:47-62`. *(revised on advisor review)*

- **ptyd's identity is tracked separately from the bundle's runtime identity,
  and ptyd does not embed the release version.** `bundleRuntimeId` hashes every
  binary in `DAEMON_BINARIES` plus the plugin manifest, and any difference
  becomes "update ready"; if ptyd simply joined that set, a supervisor-only
  update would clear the flag while leaving an older ptyd running, and if ptyd
  baked in `COFLUX_RELEASE_VERSION` the way the supervisor does
  (`crates/supervisor/src/main.rs:39`) its bytes would change on every tag and
  "ptyd did not change" could never be detected. So: ptyd embeds its protocol
  version only, its bundled identity is compared against the running ptyd's
  reported identity on its own, and the ordinary update action replaces the
  supervisor alone. Based on: `apps/desktop/src/main/desktop-runtime.ts:83-90`,
  `apps/desktop/src/main/daemon-manager.ts:104`,
  `crates/supervisor/src/runtime_control.rs:58`. *(revised on advisor review)*

- **`holder` and `next_holder_epoch` are not carried across.** Losing them is
  already the behaviour clients handle: the supervisor restart takes the worker
  with it, the client's old channel hits `stale_transport`, the lane recovers
  and re-attaches with a fresh epoch, and a fresh epoch cannot be mistaken for
  a takeover because holder validation also checks the channel id, and channel
  ids are per worker connection. Based on:
  `packages/client/src/device-router.ts:1493`, `:1532`, `:1549`,
  `crates/supervisor/src/sessiond.rs:932-950`.

- **Input de-duplication cursors are kept by ptyd per `(session_id,
  client_instance_id)` as `{seq, data}`, capped at the existing logical-client
  limit of 256, rejecting new identities at the cap while continuing to serve
  registered ones.** A single `last_written_seq` per session is not enough:
  admission distinguishes duplicate, same-seq-different-payload collision, and
  gap, and all three need the per-identity cursor to be reconstructed. ptyd is
  the side that performs the write, so its cursor is the record of what actually
  reached the PTY. Based on: `crates/supervisor/src/sessiond.rs:984-1035`,
  `:22-25`.

- **ptyd uses a bare `openpty` plus `write(2)`, and must never obtain a writer
  through `portable_pty`'s `take_writer()`.** That writer's `Drop` writes `\n`
  followed by EOT to the PTY — the production supervisor calls `take_writer()`
  today, and the only reason this has been survivable is the shape of the
  current teardown. In ptyd the same call would put an end-of-file into every
  shell on any path that drops a session writer while the shell should live on.
  Based on: `crates/supervisor/src/sessions.rs:1070`,
  `wiki/plans/20260914-pty-teardown-input-benign.md`.

- **ptyd ships as a library crate with a thin binary, and the supervisor's unit
  tests start a ptyd in-process.** About 1400 lines of supervisor tests from
  `crates/supervisor/src/sessions.rs:2215` onward drive real PTYs through six
  `openpty` call sites; once the supervisor stops opening PTYs those tests need
  a ptyd to talk to. An in-process library instance keeps them end-to-end
  instead of degrading them into mocks. Rejected: deleting or stubbing that
  coverage. Based on: `crates/supervisor/src/sessions.rs:2215` and following.
  *(revised on advisor review)*

- **The ptyd protocol types live in `crates/protocol/src/ptyd.rs`.**
  `crates/protocol/src/ipc.rs` already carries the supervisor↔worker IPC types
  and `sessiond` imports from it, so the precedent is established and a new
  module beside it is the conventional home. *(decided while planning)*

- **The worker keeps restarting with the supervisor.** It is the supervisor's
  child, and a worker restart is an invariant the black-box harness already
  covers, so client recovery rides on a tested path rather than a new one. The
  cost is a few seconds of device offline at the center, which the product
  conclusions accept.

- **Replay completes before the worker is started.** Otherwise resync would
  observe sequence numbers that are still moving.

### Budgets (measured; the executor should not re-derive these)

- vt100 replay throughput measured on vendored vt100 at 50×200 with 20k
  scrollback: 62 MiB/s (SGR-heavy line output) to 149 MiB/s (TUI frames).
- Line-oriented output runs about 90–100 bytes per logical line, so the current
  `DEFAULT_HISTORY_LINE_LIMIT` of 5000 lines (`crates/supervisor/src/main.rs:61`)
  is roughly 0.5 MB — a 4 MiB ring covers it about eightfold.
- With checkpoints every half ring, replay per session is at most 2 MiB ≈ 35 ms.
  Ten live sessions ≈ 0.3 s, which is why recovery is eager and no lazy
  per-session replay is needed.
- Worst case footprint is bounded by `MAX_LIVE_SESSIONS` = 128
  (`crates/supervisor/src/sessions.rs:183`) × 4 MiB = 512 MiB of ring; the
  implementation must keep the backing store within that bound rather than
  letting it grow per historical session.

## Direction

Three processes; ptyd's lifetime is independent of the supervisor's:

```text
coflux-ptyd (long-lived, tiny, near-zero change rate)
  · openpty + fork/exec of a fully resolved spec; TIOCSWINSZ; waitpid/kill
  · read loop -> per-session 4 MiB ring indexed by output byte offset
  · never overwrites past the last checkpoint offset; stops reading instead
  · input writes + per-(session, client) cursors; resize log; opaque blob
  · read-only status for the desktop
  · versioned v1 UDS protocol with a capability handshake
coflux-supervisor (replaceable at will; crash-recoverable)
  · sessiond: VT/history/sequence authority, checkpoints, DeviceEnvelope
  · spawns and supervises the worker exactly as today
coflux-worker (unchanged; still hot-upgradeable)
```

What must stay **out** of ptyd, or its change rate defeats the plan: `spawn_env`,
`shell_integration`, secret generation, all of sessiond, DeviceEnvelope, and
anything shaped by the worker or the center. ptyd receives a spec that is
already fully resolved (argv, env map, cwd, rows, cols) and interprets none of
it.

Milestones are **strictly serial — do not fan out**. M1 gates M2; M2 gates M3;
M3 gates M4 and M5; M6 exercises the whole chain.

### Milestone 1: `coflux-ptyd` holds PTYs and answers a versioned protocol

A new library-plus-thin-binary crate spawns shells against a resolved spec,
owns their PTYs, serves the ring/cursor/resize-log/blob/status operations over
UDS with a capability handshake, reaps children with real exit codes, and
refuses to overwrite past the last checkpoint offset. It has no dependency on
sessiond and no knowledge of the worker. It is registered in the workspace
members list.

Validation: `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-ptyd` -> exit 0,
zero warnings; `COFLUX_HOME= cargo test -p coflux-ptyd` -> exit 0, with cases
that assert at least: reading by offset after the ring has wrapped; the
logical-client cap rejecting new identities while still serving registered ones;
the read loop stopping rather than overwriting at or past the checkpoint offset,
with no subscriber attached; `waitpid` reporting a real exit code; the resize
log recording offsets; the backing files being `0600`, unlinked when their
session ends, and swept at startup when a previous run left them behind; and —
the direct test for the EOT trap — that closing the supervisor's connection
leaves a `cat` child alive.

### Milestone 2: the fifth binary ships through packaging, signing and release

`coflux-ptyd` joins the bundled daemon everywhere the existing four binaries
are enumerated: the desktop staging script and its binary list, the
electron-builder `mac.binaries` list the desktop config test checks pairwise,
the release signing manifest and its release statements, both release
workflows, the `cofluxd` installer's component table, and the CI and test
pretest build lists. Without this, a later `pnpm build` passes while the bundle
has no ptyd and the app reports an incomplete installation.

Validation: `pnpm -C apps/desktop test` -> exit 0 (the config test enforces the
binary lists pairwise); `pnpm -C tests test` -> exit 0 (release trust and
signing cases); `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli -p coflux-ptyd`
-> exit 0.

### Milestone 3: the supervisor runs as a ptyd client and rebuilds on start

The supervisor no longer opens a PTY. It creates sessions through ptyd,
consumes output by subscribing at a byte offset, writes input through ptyd,
takes checkpoints only at provably safe boundaries, and exits through a
leave-sessions path when it is being replaced. Without a reachable ptyd it
refuses to start and says that `cofluxd` needs updating, rather than falling
back to owning PTYs itself. On start it enumerates ptyd's
sessions, feeds each blob, replays the remaining ring, applies the resize log
at the recorded offsets, and only then starts the worker. `deltas_after` slices
by offset and gap reporting uses the ring start. A session that cannot be
rebuilt degrades alone.

Validation: `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker`
-> exit 0, zero warnings; `COFLUX_HOME= cargo test -p coflux-supervisor` -> exit 0,
including a checkpoint-boundary case that splits a stream carrying an OSC 133
mark at every byte position and asserts the eligibility predicate is false
inside the OSC and true after its terminator (the `COFLUX_HOME=` prefix is
required on a machine running Coflux: without it the presence and
shell-integration cases fail against the developer's own daemon).

### Milestone 4: the desktop updates the runtime without ending terminals

The desktop starts and tracks both processes, keeps ptyd running across a
supervisor replacement, drops the confirmation from the supervisor update path
while keeping it for stop, quit, logout and the separate ptyd update, restarts
the previous supervisor directory when the new one fails to come up, restarts a
crashed supervisor by itself, and keeps reporting live terminals from ptyd's
status while the supervisor is absent.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0, with named cases for the rollback path
(new directory fails to start -> previous directory started -> the runtime
marker file reverts to the previous id) and for automatic restart after a
supervisor crash; `pnpm -C apps/desktop build` -> exit 0.

### Milestone 5: the non-desktop runtime keeps ptyd alive across a restart

On the LaunchAgent and systemd paths that `cofluxd` generates, restarting the
supervisor does not take ptyd with it — systemd's default
`KillMode=control-group` would kill the whole cgroup on `systemctl restart`, so
ptyd needs its own unit or `KillMode=process`, and the launchd path needs an
explicit answer for who starts ptyd and how it survives the supervisor's
SIGTERM. Stopping the runtime deliberately still stops ptyd.

Validation: `pnpm -C tests test` -> exit 0, with a case that renders the
generated plist and unit text and asserts ptyd is present and independently
managed (the repository keeps no fixture files for these — they are template
functions inside `packages/cli/cofluxd.mjs`).

### Milestone 6: the black-box harness proves terminals survive a replacement

`spawnDaemon` starts ptyd alongside the supervisor and registers its process
group for teardown, so runs do not leak processes into each other. New cases
cover: a supervisor replacement with live sessions keeps the shells running and
the screens identical; output produced during the replacement is not lost and
sequence numbers stay contiguous; input in flight across the replacement is
applied exactly once; a killed supervisor recovers the same way; a wrapped ring
with a valid checkpoint still rebuilds correctly; and a supervisor running
against a ptyd that advertises a reduced op set still creates sessions and
carries input and output.

Validation: `pnpm -C tests test` -> exit 0.

## Landmines

- `crates/supervisor/src/sessions.rs:1070` — the production path really does
  call `take_writer()`; its `Drop` writes `\n`+EOT (`portable-pty`
  `unix.rs:351-363`). Any ptyd design that reuses that API puts an EOF into
  shells that should survive.
- `crates/supervisor/src/sessiond.rs:565-584` — `deltas_after` returns output
  only when `from_seq` is exactly `last + 1` at a batch boundary. Left as is,
  every client resume after a rebuild degrades to a full-screen snapshot,
  which would look like the feature not working.
- `crates/supervisor/src/sessiond.rs:226`, `:261` — the OSC 133 mark carries the
  session secret as the parameter `coflux=<secret>`. A replay boundary inside
  that OSC prints the secret into the screen and scrollback.
- `crates/supervisor/src/sessiond.rs:22-25` — logical-client identities are
  capped at 256 and must live to end of session; ptyd's cursor store inherits
  both properties, including "reject new identities at the cap, keep serving
  registered ones".
- `crates/supervisor/src/sessions.rs:104-138`, `:195-201` — output coalescing
  closes on either a 5 ms timeout or a 64 KiB byte cap, and the 64-record chunk
  queue is what paces the PTY today. Both the checkpoint eligibility gate and
  ptyd's stop-reading rule hang off this behaviour; "quiet" is ambiguous unless
  the implementation says which of the two closings it means.
- `crates/supervisor/src/sessiond.rs:477` — resize re-flows from the snapshot,
  vt100's `set_size` truncates. The two are not interchangeable during replay.
- `crates/supervisor/src/runtime_control.rs:110-118` — the `stop` op kills
  everything and exits. Reusing it for a supervisor replacement would end every
  terminal, which is the exact failure this plan exists to remove.
- `crates/supervisor/src/sessions.rs:491` — the `OperationLedger` does not
  survive a supervisor restart (stated in the proto). Once restarts become
  routine, an in-flight `create` can execute twice. Out of scope here; do not
  quietly "fix" it with a half measure.
- `crates/supervisor/src/main.rs:222-240` — the SIGTERM handler kills the worker
  and every registered PTY, then exits. Whatever starts ptyd must keep it out of
  that teardown, and out of the process group or cgroup the service manager
  signals.
- `apps/desktop/src/main/desktop-runtime.ts:83-90` and
  `apps/desktop/src/main/daemon-manager.ts:104` — `bundleRuntimeId` hashes all
  the bundled binaries plus the plugin manifest and any difference becomes
  "update ready". ptyd joining that set naively makes a supervisor-only update
  clear the flag while an older ptyd keeps running.
- `apps/desktop/test/config.test.ts:67-75` — the desktop config test checks
  `DAEMON_BINARIES` against `electron-builder.yml`'s `mac.binaries` pairwise,
  and `apps/desktop/scripts/stage-daemon.mjs:25` keeps its own copy of the
  list. All three move together or the test fails.
- `tests/package.json:7` and `.github/workflows/ci.yml:182,187` build an
  explicit crate list; a ptyd missing from them makes the black-box suite fail
  with a missing binary rather than a meaningful assertion.
- `Cargo.toml:6` — workspace members are an explicit list; a new crate that is
  not added is not built.
- `tests/src/harness.mjs:310-340` — `spawnDaemon` starts a detached process
  group and teardown kills that group. A ptyd started outside it survives the
  run and pollutes the next one.
- `packages/cli/cofluxd.mjs:354-359` and `:398-430` — the installer's component
  table and the plist/unit templates are plain functions listing supervisor,
  worker, cli and transport. There are no fixture files to edit.
- `scripts/release-sign.mjs:34-36` — the manifest is `schemaVersion: 2` with
  `worker` and `supervisor` statement sets only; adding a signed component
  changes the schema, and `tests/src/cli-release-trust.test.mjs` and
  `tests/src/release-sign.test.mjs` guard it.
- `apps/desktop/src/shared/desktop-bridge.ts:134` — a comment still says the
  action ends all local terminals; it stops being true for the supervisor
  update path.
- Testing on a machine that runs Coflux: `cargo test -p coflux-supervisor`
  without an empty `COFLUX_HOME` picks up the developer's own daemon and fails
  presence/shell-integration cases. Use `COFLUX_HOME= cargo test -p ...`.

## Scope

In scope:
- `crates/ptyd/` (new crate `coflux-ptyd`, library plus thin binary) and
  `Cargo.toml` workspace members
- `crates/protocol/src/ptyd.rs` (new module) and `crates/protocol/src/lib.rs`
- `crates/supervisor/src/sessions.rs`, `sessiond.rs`, `main.rs`, `manager.rs`,
  `runtime_control.rs`
- `apps/desktop/src/main/` (runtime lifecycle, daemon manager, paths, state),
  `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/renderer/components/workbench/daemon-view.ts` and the
  settings surface that renders those actions
- `apps/desktop/scripts/stage-daemon.mjs`, `apps/desktop/electron-builder.yml`,
  `apps/desktop/test/config.test.ts`
- `packages/cli/cofluxd.mjs` (component table, plist and unit templates)
- `scripts/release-sign.mjs` and the release-statement helper it uses
- `.github/workflows/release.yml`, `.github/workflows/desktop-release.yml`,
  `.github/workflows/ci.yml`
- `tests/package.json`, `tests/src/harness.mjs`, and new black-box cases
  alongside `tests/src/cli-release-trust.test.mjs` and
  `tests/src/release-sign.test.mjs`
- `docs/hot-upgrade-design.md`, `docs/architecture.md` — the three-process
  authority split replaces the stated "the supervisor cannot be hot-swapped"

Out of scope:
- ptyd's own hot upgrade — a ptyd change still ends terminals, through its own
  confirmed action; keeping the state in `mmap` files is the only concession
  made to a future in-place ptyd upgrade
- `OperationLedger` continuity across a supervisor restart — recorded as a known
  degradation
- Splitting `bundleRuntimeId` so worker-only changes skip the restart prompt —
  measured at one release in seven, and `SUPERVISOR_VERSION` is compiled in from
  the release tag (`crates/supervisor/src/main.rs:39`) so the supervisor's bytes
  change on every tag anyway
- Any change to the worker's own upgrade, signing or rollback machinery
- Windows

Left to the executor: the concrete ptyd↔supervisor message encoding, the layout
of the ring inside its `mmap` file, and the implementation of the checkpoint
eligibility predicate.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `CARGO_PROFILE_DEV_DEBUG=0 cargo build -p coflux-supervisor -p coflux-worker -p coflux-cli -p coflux-ptyd` | exit 0, zero warnings |
| ptyd tests | `COFLUX_HOME= cargo test -p coflux-ptyd` | exit 0 |
| Supervisor tests | `COFLUX_HOME= cargo test -p coflux-supervisor` | exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Black-box | `pnpm -C tests test` | exit 0 |
| Real-machine walkthrough (acceptance) | `pnpm dev:desktop:prod` | terminals survive a runtime update |

## Done criteria

- [ ] All listed commands pass.
- [ ] Replacing the supervisor binary leaves every live terminal running, with
      its screen contents and scrollback intact and input still accepted.
- [ ] Output produced while the supervisor is absent is delivered afterwards
      with contiguous sequence numbers; input in flight is applied exactly once.
- [ ] With no subscriber attached and a shell producing output continuously,
      ptyd stops reading rather than overwriting at or past the checkpoint
      offset, and a test asserts it.
- [ ] A supervisor that fails to start rolls back to the previous directory with
      terminals untouched, the runtime marker reverts, and the panel reports the
      failed update.
- [ ] A killed supervisor is restarted automatically and rebuilds its sessions.
- [ ] The supervisor update action no longer confirms; stop, quit, logout and a
      ptyd update still do.
- [ ] A supervisor running against a ptyd advertising a reduced op set still
      creates sessions and carries input and output, asserted in the black-box
      suite through the test-only op-advertisement switch.
- [ ] The checkpoint eligibility predicate is false at every byte position
      inside an OSC 133 mark and true after its terminator, asserted by
      splitting such a stream at every position.
- [ ] Every `terminal-data` file is `0600`, disappears when its session ends,
      and a file left behind by a killed ptyd is removed on the next start;
      the directory is excluded from backups.
- [ ] A supervisor started with no ptyd reachable exits with a message naming
      `cofluxd` update as the fix, and does not open a PTY itself.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.
- The ptyd protocol cannot be made forward-compatible in the sense above — a
  supervisor upgrade that requires a matching ptyd defeats the plan and needs
  the user's decision, not a workaround.
- Recovery cannot be made per-session, so one bad session would take down the
  supervisor.

## Maintenance notes

- ptyd's change rate is the whole asset. Every time something is about to be
  added to it, check it against the "must stay out" list in Direction: parsing,
  policy, protocol shapes and secrets belong to the supervisor. A ptyd that
  changes every release buys nothing.
- The ptyd protocol is a compatibility surface with the same seriousness as the
  center's wire protocol: it is what lets a new supervisor meet an old ptyd.
- `output_seq ≡ ring offset` is load-bearing in both directions. If sequence
  allocation ever stops being "one per output byte", the ring index, the resume
  semantics and the checkpoint offsets all break together.
- The first upgrade onto this architecture still ends terminals, by
  construction. Later plans should not re-litigate that.
- ptyd's own hot upgrade is the remaining gap. The intended route is `execve`
  self-replacement inside ptyd with the state already in `mmap` files and a
  `--selftest` child as the pre-flight — the same dyld/AMFI exposure that
  ruled `execve` out for the supervisor, but confined to a small program that
  rarely changes.
- The `terminal-data` files are the one place raw terminal output is persisted.
  Any future change that widens their lifetime, loosens their mode, or lets
  them survive a session is a product decision, not a cleanup.
