# Plan 20261023-terminal-da1-reply: A terminal's device-attributes query is answered even when no window is attached

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat d18aef5f..HEAD -- crates/runtime/src/sessiond.rs crates/runtime/src/sessions.rs crates/runtime/src/device.rs apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/terminal-attach.ts apps/desktop/src/renderer/components/workbench/terminal-control-state.ts packages/client/src/device-router.ts crates/ptyd/src/server.rs crates/protocol/src/ptyd.rs vendor/vt100/src/perform.rs`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent(opus) — from the departure check
- Stop after: implementation — from the departure check (plan audit chosen)
- Plan review: audit — ran before handoff (fable); findings folded in, see the Discussion log
- Workspace: isolated — the session started in the main worktree; this plan lives in `.claude/worktrees/20261023-terminal-da1-reply` on `dev/20261023-terminal-da1-reply`
- Planned at: `d18aef5f`, 2026-10-23

## Record

### Requirement

Opening a new terminal whose shell is fish ≥ 4.1 stalls for ten seconds and then
prints `warning: fish could not read response to Primary Device Attribute query
after waiting for 10 seconds`. fish sends a Primary Device Attributes query (DA1,
`CSI c` / `CSI 0 c`) at startup and waits for the terminal's `CSI ? … c` reply
(`fish-terminal-compatibility(7)`: failing to answer "will cause a brief pause at
startup followed by a warning").

Nobody answers because of how a Coflux terminal comes up. The runtime spawns the
shell on `sessionCreate`; the desktop attaches afterwards in a separate round
trip, and a first attach is always served an ANSI snapshot rendered from
sessiond's own VT grid, never the raw bytes. The query is parsed and swallowed by
sessiond's `vt100` parser, which never answers queries, so xterm.js — which does
answer DA1 — never sees it. The same gap hits any program that queries while no
client is receiving the raw output: terminals an agent drives with nobody
watching, and panes the desktop keeps attached but hidden (their replies are
dropped by the renderer's input gate).

Done means: every DA1 query a program emits gets **exactly one** reply — from the
attached client when one is receiving the raw output and can answer, otherwise
from sessiond — and nothing about how attached clients answer the other queries
(cursor position, OSC 10/11 colours, kitty keyboard, XTGETTCAP, …) changes. A
wrong-but-adjacent solution would answer DA1 twice, answer it out of order with
the client's other replies, or answer bytes replayed from history.

Not perceptible as a new surface: there is no new UI, command or copy. What the
user observes is that a fresh fish terminal shows its prompt immediately with no
warning.

### Decisions & tradeoffs

- **D1 Who answers**: sessiond answers a DA1 query if and only if the output
  chunk containing it is **not** being delivered raw to a holder that is an
  external client. "Delivered raw to an external-client holder" means all three
  hold at feed time: a holder exists, its identity is not an agent-synthetic one
  (D7), and the holder's channel is among the subscribers this very chunk is
  queued to as a live delta (not gapped, sequence-contiguous). In every other
  case — no holder, holder not yet subscribed, holder gapped, agent holder —
  sessiond answers. The decision is taken under the session lock that attach also
  takes, so it is atomic with respect to attach.
  Rejected: sessiond always answers and clients stop answering (the tmux model) —
  programs use DA1 as an end-of-queries sentinel (fish sends kitty-keyboard,
  XTVERSION, XTGETTCAP queries then DA1; nvim does the same with OSC 11); an
  instant local DA1 reply would overtake the client's networked replies and make
  programs conclude those features are unsupported in every attached terminal.
  Rejected: "answer iff no subscriber exists" — agent IO attaches through a
  synthetic channel and never detaches, so that channel stays a subscriber and a
  headless agent terminal would never be answered.
  Based on: first attach is snapshot-only (`crates/runtime/src/sessiond.rs:1187-1208`,
  `packages/client/src/device-router.ts:1994`); agent attach without detach
  (`crates/runtime/src/device.rs:2106-2178`); the device layer's own notion that
  an agent holder is not a human (`crates/runtime/src/device.rs:1925-1930`);
  holder/subscriber bookkeeping (`crates/runtime/src/sessiond.rs:1110-1130`,
  `1210-1217`); a failed Attached send removes the subscriber but keeps the
  holder (`crates/runtime/src/sessions.rs:2211-2215`), which lands in "sessiond
  answers".

- **D2 DA1 only, answered as xterm.js answers it**: sessiond recognises `CSI c`
  and `CSI 0 c` — no private-marker byte (`<`, `=`, `>`, `?`), no intermediate
  byte, every parameter value 0 — and answers each one with `ESC [ ? 1 ; 2 c`,
  byte-identical to xterm.js, so a program sees the same terminal whoever
  answered. Any other parameter (`CSI 1 c`), any private marker (`CSI > c` DA2,
  `CSI = c` DA3, `CSI ? … c` replies) is ignored.
  Rejected: also answering DA2, CPR, OSC 10/11, XTGETTCAP — the runtime cannot
  know a client's colours, and under the DA1-sentinel convention an unanswered
  query correctly reads as "unsupported".
  Based on: xterm.js `sendDeviceAttributesPrimary` answers `\x1b[?1;2c` for
  `TERM` xterm and ignores a non-zero parameter (`node_modules/.pnpm/@xterm+xterm@6.1.0-beta.304/…/lib/xterm.js`);
  vendored vt100 routes `CSI c` with no intermediate to
  `Callbacks::unhandled_csi(None, None, …, 'c')` and markers through its
  `Some(i)` branches (`vendor/vt100/src/perform.rs:157-192`); vte 0.15 reports
  both `CSI c` and `CSI 0 c` as params `[[0]]`.

- **D3 Replies only for live output**: a reply is written only for bytes fed
  from the live ptyd subscription. Bytes re-fed while rebuilding a session after
  a runtime swap (checkpoint + ring replay) and canonical snapshots re-parsed on
  resize or restore never produce a written reply.
  Rejected: answering re-fed bytes — most of them were live under the previous
  runtime, which already answered them or saw a client receive them.
  `(revised on plan audit)` The re-fed range also contains the bytes the program
  wrote between the old runtime's last read and the new runtime's subscription;
  no runtime saw those. They are not answered either, because sessiond cannot
  tell where the old runtime stopped reading (see Maintenance notes).
  Based on: live feed `crates/runtime/src/sessions.rs:1424`; recovery re-feed
  `crates/runtime/src/sessions.rs:1713-1751`; the new reader subscribes from
  `info.output_offset` (`crates/runtime/src/sessions.rs:1707`, `1822`).

- **D4 Write path**: replies go through the session's existing ordered input
  queue and writer thread, so they never reorder relative to agent input. They
  are written to ptyd under **one fixed reserved identity**,
  `__coflux-sessiond-reply`, whose input sequence is contiguous and advances only
  on a write ptyd confirmed. A new session starts it at 0; a rebuilt session
  resumes it from the cursor ptyd lists for that identity (0 if none); a rebuild
  without ptyd cursors (`cursorless_rebuild`) disables replies for that session.
  Reply records never touch client input bookkeeping (reservations, completion,
  acks, failures).
  Rejected: a fresh identity per runtime instance — ptyd caps logical identities
  at 256 per session and every hot upgrade would consume one. Rejected: writing
  replies on a side connection that bypasses the queue — it would reorder against
  agent input. Rejected: restarting the sequence at 0 after a rebuild — every
  reply is byte-identical, so ptyd would classify the restarted sequence numbers
  as duplicates and silently skip writing them.
  Based on: ptyd cursor rules (`crates/ptyd/src/server.rs:455-504`: a seq at or
  below the cursor with identical payload returns `Written { duplicate: true }`
  without writing, a new identity must start at 1, `input_seq_gap` otherwise),
  which `PtydInputSink::write` maps to `Ok(())` (`crates/runtime/src/sessions.rs:705-707`);
  `PTYD_LOGICAL_CLIENT_LIMIT = 256` (`crates/protocol/src/ptyd.rs:48`); ptyd
  lists every identity's cursor (`crates/ptyd/src/server.rs:565-578`) and the
  rebuild reads them back (`crates/runtime/src/sessions.rs:1766-1784`);
  `complete_input` debug-asserts a transport binding and an `Err` there kills the
  session (`crates/runtime/src/sessiond.rs:1491-1500`, `crates/runtime/src/sessions.rs:1229-1245`).

- **D5 No double reply on resume** `(revised on plan audit)`: sessiond keeps a
  marker — the output seq of the **final byte** of the latest DA1 query D1
  assigned to sessiond (whether or not a reply was actually written, so recovery
  re-feed marks too). An attach whose `resume_from_seq` is below the marker —
  the client has not received that byte — is served a snapshot instead of a local
  or ring replay. The marker is saved in the checkpoint header as an additive,
  `serde(default)` field (the checkpoint format version does not change), and a
  degraded rebuild that discards its restored state carries the marker over.
  Scenario it closes: the laptop sleeps, an agent launches fish on the remote
  device, sessiond answers; the desktop wakes and resumes with replay, and xterm.js
  would answer the same query again into whatever is running by then.
  Rejected: a chunk-granular marker (the chunk's `to_seq`) — recovery re-feeds in
  reads of up to 1 MiB from the last checkpoint (every 2 MiB), so any young fish
  terminal would get a marker near the end of the ring and nearly every resume
  after a hot upgrade would become a full redraw. Rejected: a protocol flag
  telling clients to suppress replies while replaying — a wire change in both
  protocol packages for a rare case. Rejected: forcing a snapshot for every resume
  after a rebuild — a needless full redraw on every hot upgrade.
  Based on: attach fallback to snapshot (`crates/runtime/src/sessiond.rs:1202-1208`);
  the client uses `ansiSnapshot` whenever present regardless of what it asked for
  (`packages/client/src/device-router.ts:1937-1940`); header policy "new optional
  fields don't bump the version" and no `deny_unknown_fields`
  (`crates/runtime/src/sessiond.rs:780-793`); re-feed read size
  `PTYD_MAX_READ_BYTES` (`crates/protocol/src/ptyd.rs:45`, `crates/runtime/src/sessions.rs:1715-1723`);
  the degraded branch `if !replay_ok { state = SessionState::new(..) … }`
  (`crates/runtime/src/sessions.rs:1755-1760`).

- **D6 Hidden attached panes answer**: the desktop forwards xterm.js `onData`
  for a pane whether or not it is visible, keeping the control-state and session
  checks. A hidden pane has no keyboard focus, so what it emits is xterm.js's
  automatic replies and focus reports. The resize gate keeps its visibility check.
  Rejected: detaching hidden panes — changes the attach model for a one-line gap.
  Based on: the gate `terminal-pane.tsx:755-758` (dates from the original
  multi-terminal workbench, no recorded reason); hidden panes stay attached and
  keep receiving output (`terminal-pane.tsx:932-939`); one controller per task
  (`apps/desktop/src/renderer/components/workbench/terminal-attach.ts:59`), so no
  second xterm can answer the same session; `canSendTerminalInput` allows
  `owned` and `attaching` (`terminal-control-state.ts:19-21`).

- **D7 Recognising an agent holder** `(decided while planning)`: by the
  `__coflux-agent-` prefix the device layer already mints for agent identities,
  with one shared definition used by both the device layer and sessiond.
  Rejected: a new field on `DeviceSessionAttach` — a wire change for something
  the runtime already knows internally.
  Based on: `const AGENT_CHANNEL_PREFIX` (`crates/runtime/src/device.rs:56`) and
  `fresh_agent_client_instance_id` (`crates/runtime/src/device.rs:4789-4793`).

- **D8 Where DA1 is recognised** `(revised on plan audit)`: in sessiond's
  per-byte `DecModeScanner`, which already follows vte's escape/CSI/string states
  for every byte of fed output, so each query is known at its exact byte offset
  (D5 needs that). The scanner runs only on output passed through
  `TerminalState::feed`; snapshot re-parses on resize and restore call the parser
  directly and therefore never detect anything (D3). vt100's own routing is the
  test oracle.
  Rejected: counting in vt100's `unhandled_csi` callback — the callback carries
  no byte offset, so only a chunk-granular marker would be possible.
  Based on: `DecModeScanner` and its vte-parity tests
  (`crates/runtime/src/sessiond.rs:33-267`, `2003-2025`); `TerminalState::feed`
  runs it per byte (`crates/runtime/src/sessiond.rs:457-487`).

### Discussion log

- The user pasted fish's warning and asked whether it is a Coflux bug. Diagnosis:
  yes — the shell's DA1 is swallowed by sessiond before any client attaches
  (spawn on create, snapshot-only first attach, vt100 never answers), and hidden
  panes drop xterm's replies.
- The user ran `/dev:explore` with "design plan, start fixing". Exploration
  surfaced the sentinel-ordering problem (rejecting the tmux model), the lingering
  agent subscriber (rejecting "answer iff no subscriber"), the recovery re-feed
  and the resume double-answer.
- Departure check, Direction: options "Approve (recommended)" / "Daemon only"
  (skip the desktop hidden-pane change) / "Always answer in daemon" (tmux model).
  Answer: **Approve**. Settled D1–D6.
- Departure check, Execution: subagent(opus) recommended over sonnet / fable /
  self. Answer: **Subagent (opus)**.
- Departure check, Autopilot: plan audit recommended over plain autopilot /
  review pause. Answer: **Plan audit** — `Stop after: implementation`,
  `Plan review: audit`.
- `(decided while planning)` D7: agent detection by the existing prefix, one
  shared constant.
- `(decided while planning)` D4 detail: the reserved identity is fixed as
  `__coflux-sessiond-reply` now, because ptyd persists cursors by identity and a
  later rename would orphan them; the reply sequence is owned by the writer thread
  and advances only on a confirmed write, so a dropped or rejected reply never
  leaves a sequence gap.
- `(revised on plan audit)` The audit (fable) found the chunk-granular marker
  would turn nearly every post-upgrade resume into a redraw: D5 now marks the
  query's final byte, and D8 moves detection into the byte scanner. It also found
  the degraded rebuild discards the marker (now carried over, D5), that D3's
  rationale missed the swap-pause tail (corrected; accepted residual), that
  leaving `feed`'s signature open would force edits to existing tests (the brief
  now fixes drain methods instead), a second comment that becomes false on the
  desktop, why the reply sequence must resume rather than restart (ptyd's silent
  duplicate rule, now in D4), and concrete details for the live-path test. All
  findings were accepted.

### Maintenance notes

- Accepted residual: a human holder whose channel died without sessiond being
  told (no channel-close signal reaches sessiond) still counts as receiving raw
  output, so a query emitted then goes unanswered until that client resumes and
  its xterm answers late — today's behaviour.
- Accepted residual: a DA1 the program emits during a hot upgrade's swap pause
  (after the old runtime's last read, before the new one subscribes) is re-fed,
  not answered, and marked, so a client resuming over it gets a snapshot and does
  not answer it either: that program waits out its timeout, as today.
- Accepted residual: a degraded rebuild that fails its ring replay carries over
  only the marker it had learned before the failure; a query further along the
  ring can still be replayed to a resuming client and answered a second time.
- Accepted residual: an unattended terminal now behaves like a real one — a DA1
  that appears in `cat`'d binary output gets a reply typed into the shell, as in
  Terminal.app.
- Accepted residual: a reply dropped because the input queue is full, or one ptyd
  rejects by cursor, is not retried.
- The identity `__coflux-sessiond-reply` is persisted in ptyd cursors and uses one
  of the 256 logical-identity slots per session. Never rename it.
- Unverified (audit hunch): the `__coflux-` identity namespace is not enforced on
  a client's `clientInstanceId` over every transport (the tailcat path rejects it
  only on `channelId`, `apps/server/src/tailcat-rendezvous.ts:66`). A client of
  the same account presenting such an identity could be classed as an agent or
  share the reply cursor; it gains nothing it could not do by typing.
- If sessiond ever answers more queries, D1's rule and D5's marker apply to them
  unchanged. If the desktop ever renders one session in two xterms, D6 produces
  double replies.

## Execution brief

> Written for `subagent(opus)` at `d18aef5f`. Implement the tasks in order.
> Decide only what Your call leaves to you; on anything else that is unclear,
> stop and report.

### Goal

fish (and any program) sends a DA1 query, `ESC [ c` or `ESC [ 0 c`, and waits for
a `ESC [ ? … c` reply. In Coflux the shell starts before any client attaches, a
first attach receives a rendered snapshot rather than raw bytes, and sessiond's
vt100 parser never answers, so the query is lost and fish stalls ten seconds.

Make sessiond the fallback answerer: when the bytes containing a DA1 query are not
being delivered raw to an attached human client (which answers through xterm.js),
sessiond writes `ESC [ ? 1 ; 2 c` into the PTY itself, exactly once per query,
through the session's ordered input writer. Guard the two ways that could produce
a second reply: re-fed history after a runtime swap never produces a written
reply, and a client resuming over a query sessiond answered gets a snapshot
instead of a replay. On the desktop, let a hidden-but-attached pane forward
xterm.js's own replies.

Conventions: the runtime crate is `coflux-runtime`; sessiond's pure state core
(`sessiond.rs`) is unit-tested in its own `mod tests`, and `sessions.rs` has
tests that drive an in-process ptyd with a real child process
(`test_sessions`, `create_session_for_test`). Write new or updated comments in
English (repository policy), matching the surrounding comment density. The build
must stay warning-free (CI uses `RUSTFLAGS=-D warnings`). There is no Rust
formatter gate; the desktop renderer is linted by oxlint. Existing tests must
keep passing **unchanged** — the API shapes below are chosen so that they can.

### Milestone 1: sessiond's state core recognises DA1 and decides who answers

Depends on: none. Files: `crates/runtime/src/device.rs` (T1 only), `crates/runtime/src/sessiond.rs`.

#### T1 · One definition of the agent identity prefix

- Where: `crates/runtime/src/device.rs` — `const AGENT_CHANNEL_PREFIX: &str = "__coflux-agent-";`
- Change: make a single crate-visible definition that both `device.rs` and the T4 check in `sessiond.rs` use (D7).
- After: `device.rs` behaves exactly as before; there is exactly one string literal `"__coflux-agent-"` in the crate's non-test code.

#### T2 · The byte scanner recognises a completed DA1 query

- Where: `crates/runtime/src/sessiond.rs` — `struct DecModeScanner`, `enum ScanState` (`Csi { … }`), `impl DecModeScanner` → `fn feed(&mut self, byte: u8) -> Option<AltEvent>`
- Change: make the scanner recognise the final byte of a DA1 query (D2, D8): a CSI whose final byte is `c`, in phase `Entry` or `Parameter` (not `Intermediate`, not `Ignore`), with no private-marker byte `0x3c..=0x3f` anywhere at entry, and every parameter value 0 (no parameters counts as 0). The current `private` flag only records `?`, so this needs its own state.
- After: for each byte, it is known whether that byte completed a DA1 query. Tests (input → completions, bytes fed one at a time): `\x1b[c` → 1 at the `c`; `\x1b[0c` → 1; `\x1b[0;0c` → 1; `\x1b[c\x1b[0c` → 2; `\x1b[?1;2c` → 0; `\x1b[>c` → 0; `\x1b[>0c` → 0; `\x1b[=c` → 0; `\x1b[1c` → 0; `\x1b[ c` (intermediate) → 0; `\x1bc` (RIS) → 0; `\x1b]0;[c\x07` → 0 (`[c` is OSC payload); `\x1bP[c\x1b\\` → 0 (DCS payload). Add an oracle test in the style of `assert_dec_scanner_matches_vt100`: a `vt100::Parser` whose callbacks count `unhandled_csi(None, None, params, 'c')` with all-zero params must agree with the scanner's count on every input above, including splits across chunk boundaries (`\x1b[` then `c`).
- Don't: change `feed`'s `Option<AltEvent>` return or add a variant to `AltEvent` — `assert_dec_scanner_matches_vt100` collects every event and compares it to alt-screen transitions only, so a new event kind breaks existing tests. Surface the DA1 completion through a separate flag or method.
- Don't: scan for the byte pattern outside the scanner's state machine (D8); bytes inside OSC/DCS strings and split sequences must follow vte's rules.

#### T3 · `TerminalState::feed` records the offset of every DA1 query it fed

- Where: `crates/runtime/src/sessiond.rs` — `pub fn feed(&mut self, bytes: &[u8]) -> Option<Delta>` in `impl TerminalState`, the loop `let Some(event) = self.mode_scanner.feed(byte) else {`
- Change: while the loop walks the bytes, record the output seq of each byte that completed a DA1 query (`from_seq + index`, where `from_seq` is this delta's first seq). Expose them through a drain method on `TerminalState`. Keep the return type `Option<Delta>`. The DA1 check must run for every byte, including bytes the loop currently skips with `continue` because they produced no alt event; it must not split the chunk for `parser.process` (only alt events split it).
- After: after `feed`, the drain returns the seqs of the DA1 queries completed in that chunk, in order, and is empty after being drained. `TerminalState::resize` and `TerminalState::restore` call `parser.process` on canonical snapshots directly and never record anything. Keep it that way.

#### T4 · `SessionState::feed` decides whether sessiond answers and records the marker

- Where: `crates/runtime/src/sessiond.rs` — `impl SessionState`, `pub fn feed(&mut self, bytes: &[u8]) -> Vec<PendingDelta>`
- Change: keep the signature. Add a session-level reply buffer, **replaced** (not appended to) on every `feed` call, and a drain method for it. After building `pending`, if the chunk completed any DA1 queries, decide per D1. An external-client holder receiving raw output means three things:
  - `self.holder` is `Some`.
  - Its `client_instance_id` does not start with the T1 prefix.
  - Its `channel_id` is one of the `channel_id`s in this call's `pending`.
  If that is not the case, fill the buffer with one `b"\x1b[?1;2c"` per query, and set the marker (D5) to the seq of the last of those queries' final bytes, never lowering it. `feed` never writes anything itself.
- After (tests, each on a fresh `SessionState`):
  - No holder; feed `\x1b[c` → the drain returns one `\x1b[?1;2c`, and the marker equals that chunk's `to_seq` (the `c` is its last byte).
  - Human holder attached (`attach` with `resume_from_seq: None`); feed `\x1b[c` → no replies, marker unchanged.
  - Human holder attached, then `delivery_result(channel, to_seq, false)` so its subscriber is gapped; feed `\x1b[c` → one reply.
  - Holder whose `client_instance_id` starts with `__coflux-agent-`; feed `\x1b[c` → one reply.
  - No holder; feed `\x1b[c\x1b[0c` → two replies.
  - No holder; feed `x\x1b[cyyyy` → marker = seq of the `c` (4), not the chunk's `to_seq` (8).
  - No holder; feed `hello` → no replies, marker unchanged; a reply buffer left over from an earlier `feed` is gone.
- Don't: treat "a subscriber exists" as "someone answers". Agent channels stay subscribed after their write (D1).

#### T5 · Resuming over an answered query falls back to a snapshot

- Where: `crates/runtime/src/sessiond.rs` — `fn attach_inner`, at `let local = resume_from_seq` and the `from_ring` match that follows
- Change: when `resume_from_seq` is `Some(seq)` with `seq < marker`, use neither the local retransmit buffer nor the ring. Take the existing snapshot branch: `snapshot_seq = output_seq`, `ansi_snapshot = Some(..)`, empty `replay`.
- After (tests): no holder; feed `a` (seq 1), then feed `\x1b[c` (seqs 2–4, marker 4).
  - Attach with `resume_from_seq: Some(1)` → `ansi_snapshot` is `Some`, `replay` empty.
  - `Some(3)` (the client has `ESC [` but not the `c`) → snapshot.
  - `Some(4)` → `ansi_snapshot` is `None`, as today.
  - With marker 0, the existing resume behaviour and tests are unchanged.

#### T6 · The marker survives a sessiond rebuild

- Where: `crates/runtime/src/sessiond.rs` — `struct CheckpointHeader`, `pub struct Checkpoint`, `impl Checkpoint` (`header`, `decode`), `TerminalState::checkpoint`, `TerminalState::restore`
- Change: carry the marker in `Checkpoint` and in `CheckpointHeader` as an additive field with `#[serde(default)]`; restoring from a checkpoint restores it. Leave `CHECKPOINT_FORMAT_VERSION` at 1. Also give the rebuild path a way to read the marker from one `SessionState` and set it on another (T9 needs it).
- After (tests): checkpoint → `encode` → `decode` → restore keeps the marker. A header JSON written without the field still decodes, with marker 0.
- Don't: bump `CHECKPOINT_FORMAT_VERSION` (D5). A bump makes every older runtime discard the checkpoint on rollback.

### Milestone 2: The runtime writes sessiond's replies into the PTY

Depends on: Milestone 1. File: `crates/runtime/src/sessions.rs`.

#### T7 · The input writer accepts sessiond replies

- Where: `crates/runtime/src/sessions.rs` — `struct QueuedInput`, `fn spawn_input_writer`, and its three call sites:
  - `fn create_session`
  - the session-recovery function, at the block commented `// 5) 挂上 writer 与订阅，登记为存活 session。`
  - `fn create_session_for_test`
- Change: let the queue carry reply records alongside client input. The writer thread owns the reply sequence: it writes a reply under the identity `__coflux-sessiond-reply` with `input_seq = last confirmed + 1`, and advances only when the write returns `Ok`. The starting value is passed in when the writer is spawned:
  - A new session starts at 0.
  - A recovered session whose cursors were restored starts at the seq ptyd listed for `__coflux-sessiond-reply` in step 4 (`self.ptyd.cursors(&session_id)`), or 0 if that identity is absent.
  - A recovered session that set `cursorless_rebuild` has replies disabled: reply records are dropped with a log line.
  For a reply record:
  - Success: nothing else happens. No `complete_input`, no ack.
  - ptyd rejects it by cursor (`failure.rejected.is_some()`): log and continue.
  - Teardown EIO (`is_teardown_write_failure`): kill and break, exactly as for client input.
  - Any other failure: log, kill the session and break, as for client input, but without `fail_input` and without `send_device_error`.
  The restore loop in step 4 may keep loading the reply identity's cursor into `input_cursors` like any other identity; it needs no filter.
- After: client input handling is unchanged, and every existing `sessions.rs` test still passes untouched. The reply identity's sequence as written to ptyd is 1, 2, 3, … with no gaps and no repeats across a rebuild.
- Don't: start a recovered session's reply sequence at 0 when ptyd listed a cursor (D4). ptyd treats a seq at or below its cursor with an identical payload as a duplicate and returns success **without writing**, and every reply is byte-identical, so replies would vanish silently.
- Don't: call `complete_input`, `reject_pending_input` or `fail_input` for a reply record. `complete_input` debug-asserts the identity has a transport binding, and an `Err` from it kills the session (D4).
- Don't: mint a new reply identity per runtime instance or per reply (D4).

#### T8 · The live reader enqueues replies

- Where: `crates/runtime/src/sessions.rs` — `fn spawn_reader`, at `let pending = locked.state.feed(&batch);`
- Change: right after `feed`, drain the replies (T4) and enqueue each one with `locked.input.try_send(..)` while the session lock is still held, so ordering against attach and feed stays atomic. A `Full` or `Disconnected` queue drops the reply with a log line.
- After: a live session with no holder whose program writes `\x1b[c` receives `\x1b[?1;2c` on its stdin. Required test, in the `sessions.rs` test module:
  - Build the sessions with `test_sessions(outbound, <script path>)`, where the script is an executable file you write to a temp dir. The session's shell is spawned with just that path as argv and `PATH=/usr/bin:/bin`.
  - The script runs `stty raw -echo`, writes `\033[c`, reads 7 bytes (`dd bs=1 count=7 2>/dev/null`), prints them through `cat -v` (which renders `ESC` as `^[`, so the output contains `^[[?1;2c`), then sleeps a few seconds so the screen stays. `od -c` would space the characters out and break the assertion.
  - Create the session with `create_session_for_test(id, Some(Box::new(PtydInputSink(sessions.ptyd.input_channel().unwrap()))))`. Do not attach a holder: `live_session_for_test` attaches `client-a`, so don't use it.
  - Poll `handle.lock().unwrap().state.snapshot()` until it contains `?1;2c`, with a timeout. `test_sessions` sets `history_line_limit = 0`, but the viewport still renders.
- Don't: enqueue replies from anywhere else (D3).

#### T9 · Rebuilding a session writes no replies and keeps the marker

- Where: `crates/runtime/src/sessions.rs` — the session-recovery function:
  - the ring replay at `state.feed(chunk);` and `state.feed(&data);`
  - the degraded branch `if !replay_ok {` that does `state = SessionState::new(..)`
- Change: in the ring replay, never drain-and-enqueue. The buffered replies are discarded: the next `feed` replaces them (T4), and nothing between here and the live reader drains them. In the degraded branch, carry the marker from the state being discarded over to the new one (D5).
- After: a rebuilt session writes no reply for any re-fed byte. After a degraded rebuild, the marker is at least what the discarded state had. The test helper at `let pending = state.feed(frame);` keeps ignoring replies.
- Don't: add a branch that answers "the tail" of the re-fed range (D3).

### Milestone 3: A hidden, attached desktop pane still answers the program's queries

Depends on: none. It is independent of Milestones 1–2 (disjoint files). File: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`.

#### T10 · The input gate no longer requires visibility

- Where: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`:
  - the `terminal.onData((data) => {` handler
  - the comment above it, `// 输入/resize 的门控见 terminal-control-state.ts（输入含 attaching，尺寸只在 owned）。`
  - the comment in the effect that releases the caret on focus loss, ending `— input is gated on \`visible\`, not \`focused\`.`
- Change: drop `visible` from the `onData` condition, keeping `canSendTerminalInput(controlState) && sessionId`, and stop destructuring `visible` there. Rewrite the first comment in English: input (including xterm.js's automatic replies to terminal queries) flows whenever this client may send input, even while the pane is hidden. A hidden pane has no keyboard focus, so what it emits is the program's own query replies. Resize stays gated on visibility and ownership. Correct the second comment so it no longer says input is gated on `visible`; keystrokes would still reach a pane that keeps the caret.
- After: a hidden pane whose control state is `owned` or `attaching` forwards xterm.js `onData` to `sendInput`; visible panes behave exactly as before.
- Don't: change the `terminal.onResize` gate, the OSC 52 handler or the paste handler. Those keep their visibility and focus checks (D6).

### Your call

- Where the marker lives (`TerminalState` or `SessionState`), as long as T5 reads it, T6 persists it and T9 can carry it over.
- Names of the drain and marker methods, and how reply records are represented in the queue (a field, an enum).
- How the scanner tracks "no marker byte" and "all parameters zero".
- Where the shared agent prefix constant lives, and its name.
- Test names, the exact T8 script, and any extra tests you consider proportionate.

### Landmines

- `feed`, `attach` and the enqueue in T8 all run under `session.lock()`. The writer thread locks the session after a write. Never block on the queue while holding the lock: `try_send` is non-blocking and must stay that way (`crates/runtime/src/sessions.rs` — `fn try_send`).
- `crates/ptyd` must not change: a ptyd change is the one update that ends live terminals. Everything here uses ptyd's existing write and cursor operations.

### Scope

In scope:
- `crates/runtime/src/sessiond.rs`
- `crates/runtime/src/sessions.rs`
- `crates/runtime/src/device.rs` (the prefix constant only)
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`

Out of scope:
- `crates/ptyd/**` — must not change (see Landmines).
- `crates/protocol/**`, `packages/protocol/**`, `proto/**` — no wire change.
- `packages/client/src/device-router.ts` — it already handles a snapshot answer to a resume.
- `vendor/vt100/**` — used only as the test oracle.
- `apps/ios/**`, and the frozen web clients.
- Answering any query other than DA1.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- The vt100 oracle disagrees with the scanner on an input the tasks list, after you have checked both.
- ptyd's `cursors` listing does not include an identity that has written, so T7 cannot resume the reply sequence after a rebuild.
- An existing test in `sessiond.rs` or `sessions.rs` needs its expectations changed to pass.

## Verification

### Milestone validations

- Milestone 1: `COFLUX_HOME= RUSTFLAGS='-D warnings' cargo test -p coflux-runtime sessiond::` → all pass, including the new T2–T6 tests.
- Milestone 2: `COFLUX_HOME= RUSTFLAGS='-D warnings' cargo test -p coflux-runtime` → all pass, including the T8 test. Also `RUSTFLAGS='-D warnings' cargo build -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` → exit 0.
- Milestone 3: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop lint && pnpm -C apps/desktop test` → exit 0.

`COFLUX_HOME=` is needed locally because an inherited Coflux environment pollutes the runtime's tests.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust unit tests | `COFLUX_HOME= RUSTFLAGS='-D warnings' cargo test -p coflux-protocol -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | exit 0 |
| Rust zero-warning build | `RUSTFLAGS='-D warnings' cargo build -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | exit 0 |
| Desktop gates | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop lint && pnpm -C apps/desktop test` | exit 0 |
| Black-box (acceptance) | `pnpm dev:pg` running, then `env -u FORCE_COLOR pnpm -C tests test` | all pass. Required by AGENTS.md because the checkpoint header is on the hot-upgrade path; never run two suites at once |
| Manual (acceptance) | local stack with this branch's daemon, then open a new terminal whose shell is fish ≥ 4.1 | prompt appears immediately; no "Primary Device Attribute" warning |

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] A DA1 query with no holder gets exactly one `\x1b[?1;2c` from sessiond (T4 tests). The reply reaches the program through the real writer and ptyd (T8 test).
- [ ] A DA1 query delivered raw to an attached human holder is not answered by sessiond (T4 test).
- [ ] The marker is the seq of the query's final byte, not of its chunk's end (T4 `x\x1b[cyyyy` test).
- [ ] A resume whose replay would deliver a sessiond-answered query's final byte is served a snapshot (T5 tests, including `Some(3)`).
- [ ] The scanner agrees with the vt100 oracle on every listed input (T2 test).
- [ ] Recovery re-feed writes no reply, and the degraded branch carries the marker over. Read the diff of the recovery function.
- [ ] A recovered session's reply sequence starts from ptyd's listed cursor for `__coflux-sessiond-reply`, not from 0. Read the diff.
- [ ] Reply records never reach `complete_input`, `reject_pending_input` or `fail_input`. Read the diff.
- [ ] `CHECKPOINT_FORMAT_VERSION` is unchanged and an old header still decodes (T6 test).
- [ ] No existing test's expectations changed: `git diff d18aef5f..HEAD -- crates/runtime/src` touches no existing `assert` lines.
- [ ] `git diff --stat d18aef5f..HEAD -- crates/ptyd crates/protocol packages/protocol proto vendor` is empty.
- [ ] The desktop `onResize` gate still checks `visible`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Ships in one `v*` release: the runtime half reaches daemons through the launcher's auto-update; the desktop half (hidden panes) arrives with the desktop update. Either half alone is safe. An old desktop with a new runtime keeps today's hidden-pane gap; a new desktop with an old runtime keeps today's startup gap.
- ptyd is untouched, so the hot upgrade keeps every terminal alive. The new checkpoint field is additive: a rollback to an older runtime ignores it, because serde ignores unknown fields and the header has no `deny_unknown_fields`.
- Each session that ever gets a sessiond reply uses one of ptyd's 256 logical-identity slots for `__coflux-sessiond-reply`.
- Release note: new terminals no longer pause ten seconds or print fish's "Primary Device Attribute" warning, including terminals no window is showing.
- Manual acceptance needs the local stack (`pnpm dev:pg`, `pnpm dev:server`, this branch's `pnpm dev:daemon`, `pnpm -C apps/desktop dev`). `pnpm dev:desktop:prod` would talk to the installed runtime, which does not contain the fix.
