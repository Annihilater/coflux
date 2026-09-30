# Plan 20260930-collapsible-sidebar: The desktop sidebar collapses out of the way and comes back with ⌘B

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 59ada94f..HEAD -- apps/desktop/src/renderer/components/workbench apps/desktop/src/renderer/config.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/main/menu.ts apps/desktop/src/main/browser-policy.ts apps/desktop/src/main/window.ts apps/desktop/src/renderer/components/settings/settings-page.tsx apps/desktop/src/renderer/index.css`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check, 2026-09-30
- Stop after: implementation — departure check (plan audit chosen)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; moved to `.claude/worktrees/20260930-collapsible-sidebar` on `dev/20260930-collapsible-sidebar`
- Planned at: `59ada94f`, 2026-09-30

## Requirement

The workbench sidebar (projects, workspaces, devices, account footer) always
takes 200–480 px on the left. On a laptop screen or with split terminal groups
that width is wanted back. The user wants to hide the sidebar and bring it back,
the way Cursor does.

Product conclusions (confirmed with the user at the product gate; modelled on Cursor):

1. **Form**: collapsed means the sidebar is fully hidden — width 0. No icon rail.
2. **Toggle button**:
   - Expanded: a collapse button at the **right end of the sidebar's top 38 px
     band** (the row the macOS traffic lights sit in).
   - Collapsed: the main area's top chrome leaves room on its left for the
     traffic lights, and an expand button sits **immediately right of the
     traffic lights**. This holds whatever the main area shows: the terminal tab
     strip when a workspace is open, the changes overlay's header when it is
     open, and the top drag band of the empty states (no workspace selected,
     device page without workspaces, etc.).
   - Both buttons carry a `Tooltip` (never a native `title`): 「收起侧边栏 ⌘B」 /
     「展开侧边栏 ⌘B」 (the ⌘ glyph follows `SHORTCUT_MODIFIER_PREFIX` like the
     other hints).
3. **Keyboard and menu**: ⌘B toggles. The 「视图」 menu gets an item
   「显示/隐藏侧边栏」 showing ⌘B. The key works while a terminal has focus.
   The shortcut help (⌘/) lists it.
4. **Memory**: the collapsed state persists across restarts. Expanding restores
   the width the sidebar had (the width itself is unchanged by collapsing).
5. **Non-goals**: hover-to-peek at the left edge; dragging the width below the
   minimum to collapse; collapsing the settings page's left column. Immersive
   screen mode already hides the sidebar and is unchanged.
6. **What the user observes when done**: the button and ⌘B toggle both ways; with
   the sidebar collapsed the traffic lights never overlap a tab or the branch
   button, the tab strip still drags the window from empty space and
   double-click still follows the macOS title-bar preference; the state
   survives a restart.

## Decisions & tradeoffs

- **Collapsed state lives in Workbench, separate from the width control**: a
  boolean owned by `Workbench`, persisted under its own new unscoped
  localStorage key declared next to `SIDEBAR_WIDTH_KEY`, with reads and writes
  in try/catch as `use-sidebar-width.ts` does. The width control and its key are
  not changed. Rejected: folding "collapsed" into `SidebarWidthControl` or
  encoding it as width 0 — that control is shared with the settings page's left
  column (`use-sidebar-width.ts:5-10`), which must not collapse, and a 0 width
  would be clamped back to 200 by `clampSidebarWidth` and lose the width to
  restore. Rejected: server-scoped key — this is a per-machine UI preference,
  like the width. Based on: `apps/desktop/src/renderer/config.ts:13`,
  `apps/desktop/src/renderer/components/workbench/use-sidebar-width.ts:16-24`.

- **Collapsed = the `<Sidebar>` is not rendered**, the same way immersive mode
  removes it (`workbench.tsx:1444`). Rejected: keeping it mounted at width 0 /
  hidden — nothing in it needs to survive (project fold state resetting to
  all-expanded on re-show is acceptable), and a hidden drag band would still be
  a drag region. Every place that positions against the sidebar's width must use
  0 while collapsed — notably the hidden-main `left` at `workbench.tsx:1488`.
  Based on: `workbench.tsx:1443-1469`, `workbench.tsx:1484-1490`.

- **One window-level "left dock" holds the expand button** — the mirror image of
  the existing top-right action dock: a single instance for all workspaces and
  empty states, absolutely positioned just right of the traffic lights, carrying
  `NO_DRAG_REGION_STYLE`, and placed **after the main area in document order**.
  The surfaces that touch the window's top-left corner reserve its width on
  their left while collapsed, the same way the top-right group reserves
  `dockWidth` on the right: the top-left group's tab strip, the changes
  overlay's header, and the `EmptyMain` top band. Rejected: a button rendered
  inside each of those headers — three copies of one control, each needing its
  own no-drag hole and ordering care; the dock pattern already solved that once.
  Based on: `workbench.tsx:1745-1770` (action dock and its document-order
  comment), `workspace-terminal.tsx:960-990` (`touchesTop`/`touchesLeft`,
  `reserveDock`), `workspace-terminal.tsx:1226-1231` (changes overlay header),
  `workbench.tsx:121-133` (`EmptyMain`), `main/window.ts:69-70`
  (`titleBarStyle: "hidden"`, `trafficLightPosition: { x: 14, y: 14 }`).

- **The collapse button sits in the sidebar's existing drag band**
  (`sidebar.tsx:144-145`), right-aligned, with `NO_DRAG_REGION_STYLE`. The band
  keeps its height and stays the sidebar's window drag region. Based on:
  `sidebar.tsx:144-145`, `drag-region.ts:38-42`.

- **The left dock is shown only while the sidebar is collapsed and the
  workbench is what is on screen**: not in immersive screen mode (the sidebar is
  already gone and the window is full screen), and not while the settings page
  covers the window (it has its own left column and drag band,
  `settings-page.tsx:108`). This visibility rule is **not** the action dock's:
  the right dock is hidden only in immersive mode (`workbench.tsx:1760`) and
  deliberately stays over the settings page; do not copy its className. Like the
  right dock, the left dock's `top` follows the reconnect banner
  (`top: showReconnectBanner ? 28 : 0`, `workbench.tsx:1761`). Based on:
  `workbench.tsx:1444`, `workbench.tsx:1716`, `workbench.tsx:1760-1761`.
  (revised on plan audit)

- **⌘N / 「新建工作区」 while collapsed expands the sidebar first**, then opens
  the project's create-workspace menu in it (Cursor-style: an action that needs
  the sidebar brings it back). The create menu is a `DropdownMenu` inside
  `<Sidebar>` driven by Workbench's `createMenuProjectId`; with the sidebar
  unmounted, setting that state alone shows nothing and the menu would pop open
  unexpectedly on the next expand. Rejected: silently ignoring ⌘N while
  collapsed — the key would look broken. If the menu does not honour `isOpen`
  on first mount, the executor makes it do so (e.g. set the id after the
  sidebar has mounted); a stale `createMenuProjectId` must never survive a
  collapse. Based on: `workbench.tsx:285-286`, `sidebar.tsx:232-233`,
  `use-global-shortcuts.ts` `KeyN` branch and `"create-workspace"` command.
  (revised on plan audit)

- **Toggling by click keeps keyboard focus where it was**: the collapse button
  unmounts with the sidebar, which would drop focus to `body` and leave the
  terminal deaf until clicked. After a toggle (button or ⌘B/menu), focus returns
  to the focused tab, reusing the existing refocus path
  (`currentScreen().focused ?? focusedBrowserTabId()` → `focusTab(...)`,
  `workbench.tsx:1365-1367`). (revised on plan audit)

- **⌘B is a page shortcut, like ⌘P**: handled in `use-global-shortcuts.ts` in
  the bare-⌘ set, **after** the `isSuspended` gate (it should not fire behind
  the settings page or the palette); the 「视图」 menu item is a `pageShortcut`
  (displayed accelerator, `registerAccelerator: false`) dispatching a new
  `DesktopCommand`, handled in the same command switch as the other menu
  commands. Terminals already hand bare-⌘ keys to the app
  (`terminal-key-ownership.ts:84-91`), so no terminal change is needed.
  Rejected: a registered native accelerator — it would steal ⌘B from built-in
  browser pages (next decision). Based on: `main/menu.ts:25-30`,
  `main/menu.ts:82-100`, `shared/desktop-bridge.ts:82-112`,
  `use-global-shortcuts.ts:78-100`, `use-global-shortcuts.ts:205-270`.

- **⌘B stays with the web page while a built-in browser tab has focus**:
  `classifyGuestKey` does **not** learn ⌘B, exactly as Chrome leaves ⌘B to pages
  (bold in web editors). The menu item still works there by click. A focused
  remote screen keeps forwarding every key to the remote (`screenFocusedRef`),
  ⌘B included. Rejected: forwarding ⌘B from guests like ⌘T/⌘W — it would break
  bold in every web rich-text editor inside the app. Based on:
  `main/browser-policy.ts:158-205`, `use-global-shortcuts.ts:75-76`.

## Direction

Everything lives in the desktop app: renderer workbench components, the
renderer config, the shared bridge command type, and the main-process menu. No
protocol, server, daemon or preload change.

The milestones are sequential: milestone 2 builds on the collapsed state
milestone 1 introduces.

### Milestone 1: collapse and expand work, with the room for the traffic lights

Collapsed state owned by Workbench and persisted; the collapse button in the
sidebar's band; the left dock with the expand button; the top-left surfaces
(top-left group strip, changes overlay header, `EmptyMain` band) reserve its
width while collapsed; hidden-main positioning uses 0 width while collapsed;
the left dock is absent in immersive mode and under the settings page.
Validation: `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 2: ⌘B, the menu item and the shortcut help

⌘B in the global shortcuts (after the suspension gate), a new
`DesktopCommand` sent by a 「视图」 `pageShortcut` item 「显示/隐藏侧边栏」 with
accelerator `CmdOrCtrl+B`, the command handled with the other menu commands,
a ⌘B row in the shortcut help (`dialogs.tsx` `shortcutRows`), and ⌘N /
「新建工作区」 expanding a collapsed sidebar before opening the create menu.
`classifyGuestKey` untouched. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` -> exit 0.

Left to the executor: the icons (lucide, e.g. a panel-left pair — check
`docs/design-guidelines.md` "Icons"), any collapse animation, fine vertical
alignment between the 36 px strip (`h-9`) and the traffic lights, the exact
reserved width (measured like `attachDock` or a constant), and whether the left
inset drops in native full screen, where macOS hides the traffic lights (the
renderer already receives `screenEvent { kind: "fullscreen" }`,
`main/index.ts:552-553`, consumed at `workbench.tsx:633`), and whether ⌘B is a
no-op in immersive mode (in practice the focused screen picture forwards it to
the remote first). The empty-state copy 「从左侧项目或子工作区进入终端工作台」
(`workbench.tsx:1623`) reads wrong with the sidebar hidden; adjust it when
collapsed, wording is the executor's call.

## Landmines

- **Drag-region composition is by document order, not z-index**
  (`drag-region.ts:9-15`): a `no-drag` hole declared before a later `drag`
  element is filled back in. The left dock must come after the main area in the
  DOM, or its button is dead (no click, no tooltip) — the action dock hit
  exactly this (`workbench.tsx:1747-1752`).
- **`app-region` is inherited by DOM descendants** (`drag-region.ts:17-28`): a
  `Tooltip` rendered inside a drag element inherits `drag` unless it is a
  `[popover]`, which the rule in `renderer/index.css` covers. That rule must stay
  scoped to popovers **inside** drag regions — 2.6.1 broadened it to a global
  `[popover]` and broke tab-strip window dragging (fixed in 2.9.0). Do not touch it.
- **Tab strips drop their drag region while a tab is being dragged**
  (`workspace-terminal.tsx:969-971`, `stripIsDragRegion`). The reserved left
  space belongs to the strip and must keep following that switch.
- **Settings page shares the width control** (`use-sidebar-width.ts:5-10`,
  `workbench.tsx:1721`): collapsing must not alter the width value or its
  localStorage key, or the settings column jumps.
- **`h-9` equals `GROUP_TAB_STRIP_HEIGHT`** (`workspace-terminal.tsx:987`):
  panes are placed that far below a group's top. Reserving left space must not
  change the strip's height.
- **Use `Tooltip`, never `title`** (`docs/design-guidelines.md` §"Hover hints").
- **The fresh worktree has no `node_modules`**: `pnpm install` must run before
  any validation command (the `dev:execute-plan` preflight does it); a missing
  dependency is not a validation failure for the STOP rule.
- **The reconnect banner shifts the top chrome by 28 px while the traffic lights
  stay at y=14** — existing behaviour for the sidebar band too; not fixed here
  (`main/window.ts` is out of scope).

## Merge and deploy

Desktop-only; ships with the next desktop release. The release notes must
mention the new ⌘B shortcut. Acceptance is manual by the user on a desktop
preview (`pnpm dev:desktop:prod`, see the desktop-preview skill); Claude does
not do UI walk-throughs.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/workbench.tsx`
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx`
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx`
- `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts`
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- `apps/desktop/src/renderer/config.ts`
- `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/main/menu.ts`
- a new small renderer module for the collapsed state or the left dock, if the executor wants one
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/desktop/src/main/browser-policy.ts` — ⌘B deliberately stays with web pages
- `apps/desktop/src/renderer/components/workbench/use-sidebar-width.ts`, `sidebar-resize-handle.tsx` — width behaviour unchanged
- `apps/desktop/src/renderer/components/settings/` — the settings column does not collapse
- `apps/desktop/src/main/window.ts` — traffic light position unchanged
- `apps/desktop/src/renderer/index.css` `[popover]` no-drag rule
- the command palette — no palette entry for the toggle in this plan

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| UI walk-through (acceptance) | `pnpm dev:desktop:prod`, by the user | behaviours in Done criteria observed |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Expanded: a collapse button at the right end of the sidebar's top band, with a Tooltip 「收起侧边栏 ⌘B」; clicking it hides the sidebar entirely.
- [ ] Collapsed: an expand button right of the traffic lights with a Tooltip 「展开侧边栏 ⌘B」, present on a workspace's tab strip, on the changes overlay, and on every empty state; nothing in the main area's top chrome sits under the traffic lights.
- [ ] Collapsed: the top strips still drag the window from empty space; the expand button is clickable and shows its tooltip.
- [ ] ⌘B toggles with a terminal focused; the 「视图」 menu item toggles; ⌘/ help lists ⌘B; `classifyGuestKey` unchanged.
- [ ] Collapsed + ⌘N (or 「新建工作区」): the sidebar expands and the create-workspace menu opens in it; no menu pops open later on its own.
- [ ] After toggling by button, ⌘B or menu, typing still reaches the terminal that had focus.
- [ ] With the reconnect banner shown, the left dock sits below it like the action dock.
- [ ] The collapsed state survives a reload/restart; expanding restores the previous width; the settings page's left column is unaffected.
- [ ] Immersive screen mode behaves as before and shows no left dock; the settings page shows no left dock.
- [ ] No test was added that only restates the implementation (per `AGENTS.md` "Test harness").
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the action dock
  pattern or the drag-band structure has changed).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The traffic-light space cannot be reserved without changing the strip height
  or the pane placement constant.

## Maintenance notes

- The left dock and the right action dock are a pair; a new surface that can
  touch the window's top-left corner must reserve the left dock's width while
  the sidebar is collapsed, just as a top-right surface reserves `dockWidth`.
- Audit findings not adopted: none rejected. Two were routed to the executor's
  call rather than decided (⌘B in immersive mode; empty-state wording).
- If ⌘B is ever wanted inside built-in browser tabs, it goes in
  `classifyGuestKey`, at the cost of bold in web editors.
