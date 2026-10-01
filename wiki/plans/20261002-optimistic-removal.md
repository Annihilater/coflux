# Plan 20261002-optimistic-removal: Removing a workspace, project or terminal takes effect the moment you confirm

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat aa65d982..HEAD -- packages/client/src apps/desktop/src/renderer/components/workbench apps/server/src/hub.ts packages/client/src/connection.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; work lives on `dev/20261002-optimistic-removal` in `.claude/worktrees/20261002-optimistic-removal`
- Planned at: `aa65d982`, 2026-10-02

## Requirement

Today removal in the desktop app is pessimistic. Confirming 「删除工作区」 only sends
`workspaceRemove`; the row stays in the sidebar until the centre has closed the
workspace's sessions, the daemon has run `git worktree remove --force`, and
`workspaceRemoved` comes back — several seconds on a tree with `node_modules`, with
no visible reaction meanwhile. Project removal and closing a terminal have the same
shape. The user wants all three to behave optimistically: hide immediately, bring
the entity back only if the background removal fails.

Product conclusions (confirmed with the user):

- **Workspace.** Entry points (hover ×, context menu) and the confirm dialog are
  unchanged. On confirm the row disappears from the sidebar in the same frame, with
  no 「删除中」 indicator anywhere. If it was the selected workspace, the main area
  switches immediately to **the same project's main workspace** (not the existing
  fallback, which jumps to the earliest project's main workspace). If the removal
  fails (git error, daemon offline, …), the row returns in its original position and
  the existing top error bar shows the error; the selection does **not** switch back.
- **Project.** On confirm the project and all its workspaces disappear at once.
  Worktrees that were actually removed stay gone (their `workspaceRemoved` arrives);
  on failure the project comes back with whatever workspaces still exist. Selection
  falls back through the existing rule.
- **Terminal.** Closing a tab makes it disappear immediately. The 「停止并关闭」
  confirm for a running terminal stays. If stopping fails, the tab comes back and
  the error is shown.
- **Non-goals:** device removal; disabling delete entry points while offline;
  fixing the project 「deleting」 limbo (see Landmines).
- **Observable when done:** the row/tab is gone in the frame the confirm (or close)
  is clicked; with a forced failure — e.g. deleting a workspace whose daemon is
  offline — it comes back and the error bar shows the reason.

## Decisions & tradeoffs

- **The optimistic layer lives in the client store (`packages/client/src/store.ts`),
  and the store's public `tasks` / `workspaces` / `projects` arrays are the
  *visible* state.** A pending removal takes the entity out of those arrays
  immediately and keeps its last server copy aside, keyed by id. Rejected: a
  renderer-local hide set in the shape of plan 078's pending create
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:1166-1218`) —
  eleven renderer files read `state.tasks` / `state.workspaces` / `state.projects`
  directly (workbench, workspace-terminal, sidebar, command-palette, changes-view,
  notification-inbox, browser-view, browser-annotations-model, file-view,
  port-menu, terminal-panes), so a renderer filter would have to be repeated in every
  one and would leak wherever it was forgotten. Based on: `grep -rn "state\.(tasks|workspaces|projects)" apps/desktop/src/renderer`.
- **While a removal is pending, incoming server state for that id updates the
  set-aside copy and never reinserts it into the visible arrays.** This covers every
  path that writes those arrays: `taskUpdated`, `workspaceCreated`,
  `projectCreated` (used as the project upsert, `apps/server/src/hub.ts:3413`) and
  the full `stateSnapshot`. Rejected: plain delete-and-reinsert-on-failure — the
  centre closes a workspace's sessions before removing it (`hub.ts:3395`), so
  `taskUpdated` for those tasks arrives mid-removal and an ordinary upsert would
  resurrect them. Based on: `packages/client/src/store.ts:1004-1050` (handlers),
  `store.ts:946` (`stateSnapshot`).
- **A pending removal settles when the centre reports the entity gone**:
  `taskRemoved` / `workspaceRemoved` / `projectRemoved` for that id, a
  `daemonRemoved` for its device (`store.ts:993-995` filters the arrays by daemon),
  or a `stateSnapshot` that no longer contains it. Settling drops the set-aside copy.
- **A `stateSnapshot` that still contains a pending entity rolls it back**
  `(revised on plan audit)`. The centre sends `stateSnapshot` only in answer to
  `clientSubscribe` (`apps/server/src/hub.ts:3077`, its single send site), i.e.
  after a reconnect — and a `workspaceRemove` / `projectRemove` / `taskRemove`
  sent before a silent disconnect is lost and never resent. Exception: task ids
  flushed from `pendingTaskRemovals` on this same `authOk` stay hidden, because the
  store sends `clientSubscribe` before flushing them, so the snapshot is built
  before the centre handles their removal. Rejected: the first draft's "snapshot
  only refreshes the set-aside copy" — it keeps a row hidden for minutes with
  nothing in flight. A removal still genuinely running across the reconnect then
  flashes back and vanishes on its `workspaceRemoved`; accepted.
- **Hidden tasks keep receiving local facts.** Whatever the store applies to a
  visible task — `markSessionExited`'s local EXITED (`store.ts:704`) included —
  is applied to the set-aside copy too, so a rollback never restores a RUNNING
  task with a dead `sessionId`. A `taskUpdated` that moves a cascade-hidden task
  into a workspace that is not pending removal (plan 104 worktree follow,
  `hub.ts:1755-1802`, broadcasts the move before `workspaceRemoved`) reinserts it
  into the visible array. `(revised on plan audit)`
- **Cascade mirrors the centre's broadcasts.** Hiding a workspace hides its tasks;
  hiding a project hides its workspaces and their tasks; a rollback restores the
  whole set it hid, minus anything the centre has since reported removed (partial
  project removal). Based on: the existing cascade in `store.ts:1012-1030`.
- **Rollback triggers, per kind:**
  - *Terminal:* `closeTask` (`store.ts:1368`) is awaited, so its failure branch
    (the non-`session_not_found` error that calls `reportLocalError`) is exactly
    correlated — roll back only that task.
  - *Workspace / project:* the centre's only failure signal is an uncorrelated
    wire `error` (`hub.ts:2183`, `2208`, `3246`, `3385`, `3394`). The store's
    incoming `error` case rolls back **every** pending workspace and project
    removal. Rejected: rolling back on `lastError` in general — `reportLocalError`
    also writes `lastError` (`store.ts:1657`), and a failed terminal stop must not
    resurrect workspace rows. Rejected: adding a request id to `workspaceRemove` /
    `projectRemove` and their errors — a protocol change in both `crates/protocol`
    and `packages/protocol` for a cosmetic gain; a false-positive rollback only makes
    a row flash back and vanish again when its `workspaceRemoved` arrives, the same
    trade plan 078 accepted for create.
  - *Terminal, centre side:* a wire `error` does **not** roll back terminals
    `(revised on plan audit)`. The commonest centre answer to a `taskRemove` that
    fails is 「任务不存在」 from `requireTask` (`hub.ts:3986-3990`) — the task is
    already gone, so hiding is the correct outcome and a rollback would resurrect a
    ghost that cannot be closed until the next reconnect. A lost `taskRemove` is
    caught by the snapshot rule and the fallback timeout instead.
  - *Breadth of the `error` rule:* `hub.ts:2183` is an account-wide `broadcast`, so
    a prepared-operation failure from any client on any device (a failed
    `worktreeAdd` included) also rolls back this client's pending workspace and
    project removals. Accepted as part of the same flicker trade.
  - *Fallback timeout:* minutes-scale, on the order of the centre's
    `preparedOperationTtlMs` (5 min, `apps/server/src/config.ts:136`), counted from
    when the client sends the request (the centre sends no acknowledgement, so
    arrival is not observable). Rejected: reusing
    `PENDING_CREATE_TIMEOUT_MS = 15_000` (`workbench.tsx:133`) — `git worktree remove
    --force` (`crates/worker/src/git.rs:390`) on a large tree is legitimately slower
    than that, and a short timeout would bring the row back while the delete is still
    succeeding. A timeout rollback restores the entity **without** an error message
    `(decided on plan audit)`: it covers the centre's silent returns
    (`hub.ts:3383`, `3389`, `3393`), which have nothing to report, and writing
    `lastError` has renderer side effects on unrelated pending creates
    (`workbench.tsx:1217`, `1452`).
- **Workspace and project removal is not optimistic while the control connection is
  not authenticated**; it reports an error through the existing error channel and
  hides nothing. Rejected: hiding anyway — `connection.send` silently drops when the
  socket is not open (`packages/client/src/connection.ts:184`), so the row would stay
  hidden until the fallback timeout with nothing sent. Terminal close keeps its
  existing offline queue (`pendingTaskRemovals`, flushed on `authOk`), and hiding
  the tab while queued is correct.
- **Hiding a running terminal must not release its session before the stop
  finishes** `(revised on plan audit)`. Hiding unmounts the pane
  (`retainPaneTaskIds`, `workbench.tsx:250-256`); the pane's consumer cleanup
  (`terminal-pane.tsx:925` → `store.ts:836-846`) calls
  `deviceRouter.suspendSession`, which clears the holder and rejects holder waiters
  (`device-router.ts:2488-2500`); `stopSession` is exactly such a waiter after
  `closeTask`'s forced attach (`device-router.ts:2356`, `2457-2463`, `2224-2237`), so
  it rejects without a `code` and `closeTask` treats it as a real failure. The
  session release for a task pending removal is therefore skipped; `taskRemoved`
  (`forgetSession`) or a rollback closes the session's life cycle instead. Rejected:
  hiding only after the stop succeeds — that breaks the same-frame requirement.
- **Logout and disconnect clear pending removals** with their timers, alongside
  `pendingTaskRemovals.clear()` (`store.ts:1328`), since they reset the arrays the
  set-aside copies would be restored into. `(revised on plan audit)`
- **Removal goes through store methods, not raw `client.send`.** The renderer's
  `requestRemoveWorkspace` / `requestRemoveProject` (`workbench.tsx:1230-1258`) call
  client methods that own hide, send and rollback, in the same way `closeTask`
  already owns terminal close. The method names and signatures are the executor's
  call.
- **Selection is a renderer decision taken at confirm time.** When the workspace
  being removed is the one shown, the workbench selects the same project's main
  workspace before (or in the same batch as) dispatching the removal; on rollback it
  does nothing to the selection. Project removal relies on the existing
  `resolveWorkbenchSelection` fallback
  (`apps/desktop/src/renderer/components/workbench/workbench-state.ts`). Terminal
  close relies on the existing active-tab fallback in the workspace container.
- **No protocol, server, daemon or iOS change.**

Left to the executor: the shape of the set-aside store (maps, one record per
removal, …); whether the offline catalog (`persistOfflineCatalog`, `store.ts:551`)
writes server truth or the visible state — either is acceptable, since the next
authenticated snapshot is authoritative; the store API names; how the
`visitedWorkspaceIds` / split-group layout state reacts to a vanished workspace or
task (follow whatever the existing removed-broadcast path already does).

## Direction

The store keeps one bookkeeping structure for pending removals and routes every
writer of `tasks` / `workspaces` / `projects` through it. The renderer changes only
at its three dispatch points (project remove, workspace remove, terminal close) and
in the workspace-remove selection jump.

### Milestone 1: the store hides, settles and rolls back

The client exposes workspace and project removal methods; `closeTask` hides the task
up front. Pending entities are absent from the visible arrays, are not resurrected
by any incoming upsert or snapshot, settle on the removed broadcast or an absent
snapshot entry, and come back on the triggers listed under Decisions. Port and input
state cleanup in the `taskRemoved` handler (`store.ts:1046`ff) still finds the
removed task's `sessionId` when the task is only in the set-aside store.

Add one test file in `packages/client/src/` (harness pattern of
`store-offline.test.ts`) that pins the invariants a person cannot exercise by hand,
because they are races: a `taskUpdated` / `workspaceCreated` arriving mid-removal
does not bring the entity back; a wire `error` restores pending workspace and
project removals (and cascaded tasks) but not a pending terminal; `workspaceRemoved`
settles so a later `error` restores nothing; a `stateSnapshot` restores a pending
entity it still contains and settles one it lacks. Nothing beyond those. Note that
this harness runs with `enableLocalTransport=false`, so `stopSession` throws at once
— it cannot observe the session-release race above; that one is a named walkthrough
item under Done criteria.

Validation: `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` → exit 0;
`node --import tsx --test packages/client/src/*.test.ts` → all pass.

### Milestone 2: the workbench uses it

`requestRemoveWorkspace` / `requestRemoveProject` call the new client methods; a
workspace removal of the shown workspace switches the selection to the same project's
main workspace. Terminal close needs no renderer change beyond what milestone 1
implies.

Depends on milestone 1. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

The two milestones are sequential — do not fan out.

## Landmines

- **Project 「deleting」 limbo (pre-existing, out of scope).** `projectRemove` marks
  the project deleting in the database (`hub.ts:3248`) before removing worktrees; the
  flag is invisible to clients, and a failed worktree removal leaves the project
  stuck — it reappears after rollback but `workspaceCreate` is refused for it until
  `reconcileDeletingProjects` (`hub.ts:2262`) finishes it on a later daemon
  reconnect. Do not try to fix it here; the rollback correctly shows that it still
  exists.
- **`taskRemoved` reads `store.getState().tasks` before `setState`**
  (`store.ts:1046`ff) to find the task's `sessionId` **and `daemonId`** (the latter
  for `forgetSession`, `store.ts:1077-1080`); a hidden task is no longer in that
  array, so both must come from the set-aside copy.
- **Plan 078's create adoption treats any unknown workspace id as the new one**
  (`workbench.tsx:1176-1206`, `knownIds` taken from the visible `workspaces`). A
  workspace hidden at that moment and later rolled back would be adopted as the
  workspace just created. The ids known at create time must include workspaces
  pending removal.
- **`workspaceRemoved` / `projectRemoved` cascade by filtering `tasks` /
  `workspaces`** (`store.ts:1012-1030`); cascaded entities sitting in the set-aside
  store must settle there too, or a later rollback would resurrect tasks the centre
  already deleted.
- **The renderer's pending-create logic reacts to `lastError`**
  (`workbench.tsx:1217`, `1452`). That is unrelated to this plan and must keep
  working; do not route removal rollback through it.
- **The worktree has no `node_modules`.** Run `pnpm install` at preflight before
  any command in the table; it touches nothing tracked.

## Merge and deploy

Desktop-only: ships with the next desktop release, no server deployment, no worker
release, no migration. The release notes should say that removing a workspace,
project or terminal now takes effect immediately and comes back on failure.

## Scope

In scope:
- `packages/client/src/store.ts` and a new test file next to it
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- other files under `apps/desktop/src/renderer/components/workbench/` only where the
  vanished entity needs the same handling a removed broadcast already gets

Out of scope:
- `apps/server`, `crates/*`, `packages/protocol`, `apps/ios` — no wire change
- device removal (`clientRemoveDevice`) — not requested
- the project deleting-flag limbo — pre-existing, separate problem

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod`, by the user | see Done criteria |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Confirming 「删除工作区」 removes the row in the same frame; if it was shown, the
      main area is on the same project's main workspace.
- [ ] Deleting a workspace whose daemon is offline brings the row back in place with
      the error bar showing 「daemon 不在线」; the selection stays where it went.
- [ ] Confirming 「移除项目」 removes the project and its workspaces in the same frame.
- [ ] Closing a terminal removes its tab in the same frame; a failed stop brings it back
      with an error.
- [ ] (walkthrough) Closing a **visible, running** terminal — the tab currently shown
      in its group — stays closed: no flash back, no error bar. This is the
      session-release race no automated gate observes.
- [ ] While disconnected from the centre, workspace/project removal hides nothing and
      reports an error.
- [ ] The new client test asserts the race invariants listed under Milestone 1.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the centre gains a
  correlated removal reply, or a new writer of `tasks` / `workspaces` / `projects`
  appears outside the store).
- The outcome requires a protocol or server change.
- A validation command fails twice after one reasonable fix.
- The renderer turns out to hold its own copy of workspaces or tasks that the store
  change cannot reach.

## Maintenance notes

- Any new store handler that writes `tasks`, `workspaces` or `projects` must respect
  pending removals, or it reopens the resurrection race.
- If the centre ever answers removal with a correlated reply, replace the
  roll-back-everything-on-`error` rule with exact rollback.
