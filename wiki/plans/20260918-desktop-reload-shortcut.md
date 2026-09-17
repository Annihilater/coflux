# Plan 20260918-desktop-reload-shortcut: ⌘R reloads the window, and a renderer rebuild no longer strands main-process state

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 7b442f67..HEAD -- apps/desktop/src/main/menu.ts apps/desktop/src/main/index.ts apps/desktop/src/main/window.ts apps/desktop/src/main/executor-host.ts apps/desktop/src/main/notifications.ts apps/desktop/src/main/tailcat-transport.ts apps/desktop/src/main/tailcat-ipc.ts apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts apps/desktop/src/renderer/components/workbench/use-desktop-daemon.ts apps/desktop/src/renderer/pages/MainPage.tsx`

## Status

- Priority: P2
- Effort: S
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — departure check; the review ran and its findings are folded in
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260918-desktop-reload-shortcut` on `dev/20260918-desktop-reload-shortcut`
- Planned at: `7b442f67`, 2026-09-18

## Requirement

The packaged desktop app has no way to reload its window. `{ role: "reload" }`,
`forceReload` and `toggleDevTools` are gated behind `app.isPackaged`
(`apps/desktop/src/main/menu.ts:25-27`), so ⌘R works in a dev run and does
nothing in the app people actually use. When the UI wedges — a stale list, a
view that did not follow a state change — the only recovery is quitting the
app, which also tears down the central connection and the local daemon's device
channel.

The owner asked for ⌘R, and chose explicitly, among three offered scopes, the
middle one: **reload the interface *and* force the central connection to be
rebuilt**, rather than a page-only refresh.

Exploration established that the central half is free and the main-process half
is the actual work:

- The central `/client` WebSocket is held by the **renderer**
  (`apps/desktop/src/renderer/pages/MainPage.tsx:12-13` creates the client; the
  main process only rewrites the handshake `Origin` at the `webRequest` layer).
  Destroying the renderer destroys that socket, so a plain reload already
  produces a full re-handshake and a fresh catalogue. No code buys this.
- Main-process state, however, **outlives the renderer**, and nothing in the
  main process observes the renderer going away. Two things go wrong today: the
  native Tailcat transport is stranded (lanes, helper subprocess, control
  connection), and the Dock badge freezes at its last value. See Landmines.

What is true when this is done:

- **⌘R reloads the window in the packaged app**, from anywhere in the UI,
  including while a terminal has focus. No confirmation dialog — the owner asked
  for a refresh that just happens, the browser convention.
- The 「视图」 menu carries a 「重新载入」 item showing ⌘R. A dev run shows
  exactly one reload item, not two, and no stray separator in either build.
- The ⌘/ shortcut panel lists the new key
  (`apps/desktop/src/renderer/components/workbench/dialogs.tsx:278-292`).
- After a reload the user is back where they were: still signed in (the token is
  main-process `safeStorage`), still on the same workspace
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:81` persists
  the selection), terminals alive and re-attached with their scrollback (the
  PTYs live in the daemon; the renderer only attaches —
  `apps/desktop/src/renderer/components/workbench/terminal-attach.ts`).
- **Reloading repeatedly does not degrade the app.** Native transport lanes and
  the Tailcat helper process do not accumulate; the Dock badge tracks the
  reloaded UI instead of freezing at a stale count; the executor host stays
  correctly registered. The tenth ⌘R leaves the process in the same shape as the
  first.
- The same cleanliness holds for the other two paths that rebuild a renderer: a
  devtools reload, and recovery after a renderer process crash.

**Accepted, not fixed**: a reload replays one round of attention notifications,
exactly as a cold start does. `workbench.tsx:111` starts `previousRef` empty, so
`diffAttention` reports every currently-waiting workspace as newly entered and
`bridge.notify` fires for each one that is not the focused selection
(`workbench.tsx:123-127`). Suppressing it would require the renderer to know it
came up from a reload rather than a launch — new bridge surface for a
cosmetic difference from an already-accepted behaviour. Out of scope here; see
Maintenance notes.

## Decisions & tradeoffs

- **⌘R is a native menu role, not a page command**: use Electron's
  `{ role: "reload" }` with a Chinese label in the 「视图」 menu and let it
  register its own accelerator. Rejected: the `pageShortcut` pattern this menu
  uses for every other key (`registerAccelerator: false` plus a `DesktopCommand`
  the renderer handles, `apps/desktop/src/main/menu.ts:18-23`) — that pattern
  exists so keys reach the page, and a reload is a `webContents`-level action
  the page has no business round-tripping; `role` also gives the item its
  correct enabled state for free. Consequence: **do not** add a `reload` member
  to `DesktopCommand` (`apps/desktop/src/shared/desktop-bridge.ts:74`) and do
  not add a `KeyR` branch to `use-global-shortcuts.ts`.
  Based on: `apps/desktop/src/main/menu.ts:13-23`.
- **The dev-only block keeps `forceReload` and `toggleDevTools` but loses its
  `reload`**: the reload item becomes unconditional, and the `app.isPackaged`
  branch must no longer contribute a second one. Rejected: leaving the dev
  branch untouched — a dev run would then show two 「重新载入」 items bound to
  the same accelerator. Note that `devItems` currently opens with its own
  `{ type: "separator" }` (`apps/desktop/src/main/menu.ts:27`): once reload is
  unconditional, the separators have to be arranged so that neither build shows
  a stray or doubled divider. Based on: `apps/desktop/src/main/menu.ts:25-27`.
- **Placement**: the reload item sits in 「视图」 above the zoom group,
  separated from the terminal-navigation items that open the menu; the dev-only
  items continue to follow it. Rejected: putting it in the app menu or 「文件」 —
  reload is a view action and macOS apps put it in View. Based on:
  `apps/desktop/src/main/menu.ts:68-80`.
- **Connection teardown belongs to "the renderer was rebuilt", not to ⌘R**: the
  main process must observe its own `webContents` and reset the affected state
  there. Rejected: cleaning up inside the menu item's `click` before calling
  `reload()` — it would miss a devtools reload and a crash-recovery reload, and
  the leak is cumulative, so the paths that are missed are exactly the ones that
  hurt over a long-running app. Based on: nothing in
  `apps/desktop/src/main/index.ts` or `window.ts` currently listens to any
  `webContents` lifecycle event beyond `page-title-updated`, `will-navigate`,
  `will-attach-webview` and `setWindowOpenHandler`.
- **The reset hangs on `did-navigate`, filtered to the main frame and a
  cross-document navigation** *(revised on advisor review)*. Rejected:
  `did-start-navigation` — an external link that `will-navigate` cancels and
  hands to the system browser (`apps/desktop/src/main/window.ts:85-89`) still
  fires `did-start-navigation` first, with `isMainFrame` true and
  `isSameDocument` false, so a reset hung there would tear down the transport
  while the page is not being rebuilt at all. It also fires *before* the commit,
  while the old document is still alive and able to react to the resulting
  `closed` events by re-opening a lane that would then be stranded in turn.
  `did-navigate` fires after the commit, does not fire for a cancelled
  navigation, and does fire for both the initial `loadURL` and every reload.
  Hanging on both events is acceptable only if the `did-start-navigation` branch
  additionally filters through `isTrustedRendererUrl` — but there is no reason
  to need both. The executor must confirm one ordering assumption: `did-navigate`
  must run before the new document can establish any transport or executor
  state. The renderer's own calls come from React effects, far later than the
  commit; the only thing that runs earlier is the preload bootstrap, so check
  that it establishes neither.
- **The reset is idempotent and must tolerate firing on the very first
  `loadURL`**: the first navigation happens before any lane or channel exists.
  Every reset in scope is already a no-op in that state (`close()` on a
  transport with no helper and no lanes; `setChannel("")` when `channelDaemonId`
  is already empty; `setDockBadge(0)` when the count is already zero), and the
  implementation must keep that true rather than guarding with a "have we loaded
  once" flag. Rejected: a first-load guard — it is state that can desynchronise,
  and the underlying operations are naturally idempotent. Both objects are
  constructed before `createMainWindow` (`apps/desktop/src/main/index.ts:331`
  and `:195`, window at `:397`), so no listener placement can observe them
  undefined.
- **The native transport is fully closed on a renderer rebuild, not paused**:
  use `NativeTailcatTransport.close()`. Rejected: `pauseLanes()` /
  `setControl(false, …)` — `pauseLanes` deliberately **keeps** live
  `SESSION_READ` / `SESSION_CONTROL` lanes alive
  (`apps/desktop/src/main/tailcat-transport.ts:167`), and those are precisely
  the lanes the destroyed renderer will never reference or close again. Closing
  the helper process and the control connection is also what the owner chose
  when they picked "force a reconnect to the centre": the new page rebuilds both
  lazily. Based on: `apps/desktop/src/main/tailcat-transport.ts:158-181`.
- **The Dock badge is cleared as part of the reset** *(revised on advisor
  review)*: call `setDockBadge(0)` (already imported in
  `apps/desktop/src/main/index.ts`). Without it the badge freezes at its
  pre-reload value: the main process holds `badgeCount` in module scope
  (`apps/desktop/src/main/notifications.ts:33`) while the fresh renderer starts
  `badgeRef` at 0 and only calls `setBadge` when the computed count *differs*
  from it (`apps/desktop/src/renderer/components/workbench/workbench.tsx:112`,
  `:116-119`) — so a reload into a zero-badge state never sends anything and the
  Dock keeps the old number. The renderer's unmount cleanup that would clear it
  (`workbench.tsx:131-139`) is effect cleanup, which is not guaranteed to run
  when the page is destroyed. Rejected: making the renderer always send its
  count on mount — that is a renderer change to compensate for main-process
  state the main process itself owns.
- **The executor channel reset is defensive hardening, not a bug fix** *(revised
  on advisor review)*: the main process resets its own channel state on a
  renderer rebuild instead of relying on the renderer's mount order to correct
  it. Be clear about what is true today, so this is not mistaken for a repair:
  the renderer **does** currently self-heal, because
  `use-desktop-daemon.ts:11` initialises the daemon state to `null`, so
  `use-executor-bridge.ts:23-26` unconditionally sends
  `setExecutorChannel("")` on every mount before any `daemonId` arrives. That
  empty string differs from the retained id, so it slips past the dedupe at
  `apps/desktop/src/main/executor-host.ts:151` and the subsequent id triggers a
  real `register()`. The reason to do this anyway: the main process must not
  depend on renderer mount order for its own correctness. Giving
  `useDesktopDaemonState` a synchronous initial value, or making
  `useExecutorBridge` skip the effect until a `daemonId` exists, would silently
  restore the dedupe swallow — with no test turning red. Rejected: doing
  nothing, which leaves that trap armed. The reset must produce exactly the
  state a genuine channel drop produces — "the tasks are still running and
  reconciliation restores the state on reconnect"
  (`apps/desktop/src/main/executor-host.ts:154-156`) — and must **not** touch
  the job table; the runner lives in the main process and is unaffected by the
  renderer going away, and re-dispatching a writer would double-write.
- **The reset logic must be unit-testable without an Electron window**: express
  it so a test can drive it with plain doubles for the transport, the executor
  host and the badge, and assert idempotence on the first navigation, the reset
  on a later one, and that a cancelled or untrusted navigation resets nothing.
  Rejected: inlining it as an anonymous listener inside `createMainWindow` —
  `apps/desktop/src/main` has no window-level test harness, and this plan's whole
  value is behaviour that only appears on the *second* reload. Based on: the
  suite is `node --test` over `src/main/*.test.ts`
  (`apps/desktop/package.json`), which exercises modules directly and never
  boots Electron.
- **No confirmation dialog, and no `beforeunload`**: ⌘R refreshes immediately.
  Rejected: guarding against accidental presses — the owner asked for a direct
  refresh, nothing in the UI holds unsaved state the daemon does not already
  own, and `MainPage.tsx:35` records why a `beforeunload` handler must not be
  added here at all (Electron cancels the close outright instead of prompting,
  which would make the window unclosable).
  Based on: `apps/desktop/src/renderer/pages/MainPage.tsx:35`.

### Left to the executor

Genuinely open; decide against the live code:

- Whether the listener is registered in `apps/desktop/src/main/index.ts` (where
  the transport, the executor host and `setDockBadge` are all already in scope)
  or passed into `createMainWindow` as a callback
  (`apps/desktop/src/main/window.ts` holds no reference to any of them today).
- Whether the executor side reuses `setChannel("")` or gains an explicit verb
  for "the renderer went away". Either is fine provided the resulting state is
  indistinguishable from a channel drop and the job table is untouched.
- The wording and placement of the new shortcut row, following the existing rows.

## Direction

One work package. The two milestones touch disjoint files, but milestone 1 on
its own ships a key that makes known main-process leaks reachable, so they are
not independent in any useful sense and must not be fanned out.

### Milestone 1: ⌘R exists in the packaged app

The 「视图」 menu carries an unconditional reload item labelled in Chinese and
showing ⌘R; a dev run shows one reload item rather than two, with `forceReload`
and `toggleDevTools` still dev-only and no stray or doubled separator in either
build; the ⌘/ panel lists the key. `DesktopCommand` and
`use-global-shortcuts.ts` are unchanged.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0.

### Milestone 2: a renderer rebuild leaves nothing stranded or stale

When the main process observes its own renderer being rebuilt, it closes the
native Tailcat transport, resets the executor channel and clears the Dock badge,
so that repeated reloads neither accumulate lanes and helper processes nor leave
the Dock showing a count from before the reload. Firing on the initial load is a
no-op, and a navigation that never rebuilds the page resets nothing.

New tests in `apps/desktop/src/main/` must assert at least:

- **(a)** the first navigation, with nothing open, changes nothing;
- **(b)** a later cross-document main-frame navigation closes the transport,
  drops the executor channel and zeroes the badge;
- **(c)** a navigation that is cancelled or whose URL is not a trusted renderer
  URL resets nothing — this is the guard against the `did-start-navigation`
  trap described under Landmines;
- **(d)** as a regression guard only: after a reset, a renderer re-announcing
  the *same* `daemonId` re-registers the executor host rather than being
  swallowed by the dedupe. Note this assertion passes on the untouched baseline
  (the renderer's `""`-then-id mount order already produces it), so it proves
  nothing about the new code — it exists to catch a future change to that mount
  order or to the dedupe.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0.

## Landmines

- **`did-start-navigation` fires for navigations that never rebuild the page.**
  `will-navigate` hands external links to the system browser and cancels the
  navigation (`apps/desktop/src/main/window.ts:85-89`), but `did-start-navigation`
  has already fired by then, main-frame and cross-document. Today no bare
  `<a href>` in the renderer reaches that path (terminal links go through
  `window.open` and `setWindowOpenHandler`), so this is latent rather than live —
  which is exactly why a test has to pin it. See the event decision above.
- **The executor dedupe is currently bypassed by renderer mount order, so do not
  read the main process as "already safe".** `executor-host.ts:151` returns
  early when the announced `daemonId` equals the retained one; what saves it
  today is that the renderer always sends `""` first
  (`use-executor-bridge.ts:23-26`, because `use-desktop-daemon.ts:11` starts at
  `null`). The protection lives in the renderer, not where it is needed.
- **`pauseLanes()` is not a cleanup**: it keeps live `SESSION_READ` /
  `SESSION_CONTROL` lanes open by design
  (`apps/desktop/src/main/tailcat-transport.ts:167`). Using it here would leak
  precisely the lanes that matter.
- **Lane leaks hit hard quotas**: 256 records per lane and 1024 records /
  128 MB globally (`apps/desktop/src/main/tailcat-transport.ts:131`); past the
  cap, remote device connections start failing for reasons that look nothing
  like "I pressed ⌘R a lot".
- **`close()` leaves `online` untouched and does not clear the in-flight
  `starting` state.** The first is wanted: the new page's
  `control(true, false)` is then a no-op and the transport rebuilds lazily. The
  second means a reset landing exactly on an in-flight `ensure()` makes the new
  page's first `open()` reject with 「连接已取消」; the device router retries, so
  it is transient — do not "fix" it here.
  Based on `apps/desktop/src/main/tailcat-transport.ts:177-181`.
- **`close()` bumps `epoch`** (`apps/desktop/src/main/tailcat-transport.ts:178`)
  to cancel in-flight `open()` calls, so a lane opening at the moment of reload
  rejects rather than resolving into a stranded lane. Intended, not a bug.
- **`tailcat-ipc.ts` has no lifecycle surface**: it registers exactly
  open / send / ack / close / control, all renderer-initiated. Do not expect a
  renderer teardown to arrive through it — React effect cleanup is not
  guaranteed to run when the page is destroyed, which is the whole reason this
  plan exists. The same caveat applies to the badge cleanup at
  `workbench.tsx:131-139`.
- **The first `loadURL` fires the navigation event too** — see the idempotence
  decision above.
- **Do not add a `beforeunload` handler**: `MainPage.tsx:35` documents that
  Electron treats `preventDefault` on it as "cancel the close", making the
  window unclosable.
- **⌘W is already the page's "close terminal"** and window close was moved to
  ⇧⌘W (`apps/desktop/src/main/menu.ts:54`). ⌘R is currently unclaimed by both
  the menu and `use-global-shortcuts.ts`; a main-process accelerator wins over
  the page's capture-phase handler anyway, so a terminal never sees it.

## Scope

In scope:
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/window.ts`
- `apps/desktop/src/main/executor-host.ts`
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- New test files under `apps/desktop/src/main/`

Out of scope:
- `apps/desktop/src/main/tailcat-transport.ts` internals — `close()` already has
  the complete teardown semantics this needs; changing it risks the remote path
  for no gain here.
- `apps/desktop/src/main/notifications.ts` — the badge fix is a call from the
  reset, not a change to the badge module.
- `apps/desktop/src/main/tailcat-ipc.ts` — the reset is driven by a window
  lifecycle event, not by a new IPC verb.
- `apps/desktop/src/shared/desktop-bridge.ts` and
  `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts` —
  reload deliberately stays off the page command path.
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`,
  `use-executor-bridge.ts`, `use-desktop-daemon.ts` — the renderer's mount
  behaviour is cited as evidence, not changed. Suppressing the replayed
  attention notifications is explicitly not part of this plan.
- `apps/desktop/src/renderer/pages/MainPage.tsx` and the renderer client — the
  central WebSocket is rebuilt by the reload itself.
- The executor job table, manager and runner behaviour.
- Non-macOS key bindings and menus — `role: "reload"` carries its own
  cross-platform accelerator, and nothing beyond that is promised here.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 (214 passing at the `7b442f67` baseline, plus this plan's new tests) |

Both commands pass at the planned baseline. The first run in a fresh worktree
links dependencies before the suite starts; that writes only `node_modules`.

The UI walkthrough — press ⌘R repeatedly in a dev preview, confirm terminals
re-attach, the Dock badge follows, and remote devices still connect — is the
owner's to do by hand: this repository's convention is that front-end changes
are not agent-verified through UI automation.

## Done criteria

- [ ] All listed commands pass.
- [ ] The 「视图」 menu shows exactly one 「重新载入」 item in both packaged and
      dev runs, with no stray or doubled separator, and the ⌘/ panel lists ⌘R.
      *(Menu structure is assertable in a test; that ⌘R actually reloads a
      packaged window is the owner's manual check.)*
- [ ] A renderer rebuild closes the native transport, resets the executor
      channel and clears the Dock badge; the initial load does not; a cancelled
      or untrusted navigation does not.
- [ ] Tests (a) through (d) of milestone 2 exist and assert meaningful
      behaviour, with (d) documented in place as a regression guard that already
      passes on the baseline.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `did-navigate` turns out to fire *after* the new document can establish
  transport or executor state — the ordering assumption named in the event
  decision. The reset would then be racing the page it is cleaning up after.

## Maintenance notes

- Anything else the main process starts to hold on behalf of the renderer must
  join this reset. The rule: if the renderer created it over IPC, or the main
  process mirrors a value the renderer computes, a reload strands it. Checked
  and found safe at planning time: the daemon manager, the updater, the token
  store and the client broker are all main-process-owned state that the renderer
  re-reads on mount; every `ipcMain` handler is registered once and validates by
  sender URL rather than frame identity.
- The reverse rule holds for the renderer: state that must survive ⌘R belongs in
  `localStorage` or in the main process, not in React state.
- The replayed attention notifications after a reload (see Requirement) are
  accepted, not fixed. If they become annoying in practice, the fix belongs in
  the renderer — it would need to distinguish a reload from a launch — and is a
  plan of its own.
- If a future change routes the central WebSocket through the main process (a
  broker, or the native transport), this plan's premise — that reloading
  rebuilds the central connection for free — stops being true and the reload
  path has to reconnect it explicitly. `main/client-broker.ts` is *not* that: it
  is a unix-socket bridge letting the CLI reuse the app's login, unrelated to
  the renderer's socket.
