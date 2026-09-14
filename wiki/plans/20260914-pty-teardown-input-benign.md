# Plan 20260914-pty-teardown-input-benign: Closing a terminal stops reporting its own teardown as an error

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 9e47df6c..HEAD -- crates/supervisor/src/sessions.rs crates/supervisor/src/sessiond.rs crates/supervisor/Cargo.toml packages/client/src/device-router.ts apps/desktop/src/renderer/components/workbench/workbench.tsx packages/swift-client/Sources/CofluxClientCore/DeviceRouter.swift`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent opus — from the departure check
- Stop after: implementation — from the departure check's autopilot item
- Plan review: advisor — from the departure check's autopilot item
- Workspace: isolated — `dev/20260914-pty-teardown-input-benign`
- Planned at: `9e47df6c`, 2026-09-14

## Requirement

Closing a terminal in the desktop app frequently raises a red error toast in the
bottom-right corner that the user has to dismiss by hand:

```
PTY input 写入失败，session 已终止：Input/output error (os error 5)
```

Nothing is actually wrong. `EIO` on a PTY master write has exactly one meaning:
the slave end has no open file descriptor left — the shell is gone. Closing a
terminal goes `client.closeTask` → `stopSession` → `device_stop` →
`child.kill()` (`crates/supervisor/src/sessions.rs:1806`), so the shell dies by
design; any byte still in flight toward that PTY then fails, and the supervisor
reports the expected end of the session's life as a fatal error.

The bytes in flight are not user keystrokes. In this device's
`~/.coflux/daemon.log` all 16 occurrences carry `written=0` with a fixed payload
size of 12 or 13 bytes (one of 3), and every one shares its millisecond
timestamp with that session's `session exited` line, printed just after it.
Those are the terminal's own automatic replies: the frontend xterm.js answers
capability queries on its own (its lib carries the secondary-DA reply
`>0;276;0c`), and the 3-byte payload matches a focus-out `\x1b[O`. The shell was
killed while its terminal's reply was still on the wire.

The user reported this under fish, and fish is indeed the worst case: it
renegotiates terminal protocols around every prompt and every command, so the
density of in-flight automatic replies is far higher than zsh or bash. But fish
is an amplifier, not the cause — fish is not even installed on the device whose
log holds those 16 entries; they all come from zsh sessions running the Claude
Code and codex TUIs, which issue the same queries. Any fix keyed to fish would
be fixing the wrong thing.

When this is done: closing a terminal — under any shell, with any TUI running —
never produces a user-visible error for the teardown itself. The supervisor
still records what happened in its log, real write failures are still reported,
and the PTY byte-stream integrity guarantee that makes partial writes fatal is
untouched. No client changes are needed, so existing desktop builds and the iOS
app get the fix as soon as the daemon is updated.

## Decisions & tradeoffs

- **What counts as benign**: a write failure with `written == 0` **and**
  `raw_os_error() == Some(libc::EIO)`. Rejected: treating every write failure as
  benign — a genuine failure (a bad descriptor, a writer that stops advancing)
  would then be invisible to the user and to the log reader. Rejected: matching
  on `std::io::ErrorKind` — Rust has no stable `ErrorKind` for `EIO`; it
  surfaces as the unstable `Uncategorized`, so only the raw errno is a legal
  test. `libc` is already a dependency (`crates/supervisor/Cargo.toml:17`).
  Based on: `crates/supervisor/src/sessions.rs:558`.

- **Partial writes stay fatal**: a failure with `written > 0` keeps today's
  behaviour — fail the input, kill the child, report the error. Rejected:
  extending benign treatment to partial writes — some bytes did reach the PTY,
  so the stream can no longer be proven intact and a retry would replay a
  written prefix. This is the reason the current code is strict, and it is not
  being relaxed. Based on: `crates/supervisor/src/sessions.rs:1029`, and the
  test `sessiond_partial_write_is_fatal_and_never_replays_written_prefix`
  (`crates/supervisor/src/sessions.rs:2237`).

- **All three teardown paths are closed, not just the write**: the same symptom
  reaches the user through three neighbouring branches, and all three become
  log-only:
  1. the benign write failure above (`pty_write_failed`,
     `crates/supervisor/src/sessions.rs:1023`);
  2. an input enqueued after the writer thread has stopped —
     `InputQueueError::Disconnected` → `pty_input_unavailable`
     (`crates/supervisor/src/sessions.rs:1687`). The writer thread only ever
     exits on a session-terminating path, so this error is by construction "the
     session is going away";
  3. an input for a session already removed from the map by the reader's exit
     handling → `session_not_found`
     (`crates/supervisor/src/sessions.rs:1634`).
  Rejected: fixing only the write failure — the other two windows are narrower
  but produce the identical toast, and leaving them would make the bug look
  intermittently unfixed. Based on: all three reach
  `packages/client/src/device-router.ts:1521`, whose input branch special-cases
  only `input_seq_gap` and `stale_input` and sends everything else to
  `options.onError`, rendered at
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:813`.

- **`session_not_found` is silenced for PTY input only**: the change applies to
  the lookup at the head of `device_input`
  (`crates/supervisor/src/sessions.rs:1634`) and to no other producer of that
  code. Rejected: silencing `session_not_found` wherever it is produced — the
  attach path's copy is load-bearing on the client
  (`packages/client/src/device-router.ts:1504`: it rejects the holder wait
  immediately, without which a local `stopSession` never converges), and
  `device_stop`/snapshot/resize answer real caller questions. Based on:
  `crates/supervisor/src/sessions.rs:1511`, `:1609`, `:1634`, `:1716`, `:1788`.

- **No new wire error code, no client change**: the supervisor simply does not
  emit a device error on these paths. Rejected: a dedicated code plus a silence
  list in `packages/client` and `packages/swift-client` — it costs three
  codebases, and an older desktop build that does not know the new code still
  shows the toast, which is exactly the population that hits this bug. Dropping
  the input silently is safe on the client: `sessionExited` already sets
  `desired = false` and calls `clearInputRetry`
  (`packages/client/src/device-router.ts:1397`), input retry is only ever
  scheduled for `input_seq_gap`, and terminal input is fire-and-forget from
  `terminal.onData` (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:287`),
  so nothing awaits an answer and nothing retries.

- **Benign does not mean traceless**: each of the three paths still writes one
  log line carrying at least the session id, the input seq, and the byte count,
  worded as an expected teardown rather than a failure. Rejected: removing the
  logging — this is the only remaining evidence if the classification is ever
  wrong. The exact wording and level are the executor's call.

- **The writer thread keeps killing the child and breaking out of its loop**:
  only the user-facing error is removed. Rejected: skipping the kill because
  "the process must already be dead" — `EIO` proves the slave fds are gone, not
  that the process exited; a surviving process behind a closed slave would
  become a terminal that can never receive input again. Based on:
  `crates/supervisor/src/sessions.rs:1044`.

- **The benign path leaves the input state machine alone** *(revised on advisor
  review)*: it neither marks the input failed nor rolls its reservation back —
  the reservation stays in the deque and dies with the session.
  Rejected: reusing `fail_input` — it stores `input_failure`, after which
  **every** later `admit_input` on that session returns that same code to the
  client (`crates/supervisor/src/sessiond.rs:974`, `:1146`), re-opening the
  very toast this plan closes.
  Rejected: rolling back with `cancel_input_reservation` — it is back-only
  (`crates/supervisor/src/sessiond.rs:1058`: it pops only when
  `reservations.back()` carries the seq) and is documented as the enqueue-side
  rollback taken while still holding the session mutex, whereas the writer
  thread is working the head of the queue; with two or more reservations in
  flight — exactly what a stream of automatic terminal replies produces — it
  would simply return `false`. Even when it did succeed it would be harmful:
  the next expected seq is derived from `reservations.back().seq + 1`
  (`crates/supervisor/src/sessiond.rs:1016`), so removing an entry turns the
  following input into `input_seq_gap`, and a client that receives that code
  immediately re-sends every retained input
  (`packages/client/src/device-router.ts:1520`).
  Leaving the reservation in place is both correct and inert: a later input
  keeps admitting normally (`Enqueue` → the queue is disconnected → path 2,
  silent), a re-send of the same seq returns `Pending`
  (`crates/supervisor/src/sessiond.rs:1002`) and is silent too, and nothing
  leaks — the reader's exit handling removes the session from the map and the
  whole `SessionState` is dropped with it
  (`crates/supervisor/src/sessions.rs:1163`).

## Direction

One outcome, in the supervisor only: inputs that arrive at the end of a
session's life are a benign terminal state, not an error the user is told about.
The boundary is drawn inside `crates/supervisor/src/sessions.rs`; the wire
protocol, the clients, and the session state machine's contracts are unchanged.

This is a single work package — one file plus its unit tests. Do not fan it out.

### Milestone 1: teardown inputs stop reaching the user as errors

After this milestone: a `written == 0` + `EIO` write failure, an input enqueued
after the writer thread has stopped, and an input for a session already removed
from the session map all end in a log line and nothing else — no
`send_device_error`, and no `input_failure` stored. A partial write and a
non-`EIO` write failure behave exactly as they do today, and the existing
partial-write test still passes unchanged.

The tests must assert the observable outcome, not just a classification
predicate: a test that only proves "this errno is benign" would pass over an
implementation that classifies correctly and still reports to the client. Prove
it on the outbound side — no device error record is emitted, and the session
still accepts subsequent input. Both harnesses already exist in the file: the
injected-writer pattern (`PartialThenFailWriter`,
`crates/supervisor/src/sessions.rs:2030`) and a real `Sessions` over a bounded
outbound channel with a live PTY (`crates/supervisor/src/sessions.rs:2380`),
whose `device_attach` / `device_input` are reachable from inside the crate.
Making the failure path reachable from a test is part of this milestone; how to
do it is the executor's design call.

Validation: `cargo test -p coflux-supervisor` -> exit 0.

## Landmines

- `fail_input` (`crates/supervisor/src/sessiond.rs:1146`) is not a neutral
  "this input did not land" call: it stores `input_failure`, which
  `admit_input` checks before anything else
  (`crates/supervisor/src/sessiond.rs:974`) — so every subsequent input on that
  session, not just the same seq, is refused with the stored code. The existing
  test at `crates/supervisor/src/sessions.rs:2273` asserts that behaviour for
  the partial-write case. Using it on the benign path would hand the client a
  fresh error to display.
- `cancel_input_reservation` (`crates/supervisor/src/sessiond.rs:1058`) is not a
  general "drop this reservation" helper: it pops only the **back** of the
  deque and is meant for the enqueue-side rollback that still holds the session
  mutex (`crates/supervisor/src/sessions.rs:1675`). Calling it from the writer
  thread, which works the head, returns `false` whenever more than one
  reservation is in flight.
- Rust has no stable `ErrorKind` for `EIO`; `ErrorKind::Uncategorized` is
  unstable and cannot be matched. Use `raw_os_error()`
  (`crates/supervisor/src/sessions.rs:558` is where the failure is captured).
- Do not use "a tombstone exists for this session" as the benign test for the
  `device_input` lookup: tombstones are dropped once a client acknowledges the
  catalog (`TombstoneStore::acknowledge`,
  `crates/supervisor/src/sessions.rs:128`), so the test would silently expire.
- `"session 不存在或已退出"` appears five times in
  `crates/supervisor/src/sessions.rs` (`:1511`, `:1609`, `:1634`, `:1716`,
  `:1788`). Only `:1634`, inside `device_input`, is in scope. The attach copy at
  `:1511` is depended on by `packages/client/src/device-router.ts:1504`.
- The writer thread holds an `InputBudgetGuard` for the record being written
  (`crates/supervisor/src/sessions.rs:975`); whatever unwinding the benign path
  does must leave the pending-record and pending-byte budget balanced, or the
  bounded input queue slowly starves.
- `~/.coflux/daemon.log` on a development machine is the fastest way to confirm
  the behaviour after the change: benign teardown lines appear there, and
  `pty_write_failed` should no longer be printed for `written=0` + `os error 5`.

## Scope

In scope:
- `crates/supervisor/src/sessions.rs` (implementation and its `#[test]` module)

Out of scope:
- `packages/client/**`, `packages/swift-client/**`, `apps/desktop/**` — the fix
  is deliberately server-side so that unchanged clients benefit
- `proto/**` and any new wire error code — no protocol change
- `device_stop`, attach, snapshot and resize error reporting — their
  `session_not_found` answers real caller questions
- Partial-write handling and the replay-prefix guarantee

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `cargo test -p coflux-supervisor` | exit 0 |

## Done criteria

- [ ] All listed commands pass.
- [ ] A `written == 0` write failure whose errno is `EIO` emits no device error
      record on the outbound channel and stores no `input_failure`; a log line
      still records it.
- [ ] An input enqueued after the writer thread stopped, and an input for a
      session no longer in the session map, likewise emit no device error record
      and are logged.
- [ ] The benign assertions are made on observable output (no device error
      emitted / the session still admits input), not on a classification helper
      alone.
- [ ] A non-`EIO` write failure and any partial write remain fatal and still
      report to the client; `sessiond_partial_write_is_fatal_and_never_replays_written_prefix`
      passes unchanged.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Silencing a path turns out to require a wire-protocol or client change.

## Maintenance notes

- Running `cargo test -p coflux-supervisor` on a machine that has Coflux
  installed needs `COFLUX_HOME=` in front of it: three `shell_integration` tests
  start a real shell, whose `claude` wrapper then resolves the *live* device
  integration instead of the test's temporary directory. They fail identically
  on an untouched baseline and pass with the variable cleared; CI is unaffected.
- The test harness deliberately never calls `master.take_writer()`:
  `portable-pty`'s `UnixMasterWriter::drop` writes `\n` + `VEOF` into the PTY
  (`portable-pty-0.8.1/src/unix.rs:351`), so whoever holds one presses Ctrl-D
  for the child the moment their thread ends. A harness that took one would let
  the child exit for a reason other than the branch under test, quietly turning
  "no device error was emitted" into a vacuous pass.
- The classification rests on a platform invariant: on macOS and Linux, `EIO` on
  a PTY master write means the slave side has no opener. If a future host
  platform reports something else for the same condition, this is the place to
  widen the test — not to widen it to all errno values.
- If a client is ever seen to hang waiting for an input ack, check this path
  first: the benign branches intentionally answer nothing, relying on
  `sessionExited` to release the client's retained inputs. Verified for the
  input path: nothing awaits an input ack on either client
  (`packages/client/src/device-router.ts:2089`,
  `packages/swift-client/Sources/CofluxClientCore/DeviceRouter.swift:1299`), and
  `closeTask` waits on `device_stop`'s operation ack instead
  (`packages/client/src/store.ts:1026`). **Corrected during execution**: there is
  a third consumer this note did not enumerate — the worker's agent-I/O write
  path awaits a `PtyInputAck` and treats a device `Error` as its answer
  (`crates/worker/src/device.rs:1786`), falling back to `AGENT_IO_TIMEOUT`
  (5 s, `crates/worker/src/device.rs:56`). An agent write that lands in the
  teardown window therefore now waits out those 5 s and reports 「写入回执超时，
  写入结果未知」instead of failing fast with a code. Accepted deliberately: the
  outcome is a failure either way, the delay is bounded, the race is narrow
  (the agent attaches first, and attach's `session_not_found` is still loud),
  and making the supervisor answer differently per calling channel would rebuild
  the error path this plan removed. Revisit here if agent I/O against closing
  terminals ever becomes common.
- Not chased to the end: what happens if
  the `sessionExited` push itself is lost — whether the catalog's exit list
  flips `desired` off. Today that case produces a repeating toast every retry
  tick; afterwards it produces silent re-sends until the catalog or a re-attach
  corrects it. Same exposure, less noise — but it is the first assumption to
  check if this area misbehaves.
- Accepted blind spot: because path 2 is silent, a writer thread that stopped
  while its child somehow survived (a failed `child.kill()`) now reports
  nothing at all to the client. That combination is not reachable today — a kill
  of an already-dead process errors and is ignored — but if terminals are ever
  seen alive yet deaf to input, this is where the feedback went.
