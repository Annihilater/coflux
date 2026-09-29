# Plan 20260929-notification-click-landing: Clicking a macOS notification lands on its workspace and terminal

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 90095a31..HEAD -- apps/desktop/src/main/notifications.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc-sanitize.ts apps/desktop/src/shared apps/desktop/src/preload/index.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/notification-inbox.tsx apps/desktop/src/renderer/components/workbench/desktop-attention.ts packages/client/src/store.ts`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; work lives in `.claude/worktrees/20260929-notification-click-landing` on `dev/20260929-notification-click-landing`
- Planned at: `90095a31`, 2026-09-29

## Requirement

On macOS, clicking a Coflux desktop notification brings the app forward but does
not land on the workspace and terminal the notification is about. The user
expects one click to leave them looking at, and typing into, the terminal that
raised it.

Two kinds of notification exist, and both must land:

- **Inbox notifications** (`coflux notify` from an agent): each has a
  `notificationId` and a `taskId`. Today the click is routed to the inbox's
  `view()`, which navigates by `taskId`.
- **Attention notifications** (an agent entering the approval or question
  state, plan 103): today they carry only a `workspaceId`, so a click can at
  best select the workspace and never the terminal that is waiting.

When done:

- Clicking either kind of notification — as a banner, or later from
  Notification Center while the app is still running — brings the window
  forward, selects the right workspace (or device view, for a device-home
  terminal), activates the terminal tab that raised it, and that terminal has
  keyboard focus, even when a built-in browser tab had focus before.
- If the terminal no longer exists, the fallback is the existing behaviour:
  inbox notifications show the inbox with its "source deleted" message;
  attention notifications select the workspace if it still exists, otherwise
  nothing happens.
- Nothing about when notifications are shown, their text, dedupe, or the Dock
  badge changes.
- Retention is bounded (see Decisions): once more than that many notifications
  have been shown in one run, clicking one of the oldest only brings the app
  forward. Acceptance does not test past the bound.

The two kinds fail for different reasons today, and both must be fixed:
inbox notifications already route by `taskId` in the renderer, so for them the
failure is the main process losing the click (root cause 1); attention
notifications never reach a terminal by design, because they carry no task —
their click selects the workspace and the workspace's previously focused tab
takes focus (`workbench.tsx:763-769`, the `[activeWorkspaceId]` effect around
`:1005-1010`), not the terminal that is waiting.

## Decisions & tradeoffs

- **Root cause 1 — the native notification must stay reachable until the user
  acts on it**: the main process keeps a strong reference to every shown
  `Notification` until its `click` or `close` fires. Mechanism (revised on
  plan audit): when the JS wrapper is collected, Electron clears the native
  notification's delegate but leaves the notification itself in place and
  clickable; a later click still activates the app through macOS, yet no
  `click` event reaches JS — exactly "app comes forward, lands nowhere".
  Rejected: relying on the closure over `native` — the object is otherwise
  unreferenced and collectable. Based on: `apps/desktop/src/main/notifications.ts:11-16`
  (local `native`, no reference kept); Electron v44.3.0 source
  `shell/browser/api/electron_api_notification.cc:112-123` (destructor only
  `set_delegate(nullptr)`) and `shell/browser/notifications/notification.cc:52-56`
  (`NotificationClicked` emits only `if (delegate())`). Inferred from source,
  not reproduced — see Landmines on why it cannot be reproduced in dev.
- **The retention is bounded, and generously** (revised on plan audit):
  `close` is documented as not guaranteed to fire — on macOS it rarely fires
  for a banner that slides into Notification Center — so in practice each
  notification lives until the bound evicts it. Release on click and on close,
  and cap the set at no fewer than 200 entries, dropping the oldest. An
  unbounded set is not acceptable; a small cap (tens) is not acceptable either,
  because every evicted notification becomes a dead click. The data structure
  is the executor's call.
  Based on: `electron.d.ts` `close` event ("not guaranteed to be emitted in
  all cases").
- **The click hands the keyboard to the workbench page before routing**: on a
  notification click the main process focuses the workbench `webContents`
  (not only the window) before sending the target to the renderer, the same
  rule `sendCommand` follows. Rejected: `showMainWindow()` alone — a focused
  built-in browser page keeps the keyboard, so the terminal would be
  activated but not typeable. Whether this lives in `showMainWindow()` or only
  on the notification path is the executor's call; if it goes into
  `showMainWindow()`, check its other callers are unharmed. This inherits
  `sendCommand`'s assumption that `webContents.focus()` takes the keyboard
  back from a `<webview>` guest; that commit has no recorded real-machine
  acceptance, so the acceptance row below is what confirms it. Based on:
  `apps/desktop/src/main/index.ts:72-77` (`showMainWindow` has no
  `webContents.focus()`), `:84-94` (`sendCommand` and its comment, commit
  `90095a31`).
- **Both notification kinds carry the `taskId` of the terminal that raised
  them**: attention notifications gain the task of the session that is in the
  approval/question state. Rejected: resolving "some terminal in that
  workspace" at click time — by then the waiting state may have moved or
  cleared, and the notification is about the terminal that was waiting when it
  fired. The task id must come from the same task whose agent names the
  notification (revised on plan audit): `workspaceActivity` picks the first
  approval (else first question) in `tasks` order, and the notification's
  title uses that agent — the click must land on that same task, never on a
  different one found by another traversal. Add an optional `taskId` to
  `workspaceActivity`'s approval/question results (additive — other callers
  `sidebar.tsx:250`, `command-palette-data.ts:171,192` must be unaffected) and
  carry it through `attentionSnapshot`. Rejected: a second traversal inside
  `attentionSnapshot` — it can disagree with the agent in the title when
  several sessions wait at once.
  The attention dedupe rule (same workspace, same kind → notify once) stays
  keyed on workspace and kind, not on task. Based on:
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:208`
  (attention notify sends only `workspaceId`), `packages/client/src/store.ts:96-107`
  (the loop knows `task.id` but returns only the agent).
- **One landing routine, by `taskId`**: every notification click reaches the
  terminal through a single renderer routine that takes a task id and lands on
  it the way the command palette does — including the directory-workspace
  case, where a device-home terminal selects its device (`selectDevice`)
  rather than the directory workspace. The palette and the notification path
  must share this code, not two copies. Rejected: keeping
  `navigateNotificationTask` as a separate routine that calls
  `selectWorkspace` directly — that is the bug that leaves a device-home
  terminal's sidebar with nothing highlighted. The routine also closes the
  settings page, as `navigateNotificationTask` does today. Constraints
  (revised on plan audit): the routine must not filter on
  `TaskStatus.RUNNING` — the palette lists only running tasks, but an inbox
  notification may point at an exited task that still exists and must still
  land, as it does today; it must activate through `activateTaskByUser`
  (whose `attach.focusTask` is what forces focus when the document's active
  element is a `<webview>`), not only change layout and selection; and it
  returns whether it landed, leaving every fallback UI (opening the inbox,
  the "source deleted" message) to its caller so the palette never inherits
  inbox behaviour. Keep the palette's `onOpenTerminal(workspaceId, taskId)`
  signature (`command-palette.tsx:261`) and adapt inside `workbench.tsx`, so
  `command-palette.tsx` stays untouched. Based on:
  `workbench.tsx:740-750` (`openPaletteTerminal` with the dir-workspace
  branch), `:751-759` (`navigateNotificationTask` without it).
- **Fallback when the task is gone**: the inbox keeps its current fallback
  (mark read, open the inbox with the "source deleted" message,
  `notification-inbox.tsx:40-46`); an attention click whose task is gone
  selects the workspace if it still exists, as the existing `focusWorkspace`
  handler does (`workbench.tsx:763-769`). Whether attention clicks keep
  travelling on `IPC.focusWorkspace` or move onto a single channel is the
  executor's call, provided the IPC payload stays sanitized in
  `ipc-sanitize.ts` (`taskId` is already accepted there, `:17-26`).
- **Not in scope: notifications from a previous app run** (decided while
  exploring). After a relaunch, clicking a leftover notification only opens
  the app; wiring `Notification.getHistory()` is a separate change the user
  did not ask for.

## Direction

The click path is: main process shows a retained `Notification` → click →
window forward and keyboard to the workbench page → renderer receives a target
that carries `taskId` (and `workspaceId`, `notificationId` where present) →
one landing routine activates that task in its workspace or device view.

### Milestone 1: The main process keeps notifications alive and focuses the workbench on click

Every shown notification is strongly held (bounded) until click/close; a click
brings the window forward and focuses its `webContents` before the target is
sent. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0.

### Milestone 2: Every notification lands on its terminal

Attention notifications carry the waiting task's id; inbox and attention
clicks go through one landing routine shared with the command palette, with
the dir-workspace → device selection and the fallbacks above. Validation:
`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` -> exit 0.

Milestones 1 and 2 touch disjoint files except the shared bridge types
(`apps/desktop/src/shared/desktop-bridge.ts`, which already has `taskId` on
`DesktopNotification`); they are small — run them as one work package, do not
fan out.

Tests: extend `desktop-attention.test.ts` with one case — two sessions waiting
in one workspace — asserting the snapshot's `taskId` belongs to the same task
as its `agent`. Do not add tests that restate the React wiring or Electron
calls.

## Landmines

- **Native notification clicks cannot be observed in dev or in an unsigned
  pack.** Electron 42+ uses UNUserNotification on macOS, which requires a
  signed build (`notifications.ts:5-9`). `pnpm dev:desktop:prod` and
  `pnpm -C apps/desktop run pack` will not deliver to Notification Center, so
  the GC fix can only be accepted on a signed release build. The renderer
  half (landing by `taskId`, dir workspace, keyboard focus) can be exercised
  in dev by sending the IPC target by hand, if the verifier wants to.
- **Inbox notifications are suppressed while the window is focused and
  visible** (`index.ts:387`), and the main process tells the two kinds apart
  by whether `notificationId` is present. Once both kinds carry `taskId`, that
  discriminator must stay `notificationId` — switching it to `taskId` would
  swallow attention notifications whenever the window is focused. Attention notifications are suppressed in the
  renderer when the waiting workspace is the selected one and the document has
  focus (`workbench.tsx:206-207`). Keep both rules; a naïve refactor of the
  notify path can drop them.
- **`NotificationInbox`'s `onFocusNotification` effect has no dependency
  array** (`notification-inbox.tsx:40`) and re-subscribes every render on
  purpose so `view()` sees fresh props. If you touch it, do not add `[]` —
  that would freeze a stale `onNavigate`.
- **Directory workspaces**: selecting one directly shows a device detail
  carrier with nothing highlighted in the sidebar; only the canonical
  directory workspace of a device (`canonicalDirWorkspaceOf`,
  `workbench.tsx:358`) maps to `selectDevice`. A non-canonical directory
  workspace still falls back to `selectWorkspace` — keep the palette's exact
  condition.
- `pnpm -C apps/desktop pack` is hijacked by pnpm's built-in `pack`; use
  `pnpm -C apps/desktop run pack` if a package is ever needed.

## Scope

In scope:
- `apps/desktop/src/main/notifications.ts`
- `apps/desktop/src/main/index.ts` (notification click handling, window focus)
- `apps/desktop/src/main/ipc-sanitize.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/desktop-bridge.ts`, `apps/desktop/src/preload/index.ts` — only if the IPC payload or channels change
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/notification-inbox.tsx`
- `apps/desktop/src/renderer/components/workbench/desktop-attention.ts` and its test
- `wiki/plans/README.md` and this plan — status updates
- `packages/client/src/store.ts` — additive change to `workspaceActivity` only, if the executor picks that route

Out of scope:
- Restoring clicks on notifications left over from a previous run (`Notification.getHistory()`) — not requested.
- When notifications fire, their copy, dedupe, and the Dock badge — unchanged behaviour.
- iOS and the server — the bug is desktop-only.
- `apps/desktop/src/renderer/components/workbench/command-palette.tsx` — its callback signature stays; adapt in `workbench.tsx`.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Client typecheck (only if `packages/client` changed) | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | no errors beyond the pre-existing baseline, all in `packages/client/src/connection.test.ts` (run it on the planned SHA first to capture the baseline; it exits 1 today) |
| Real-machine click (acceptance) | signed release build: trigger `coflux notify` and an approval wait from a terminal in a non-selected workspace and from a device-home terminal, with a built-in browser tab focused; click the banner and a Notification Center entry | lands on that terminal, sidebar highlights it, keystrokes go to it |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Shown notifications are strongly held; released on click and on close; capped at ≥ 200, evicting the oldest.
- [ ] A notification click focuses the workbench `webContents` before routing.
- [ ] Attention notifications carry the `taskId` of the same task whose agent names them; a `desktop-attention.test.ts` case pins this with two waiting sessions in one workspace.
- [ ] Inbox, attention, and command-palette landing share one routine that goes through `activateTaskByUser`, does not filter on status, and returns whether it landed; a device-home terminal selects its device.
- [ ] Fallbacks for a vanished task match the Requirement.
- [ ] Show/suppress rules (discriminator still `notificationId`), copy, dedupe, and badge unchanged.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example, `openPaletteTerminal` no longer has the dir-workspace branch, or `DesktopNotification` no longer carries `taskId`).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Carrying a task id on attention notifications would change when they fire or how they dedupe.

## Maintenance notes

- The GC cause is inferred from Electron's documentation, not reproduced; the
  user's signed-build walkthrough is what confirms it. If clicks still do
  nothing on a signed build after this change, look next at whether the
  `click` event fires at all under UNUserNotification (log it in
  `~/Library/Logs/Coflux/main.log`) before touching the renderer.
- Plan audit notes: every audit finding was applied; none rejected.
- If Notification Center persistence across relaunches is ever wanted, it
  needs `Notification.getHistory()` at startup plus a stable `id` that
  encodes the target; that is a separate change.
