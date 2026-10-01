# Plan 20261002-new-tab-menu-first-item-highlight: ⌘T always shows the new-tab menu's first item highlighted

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat aa65d982..HEAD -- apps/desktop/src/renderer/index.css apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/package.json`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; moved to `.claude/worktrees/20261002-new-tab-menu-first-item-highlight` on `dev/20261002-new-tab-menu-first-item-highlight`
- Planned at: `aa65d982`, 2026-10-02

## Requirement

⌘T (and 文件 → 新建标签页…) opens the focused group's ＋ new-tab menu as a
keyboard open. Commit `b6bc35c7` specified that this focuses the first enabled
item so arrows / Enter / Esc work. In practice the first item intermittently
shows **no highlight**. The user's pattern: after switching workspaces with the
mouse, ⌘T opens the menu with nothing highlighted; once a plain key such as
an arrow has been pressed, later ⌘T opens highlight the first item until the
next mouse click.

Root cause: the item does have DOM focus, but our own global CSS hides its
focus background. `apps/desktop/src/renderer/index.css:271` makes a menu item
that has `:focus` but not `:focus-visible` (and is not hovered) transparent. The
rule exists so right-click menus do not look pre-selected. Astryx focuses the
first item from script. Chromium treats script focus as `:focus-visible`
only after a keydown without Ctrl/Alt/Meta (Blink
`keyboard_event_manager.cc` skips `UpdateHadKeyboardEvent` for those; Shift
still counts). A mouse press clears that state. ⌘T carries ⌘, so after any
mouse click the focused item is not `:focus-visible`, and the rule erases its
background.

Done means: whenever ⌘T or the native menu command opens the ＋ menu, its first
enabled item is visibly highlighted, whatever the last input was. Nothing else
changes:

- Opening the ＋ menu by clicking it shows no pre-highlighted item.
- Right-click context menus still open without a pre-highlighted item.
- Clicking 「Agent ▸」 still opens its flyout without a pre-highlighted item.
- Arrow keys and Enter behave as before. One accepted difference for the ＋
  menu only: after the pointer hovers an item and leaves, that item stays
  highlighted (see Decisions).

## Decisions & tradeoffs

- **Exempt only the ＋ menu's top-level list from the no-pre-highlight rule; keep the rule for everything else.** Mark that list with a dedicated class (Astryx `DropdownMenu`'s `className` lands on the `role="menu"` list element). Narrow the rule so it does not match items whose menu is that list. Rejected: deleting the rule, or scoping it to `ContextMenu` only. Both would make right-click menus and the Agent submenu flyout pre-highlight their first item on a pointer open. Rejected: forcing `:focus-visible` from JS. Astryx owns the `focusFirst()` call, and there is no reliable focus-visible override for script focus. Based on: `apps/desktop/src/renderer/index.css:260-273`; Astryx `ContextMenu.tsx:514` (pointer right-click → `focusFirst`); `DropdownMenuSubMenu.tsx:401-411` (click on the submenu trigger → `focusFirst`).
- **The exemption is safe for pointer opens of the ＋ menu itself.** Astryx 0.6 `DropdownMenu` focuses the menu container, not an item, when opened by pointer (#4477). So without the rule, a click-open of the ＋ menu still has no highlighted item. Based on: `@astryxdesign/core/src/DropdownMenu/DropdownMenu.tsx:740-758` (`openModalityRef === 'pointer'` → `listRef.focus()`), `:820-826`.
- **Accept the ＋ menu's residual hover highlight** (revised on plan audit). Astryx items have no `:hover` background. Hover moves focus onto the pointed-at item. Once the ＋ menu is exempt, an item the pointer left keeps its `:focus` background, while other menus still clear it. This is Astryx's own single-focus-highlight model. Rejected: a CSS distinction between the ⌘T-focused first item and a hover-focused item. No selector can tell them apart, and solving it in JS would mean taking over Astryx's focus handling, which this fix deliberately avoids. Based on: `@astryxdesign/core/src/DropdownMenu/DropdownMenuItem.tsx:52-57`, `menuItemHover.ts:29-44`.
- **No behavioural change to focus handling.** `NewTabMenu`'s open/close, focus restore, and tooltip-quiet logic stay as they are. Earlier fixes `b6bc35c7` and `90095a31` addressed different causes and stay. `90095a31` handed page focus to the workbench when ⌘T comes from a browser page. Based on: `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:228-336`.
- **No automated test.** This is UI, accepted by hand per AGENTS.md "Test harness". A break is visible the first time the menu opens.
- Left to the executor: the class name and the exact selector shape, within the landmine below.

## Direction

One milestone.

### Milestone 1: the ＋ menu's keyboard-opened first item keeps its focus background

The ＋ menu's top-level `role="menu"` list carries a dedicated class. The
global rule in `index.css` no longer matches items directly owned by that
list. It still matches every other menu, including the 「Agent ▸」 flyout
opened from the ＋ menu. Rewrite the touched CSS comment **in English** (AGENTS.md
language policy, even though the surrounding comments are Chinese). Say why the
＋ menu is exempt: ⌘T opens it from the keyboard, and Astryx already focuses the
container on pointer opens. Correct the stale claim at `index.css:267` that
the `:focus` background matches a hover background. Astryx 0.6 has no hover
background; hover moves focus.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **The submenu flyout may be a DOM descendant of the top-level list.** Astryx context layers stay inline at their JSX position when they can (`@astryxdesign/core/src/Layer/useLayer.tsx`, sentinel/`requestContextMount`). An override shaped like `.<class> [role="menuitem"]:focus { … }` would also reach the 「Agent ▸」 flyout's items and pre-highlight them on a click-open. The flyout has its own `role="menu"` but not your class. Choose a selector whose exemption follows the item's *nearest* menu. For example, put the exclusion on the ancestor in the existing rule, `[role="menu"]:not(.<class>) [role="menuitem"]…`, which still matches flyout items through the flyout's own menu element. Do not use a positive override.
- **The rule uses `!important` to beat StyleX's `:not(#\#)` specificity boost.** Keep that intact for the menus that still need it. Do not "fix" specificity by touching Astryx styles.
- **The 终端 item is `isDisabled` while a terminal is being created.** `focusFirst()` then lands on the next enabled item. That is expected and needs no handling.

## Merge and deploy

Desktop renderer only. No worker, server, or protocol change; it ships with the
next desktop release. Before merging, the user checks by hand in
`pnpm dev:desktop:prod`:

1. Click anywhere with the mouse, then press ⌘T: 终端 is highlighted.
   Then press ↓: the highlight moves to the *second* enabled item (Agent ▸).
   This proves focus is on the item, not on the container.
2. Right-click a tab: no item is pre-highlighted.
3. Click 「Agent ▸」: no flyout item is pre-highlighted.
4. Click the ＋ button: no item is pre-highlighted until the pointer hovers one.
   After hovering an item and moving away, that item stays highlighted. This
   is accepted, not a regression.

The build cannot catch a selector that is valid but wrong, so this manual
check is the only real gate.

## Scope

In scope:
- `apps/desktop/src/renderer/index.css`
- `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx` (the `NewTabMenu` component only)

Out of scope:
- `node_modules/@astryxdesign/*` — library behaviour is correct; the conflict is our CSS.
- Other menus' focus behaviour, and the hover-suppression rule at `index.css:500-505`. They are unchanged.
- `apps/desktop/src/main/*`: the ⌘T forwarding path is already correct (`90095a31`).

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Lint | `pnpm -C apps/desktop lint` (oxlint, does not read CSS) | exit 0 |
| Manual check (acceptance) | `pnpm dev:desktop:prod`, the four checks under Merge and deploy | as described |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] The ＋ menu's top-level list carries a dedicated class, and the no-pre-highlight rule excludes items owned by it.
- [ ] Context menus and the 「Agent ▸」 flyout are still covered by the rule. Check by reading the selector against the flyout landmine.
- [ ] The touched CSS comment is in English and no longer claims a hover background.
- [ ] No change to `NewTabMenu`'s open/close/focus logic beyond adding the class.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds. For example, Astryx was upgraded and pointer opens focus an item again.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- `DropdownMenu`'s `className` does not reach the `role="menu"` element.

## Maintenance notes

- The global rule exists only because some Astryx menus focus an item from script on a pointer open. If Astryx `ContextMenu` and submenu flyouts adopt the container-focus behaviour `DropdownMenu` already has, delete the rule outright, together with this exemption.
- Any other menu opened by a ⌘-shortcut would hit the same invisible-focus problem and needs the same opt-out.
