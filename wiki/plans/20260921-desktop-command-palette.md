# Plan 20260921-desktop-command-palette: ⌘P jumps to any workspace, terminal or device

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat f037003d..HEAD -- apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/settings/settings-page.tsx apps/desktop/src/renderer/desktop-bridge.ts apps/desktop/src/renderer/config.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/main/menu.ts apps/desktop/package.json packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — the review ran and its findings are folded in; the two that changed the plan's shape were the follow path not firing for an already-mounted workspace, and picker-mode `value` being the wrong pre-highlight mechanism
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260921-desktop-command-palette` on `dev/20260921-desktop-command-palette`
- Planned at: `f037003d`, 2026-09-21

## Requirement

Navigating the desktop app is sidebar-only today. Reaching a workspace means
finding its project row, and reaching a terminal means first selecting its
workspace and then its tab. With several projects, each holding several
worktrees, each holding several running agents, the pointer is the only way
across — and the thing the owner actually wants is almost always "the agent
that is waiting for me" or "the place I was a minute ago".

Once this is done, ⌘P opens a keyboard-driven palette that reaches any of them
in one step. It is a **navigation** palette, not a command launcher.

### What the palette contains

Four kinds of entry, all searchable in one query:

| Kind | Opening it means |
| --- | --- |
| Workspace | select that workspace |
| Project | select that project's **main** workspace (projects do not get their own filter tab; they rank among workspaces) |
| Terminal | switch to the workspace that owns the tab **and** make that tab active |
| Device | open that device's detail view |

**Only RUNNING terminals appear.** Exited tabs are out entirely — not greyed,
not search-only. This was settled against an earlier draft that kept them
searchable.

### Layout

```
┌────────────────────────────────────────────────┐
│ 🔍  搜索工作区、终端、设备…                      │
├────────────────────────────────────────────────┤
│  [全部]  工作区   终端   设备                    │
├────────────────────────────────────────────────┤
│  最近                                           │
│ ▶ ⎇ main           主工作区      coflux         │  ← highlighted on open
│   ▸ claude         feat/cmd-p    coflux    ●    │
│   ⎇ fix/login                    verge   ●待批准 │
│   ▣ cc-host        设备 · 在线                   │
├────────────────────────────────────────────────┤
│  ↑↓ 选择    ⏎ 打开    ⌘[ ⌘] 切换类别            │
└────────────────────────────────────────────────┘
```

### Interaction

- **Empty query** shows a 「最近」 group built from a local most-recently-visited
  list. The first row — and the initially highlighted one — is *the place you
  were before this one*; the current location is not listed at all. ⌘P then ⏎
  therefore bounces between two places, which is the single most valuable thing
  the palette does and the reason the MRU exists.
- **Typing** searches across all four kinds at once, matching branch name,
  workspace name, project name, device name and terminal title. Results are
  grouped by kind; entries that are running or waiting rank above idle ones.
- **Filter tabs** (全部 / 工作区 / 终端 / 设备) sit under the input. While the
  palette is open, ⌘[ and ⌘] move between them.
- **Activity** is shown with the sidebar's existing `ActivityDots` (running /
  awaiting approval / awaiting an answer / turn complete). Offline devices'
  workspaces are still listed and marked offline; opening one lands on the
  existing offline state.
- **Closing**: Esc, ⌘P again, or a click on the backdrop. While the palette is
  open the workbench's own ⌘ shortcuts are suspended.

### Out of this round

Action entries (create workspace/terminal, import project, open settings),
file search, and a separate ⌘⇧P command mode. The filter-tab row must leave
room for an Actions tab later, but nothing of it is built now.

### Observable when done

Press ⌘P with at least two visited places: the palette opens, 「最近」 lists
the previous one first and highlighted, ⏎ lands there. Typing a branch
fragment finds that workspace across projects; typing an agent name finds the
running terminal and lands on that tab in its workspace — including when that
workspace is the one already on screen. ⌘[ / ⌘] cycle the filter tabs and the
list actually changes. Esc, ⌘P and a backdrop click each close it.

## Decisions & tradeoffs

- **Palette base**: use `@astryxdesign/core/CommandPalette` (the design system
  already ships it: root, Input, List, Group + heading, Item, Empty, Footer,
  plus combobox semantics and `Kbd` shortcut badges). Rejected: `cmdk`, `kbar`,
  Ariakit/react-aria comboboxes — the user raised headless libraries explicitly;
  adopting one means a second styling system outside stylex theming tokens, a
  second dialog layer next to `Dialog`, and a second keyboard model, for a
  component we already own. Based on:
  `apps/desktop/node_modules/@astryxdesign/core/src/CommandPalette/CommandPalette.spec.md`,
  `.../CommandPalette.tsx:640-665` (Layout header/content/footer slots).
- **All palette copy is passed explicitly, in Chinese**: placeholder, both
  empty states, and the footer. The renderer mounts no astryx i18n provider, so
  the component's defaults render English (`'No results'`, `'Type to search'`,
  and the footer's `↑↓ / ⏎ / esc` labels). Rejected: installing a locale
  provider for this feature — it would change every other astryx component's
  strings at once, which is a separate decision. Based on:
  `.../CommandPaletteFooter.tsx:104-114`, `.../CommandPalette.tsx:299-303`;
  no `useTranslator`/provider wiring exists under
  `apps/desktop/src/renderer/`.
- **The data is snapshotted when the palette opens and frozen for its
  lifetime**: build the item set once per open from `client.store`, and do not
  re-read the store while it is open. Rejected: subscribing to the store so
  activity stays live — the palette lives a second or two, and a list that
  reorders between the keystroke and ⏎ sends the user to the wrong place. The
  component cooperates: `bootstrap()` runs only on the `isOpen` transition, so
  a fresh `searchSource` identity does not re-trigger it. Based on:
  `.../CommandPalette.tsx:488-495`.
- **The initial highlight is driven through the palette's own context, not
  through picker-mode `value`** *(revised on advisor review)*: a component
  rendered inside the `input` slot — which sits within `CommandPaletteContext`
  — calls `setHighlightedIndex(0)` whenever `selectableItems` changes. The
  ranking function already puts the previously visited place at index 0, so
  that is the ⌘P+⏎ bounce; it also keeps a sane highlight after each keystroke
  and after a filter-tab switch. Rejected: passing `value` (picker mode). It
  does pre-highlight after bootstrap, but it additionally marks that row
  `isSelected`, which paints a persistent `itemSelected` background for the
  palette's whole lifetime — after one ArrowDown two rows look active — and it
  leaves a stale `highlightedIndex` when the id is absent from the next
  results. Rejected: leaving the component default — `highlightedIndex` starts
  at `-1` and the Enter handler ignores the key entirely, so ⏎ would do nothing
  until ArrowDown. Based on: `.../CommandPaletteContext.ts:16-32` and
  `.../CommandPalette/index.ts:35` (`useCommandPaletteContext` is public, and
  exposes `search`, `setSearch`, `setHighlightedIndex`, `selectableItems`),
  `.../CommandPaletteItem.tsx:146` and `:201` (`isSelected` → `itemSelected`),
  `.../CommandPalette.tsx:452-467`, `.../CommandPalette.tsx:509-511`.
- **Switching the filter tab must re-run the search explicitly**: the component
  calls its source only on a keystroke and on the `isOpen` transition, so a tab
  change alone changes nothing on screen. The tab must be readable by the
  source at the moment the re-run happens — keep it where the source reads the
  current value, not captured in a stale closure. Rejected: rebuilding the
  `searchSource` and hoping the component notices; it does not. Based on:
  `.../CommandPalette.tsx:562-567` (`setSearch` is the only re-entry),
  `.../CommandPalette.tsx:488-495` (bootstrap fires on `isOpen` only).
- **Search, ranking and grouping are a pure function**, separate from the
  component, shaped like the executor model search: inputs are the frozen
  snapshot, the query, the MRU order and the active filter tab; output is the
  `SearchableItem[]` the palette renders, carrying the group name in
  `auxiliaryData.group` (the component auto-groups on it, preserving insertion
  order). Its unit test pins ranking and group order only — no rendering test.
  Based on:
  `apps/desktop/src/renderer/components/settings/executor-model-search.ts:28-57`,
  `.../CommandPalette.tsx:123-172` (`getGroup` / `buildSelectableItems`).
- **The MRU module takes its storage and key as arguments** and must not import
  `@/config` *(revised on advisor review)*: the desktop bridge is required at
  module evaluation time and throws without a `window`, and Node has no
  `localStorage`, so a unit test that pulls in `@/config` cannot even load.
  Compose the server-scoped key in `config.ts` and pass it in, exactly as the
  session token and the offline catalog already do. Based on:
  `apps/desktop/src/renderer/desktop-bridge.ts:38-43` (`requireDesktopBridge`
  throws when `window` is undefined), `apps/desktop/src/renderer/pages/MainPage.tsx`
  (`offlineCatalog: { storage, key }`), `apps/desktop/src/renderer/config.ts:15`
  (server-scoped key precedent).
- **The MRU records a visit only for the workspace the user is actually
  looking at** *(revised on advisor review)*: active-tab reports arrive for
  hidden, kept-alive workspaces too — a background agent exiting makes its
  container fall back to another tab and report it — so recording every report
  would make a tab the user has never seen "the previous place". Gate recording
  on the reported workspace being the active one. Also make recording
  idempotent (move-to-front, not a new visit): the selection is re-persisted
  on every snapshot reconciliation, not only on a real navigation. Based on:
  `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:297-308`
  (report path), `.../workbench.tsx:277-283` (`reportActiveTab` has no
  active-workspace gate), `.../workbench.tsx:80-88` (`persistSelection`).
- **"The current location" is a set, not one id** *(revised on advisor review)*:
  it is the selected workspace, that workspace's active tab, the project whose
  main workspace it is, and the selected device. Excluding only the selection
  leaves the active terminal at the top of 「最近」, so ⏎ would land where the
  user already is while the naive "previous first, current absent" reading still
  looks satisfied. Rejected: excluding just the selection id.
- **Opening a terminal entry goes through the plan-104 follow path, which this
  plan must first make work for an already-mounted workspace**
  *(revised on advisor review)*: `followTaskId` has exactly one consumer, an
  effect that depends solely on `workspaceTasks` — its comment states the
  assumption outright, that follow and tasks arrive in the same batch. That
  holds when the centre moves a task between workspaces; it does **not** hold
  for a palette jump, which changes no task entity. So a jump into a workspace
  already on screen, or to another tab of the current workspace — the common
  case, and exactly the ⌘P+⏎ bounce — silently does nothing in the container
  while the workbench-level panel state moves. Add an activation effect keyed on
  `followTaskId` in the container; the parent already clears the follow token
  after one pass, so a re-run is a no-op. Rejected: extending
  `WorkspaceTerminalHandle` with `selectTaskById` — the handle only reaches the
  *active* workspace's instance, which is the one case that does not need it,
  and the follow token is what carries a jump into a workspace that is not
  mounted yet. Based on:
  `.../workspace-terminal.tsx:84-92` (handle surface),
  `.../workspace-terminal.tsx:283-313` (the sole `followTaskId` consumer and its
  stated assumption), `.../workbench.tsx:291-313` (the five-step jump used by
  the task-move path), `.../workbench.tsx:313-315` (follow fires once),
  `.../workbench.tsx:405-423` (`navigateNotificationTask` takes the same path
  and carries the same hazard).
- **Opening the palette closes the settings page** *(revised on advisor
  review)*: the settings page installs its own capture-phase Escape handler
  that stops propagation, so with both open Escape closes settings and leaves
  the palette stranded on screen. The notification-navigation path already
  closes settings for the same reason. Based on:
  `apps/desktop/src/renderer/components/settings/settings-page.tsx:81-90`,
  `.../workbench.tsx:420`.
- **The global ⌘ handler must let the palette have ⌘[ / ⌘] , and must keep ⌘P
  for itself**: those brackets are swallowed today in the window's capture
  phase, which runs before any React `onKeyDown`, so suspending the workbench
  shortcuts while the palette is open is what makes the tab row reachable at
  all. ⌘P itself must be handled *before* that suspension check — like ⌘, — or
  a second ⌘P cannot close the palette. Suspension is currently a single
  boolean fed from `settingsOpen`; the palette must widen it, never replace it.
  Based on:
  `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts:46-107`
  (capture listener; `Comma` returns before the `isSuspended` gate, `Slash` and
  the rest after), `.../workbench.tsx:630` (`isSuspended: settingsOpen`).
- **⌘P is wired on both existing paths**: the capture-phase handler and a
  native menu item, as every other page shortcut is. The menu item declares the
  accelerator for display but does not register it, so the key still reaches
  the page. This needs a new `DesktopCommand` value; there is no separate
  allow-list to update. Based on: `apps/desktop/src/main/menu.ts:19-24`
  (`pageShortcut`, `registerAccelerator: false`),
  `apps/desktop/src/shared/desktop-bridge.ts:74`,
  `apps/desktop/src/preload/index.ts:87-89` (plain forwarding).
- **⌘P is listed in the ⌘/ shortcuts dialog**: that table is hand-written, so a
  new shortcut does not appear by itself and the help panel would be wrong the
  day this ships. Based on: `.../dialogs.tsx:235-253` (`shortcutRows()`).
- **Terminal titles use the tab's own rule**: the session checkpoint title when
  present, falling back to `task.title`. Searching must match what the tab
  shows, not the placeholder underneath it. Based on:
  `.../workspace-terminal.tsx:431`.
- **Renderer-only change**: no new requests, no protocol or server or daemon
  edits. The palette drives the workbench's existing selection and tab entry
  points. (decided while planning) Based on: the jump path above being pure
  local state.

### Left to the executor

These are deliberately not settled here — decide them against the live code:

- The visual composition of a row (icon, primary label, trailing metadata) and
  which lucide icons to reuse from `sidebar.tsx` for each kind.
- The MRU's capacity.
- The concrete scoring weights inside the ranking function, provided the
  ordering the plan describes holds.
- Where the palette's files sit under
  `apps/desktop/src/renderer/components/workbench/`, and how the pieces are
  split across them.

## Direction

The palette is a renderer-only feature in three layers, built bottom-up.
**The milestones are strictly serial** — M2 consumes M1's types and functions,
M3 wires M2 into the workbench, and M2/M3 both touch the same new component
file. Do not fan this plan out into concurrent work packages.

New unit tests must live next to the code under
`apps/desktop/src/renderer/components/workbench/` and end in `.test.ts`:
`apps/desktop/package.json`'s `test` script enumerates directories with that
glob, so a `.test.tsx` file, or one placed elsewhere, is silently never run.

### Milestone 1: the data layer is pure and tested

A snapshot type covering the four entry kinds, a server-scoped MRU store whose
storage and key are injected, and the ranking function that turns snapshot +
query + MRU + active filter into grouped `SearchableItem[]`. Non-RUNNING tasks
are excluded at snapshot construction, not at render. Empty query yields the
「最近」 group with the whole current-location set omitted and the previous
location at index 0.

Validation: `pnpm -C apps/desktop test` -> exit 0, with new assertions covering
(a) empty-query order: given a visit sequence ending `[activeTab, itsWorkspace,
previousPlace]`, the first row is `previousPlace` and neither the selected
workspace, its active tab, its project, nor the selected device appears,
(b) a query matching a branch, a project name, a device name and a terminal
title, (c) running/waiting entries ahead of idle ones, (d) group order
stability, (e) filter-tab narrowing, (f) a task whose status is not RUNNING
never appears — assert against `TaskStatus.RUNNING` rather than against
EXITED, since IDLE also exists. The test must not import `@/config`.
`pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 2: the palette renders and behaves

A component wrapping `CommandPalette`: Chinese placeholder, Chinese empty
states, a Chinese footer carrying the ↑↓ / ⏎ / ⌘[ ⌘] hints via `Kbd`, the
filter-tab row in the `input` slot with ⌘[ / ⌘] handled there (switching a tab
re-runs the search), `renderItem` drawing each kind with `ActivityDots` for
activity, and the context-driven highlight reset. It takes its snapshot once
per open and calls back with the chosen entry. Native `title` attributes are
prohibited — use `Tooltip` if a row needs a hover hint
(`docs/design-guidelines.md`).

Validation: `pnpm -C apps/desktop typecheck` -> exit 0.
`pnpm -C apps/desktop build` -> exit 0.

### Milestone 3: ⌘P opens it and choosing an entry lands

`KeyP` in the capture-phase handler (before the suspension gate, so a second
⌘P closes), a matching native menu item and `DesktopCommand` value, a row in
the ⌘/ shortcuts dialog, the workbench widening its suspension while the
palette is open and closing the settings page when it opens, the follow-path
fix in the terminal container, the four open actions wired to the existing
selection / device / follow-task entry points, and MRU recording at the
existing selection and active-tab sites under the visible-workspace gate.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0.
`pnpm -C apps/desktop test` -> exit 0. `pnpm -C apps/desktop build` -> exit 0.

## Landmines

- **`followTaskId` is consumed by exactly one effect, and that effect depends
  only on `workspaceTasks`** (`workspace-terminal.tsx:283-313`). Its own comment
  records the assumption — follow and tasks arrive together — which a palette
  jump breaks. The symptom is partial and easy to misread during a walkthrough:
  a jump into a *freshly mounted* workspace works (the effect runs on mount),
  while a jump inside an already-mounted one leaves the tab bar on the old tab
  with the panel showing the new one. Test the second case deliberately.
- **`highlightedIndex` starts at `-1` and the Enter handler ignores the key
  while it is negative** (`CommandPalette.tsx:509-511`). It is also never reset
  between opens: `handleClose` (`:346-364`) does not touch the combobox, and
  Enter/Escape return before `combobox.onKeyDown` would reset it. A stale index
  from the previous open can point anywhere in the new list.
- **`renderItem`'s `isSelected` argument is always false here.** It reflects
  picker-mode `value` (`CommandPaletteItem.tsx:146`), which this plan
  deliberately does not use; the visible highlight comes from the component's
  own `itemHighlighted` style. Do not draw the active row from `isSelected`.
- **`bootstrap()` runs only when `isOpen` flips** (`CommandPalette.tsx:488-495`),
  and it closes over the `runSearch` of that render. Anything the source needs
  at open time must be ready in the same render that sets `isOpen`, not
  computed in an effect afterwards.
- **The capture-phase handler runs before React's `onKeyDown`**
  (`use-global-shortcuts.ts:107`, `{ capture: true }`). ⌘[ / ⌘] are consumed
  there today for terminal tab switching, so the palette's own bracket handling
  is dead code until the workbench is suspended.
- **`isSuspended` gates most keys but not all** — `Comma` returns before the
  gate, `Slash` after (`use-global-shortcuts.ts:57-70`). Putting `KeyP` on the
  wrong side of that gate makes the palette unclosable by keyboard.
- **The settings page owns Escape in the capture phase and stops propagation**
  (`settings-page.tsx:81-90`), so an overlay opened on top of it cannot see
  Escape at all — not even through the `<dialog>` cancel path.
- **`reportActiveTab` fires for hidden workspaces** (`workbench.tsx:277-283`,
  fed from `workspace-terminal.tsx:297-308`). Recording those as visits poisons
  the MRU with places the user never opened.
- **`persistSelection` re-runs on every snapshot reconciliation**, not only on
  a real navigation (`workbench.tsx:80-88` plus the selection-resolution
  effect). MRU recording must be move-to-front, not append-a-visit.
- **`WORKSPACE_KEY` is not server-scoped** (`config.ts:12`, plain
  `"coflux_workspace"`), while `DAEMON_ONBOARDING_DISMISSED_KEY` (`config.ts:15`)
  and the offline catalog key are. Entity ids are not portable across servers;
  copy the scoped precedent, not the unscoped neighbour.
- **`localStorage` access can throw** (private mode, blocked site data). The
  existing code wraps the onboarding write in try/catch (`workbench.tsx:91-96`);
  an MRU read that throws on startup would take the whole workbench down.
- **The workspace-level activity helpers live in `@coflux/client`, not in the
  sidebar** (`packages/client/src/store.ts`, `workspaceActivity` /
  `workspaceProgress`); per-terminal state comes from
  `sessionAgents[task.sessionId]`. The sidebar is where they are *used*
  (`sidebar.tsx`), not where they are defined.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/` — new palette component,
  snapshot/ranking/MRU modules and their tests
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` — open state,
  suspension, settings-page interlock, jump actions, MRU recording
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx` —
  activation effect keyed on `followTaskId`
- `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts` — ⌘P
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx` — the ⌘/ row
- `apps/desktop/src/renderer/config.ts` — MRU storage key
- `apps/desktop/src/shared/desktop-bridge.ts` — new `DesktopCommand` value
- `apps/desktop/src/main/menu.ts` — matching menu item

Out of scope:
- `apps/server`, `crates/`, `packages/protocol` — no wire or persistence change
- `packages/client` — read for the activity helpers, not edited
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — read for
  conventions (icons, `ActivityDots`), not edited
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` — its own
  capture-phase shortcuts are a known cosmetic gap, see Maintenance notes
- Action entries, file search, ⌘⇧P — explicitly out of this round
- `apps/macos`, iOS — the palette is desktop-only

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Renderer build | `pnpm -C apps/desktop build` | exit 0 |
| Desktop walkthrough (acceptance) | `pnpm dev:desktop:prod` | palette opens on ⌘P against the real account |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] ⌘P opens the palette; a second ⌘P, Esc, and a backdrop click each close it.
- [ ] Opening the palette while the settings page is open closes the settings
      page first, so Escape reaches the palette.
- [ ] With an empty query the palette lists 「最近」 with the previously visited
      location first and highlighted, and none of {selected workspace, its
      active tab, its project, selected device} present; ⏎ lands there without
      pressing an arrow key first.
- [ ] Jumping to a terminal tab lands on that tab — verified in a workspace
      that is **already mounted** (switch tabs within the current workspace),
      not only in one being visited for the first time.
- [ ] A query matches across workspaces, projects, devices and running terminal
      titles in one pass, grouped by kind.
- [ ] Only tasks whose status is RUNNING ever appear.
- [ ] ⌘[ / ⌘] cycle the filter tabs while the palette is open **and the result
      list changes accordingly**, and resume switching terminal tabs once it
      closes.
- [ ] ⌘P appears in the ⌘/ shortcuts dialog.
- [ ] All palette copy is Chinese; no English default string is reachable.
- [ ] No row carries a persistent selected background alongside the keyboard
      highlight.
- [ ] Required tests exist and assert ranking, grouping and MRU exclusion
      behaviour, and none of them imports `@/config`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- The context-driven highlight cannot be made to work from inside the `input`
  slot — the ⌘P+⏎ bounce is the feature's core, and falling back to picker-mode
  `value` means accepting a permanently tinted row, which is a direction change
  rather than an implementation detail.

## Maintenance notes

- No automated gate covers the palette's rendering, its keyboard behaviour, or
  the jump landing on the right tab: the tests cover the pure ranking layer
  only, by design (`AGENTS.md`, "Test harness"). The real-machine walkthrough
  is the acceptance, and it needs at least two projects and a running agent to
  be meaningful.
- `navigateNotificationTask` (`workbench.tsx:405-423`) takes the same follow
  path as the palette's terminal jump and therefore carries the same
  already-mounted hazard today. Fixing the container effect fixes both; the
  notification path is not otherwise touched here.
- `terminal-pane.tsx:815-837` installs its own capture-phase shortcuts (⌘F,
  ⌘↑/↓) that `isSuspended` does not reach, so ⌘F with the palette open still
  opens the terminal's find bar underneath the modal. Cosmetic, not blocking,
  and deliberately left alone — widening suspension to the pane is a separate
  change.
- The filter-tab row is the extension point for Actions entries later. Adding
  them means new item kinds in the snapshot and a new tab — no change to the
  palette shell.
- `CommandPalette` is a `draft`-authority component in astryx 0.6.0 and its own
  spec records open questions about theming seams
  (`CommandPalette.spec.md`, "Open questions"). Re-read that file, and the
  context surface this plan depends on, on the next astryx upgrade.
- The offline catalog persists tasks (`packages/client/src/store.ts`), so a
  cold start has terminal entries before the first snapshot arrives. Do not
  write a pruned MRU back to storage while `snapshotRevision === 0`, or an
  offline launch will forget places that still exist. (Inferred from the
  cold-start path; not reproduced.)
