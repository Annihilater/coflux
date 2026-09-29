# Plan 20260929-executor-pip: watch an executor run in a picture-in-picture card on the terminal that started it

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat bcb91b3b..HEAD -- proto/ packages/protocol/ packages/executor/ packages/client/src/ packages/cli/ crates/worker/src/ crates/cli/src/ apps/server/src/hub.ts apps/desktop/src/ integrations/claude-plugin/`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(fable) — departure check, 2026-09-29
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — cut `dev/20260929-executor-pip` at `.claude/worktrees/20260929-executor-pip` from the main worktree (clean, `bcb91b3b`)
- Planned at: `bcb91b3b`, 2026-09-29

## Requirement

An agent in a coflux terminal (Claude Code, Codex) hands a bounded sub-task to
the built-in executor with `coflux executor run`. Today that run has **no UI at
all**: the agent's CLI blocks until the run ends, and the person watching the
terminal cannot see what the executor is doing, how far it got, or stop it.
The executor's only desktop surface is its settings page.

Plan `wiki/plans/20260912-executor-engine.md:48` already reserved a second slice
for this ("glass card in the bottom-right corner, click to expand the full
transcript, a stop button, stacked tasks"), and the runner already emits
`transcript` fragments "for the second slice's floating window"
(`packages/executor/src/runner-protocol.ts:67`) that nobody consumes
(`packages/executor/src/manager.ts:247`). This plan is that slice.

### Product conclusions (confirmed by the user, 2026-09-29)

1. **Consumer and trigger**: the person watching an agent work in a coflux
   terminal, on **any desktop of the account** that can see that terminal. They
   want to glance at the delegated sub-task's progress and, when needed, read it
   in full.
2. **Form**: a **read-only picture-in-picture card bound to the terminal that
   started the run** (the caller's terminal, i.e. the task whose session ran
   `coflux executor run`). It covers runs on **every device**, whichever host
   (Coflux.app or a headless npm daemon) runs them. It is not a chat input — the
   executor is one-shot with no follow-up — and there is no run history.
3. **Interaction flow**
   - The card appears in the bottom-right corner of the caller terminal's pane
     the moment the run is submitted. With split groups it lives in that one
     pane only.
   - It can be dragged; on release it snaps to the nearest of the pane's four
     corners (picture-in-picture behaviour). Controls show on hover.
   - When the caller terminal is not in view, its tab and its sidebar entry show
     an activity indicator.
   - Clicking the card expands it in place into a large panel over most of the
     pane (margins left so it still reads as floating over the terminal); Esc or
     the collapse button shrinks it back.
   - Both sizes carry a **stop** button: one click cancels the run, no
     confirmation. The agent receives `cancelled`.
   - **When the run ends, the card disappears immediately.** Exception: if it is
     expanded at that moment, the panel stays, showing the final state, until the
     user collapses or closes it.
   - Several concurrent runs from one terminal (read-only runs can run in
     parallel) stack in the same corner.
   - A desktop that opens, or switches to the terminal, mid-run shows the run's
     full record so far, not only what arrives afterwards.
4. **UI structure**
   - **Collapsed**: a title row — activity indicator (`ActivityDots`), task
     title, write / read-only mark, elapsed time — above the **last 3–4
     transcript lines as a rolling log** (the model's sentences, and tool calls
     as monospace `$ command` lines). Fixed height; content changes never resize
     the card.
   - **Expanded**: the same header plus stop and collapse; the body uses the
     conversation-paper typography (`terminal-paper.tsx`): the prompt at the top
     as the user bubble (folded when long), the model's prose rendered as
     markdown, each tool call as a `$ command` row whose output is folded by
     default and opens on click, errors in the error colour.
   - **States**: queued (accepted, not started), running, host connection lost
     (greyed and labelled, until the run actually ends).
5. **Task title**: `coflux executor run` gains an optional `--title`; the SKILL
   tells agents to pass one. Without it the card uses the prompt's first line.
6. **Scope cut** — in: the card (both sizes), a complete transcript (commands and
   their output, split per turn), the transcript reaching viewing desktops over
   the end-to-end device channel, `--title`, stop. Out: run history, follow-up
   input, per-token streaming, Linux hosting, an executor tab.
7. **Observable when done**: an agent in a terminal on any device starts an
   executor run; within a moment a card appears in that terminal's pane with a
   rolling log; dragging it to another corner snaps; expanding shows the prompt,
   every command with its output and the model's prose; stop really stops the
   run; the card disappears when the run ends; on another tab the originating
   terminal's tab shows the indicator.

## Decisions & tradeoffs

- **The daemon collects and buffers the transcript; viewers subscribe to it
  with a sequence cursor.** The host (Coflux.app main process, or the daemon's
  own node child) forwards each transcript fragment to the daemon; the daemon
  keeps it per run, in memory; a viewing client subscribes with a `from_seq` and
  gets the backlog then live fragments, and resumes from its last seq after a
  reconnect. The buffer is dropped once the run's terminal state has been
  recorded. Rejected: viewers fetch the transcript from the host directly — a
  daemon-hosted run has no host a client can reach, and a Coflux.app host on
  another machine is not addressable either. Rejected: fragments ride the
  existing `DeviceExecutorReport.note` — `note` is one sentence the CLI shows,
  and reports are terminal-state-retransmitted, not a stream. Based on:
  `crates/worker/src/executor_host.rs:1-20` (daemon host is a stdio child the
  worker owns), `proto/coflux/v1/device.proto:714-726` (report shape).
- **This reverses one line of plan 116, and only one**: "the transcript stays
  inside the desktop app and never passes through the daemon"
  (`wiki/plans/20260912-executor-engine.md:110,225`) no longer holds — the user
  chose runs on every device, which needs the transcript to leave the host
  process. It still **never reaches the centre**: transcript and prompt travel
  only over the end-to-end device channel. "No per-token data through the
  daemon" still holds: a fragment is a whole assistant message, a whole tool
  call, or an error, never a delta.
- **Two hard caps are part of the contract.** Per fragment: a tool call's
  captured output is truncated in the runner to a bounded head and tail (order of
  a few KB each, with an explicit "… N bytes omitted …" marker); assistant text
  is not truncated. Per run: the daemon's buffer has a total byte cap (order of
  1 MB); beyond it the oldest fragments are dropped and the backlog it serves
  starts with an explicit "earlier output omitted" marker the card renders.
  Exact numbers are the executor's call. Rejected: unbounded buffers — a verbose
  build log would grow a long-lived worker without limit, and the host's JSONL
  line cap is 4 MB (`crates/worker/src/executor_host.rs:50,215`), which a single
  uncapped tool output could exceed and turn into a host error. (decided while
  planning)
- **Run metadata goes through the centre, content does not.** The worker sends
  the centre a full idempotent snapshot of its live executor runs on every
  change and unconditionally after authentication — the exact shape of
  `SecretRequests` (`proto/coflux/v1/daemon.proto:100-109`,
  `crates/worker/src/secret.rs:23,263`): per run `run_id`, the caller's
  `session_id` and `task_id`, `title`, `write`, state, `submitted_at`,
  `started_at`. The server validates session/task against its catalog, keeps the
  result in memory only, fans it out to the account's clients per daemon, clears
  it on daemon disconnect and re-sends it on subscribe — exactly as
  `acceptSecretRequests` does (`apps/server/src/hub.ts:1910-1956,2889,2985`).
  The prompt, the transcript, notes and summaries are **not** in it. This
  snapshot alone drives whether a card exists and the tab/sidebar indicator.
  "Every change" includes the ledger's lazy sweep: `ExecutorLedger::sweep`
  (`crates/worker/src/agent_ctl/executor.rs:311`) turns overdue runs `Unknown`
  only when something touches the ledger (`device.rs:2412`), with no timer — so
  a snapshot must follow a sweep that changed anything, and something must drive
  the sweep while runs are live even when no CLI is polling, or a card whose
  run went `Unknown` would hang on screen. The run-metadata ref is shared by the
  daemon→server and server→client messages, so it lives in
  `proto/coflux/v1/common.proto` next to `SecretRequestRef` (`common.proto:207`).
  (sweep and placement revised on plan audit)
  Rejected: everything over the device channel — a desktop only has a device
  lane to devices it retains, so an unselected device's terminal could never
  light its sidebar indicator. The title is agent-written text, like a secret
  request's `reason`, which already crosses the centre under the same rule.
- **A card is bound to the caller's terminal (`task_id`), never to the run's
  workspace.** Under plan 102 an agent that `cd`s into a worktree submits a run
  whose effective workspace differs from its terminal's owning workspace
  (`crates/worker/src/agent_ctl.rs:531-545`); the card still belongs on the
  terminal the agent runs in. The caller's session is already known at submit
  (`agent_ctl.rs:531`, the `/agent` request is process-tree attested) but is not
  stored in `RunRecord` today (`crates/worker/src/agent_ctl/executor.rs:113-135`).
- **The host-registration gate is not widened.** Host registration and host
  reports stay accepted only from the local loopback channel
  (`crates/worker/src/device.rs:2436-2455`), and transcript fragments from a
  desktop host arrive on that same host channel under the same gate. Viewing and
  stopping are **separate** client→worker device payloads open to any
  authenticated device channel: subscribing to a transcript requires
  `DEVICE_SCOPE_SESSION_READ`, stopping requires `DEVICE_SCOPE_SESSION_CONTROL`
  (precedent: secret answers and annotations need SESSION_CONTROL and no attach,
  `proto/coflux/v1/device.proto:818-825,953`). A stop from a viewer lands on the
  ledger's existing cancel path — the one the `/agent` `ExecutorCancel` action
  uses (the CLI sends it when `--timeout` expires; there is no `executor cancel`
  subcommand) — it is not a second cancellation mechanism. A fragment is
  accepted only when it comes from the host **currently holding the host slot
  under the run's `host_id`** — never from "the channel the run was assigned
  on", because a desktop that reconnects re-registers with the same `host_id`
  on a new channel and higher epoch and must keep streaming
  (`crates/worker/src/agent_ctl/executor.rs:282`; the local-host report path
  already checks this way, `crates/worker/src/device.rs:2641`). Rejected:
  letting viewers register or talk the host protocol. (scope split decided while
  planning; host check revised on plan audit)
- **Transcript enrichment lives in `@coflux/executor`, once, for both hosts.**
  Today tool fragments are only `→ bash` (`packages/executor/src/runner.ts:403-404`)
  and assistant text accumulates across the whole run without being reset
  (`runner.ts:387,399,409`), so every `message_end` re-emits everything said so
  far. After this plan: one assistant fragment per assistant message, holding
  that message's text only; one tool fragment per tool call carrying the tool
  name, its salient argument (the shell command for bash, the path for file
  tools) and its capped output plus success/failure; error fragments as today.
  The fragment shape is structured (kind + fields), not a pre-formatted string,
  so the desktop can fold outputs. The two hosts forward the same fragments;
  only the envelope differs (JSONL to the worker, device frame to the daemon).
- **The provider credential never enters the transcript** — upgraded from a
  discipline to an acceptance item, since the transcript now leaves the host
  process. `runner-protocol.ts:51-55` already forbids it; a unit test must
  assert a run's fragments never contain the `apiKey` value, including when a
  tool's output echoes the environment.
- **`--title` on both CLIs and the `/agent` action.** `coflux executor run`
  exists twice with command-for-command parity — TS `packages/cli/coflux.mjs:462`
  and Rust `crates/cli/src/commands.rs:636` — and both gain an optional
  `--title`; `ExecutorSubmit` (`crates/worker/src/agent_ctl.rs:154`) gains an
  optional `title`. The worker falls back to the prompt's first line when it is
  absent, so every consumer sees one resolved title. The SKILL
  (`packages/cli/skills/coflux/SKILL.md:422`) documents it, the plugin copy is
  synced, and `integrations/claude-plugin/.claude-plugin/plugin.json` (0.18.0)
  is bumped.
- **Old peers degrade silently, never by timeout — and never at the heartbeat's
  expense.** A worker that predates the viewer payloads answers them with an
  id-less `empty_payload` error; the client attributes that to a dedicated
  "executor transcript unsupported on this route" state and shows cards without
  a log. This is **not** a copy of the annotations attribution: that one only
  claims errors while an annotation request is in flight
  (`packages/client/src/device-router.ts:1515`), whereas a transcript
  subscription is a long-lived frame outside `pendingRequests`, so the client
  keeps its own bookkeeping of "subscriptions sent on this channel generation and
  not yet answered", and its attribution branch runs **before** the heartbeat
  branch (`device-router.ts:1518-1530`) and yields to it under the same
  confirmed-heartbeat rule annotations use. An error it attributes must never set
  `heartbeatUnsupported`. An old host that sends no transcript leaves the card
  with metadata only. New fields and payloads are additive;
  `DEVICE_PROTOCOL_VERSION` and `CONTROL_PROTOCOL_VERSION` do not change.
  (revised on plan audit)
- **Release order is server → worker (+ executor via cofluxd) → desktop.** The
  server must understand the snapshot before a worker sends it; a desktop
  without a new worker simply shows no cards. Record this in the plan's outcome;
  releasing is not part of this plan.

## Direction

Data flow: `coflux executor run --title` → `/agent` `ExecutorSubmit` (caller
session/task recorded) → ledger → assignment to the host → runner emits
structured fragments → host forwards them to the worker → worker buffers per
run and (a) pushes metadata snapshots to the centre, which fans them out to all
desktops, and (b) serves backlog + live fragments to subscribed device channels
→ desktop renders the card on the pane of `task_id`; stop goes back over the
device channel into the ledger's cancel path.

Conventions: wire protocol in `proto/` with generated Rust/TS/Swift kept in sync
(`buf generate` must leave no diff); internally tagged camelCase; comments in
English; desktop UI follows `docs/design-guidelines.md` (`ActivityDots`,
`Tooltip` rather than `title`, lucide icons, no spinners).

Milestone dependencies: **M1 gates everything.** After M1, **M2, M3, M4 and M5
are independent** (disjoint paths: `packages/executor/`; `crates/worker/`;
`apps/server/` + `packages/client/`; `packages/cli/` + `crates/cli/` + SKILL +
plugin). **M6 needs M2 and M4** (it consumes the host fragment shape and the
client store API).

### Milestone 1: the wire contract exists

New messages in `proto/`: the daemon→server executor-runs snapshot and its
server→client broadcast; client→worker transcript subscribe/unsubscribe and
stop; worker→client transcript batches (backlog and live, each fragment with its
seq, plus the "omitted" marker); host→worker transcript fragments on the device
channel; the structured fragment type. The host JSONL protocol
(`packages/executor/src/host-protocol.ts`) and the runner protocol gain the
structured fragment. `title` on the `/agent` submit. Generated code regenerated.
Validation: `cd proto && buf lint && buf generate` then
`git status --porcelain packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated`
-> empty after committing the generated files;
`cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=bcb91b3b,subdir=proto"`
(as `.github/workflows/ci.yml:107` does) -> exit 0; `cargo build --workspace` ->
zero warnings.

### Milestone 2: the executor package produces a complete, capped, credential-free transcript

Runner fragments as decided (per-message assistant text, tool calls with
argument and capped output, errors); both hosts' outbound forwards them;
`manager.ts` stops discarding them.
Validation: `node --import tsx --test packages/executor/src/*.test.ts` -> exit 0,
including new tests for the per-message split, the output cap and marker, and
the credential never appearing in fragments.

### Milestone 3: the worker records, buffers, announces and serves runs

`RunRecord` carries caller session/task and the resolved title; per-run
transcript buffer with the byte cap; fragments accepted only from the run's
registered host (loopback device channel, or the local JSONL host); snapshot to
the centre on every change and after authentication; viewer subscribe with
backlog-then-live and resume by seq, subscriptions dropped with their channel;
viewer stop into the existing cancel path; scope gating as decided.
Validation: `cargo build --workspace` -> zero warnings;
`COFLUX_HOME= cargo test -p coflux-worker` -> exit 0, including new tests for the
buffer cap and omitted marker, resume-from-seq, buffer dropped at terminal state,
the snapshot changing on submit, on a reported terminal state and on a
sweep-produced `Unknown`, fragments accepted from a reconnected host with the
same `host_id`, and a SESSION_READ-only channel being refused stop.

### Milestone 4: the centre relays the snapshot and the client exposes runs and transcripts

Server accepts, validates (session/task belong to that daemon's catalog), keeps
in memory, broadcasts, clears on disconnect and re-sends on subscribe, as for
secret requests. `@coflux/client` store holds live runs per daemon (live-only,
cleared like `secretRequests`, `packages/client/src/store.ts:425,697,995,1123`)
and offers subscribe-to-transcript and stop over the device channel, with the
`empty_payload` degradation attributed without touching the heartbeat.
Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` ->
exit 0; `node --import tsx --test packages/client/src/*.test.ts` -> exit 0.

### Milestone 5: agents can name their runs

`--title` on both CLIs with identical behaviour; SKILL updated; plugin synced
and version bumped.
Validation: `cargo test -p coflux-cli` -> exit 0;
`node scripts/sync-claude-plugin.mjs --check` -> exit 0.

### Milestone 6: the card

Desktop main forwards a desktop-hosted run's fragments to the daemon over the
host channel. The renderer shows the picture-in-picture card per product
conclusions 3–4 on the pane of the run's `task_id`, and the tab/sidebar
indicator.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`
-> exit 0. Pure logic worth a unit test (the corner snap, the rolling-log
selection, the "ended while expanded" retention rule) gets one; rendering does
not.

Left to the executor, explicitly: exact message and field names and proto tags;
cap sizes; how the card component is structured and whether the paper's
markdown components are extracted for reuse; drag/snap implementation and
whether the chosen corner is remembered per terminal; which existing signal the
tab/sidebar indicator reuses; elapsed-time formatting.

## Landmines

- **Esc and ⌘ keys leak into xterm while the panel is expanded** unless the pane
  yields them, as it does for the paper: `terminal-pane.tsx:879-898` gates its
  capture-phase shortcuts on `paperOpen`. The expanded card must be handled the
  same way, and Esc must collapse the card rather than reach the shell.
- **Device frames above 30 MiB make `sendOn` fail and tear down the whole
  session lane** (`MAX_DEVICE_FRAME_BYTES`, `crates/protocol/src/lib.rs:71`,
  enforced at `crates/worker/src/gateway.rs:230`).
  The backlog must be sent in batches far below that, whatever the buffer cap.
- **A worker hot upgrade discards the ledger and the buffers** — the run records
  already live only in worker memory (`executor_host.rs:16-24`). The snapshot
  after re-authentication will no longer list the run and the card disappears;
  that is accepted behaviour, not a bug to engineer around.
- **Proto tag collisions at merge time.** Parallel branches have collided on
  device-payload tags before (browser annotations had to be renumbered to
  110–117 when merged). Check the highest tags on `main` before merging and
  renumber if another branch landed first.
- **The daemon host's JSONL line cap** (`executor_host.rs:50`) applies to
  fragment lines too; the per-fragment cap in M2 is what keeps it safe.
- **The executor settings page and the host registration must keep working
  unchanged** — `use-executor-bridge.ts` relays exactly four inbound and two
  outbound kinds; adding the fragment relay must not reorder the retain /
  announce effects whose ordering is documented there
  (`apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:104-115`).
- **The heartbeat's empty_payload attribution will swallow the transcript
  subscription's.** `device-router.ts:1518-1530` marks a whole route
  `heartbeatUnsupported` on any id-less `empty_payload` on the session lane while
  a ping is in flight, with no confirmed-heartbeat check. Read
  `packages/client/src/device-router.ts:1500-1545` and `1629-1651` before
  choosing the subscription frame's shape and its attribution (see the "Old
  peers" decision).
- **The caller closing its own terminal mid-run removes the card.** The server
  drops snapshot entries whose session is no longer in that daemon's catalog or
  runtime routes (`apps/server/src/hub.ts:1910-1926`), so the run keeps going
  while its card disappears. Accepted behaviour — the card is bound to that
  terminal — not something to engineer around.
- **`/agent` already parses a `title` field** (`crates/worker/src/hook.rs:418`,
  `AgentBody`); `executor.submit` only needs to pass it through, not add a
  second field.
- **The worktree has no `node_modules`.** Run `pnpm install` before any TS
  validation (tsc, `node --import tsx`, `pnpm -C apps/desktop …`).
- **clippy is not a gate in this repository** (baseline already has errors);
  the gate is a zero-warning `cargo build`.

## Scope

In scope:
- `proto/coflux/v1/{common,daemon,client,device}.proto` and generated code under
  `packages/protocol/src/gen`, `crates/protocol/src/gen`,
  `packages/swift-client/Sources/CofluxProtocol/Generated`
- `packages/executor/src/` (runner, runner/host protocols, manager, host core)
- `crates/worker/src/` (agent_ctl, agent_ctl/executor, device, executor_host, and
  where the snapshot is sent)
- `apps/server/src/hub.ts`
- `packages/client/src/`
- `packages/cli/coflux.mjs`, `crates/cli/src/`
- `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin/`
- `apps/desktop/src/main/executor-*.ts`, `apps/desktop/src/shared/`,
  `apps/desktop/src/preload/`, `apps/desktop/src/renderer/components/workbench/`
- `wiki/plans/`

Out of scope:
- Run history, follow-up input, per-token streaming — product non-goals.
- Linux executor hosting — separate sandbox plan.
- iOS — not requested; the protocol additions must not break the Swift build.
- Black-box tests under `tests/` — this surface is visible the first time the
  app is used (AGENTS.md "Do not grow this back by habit").
- Releasing, deploying, pushing, merging.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + generate | `cd proto && buf lint && buf generate` | exit 0, no diff in the three generated trees |
| Proto breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=bcb91b3b,subdir=proto"` | exit 0 |
| Rust build | `cargo build --workspace` | exit 0, zero warnings |
| Worker tests | `COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| CLI tests | `cargo test -p coflux-cli` | exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Executor tests | `node --import tsx --test packages/executor/src/*.test.ts` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Plugin sync | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Black-box core | `pnpm -C tests test` | exit 0 (wire protocol touched) |
| Walkthrough (acceptance) | local stack per `docs/desktop-acceptance.md`: `pnpm dev:pg`, `pnpm dev:server`, this branch's `pnpm dev:daemon`, `pnpm -C apps/desktop dev`; an agent runs `coflux executor run --title=… --prompt=…` | product conclusion 7 observed by the user |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] A run carries the caller's session/task and a resolved title; the centre's
      snapshot lists it on submit and drops it on terminal state; every desktop
      of the account receives it.
- [ ] A viewer that subscribes mid-run receives the full backlog (or the
      "omitted" marker followed by the retained tail) and then live fragments,
      and resumes by seq after a reconnect.
- [ ] Tool fragments carry the command and capped output; assistant fragments
      hold one message each; no fragment contains the provider credential
      (asserted by a test).
- [ ] Stop from a viewer with SESSION_CONTROL cancels the run through the
      existing cancel path; a SESSION_READ-only channel is refused (asserted by a
      test).
- [ ] Host registration is still loopback-only; transcript fragments are
      accepted only from the host currently holding the slot under the run's
      `host_id`, including after that host reconnects (asserted by a test).
- [ ] A run turned `Unknown` by the ledger sweep leaves the centre snapshot
      without any CLI polling (asserted by a test).
- [ ] A new client talking to an old worker keeps its heartbeat: an
      `empty_payload` answering a transcript subscription never sets
      `heartbeatUnsupported` (asserted by a `packages/client` device-router test).
- [ ] `--title` behaves identically on both CLIs; SKILL and plugin copy match;
      plugin version bumped.
- [ ] The desktop renders the card per product conclusions 3–4, binds it to
      `task_id`, and yields Esc/⌘ keys while expanded.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated, naming the release order
      (server → worker/cofluxd → desktop) and that the walkthrough is pending
      the user.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Viewer subscription cannot be served without widening the host-registration
  gate or routing transcript content through the centre.
- The caller's terminal (`task_id`) cannot be resolved at submit for a caller
  that `/agent` accepts.

## Maintenance notes

- This plan supersedes the "transcript never passes through the daemon" line of
  `wiki/plans/20260912-executor-engine.md`; the rest of plan 116 stands.
- The card's existence is driven by the centre snapshot while its content comes
  over the device channel; a desktop that cannot reach the device (no lane)
  still shows the card with metadata and no log. That split is intentional.
- Plan audit (fable, 2026-09-29) revised: old-worker degradation must not reuse
  the annotations attribution (heartbeat hazard); `common.proto` added to scope;
  the M1 breaking command fixed; sweep-driven snapshots; fragments gated on the
  host slot's `host_id`; the caller-terminal-closed and `title`-already-parsed
  landmines; the `pnpm install` precondition. No finding was rejected.
- If run history is ever wanted, it needs persistence the daemon deliberately
  does not have today; do not grow the in-memory buffer into one.
