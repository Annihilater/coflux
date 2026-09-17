# Plan 20260916-local-connect-failure-surface: Local enrollment failures stop interrupting with a modal, and timeouts name their own stage

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- apps/desktop/src/main/desktop-account.ts apps/desktop/src/main/index.ts apps/desktop/src/main/daemon-manager.ts apps/desktop/src/main/update-install.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/renderer/components/workbench/daemon-view.ts apps/desktop/src/renderer/components/workbench/daemon-onboarding.tsx apps/desktop/src/renderer/pages/MainPage.tsx apps/server/src/hub.ts packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check, 2026-09-16
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — reviewed 2026-09-16; findings folded in, see entries marked `(revised on advisor review)`
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260916-local-connect-failure-surface` on `dev/20260916-local-connect-failure-surface`
- Planned at: `ebca9085`, 2026-09-16

## Requirement

### What went wrong

On 2026-09-16 the user was interrupted by a modal alert on macOS: **本机暂未接入 / Error: 账号清理连接超时，已保留待重试记录**. Investigation established four facts:

1. The modal comes from the `catch` in `connectLocal` (`apps/desktop/src/main/index.ts:270`), which reports every failure of local enrollment as `dialog.showMessageBox`.
2. The message text comes from a single 15-second timer in `apps/desktop/src/main/desktop-account.ts:20` that covers **all** phases of `accountControl` — connecting, authenticating, subscribing, waiting for the snapshot, removing tasks, revoking the session. Whichever phase stalls, the user is told the *account cleanup* timed out.
3. The user almost certainly did not trigger it: `apps/desktop/src/renderer/pages/MainPage.tsx:15` calls `connectLocal()` automatically on every `onAuthenticated`, which fires on every `authOk` including reconnects (`packages/client/src/store.ts:687`). App launch or a wake-from-sleep with a stalled network is enough.
4. There was nothing to clean up. Both Macs' outboxes (`~/Library/Application Support/Coflux/desktop-account-*.bin`, safeStorage-encrypted) are 99 bytes; with a `v10` prefix and AES-CBC's 16-byte blocks that is an 82-byte plaintext, which matches `{"accountId":"<uuid>","credentials":{},"pending":[]}` and is ~70 bytes short of holding even one `pending` entry. The phrase "已保留待重试记录" was therefore false, and the stall was in connect/snapshot, not cleanup. (Inference from file size, not a decryption.)

A separate, real gap was found in the server while tracing the cleanup path: `taskRemove` (`apps/server/src/hub.ts:3112`) discards the result of `removeTaskRecord`, and that function returns silently — no `taskRemoved`, no `error` — when the device row is gone or the task no longer matches (`apps/server/src/hub.ts:3226-3236`). A client waiting for `taskRemoved` then has nothing to wait for and can only time out. The window is narrow (a concurrent device removal already deletes that device's tasks inside the transaction and broadcasts `taskRemoved` afterwards, see `apps/server/src/hub.ts:3684`), so this is a defensive hole rather than the cause of the reported modal — but a request that never answers is worth closing while the client side is being reworked.

### What is true when this is done

**Product conclusions (settled during exploration; do not reopen).**

- **Failure surface**: local enrollment failures are written into `daemonState.error` and rendered where the other machine-level failures already are — the status line of the 「这台 Mac」 section in settings, and the failing step of the enrollment onboarding with its retry action. The modal alert is gone for this path. Automatic and user-initiated attempts share this one surface; neither pops a modal.
- **Recovery**: no new retry loop. A reconnect fires `onAuthenticated` again, which retries enrollment; a successful attempt clears the recorded error.
- **Action label**: the account-verification step becomes its own action, `connect`, labelled 「接入账号」, so a failure reads 「接入账号失败：<原因>」 alongside 安装组件 / 启动服务 / 重启服务 / 停止服务 / 移除接入.
- **Stage-accurate messages**, replacing the one sentence used for every phase today:

  | Stage | Message |
  | --- | --- |
  | Connecting (before the socket opens) | `连接账号服务器超时，请检查网络后重试` |
  | Authenticating through receiving the account snapshot | `读取账号信息超时，请重试` |
  | Removing this machine's terminals | `本机终端清理超时，已保留待重试记录` |
  | Revoking the old session after cleanup | `退出登录确认超时，已保留待重试记录` |

  Only the last two messages claim a retry record. A connect or snapshot stall during a `drain()` also runs with a persisted `pending` entry, so the claim would not be *false* there — but those two stages are also reached with nothing pending, which is exactly the reported defect, so they never make the claim.
- **Out of the product cut**: the 「未能完成退出登录」 modal in `logoutLocal` stays a modal — it is a user-initiated action whose outcome decides whether credentials were cleared, and silent failure would read as success.
- **Observable acceptance**: with the network down, launching the app shows no alert, and the settings 「这台 Mac」 status line carries the failure reason; once the network returns and the client reconnects, enrollment succeeds on its own and the red text disappears.

**Server behaviour.** Every `taskRemove` request produces exactly one answer on the requesting connection: the existing `taskRemoved` broadcast on success, a point-to-point `taskRemoved` when the task is already gone (removal is idempotent — the caller's intent holds), and a `ServerError` only when the removal genuinely failed (the device row is revoked or not owned by the account).

## Decisions & tradeoffs

- **Failure surface is the existing daemon state, not a new UI**: local-enrollment failures go into the same `DesktopDaemonState.error` channel that install/start/restart/stop/remove failures already use, and are rendered by the existing consumers. Rejected: a toast or notification layer — the desktop already has exactly one place users look for machine-level failures, and a second one would split that. Based on: `apps/desktop/src/renderer/components/workbench/daemon-view.ts:34` (`failure` line), `apps/desktop/src/renderer/components/settings/machine-section.tsx:31` (dismiss on leaving the section), `apps/desktop/src/renderer/components/workbench/daemon-onboarding.tsx:124-125` (per-step failure detail).
- **Account verification is its own action `connect`, labelled 「接入账号」**: it is added to `DesktopDaemonBusy` rather than folded into an existing action. Rejected: reusing `start` — the failure would render as 「启动服务失败」 while the local service may be running perfectly and only the account check failed; a label that misnames the cause is worse than the modal it replaces. Based on: `apps/desktop/src/shared/desktop-bridge.ts:25` (the union), `apps/desktop/src/renderer/components/workbench/daemon-view.ts:24` (`DAEMON_BUSY_LABEL` is a total `Record`, so the compiler enumerates the sites that must be updated).
- **The account-verification action gets its own runner alongside `run()`, and does not reuse it as-is** *(revised on advisor review)*: the new runner shares `busy` / `error` / `emit` / `refresh` with `run()` (`apps/desktop/src/main/daemon-manager.ts:107-120`), and must additionally satisfy three properties that `run()` does not provide:
  1. **It reports success or failure to its caller.** `run()` swallows the exception and resolves `void`, so a caller cannot tell a failed verification from a successful one.
  2. **It never silently skips the verification.** `run()` returns the in-flight action when one exists (`daemon-manager.ts:108`); a reconnect landing while the user has a restart or stop in flight would then skip the account check entirely. The new runner waits for the in-flight action instead of returning it.
  3. **It does not occupy the `action` slot** — or, if it does, the plan's author accepts that `stopForExit` (`daemon-manager.ts:189-192`) will make ⌘Q wait for the full network budget. Not occupying it is preferred: this change exists because that budget can be tens of seconds of a stalled handshake.
  Rejected: calling the existing `run("connect", …)` and treating its resolution as success — it resolves identically on failure, so the daemon would start after a verification that said 「这台 Mac 仍关联其他账号」 (`desktop-account.ts:111`), which is exactly what today's sequential code prevents (`index.ts:265-267`). Rejected: restructuring the daemon-manager state machine — the three properties above are satisfiable in roughly a dozen lines beside `run()`.
- **The daemon start runs only after a verification that actually succeeded** *(revised on advisor review)*: a failed or skipped verification must not reach `daemon.enroll()`. Based on the current gate at `apps/desktop/src/main/index.ts:265-267`, where `await localAccount.connect(token)` throwing skips the enrollment by control flow.
- **A `connect` failure must not block installing an app update** *(revised on advisor review)*: the updater's gate refuses to install while the daemon state carries an error (`apps/desktop/src/main/index.ts:203`), and `update-install.ts:19` turns that refusal into a silent no-op. A recorded `connect` error persists until the user leaves the settings section or the next action clears it, so without a change one offline moment would quietly disable app updates. The gate must ignore `error.action === "connect"`: an account-level failure says nothing about whether the local runtime is safe to stop and replace. Rejected: accepting the coupling — the failure mode is silent, and this plan makes the error far more common than the five runtime actions it was designed for.
- **The timeout is per stage, with the stage's own message**: entering a stage resets the deadline and the message it will fail with. Suggested budgets — connecting 20s, each subsequent stage 15s; the exact numbers are the executor's call. Rejected: one longer global timeout — it neither tells the user which stage stalled nor stops the false cleanup claim, which is the actual defect. Based on: `apps/desktop/src/main/desktop-account.ts:20`.
- **The timeout budget is injectable**: `accountControl` takes its timing from a parameter with the production defaults applied at the call site, so tests can drive stage timeouts in milliseconds. Rejected: hard-coded constants — a test for the connect-stage message would otherwise have to wait 20 real seconds, and the existing suite (`desktop-account.test.ts:69`) runs real sockets in-process and stays fast. Based on: `apps/desktop/src/main/desktop-account.test.ts:69-97`.
- **`taskRemove` answers every request, but only a genuine failure answers with `ServerError`**: "task already gone" replies `taskRemoved` to the requesting connection (idempotent success); "device revoked or not owned by this account" replies `ServerError`. Rejected: replying `ServerError` for both — a `ServerError` is consumed as a global signal in the renderer (it drops a pending workspace creation at `apps/desktop/src/renderer/components/workbench/workbench.tsx:521` and clears launching state in `terminal-attach.ts:322` / `workspace-terminal.tsx:315`), so emitting one on the common idempotent path would disturb unrelated terminals. Rejected: keeping the silence — a request with no answer can only be resolved by a timeout. Based on: `apps/server/src/hub.ts:3112-3116`, `apps/server/src/hub.ts:3226-3236`, `packages/client/src/store.ts:930-933`.
- **The caller distinguishes those cases by a discriminant, never by matching the message text** *(revised on advisor review)*: the three failure branches of `removeTaskRecord` currently differ only by a Chinese `message` string (`apps/server/src/hub.ts:3227`, `:3234`, `:3236`), and `OperationOutcome`'s failure shape carries nothing else (`apps/server/src/hub.ts:279`). The removal must return a discriminated result that names the case; the account-side caller (`removeTerminalForAccount`, `apps/server/src/hub.ts:4178`) maps it back to the `OperationOutcome` it returns today, keeping its behaviour and its messages unchanged. Rejected: `error === "任务已不存在"` — a string literal comparison against user-facing copy breaks the next time the wording is edited, silently turning an idempotent success back into an error.
- **The idempotent `taskRemoved` is sent point-to-point, not broadcast**: only the requester needs to learn that its removal is settled. Rejected: broadcasting — other clients never had the task in their state, so the broadcast carries no information and only widens the blast radius. Based on: the broadcast on the real removal path at `apps/server/src/hub.ts:3259`.
- **No protocol change**: `taskRemoved` and `ServerError` already exist in both directions, so `CONTROL_PROTOCOL_VERSION` stays at 2 and neither `crates/protocol` nor `packages/protocol` is touched. Based on: `proto/coflux/v1/client.proto:359-360`.
- **No new retry loop**: recovery relies on the existing reconnect path calling `onAuthenticated` again. Rejected: a polling retry in the main process — it would race the reconnect-driven attempt and multiply failing attempts on a flaky network. Based on: `packages/client/src/store.ts:686-687`.
- **Tests: desktop unit tests only, no black-box test**: cover the stage messages in `desktop-account.test.ts` and the new action label in `daemon-view.test.ts`. Rejected: adding a black-box case for the server reply — `AGENTS.md` states the suite was deliberately cut to three areas and must not grow back; a wrong `taskRemove` reply is visible the first time a terminal is deleted. Based on: `AGENTS.md:68-82` ("Test harness", "Do not grow this back by habit").

## Direction

Three milestones. **M1 and M2 both rework `apps/desktop/src/main` (`desktop-account.ts`, `index.ts`) and must run as one work package. M3 touches only `apps/server/src/hub.ts` but is a few lines — not enough bulk to pay for a separate dispatch. Execute this plan as a single work package; do not fan out.** M2 consumes the messages M1 produces, so run them in order; M3 is independent of both.

### Milestone 1: `accountControl` fails with the stage that actually stalled

`accountControl` tracks which stage it is in and fails with that stage's message and deadline, with the budgets injectable. The `finished` guard still settles the promise exactly once, and the existing outcomes — obsolete server version, account mismatch, `authError`/`clientOutdated`/`error`, the `4001` close after logout — keep their current messages and behaviour.

Validation: `pnpm -C apps/desktop test` -> exit 0, with new cases asserting the connect-stage, snapshot-stage and cleanup-stage messages. Note the test shapes differ per stage: a stalled **connect** needs a bare `net.createServer` that accepts the TCP connection and writes nothing (a `ws` `WebSocketServer` completes the handshake, so the socket opens and the connect stage ends); the snapshot and cleanup stages need a real `WebSocketServer` that answers the earlier messages and then stays silent.

### Milestone 2: enrollment failures land in the machine status, not in a modal

`connectLocal`'s account-verification phase is tracked as the `connect` action, so its failure reaches `DesktopDaemonState.error` and is rendered by the settings status line and the onboarding step with its retry; the `dialog.showMessageBox` for this path is removed. What must hold after this milestone:

- A failed or skipped verification does not run the daemon start.
- `connectLocal` still resolves rather than rejecting, and still clears its in-flight handle in `finally`, so `MainPage.tsx:15`'s `.catch` does not become a second failure surface and a failed attempt does not wedge later attempts.
- A later successful attempt clears the recorded error.
- The onboarding treats a `connect` failure as a failure of its first step, retried through the existing `enroll` action.
- A recorded `connect` error does not block the updater's install gate.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0, with `daemon-view.test.ts` covering the `connect` label in the status line and in the onboarding step resolution.

### Milestone 3: `taskRemove` always answers

Every `taskRemove` produces exactly one reply on the requesting connection, per the decisions above: broadcast `taskRemoved` on real removal (unchanged), point-to-point `taskRemoved` when the task is already gone, `ServerError` when the device is revoked or not owned — distinguished by a discriminant, not by message text. Take care not to emit two errors for a request `requireTask` already rejected (`apps/server/src/hub.ts:3496-3502`). The account-side caller of `removeTaskRecord` (`rejectRunning = true`, plan 091) keeps its current outward behaviour, including the 「终端仍在运行」 rejection.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0.

## Landmines

- `apps/desktop/src/main/daemon-manager.ts:108` — `run()` returns the in-flight action when one exists. Nesting the daemon start inside an outer action **deadlocks**: the inner `run("start", …)` returns the outer action's promise, the outer body awaits it, and the outer body is what that promise is waiting on. `busy` stays set forever and `stopForExit` (`:190`) blocks the app from quitting. Keep the two actions sequential and separate.
- `apps/desktop/src/main/daemon-manager.ts:189-192` — `stopForExit` awaits whatever occupies the `action` slot. Putting a network-bound action in that slot makes ⌘Q wait for the timeout budget this plan is about.
- `apps/desktop/src/main/index.ts:203` — the updater's `beforeInstall` refuses to install while `daemonManager.getState().error` is set, and `apps/desktop/src/main/update-install.ts:19` handles that refusal by returning silently. A lingering `connect` error would disable app updates with no visible reason.
- `packages/client/src/store.ts:930-933` — every `ServerError` bumps `lastError`, which three renderer sites consume as a signal about *their* pending operation: `workbench.tsx:521` discards a pending workspace creation, `terminal-attach.ts:322` and `workspace-terminal.tsx:315` clear launching state. A new `ServerError` on a common path disturbs unrelated terminals.
- `apps/server/src/hub.ts:3496-3502` — `requireTask` already sends a `ServerError` when the task is missing or foreign, and `taskRemove` returns right after. Adding a reply for the `removeTaskRecord` failure path must not turn that into two errors for one request.
- `apps/desktop/src/main/desktop-account.ts:69-79` — the outbox is a safeStorage-encrypted `AccountData` JSON, and `createDesktopAccount` throws 「本机账号记录损坏，拒绝自动接入」 on a shape it does not recognise. Changing that shape would brick existing installations on upgrade; the timeout work has no reason to touch it.
- `apps/desktop/src/main/desktop-account.ts:21-27` — `finish()` is the single settle point, guarded by `finished` and clearing the timer. A per-stage timer must preserve that: exactly one settle, no timer left running after the socket closes.
- `apps/desktop/src/renderer/components/workbench/daemon-view.ts` — the compiler will **not** find every site. `DAEMON_BUSY_LABEL` (`:24`) is a total `Record` and does fail to compile, but `resolveDaemonActions` (`:92`) only tests whether `busy` is truthy, and `resolveOnboardingSteps` (`:194-215`) compares `error.action` against string literals — both keep compiling while silently ignoring `connect`. Without editing `resolveOnboardingSteps` and the `StepRow` details in `daemon-onboarding.tsx:124-125`, a `connect` failure shows no red text and offers no retry in the onboarding, which is half of this plan's product outcome.
- `apps/desktop/src/renderer/pages/MainPage.tsx:15` — enrollment is triggered on every `authOk`, reconnects included. Whatever the new failure path does, it must be safe to run repeatedly and must not accumulate state across attempts.

## Scope

In scope:
- `apps/desktop/src/main/desktop-account.ts` and `apps/desktop/src/main/desktop-account.test.ts`
- `apps/desktop/src/main/index.ts` — the `connectLocal` failure path and the updater's `beforeInstall` gate (`:203`)
- `apps/desktop/src/main/daemon-manager.ts` — the runner for the account-verification action
- `apps/desktop/src/shared/desktop-bridge.ts` (the `DesktopDaemonBusy` union)
- `apps/desktop/src/renderer/components/workbench/daemon-view.ts` and `daemon-view.test.ts`
- `apps/desktop/src/renderer/components/workbench/daemon-onboarding.tsx` — required, not optional (see the landmine)
- `apps/desktop/src/renderer/components/settings/machine-section.tsx` — only if the new action needs wiring beyond what `daemonStatusLine` already provides
- `apps/server/src/hub.ts` — the `taskRemove` reply and the `removeTaskRecord` result shape
- `wiki/plans/20260916-local-connect-failure-surface.md`, `wiki/plans/README.md`

Out of scope:
- `proto/`, `crates/protocol`, `packages/protocol` — no wire change is needed
- `packages/client` — the client library's `taskRemove`/`lastError` handling stays as is
- The `logoutLocal` modal (`apps/desktop/src/main/index.ts:290`) — deliberately kept modal
- The daemon lifecycle itself (install, start, restart, stop, remove) — only a new action joins the existing state machine
- Any retry loop, backoff, or polling in the main process
- iOS and CLI clients

## Commands

This worktree starts without dependencies. Run `pnpm install --frozen-lockfile` at its root once before the first validation; the orchestrator's preflight normally does this, and a missing `node_modules` is not a code failure.

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (once, prerequisite) | `pnpm install --frozen-lockfile` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop acceptance (acceptance) | `pnpm dev:desktop:prod` | manual walkthrough by the user |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] `accountControl` reports the stalled stage: connect, snapshot, cleanup and logout each fail with their own message from the Requirement's table, and only the two cleanup-side messages claim a retry record.
- [ ] A failing local enrollment produces no modal alert; the reason appears in the settings 「这台 Mac」 status line **and** on the failing onboarding step with its retry, labelled 「接入账号失败：…」.
- [ ] A failed or skipped account verification never runs the daemon start; a successful one still does.
- [ ] `connectLocal` resolves rather than rejecting, clears its in-flight handle on every path, and a later successful attempt clears the recorded error.
- [ ] A recorded `connect` error does not prevent an app update from installing.
- [ ] The app still quits promptly while an account verification is stalled.
- [ ] `taskRemove` answers every request exactly once, with `ServerError` reserved for a genuine failure and the cases told apart by a discriminant rather than by message text.
- [ ] Required tests exist and assert meaningful behavior (stage messages against a socket that stalls at each stage; the `connect` label in the status line and in the onboarding step resolution).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files — in particular, if the failure cannot reach `DesktopDaemonState` without a protocol or `packages/client` change.
- A validation command fails twice after one reasonable fix. A missing `node_modules` is not such a failure: install once and continue.
- A named assumption is false — notably, if the three properties required of the account-verification runner cannot be met beside `run()` without restructuring the daemon manager's state machine.

## Maintenance notes

- Modal alerts on background paths: this plan removes the enrollment one, but it is not the last. `migrateLegacy` still raises a confirmation through `confirmStop` when a legacy LaunchAgent plist is present (`apps/desktop/src/main/daemon-manager.ts:121-124`), reached from the same automatic enrollment. It is a deliberate "you must know this ends your terminals" prompt, not an error report, and stays.
- Worst-case duration grows: one `accountControl` can now spend roughly 65s (20 + 15 + 15 + 15) instead of 15s, and `connect()` may call it repeatedly — once per pending entry, twice for an entry that falls back to the replacement token (`apps/desktop/src/main/desktop-account.ts:87-92`). `logoutLocal` (`index.ts:283`) and the updater gate (`index.ts:201`) both await the in-flight attempt, so keep the budgets modest.
- The stage budgets are a judgement call, not a measurement: the production observation behind the 20s connect budget is a stalled TLS handshake on a cross-border link, where the socket neither opens nor errors. If users report premature connect failures on slow networks, that budget is the knob.
- The server's silent `taskRemove` failure was found by static reading, not by reproducing it; the concurrent device-removal path already deletes that device's tasks and broadcasts (`apps/server/src/hub.ts:3684`), which is why it almost never fires. Do not read the fix as evidence that it caused the reported modal — it did not.
