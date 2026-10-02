# Plan 20261002-runtime-follows-app: The desktop's local runtime follows the app version without a button

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat fe64fcf3..HEAD -- apps/desktop/src/main apps/desktop/src/renderer/components/workbench/daemon-view.ts apps/server/src/auto-update.ts apps/server/src/hub.ts apps/server/src/daemon-capabilities.ts crates/worker/src/main.rs crates/supervisor/src/main.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(fable) — departure check, 2026-10-02
- Stop after: implementation — departure check ("plan audit, then execute")
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; lives in `.claude/worktrees/20261002-runtime-launcher-merge` on `dev/20261002-runtime-launcher-merge`
- Planned at: `fe64fcf3`, 2026-10-02

This is the first of two sequential plans for one requirement (the second is
`20261002-runtime-launcher-merge`). It is deliberately small and independently
releasable: its commits form a prefix of the branch, and the second plan keeps
both of its outcomes (the automatic trigger and the capability) while
replacing the mechanism underneath.

## Requirement

Since `coflux-ptyd` owns every PTY, replacing the local supervisor no longer
ends terminals. The desktop still makes the user press 「更新」 in the local
device panel to move the running runtime onto the version bundled with the
app, and the center still hot-pushes the latest GitHub worker into
desktop-hosted daemons, so a desktop Mac's daemon has two update sources that
can disagree.

When this plan is done:

1. **Desktop, automatic replacement.** When the app starts (including the
   restart after an app auto-update) and finds a running supervisor that
   supports `leave` (custody `ptyd`) whose `runtimeId` differs from the bundled
   one, it replaces it with the bundled runtime by itself, with no click and no
   confirmation. Terminals survive; the user sees at most a short pause and a
   reconnect. There is no 「更新」 button for this case any more.
2. **Failure surface.** If the new runtime fails to start, the existing
   rollback restores the previous one and the panel shows 「更新未能应用」 with a
   「重试」 action (which runs the same replacement again). An automatic attempt
   happens at most once per app launch per bundled `runtimeId` — a failing
   version never loops.
3. **Unchanged.** 「更新终端组件」 (a changed ptyd) remains a separate,
   confirmed action. A running supervisor that predates ptyd (no `leave`) is
   never replaced automatically: replacing it ends terminals, so it keeps the
   existing confirmed path.
4. **Center stops pushing into desktop-hosted daemons.** A daemon started by
   the desktop app advertises a capability saying its lifecycle belongs to the
   app; the center's automatic worker push skips it, and a client-initiated
   upgrade request for it is refused with an error. Its runtime version is
   therefore always the app's bundled version.

Consumer-observable acceptance: after an app update, the local device panel
shows the new version without any click and running terminals are still
there; the server log shows no `auto upgrade dispatched` for that Mac's
daemon.

## Decisions & tradeoffs

- **Trigger point**: the automatic replacement runs in the main process when
  the daemon manager observes a running, leave-capable supervisor whose
  `runtimeId` differs from the bundled `runtimeId`, reusing the existing
  replace-with-rollback path (`restartSupervisor` / `replaceSupervisor`).
  Rejected: a renderer-side auto-click — the renderer may not be mounted and
  the decision is lifecycle, not UI. Based on:
  `apps/desktop/src/main/daemon-manager.ts:132` (`updateReadyOverride` already
  computes "running runtimeId ≠ bundled"), `:262-291` (replace with rollback),
  `apps/desktop/src/main/index.ts:422` (today only the button calls
  `daemon.restart()`).
- **The follow decision lives in its own module that outlives this plan
  (revised on plan audit)**: the "should I replace automatically now"
  decision (bundled id vs running id, leave-capable, once per launch per
  bundled id, not while busy) goes into a new pure module, e.g.
  `apps/desktop/src/main/runtime-follow.ts` with its test — **not** into
  `runtime-replace.ts`, which `20261002-runtime-launcher-merge` deletes.
- **The panel needs to know leave-capability (revised on plan audit)**:
  `DesktopDaemonState` gains whatever field lets the renderer tell a
  leave-capable stale runtime (no 「更新」; failure shows 「重试」) from a pre-ptyd
  one (keeps 「更新」 with its confirmation). Based on:
  `apps/desktop/src/shared/desktop-bridge.ts:34-56` (no custody field today),
  `apps/desktop/src/renderer/components/workbench/daemon-view.ts:127-128`
  (`update-ready` → 「更新」 unconditionally).
- **No loop**: at most one automatic attempt per app launch per bundled
  `runtimeId`; after a failure only the user's 「重试」 tries again. Rejected:
  retry with backoff — a version that cannot start will not start on the
  second try either, and every attempt pauses terminals.
- **Pre-ptyd supervisors are excluded** from automatic replacement
  (`runtimeSupportsLeave` false → keep today's confirmed stop+start path).
  Based on: `apps/desktop/src/main/daemon-manager.ts:268-271`,
  `apps/desktop/src/main/desktop-runtime.ts:165-167`.
- **Desktop-managed is a capability string, not a proto field.** The worker
  adds a capability (name is the executor's call; something like
  `desktop_managed`) to `DaemonAuth.capabilities` and the enroll request's
  capabilities when it runs under a desktop-started supervisor. Rejected: a
  new proto field — `capabilities` is `repeated string` validated only as
  bounded text, so no schema change or breaking-check baseline is needed.
  Based on: `proto/coflux/v1/daemon.proto:16-25,37-38`,
  `crates/worker/src/main.rs:161-176` (`daemon_capabilities`),
  `apps/server/src/hub.ts:5202-5206` (`validCapabilities`: ≤32 entries, ≤64 bytes).
- **How the worker knows it is desktop-hosted**: from the environment the
  desktop gives the supervisor, which the supervisor already passes through to
  every worker including hot-upgraded ones. `COFLUX_RUNTIME_CONTROL=1` is set
  only by the desktop today; the executor may reuse it or add a dedicated
  variable. Rejected: the worker inspecting its parent process or paths.
  Based on: `apps/desktop/src/main/desktop-runtime.ts:303-306` (spawn env; `COFLUX_RUNTIME_CONTROL=1` at :303),
  `crates/supervisor/src/main.rs` (only reader of `COFLUX_RUNTIME_CONTROL`).
- **Server gating covers both push paths.** The automatic sweep
  (`AutoUpdater.maybeUpgrade`) skips desktop-managed daemons, and the
  `clientUpgradeDaemon` handler refuses them with an error message. Rejected:
  gating only the sweep — `clientUpgradeDaemon` is a second, ungated path to
  `workerUpgrade`. Based on: `apps/server/src/auto-update.ts:175-212`,
  `apps/server/src/hub.ts:1042-1044` (`listOnlineDaemonsForUpdate` does not
  expose capabilities today), `apps/server/src/hub.ts:3215-3236`.

## Direction

### Milestone 1: the desktop replaces a stale runtime by itself

After the app starts with a leave-capable running supervisor on a different
`runtimeId`, the replacement runs automatically once; failure shows
「更新未能应用」 with 「重试」; the 「更新」 button no longer exists for the
leave-capable case; the pre-ptyd case and 「更新终端组件」 are unchanged.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0,
including a unit test of the "attempt once per launch per runtimeId" decision
and an updated `daemon-view.test.ts` for the panel actions.

### Milestone 2: the center never pushes into a desktop-hosted daemon

The worker advertises the desktop-managed capability only when started under
the desktop; the server's sweep skips such daemons and `clientUpgradeDaemon`
refuses them. Validation: `cargo build` with zero warnings,
`COFLUX_HOME= cargo test -p coflux-worker` → pass,
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0. No new
server unit test (server tests run from an explicit file list in
`.github/workflows/ci.yml:182-184`, which is out of scope; the skip is
observable in the server log) — revised on plan audit.

Milestones 1 and 2 are independent of each other.

## Landmines

- `daemon-manager.ts`'s `start()` returns early when a runtime is already
  running (`apps/desktop/src/main/daemon-manager.ts:245-249`) — that early
  return is exactly where today's flow stops short of replacing; the
  automatic path must not also run inside a `run(...)` action that is already
  busy (watchdog/`busy` interplay at `:150-170`).
- `lastError` in the desktop is shown to every attached terminal surface in
  some flows (see memory of the agents launcher work); keep the failure in the
  daemon panel's own error slot that `restartSupervisor` already throws into.
- The auto-update push compares `workerVersion !== latest` with no semver
  (`apps/server/src/auto-update.ts:178-179`); the bundled worker's version is
  the release tag (`.github/workflows/desktop-release.yml:47-73`), so without
  this plan's skip a lagging app is still pushed forward.

## Merge and deploy

- Deploy the server change before relying on the skip; an old center keeps
  pushing (harmless: the old behaviour).
- Release notes (English): the desktop now applies local runtime updates
  automatically after an app update; terminals are kept.

## Scope

In scope:
- `apps/desktop/src/main/` (daemon manager, state, index wiring, new `runtime-follow.ts` + test)
- `apps/desktop/src/shared/desktop-bridge.ts` (state field)
- `apps/desktop/src/renderer/components/workbench/daemon-view.ts` and its test
- `crates/worker/src/main.rs` (capability)
- `apps/server/src/auto-update.ts`, `apps/server/src/hub.ts`, `apps/server/src/daemon-capabilities.ts`

Out of scope:
- Any change to ptyd, the supervisor's replace/leave semantics, the manifest,
  or signing — those belong to `20261002-runtime-launcher-merge`.
- `proto/` — no schema change.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop lint | `pnpm -C apps/desktop lint` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust build | `cargo build` | zero warnings |
| Worker tests | `COFLUX_HOME= cargo test -p coflux-worker` | pass |
| Desktop walkthrough (acceptance) | `pnpm dev:desktop:prod` against a running older runtime | runtime replaced without a click, terminals kept |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] A leave-capable stale runtime is replaced automatically once per launch per bundled `runtimeId`; failure shows 「更新未能应用」 + 「重试」.
- [ ] Pre-ptyd supervisors and 「更新终端组件」 keep their confirmed paths.
- [ ] Desktop-hosted daemons advertise the capability; both server push paths honour it.
- [ ] No proto change.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- `20261002-runtime-launcher-merge` replaces the TS replace/rollback mechanism
  with a request to the Rust launcher; it keeps this plan's automatic trigger
  (`runtime-follow.ts`), the once-per-launch rule, the failure surface and the
  capability.
