# Plan 20261011-standalone-device-screen: A device's screen is a standalone view in the sidebar, not a workspace tab

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat a0a52e49..HEAD -- apps/desktop/src docs/remote-screen.md`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: wiki/plans/20261011-screen-resolution-presets.md, wiki/plans/20261010-screen-lane-frames.md (same branch)
- Category: feature
- Execution: subagent(opus) — departure check, 2026-10-11
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: current — linked worktree `.claude/worktrees/20261010-screen-lane-frames` on `dev/20261010-screen-lane-frames`; lands in PR #107
- Planned at: `a0a52e49`, 2026-10-11

## Requirement

Since the remote screen started working end to end (this branch), the user found that a screen opened as a tab inside one workspace's editor group is easy to lose, and that the resolution dropdown (`ResolutionMenu` in `screen-view.tsx`) is oversized and unlike the app's other compact menus. A screen belongs to a device, not to a workspace.

Product conclusions (confirmed by the user at the product gate; do not reopen):

- **Form.** A screen is no longer a workspace tab. It is a standalone view, **at most one per device**.
- **Entry: a screen button in the top-right action dock**, before 文件 / ports / notifications. It opens the screen of **the current selection's device** — the selected workspace's device, or the selected device page's device. It is shown only when that device advertises the screen capability and is not this Mac. If that device's screen is already open, the button jumps to it (several workspaces on the same device all land on the same screen). Also kept: 「打开屏幕」 in the sidebar device row's context menu, and 「打开屏幕」 in the command palette. **Removed:** the ＋/⌘T new-tab menu's 「屏幕」 item and the File menu's 「新建屏幕标签页」.
- **Sidebar.** An open screen appears as an indented sub-row under its device in the 设备 section: monitor icon, 「屏幕」 and the resolution (e.g. `屏幕 · 1440×900`). Clicking it selects the screen (highlighted while selected, like a selected device row). Hovering shows ×, which disconnects: the remote session ends and the virtual display goes away, and the sub-row disappears.
- **Main area.** A selected screen fills the whole main area to the right of the sidebar. A status bar on top shows the device, direct/relay and latency, the resolution dropdown, 「沉浸」 and 「断开」. The top-right action dock stays usable. Selecting a workspace pauses the screen (session and virtual display kept); selecting the screen again resumes it. Immersive mode (⌃⌥⌘F, and the 沉浸 button) behaves as today.
- **Resolution dropdown.** Same options and behaviour as plan `20261011-screen-resolution-presets` (跟随窗口 + 5 presets, per-device memory), restyled like the app's other compact menus: no chevron, the current option marked with a ✓, the trigger's own font size.
- **Restart.** Open screens are restored to the sidebar after an app restart and reconnect when selected; the per-device resolution choice is kept. Old screen *tab* records are dropped without migration.
- **Done when (user-observable).** From any workspace on Home, the top-right button opens Home's screen; the sidebar shows the 屏幕 row under Home; switching to a workspace and back leaves the screen as it was; opening it from a second Home workspace jumps to the same screen; × disconnects it.

## Decisions & tradeoffs

- **A screen is a selection, not a layout entry.** The workbench selection gains a third kind, a device's screen, next to `workspace` and `device` (`WorkbenchSelection` in `components/workbench/workbench-state.ts:33`), persisted through the same stored-selection key with its own serialization, and kept valid by `resolveWorkbenchSelection` (`workbench-state.ts:66-92`) only while that device still exists **and** has an open screen record — otherwise it falls back like any invalid selection. Rejected: keeping a tab and adding a sidebar shortcut to it — the user wants the screen detached from workspaces. Rejected: a separate boolean overlay like `settingsOpen` — a screen must be selectable, highlighted and restored like the other selections.
- **Screen records are keyed by device id, one per device**: the record holds the device id and the stable remote session id (`createScreenSessionId`), under a new storage key scoped by server address; the old `SCREEN_TABS_KEY` records are ignored (and may be removed). No workspace, no directory workspace: opening a screen must not call `ensureDirectoryWorkspace` or require the device's canonical directory workspace (today `openDeviceScreen`, `workbench.tsx:864-887`). The server-side `directoryWorkspaceEnsure` operation stays untouched (out of scope); the desktop simply stops using it for screens.
- **The screen-tab kind leaves the tab system entirely.** Every registration listed under Landmines is removed or replaced; after this change no layout entry, tab strip, ＋ menu, ⌘W path, focus/activate branch or reconcile exemption knows about screens. Rejected: leaving dead `SCREEN_TAB_PREFIX` handling "for compatibility" — old ids must simply be dropped by reconcile like any unknown id.
- **The screen view is a layer over the whole main area that stays mounted.** One view per open screen record, kept mounted while the record exists (hidden with `visibility`, never unmounted or re-keyed, so the canvas, decoder and session survive selection changes); visible and focused exactly when its screen is the selection. Its session's visibility drives pause/resume as today (`ScreenSession.setVisible`). Based on: today's `ScreenViews` layer (`screen-view.tsx:78-86`, per-view `visibility`) and `ScreenRuntime` (`screen-runtime.ts`, today keyed by tab id — re-key by device).
- **A screen selection means no active workspace, and the screen layer lives outside the terminal `<main>`.** With a screen selected, `activeWorkspaceId` is null. That is what keeps visited workspaces mounted but invisible (`workbench.tsx:1778-1786`), nulls `activeTerminalRef` (`:1616`) and so turns ⌘T/⌘W/⌘1–9/⌘\ into no-ops; this mechanism satisfies the hidden-workspace shortcut criterion. The screen layer cannot stay inside `<main>`, because `<main>` renders only when there are terminal workspaces (`:1766`) and goes invisible without an active one. It becomes a `relative isolate` sibling that takes the flex slot, rendered whenever any screen record exists regardless of visited workspaces, and placed before the action dock in document order. The no-selection empty state (`:1911`, `!pendingSelected && !selectedDevice && !activeWorkspace`) and `document.title` (`:991-994`) gain a screen case. The screen's device is retained like a selected device (`selectedDaemonId`, `:527`, `retainDevice`). (revised on plan audit)
- **Focus follows the selection from an effect, not from the click.** Views are pre-mounted and hidden, so focusing the picture synchronously in a click handler targets a `visibility:hidden` element. Focus is driven from an effect after the screen selection commits (mirror `focusShownTab`, `workbench.tsx:1440-1446`), or the runtime's pending focus is consumed when the view's `visible` flips. (revised on plan audit)
- **Opening never replaces an existing record.** Open = create a record (new `createScreenSessionId`, `fresh` = take over) only when the device has none; otherwise just select the existing one, same session id, no takeover. Consequently, after a restart, 「打开屏幕」 on a device whose record survived is a jump that does not take over; a taken-over screen recovers only through 「重新接管」 (as `docs/remote-screen.md` says). Re-creating the record on a jump would open a second remote session and orphan the first virtual display. (revised on plan audit)
- **Records are reactive and pruned.** The Workbench subscribes to the record store (`useStore`), so removing the selected screen's record re-validates the selection in the same render. Records whose device is gone from the snapshot are pruned once the snapshot is ready, like the file-tab prune effect (`workbench.tsx:825-835`, gated on `snapshotReady`), along with their hidden view and session. Disconnecting (× or 「断开」) the *selected* screen returns to the selection the user came from (the same "previous selection" the dock button uses), not `resolveWorkbenchSelection`'s first-project fallback, which stays for the device-gone case. (revised on plan audit)
- **The sidebar sub-row's resolution text** is the connected remote size (`ScreenSession.state.display`) when known, else the fixed preset's label when one is chosen, else just 「屏幕」. The sidebar subscribes to the session state for this (`runtime.sessionOf` + `useSyncExternalStore`). (revised on plan audit)
- **The palette offers 「打开屏幕」 based on the current selection's device**, not on `current.workspaceId` (`command-palette.tsx:237`), so it works from a device page with no directory workspace and from a screen selection. The palette action key `new-screen-tab` is renamed (`command-palette-data.ts:23, 254, 262`; test `:264-271`), consistent with the leftover-grep command. (revised on plan audit)
- **Immersive is keyed by device.** `immersiveTabId` becomes the immersive device's id; "on screen" means that device's screen is the selection; `onToggleImmersive` (`:1685-1690`), `toggleSidebar` (`:1102`) and `immersiveOnScreen` (`:1401`) are re-keyed accordingly. (revised on plan audit)
- **The status bar sits at the window's top edge, so it is a drag band that leaves room for the docks.** It behaves like the 文件 overlay header (`workspace-terminal.tsx:1412-1430`): draggable background, `paddingRight` of the measured dock width, the collapsed-sidebar left-dock reserve, and every control in it `no-drag`. It must precede the action dock in document order so the dock's no-drag hole wins (`drag-region.ts:3-30`; comment at `workbench.tsx:2072-2082`). Height follows the app's top bar (`h-9`), not the old 28 px. In immersive mode the existing slide-in behaviour stays.
- **The top-right button lives in the existing action dock** (`workbench.tsx:2083-2120`), styled like the 文件 toggle beside it (icon button, Tooltip, no native `title`). While the current selection is that device's screen it shows pressed; clicking it then returns to the selection the user came from (the last workspace or device page), mirroring a toggle. (decided while planning)
- **The resolution dropdown follows `ScopeMenu`** (`changes-view.tsx:1129-1158`): `items` with a `Check` icon (or an empty `size-3.5` placeholder) for the current value, `hasChevron={false}`, ghost `sm` trigger with the standard compact-trigger style, `menuWidth` about 200, sibling `Tooltip` with `anchorRef`. No `DropdownMenuRadioGroup`, no `fontSize: "inherit"`. Behaviour and storage from `screen-resolution.ts` are unchanged.
- **Immersive mode keys on the screen (device), not a tab id.** Today `immersiveTabId` and its exit rule ("ends when the tab is not visible", `workbench.tsx:1401-1411`) carry over with the screen selection as the visible condition; the sidebar, left dock and action dock are hidden as today (`workbench.tsx:1697, 1738, 2087`).
- **Main process: only the File menu item goes.** `main/menu.ts:63` 「新建屏幕标签页」 and the `"new-screen-tab"` command (`shared/desktop-bridge.ts:124-125`, `use-global-shortcuts.ts:275-277`) are removed. `screen-host.ts` is keyed by session and device id, not tab id, and needs no change.
- **Tests.** Update or remove tests that pin the removed tab kind (`screen-tabs.test.ts`, the screen-id cases in `file-tabs.test.ts`, `command-palette-data.test.ts`). Add a test only where it pins something a person would not notice: the selection serialization/validation of the new kind (a screen selection whose record or device is gone falls back), and parsing of the new per-device records (garbage ignored, one per device). Per `AGENTS.md` (Test harness), no tests restating UI.

## Direction

### Milestone 1: screens are per-device records and a selection kind

Per-device screen records with their storage; the selection kind, its serialization and validation; `ScreenRuntime` keyed by device. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test`.

### Milestone 2: the screen view fills the main area and the tab kind is gone

The screen layer renders over the whole main area driven by the selection; the status bar is the drag band described above; immersive keys on the screen; the resolution dropdown is restyled; every screen-tab registration is removed (Landmines list), including the ＋ menu item, the File menu item and the command; the palette and device-row 「打开屏幕」 now open or jump to the device's screen. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`.

### Milestone 3: the sidebar sub-row and the top-right button

The 设备 section shows each open screen as an indented sub-row under its device (select on click, × to disconnect on hover, highlighted when selected); the action dock shows the screen button per the product rules. `docs/remote-screen.md` describes the new form (entry points, one per device, selection, restore). Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`.

Milestones are sequential (M2 and M3 build on M1's selection and records, and share `workbench.tsx`); one work package — do not fan out.

## Landmines

- **Every place the screen-tab kind is wired in** (remove or replace all; renderer paths relative to `apps/desktop/src/renderer/components/workbench/`):
  - `terminal-layout.ts:100-109` (`SCREEN_TAB_PREFIX`, `isScreenTabId`), `:124-125` (`isViewTabId` includes screens — the reconcile exemption), `:129-130` (`isTaskTabId`), `:186-188` (`screenTabIdsOf`), `:782-789` (`pruneScreenTabs`), `:748` (reconcile).
  - `screen-tabs.ts` (whole module) and `screen-tabs.test.ts`; screen ids in `file-tabs.test.ts`.
  - `screen-runtime.ts:15-106` (keyed by tab id; `fresh` = take over on first open, keep that semantics per device).
  - `workbench.tsx`: imports `:6, :83, :112`; `:187` store; `:427-434` cold-start restore (chained into the file-tab restore at `:430` — keep file tabs restoring); `:441` runtime; `:444-449` immersive/focus refs; `:590` `focusTab`; `:666-669` `activateTaskByUser`; `:746-754` `canOpenScreenOn` (keep as the capability gate); `:760-777` open/close; `:837-857` immersive; `:864-887` `openDeviceScreen`; `:1102` `toggleSidebar`; `:1386-1411` entries/immersive exit; `:1574-1577` ⌘W; `:1599-1602`, `:1642-1648` handles/actions; `:1684-1690`; `:1697, :1738` immersive hides docks/sidebar; `:1755` sidebar `onOpenScreen`; `:1810-1812` props; `:1843-1857` `<ScreenViews>`; `:1884-1894` device empty state's 打开屏幕; `:2029` palette; `:2087` dock hidden in immersive.
  - `workspace-terminal.tsx`: `:43`, `:130-131`, `:173-176`, `:205-210`, `:253-254`, `:340` (＋ menu 屏幕), `:542-568`, `:695`, `:863-915` (`renderScreenTab`), `:1030`, `:1227`; drag ghost `DragGhost.screen` (`:398-399`), `tabDragProps(..., screenGhost, ...)` (`:750, :761`), `dragGhost.screen` (`:1401`) — none match the grep patterns. (revised on plan audit)
  - Palette: `command-palette-data.ts:23, 124-125, 252-264`; `command-palette.tsx:53-54, 237, 278`; `command-palette-data.test.ts`.
  - Shortcuts: `use-global-shortcuts.ts:38-40, 71-85` (⌃⌥⌘F and the screen-focus yield — keep both, re-keyed), `:218`, `:275-277` (`new-screen-tab` — remove); `dialogs.tsx:216` (help line for immersive — keep).
  - Sidebar: `sidebar.tsx:6, 64-67, 538-540`.
  - Main/shared: `main/menu.ts:63`; `shared/desktop-bridge.ts:124-125` (`"new-screen-tab"`).
- **`resolveWorkbenchSelection` resets anything it does not recognise** to the first project's main workspace (`workbench-state.ts:66-92`); the new kind must be handled there or every restart lands on a workspace and the persisted screen selection is lost.
- **Selecting a screen must not make `activeWorkspaceId` null in a way that unmounts workspaces.** Today the terminal `<main>` stays mounted and invisible when no workspace is active (`workbench.tsx:1779-1785`); keep that, and keep visited workspaces' terminals alive behind the screen. `activeWorkspace` derivation (`:519-527`) must not treat a screen selection as a device page (which shows the canonical directory workspace).
- **Global shortcuts.** While a screen picture has focus every key goes to the remote (`use-global-shortcuts.ts:71-85`, main's `setIgnoreMenuShortcuts`). Workspace-scoped shortcuts (⌘T, ⌘W, ⌘1–9 tab switching, ⌘\ split) must not act on the hidden workspace when a screen is selected but its picture is not focused — make them no-ops or route them sensibly; ⌘W must not close a hidden workspace's tab.
- **Drag regions.** The status bar is at the window's top edge: draggable background, `no-drag` controls (resolution dropdown, 沉浸, 断开), correct document order against the action dock, and room for the collapsed-sidebar left dock (`workbench.tsx:2131-2141`). Astryx popovers inherit drag unless covered by the global `[popover]` rule (`index.css`).
- **The sidebar 设备 section is height-capped** (`max-h-[42%]`, `sidebar.tsx:434`); sub-rows add height — keep it scrollable as today.
- **Takeover.** A screen opened by the user (button, sidebar menu, palette) takes over (`takeOverOnOpen` / `fresh`); restoring after restart, reselecting and reconnects never do (`screen-session.ts:82` doc). Keep that per device.
- **Resolution presets in this branch** (`screen-resolution.ts`, `ScreenSession.setResolution`) are kept as is; only the trigger/menu presentation changes.

## Scope

In scope:
- `apps/desktop/src/renderer/**` (workbench, sidebar, screen view/session/runtime/records, palette, shortcuts, config, tests)
- `apps/desktop/src/main/menu.ts` (remove the File menu item only)
- `apps/desktop/src/shared/desktop-bridge.ts` (remove the `new-screen-tab` command only)
- `docs/remote-screen.md`

Out of scope:
- `apps/desktop/src/main/screen-host.ts`, `apps/desktop/src/preload/**` beyond what removing the command forces, `native/screen`, `crates/`, `proto/`, `apps/server`, `packages/` — nothing on the wire, in the runtime or the helper changes
- the controlled Mac's physical display mirroring mode (800×600 hardware mirror) — later round
- `wiki/plans/` (the orchestrator updates it)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Leftover tab kind | `grep -rn "SCREEN_TAB_PREFIX\|isScreenTabId\|screenTabIdsOf\|pruneScreenTabs\|new-screen-tab\|renderScreenTab" apps/desktop/src` | no matches |
| Side-by-side packed app on Work (acceptance) | as in `wiki/plans/20261010-screen-lane-frames.md`, "Acceptance: quick two-Mac check" | the Done-when list under Requirement holds |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] No screen tab kind remains anywhere in the tab system; old screen tab records do not break startup and are dropped.
- [ ] The screen selection persists across restart, is restored with its sidebar sub-row, and falls back when the device or record is gone.
- [ ] At most one screen per device: opening from a second workspace, the sidebar menu or the palette selects the existing one.
- [ ] Opening a screen never creates or requires a directory workspace.
- [ ] Hidden screens stay mounted and paused; reselecting resumes without reconnecting the remote session.
- [ ] The status bar is a drag band with working no-drag controls and does not cover the action dock; immersive mode works as before.
- [ ] The resolution dropdown matches the compact-menu convention (no chevron, ✓, standard trigger).
- [ ] Workspace-scoped shortcuts do not act on a hidden workspace while a screen is selected (a screen selection leaves `activeWorkspaceId` null).
- [ ] Opening an already-open device's screen selects it without a new record, session id or takeover; disconnecting the selected screen returns to the previous selection; records of devices gone from the snapshot are pruned.
- [ ] A screen opens and is shown even when no terminal workspace has ever been visited (the layer is not inside the terminal `<main>`), and the picture takes keyboard focus when the screen is selected.
- [ ] Required tests exist and assert meaningful behaviour (selection kind, per-device records).
- [ ] Implementation follows every entry in Decisions & tradeoffs; no out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (notably `screen-host.ts`, the helper or the protocol).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- This replaces the tab form of plan `20260929-remote-desktop` (its "Form" and "Entry points" product conclusions). Takeover, lifecycle, keyboard ownership and immersive semantics from that plan still hold.
- The server's `directoryWorkspaceEnsure` was added for screens and becomes unused by them; leave it until a separate cleanup decides.
- Known and accepted: a stored screen selection starts dialling before the first snapshot delivers daemons and shows 「设备离线」 until the device appears (`retryIfWaiting`).
- Plan audit (fable, 2026-10-11): 9 findings, all inside the approved direction and all folded in (marked "revised on plan audit"); none rejected.
