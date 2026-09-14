# Plan 20260914-right-edge-menu-alignment: Right-edge top-bar menus open at full width again

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 0e31df00..HEAD -- apps/desktop/src/renderer/components/workbench/notification-inbox.tsx apps/desktop/src/renderer/components/workbench/port-menu.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/package.json`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: self — departure check in `dev:explore` (2026-09-14)
- Stop after: implementation — departure check, autopilot chosen
- Workspace: isolated — departure check accepted the default; worktree `.claude/worktrees/20260914-right-edge-menu-alignment`, branch `dev/20260914-right-edge-menu-alignment`
- Planned at: `0e31df00`, 2026-09-14

## Requirement

Since the astryx lift to 0.6.0 (`wiki/plans/20260913-astryx-0-6-0.md`, merged in
`e272645a`) the two `DropdownMenu` triggers at the right edge of the desktop
top bar — the notification inbox bell and the port-forwarding router icon,
mounted at `workbench.tsx:877-878` — open as a sliver a few tens of pixels
wide, hugging the trigger's left edge, with every character wrapped onto its
own line. Both menus are unusable.

Neither call site passes `alignment`, so both get astryx's default `start`:
the menu's start edge sits on the trigger's start edge and the menu grows
toward the window's right edge. astryx positions menus with CSS anchor
positioning, and for that alignment the menu's containing block is the strip
from the trigger's left edge to the viewport's right edge — a few dozen pixels
for a trigger at the right edge.

On 0.1.6 this was masked: the menu carried a hard `min-width: <menuWidth>px`,
overflowed that strip, and the browser's `position-try-fallbacks` (`flip-inline`)
flipped it to open leftwards. On 0.6.0 the width became
`min(<menuWidth>px, calc(100% - gutter))` plus a `max-inline-size` viewport
guard, so the menu now shrinks to fit the strip instead of overflowing it, and
the flip never fires.

Done means: both menus open leftwards from their trigger at their configured
`menuWidth` (320px inbox, 220px ports), exactly as they did on 0.1.6, and no
other menu in the desktop app changes.

## Decisions & tradeoffs

- **Fix by declaring the alignment, not by changing width or upstream**:
  pass `alignment="end"` on the `DropdownMenu` in `notification-inbox.tsx`
  and in `port-menu.tsx`. Rejected: keeping the default and restoring overflow
  (a larger or `!important` width, a custom `menuWidth` keyword, a wrapper
  with its own positioning) — that reproduces the accidental 0.1.6 behaviour
  by fighting the viewport guard, and breaks the moment the guard changes
  again. Rejected: patching or swizzling astryx — the component already
  exposes the right knob. `end` is the semantically correct value for a
  right-edge trigger: it maps to `position-area: … span-self-inline-start`,
  whose containing block runs from the viewport's left edge to the trigger's
  right edge, wide enough for both configured widths.
  Based on: default `alignment = 'start'` at
  `apps/desktop/node_modules/@astryxdesign/core/src/DropdownMenu/DropdownMenu.tsx:578`;
  the `start`/`end` → `span-self-inline-end`/`span-self-inline-start` mapping at
  `apps/desktop/node_modules/@astryxdesign/core/src/Layer/useLayer.tsx:406-418`;
  the flip-only fallbacks for non-centered alignments at `useLayer.tsx:444-447`;
  the width clamp at
  `apps/desktop/node_modules/@astryxdesign/core/src/DropdownMenu/menuWidth.ts:38`
  (0.1.6 used a hard `min-width` at its `DropdownMenu.tsx:88`, see the pnpm
  store copy `@astryxdesign+core@0.1.6_*`).

- **Touch only the two right-edge call sites**. Rejected: adding `alignment`
  to `branch-menu.tsx:45` (top bar, left side; `start` is already the wanted
  direction), `account-footer.tsx:99` (sidebar bottom, `placement="above"`,
  grows rightwards into the window), or the three `ContextMenu`s in
  `sidebar.tsx` (pointer-anchored) — none of them is affected and a blanket
  change would be an unreviewed layout change.
  Based on: the call-site inventory in `apps/desktop/src/renderer/components/workbench/`
  (grep `<DropdownMenu` / `<ContextMenu`) and the mount order in
  `workbench.tsx:877-878`.

- **`menuWidth`, the tooltip sibling workaround, and `menu-button-tooltip.ts`
  stay byte-identical**. Rejected: folding any tooltip cleanup into this fix —
  `docs/design-guidelines.md:32` records that the workaround is still required
  on 0.6.0, and it is a separate decision with its own upstream check.
  Based on: `docs/design-guidelines.md:26-32` and the astryx 0.6.0 plan's
  "The menu-trigger tooltip workaround stays" entry.

## Direction

One milestone; nothing to fan out.

### Milestone 1: right-edge menus declare `alignment="end"`

After this milestone both `DropdownMenu` usages in `notification-inbox.tsx`
and `port-menu.tsx` carry `alignment="end"`, and the rest of the desktop
renderer is unchanged. Validation: `pnpm -C apps/desktop typecheck` → exit 0,
and `git diff --stat` lists only those two files.

Visual acceptance is the user's: this project does not have Claude verify
frontend changes in a browser or the running app. The executor runs the
in-process checks only.

## Landmines

- `apps/desktop/src/renderer/components/workbench/notification-inbox.tsx:105-110`
  and `port-menu.tsx:56`: the comments and the sibling `<Tooltip>` after each
  menu are deliberate (`docs/design-guidelines.md`). Do not "tidy" them while
  adding the prop.
- The 0.6.0 upgrade plan's acceptance
  (`wiki/plans/20260913-astryx-0-6-0.md:205`) only walked the trigger
  tooltips and the avatar, never the opened menus, which is how this slipped
  through. Record that lesson in Maintenance notes here; do not edit the old
  plan.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/notification-inbox.tsx`
- `apps/desktop/src/renderer/components/workbench/port-menu.tsx`
- `wiki/plans/README.md` (status)

Out of scope:
- `apps/desktop/src/renderer/components/workbench/branch-menu.tsx`,
  `account-footer.tsx`, `sidebar.tsx` — unaffected call sites (see Decisions)
- `apps/desktop/src/renderer/components/workbench/menu-button-tooltip.ts`,
  `docs/design-guidelines.md` — tooltip workaround is a separate decision
- `apps/desktop/package.json`, `pnpm-lock.yaml` — no dependency change; the
  fix is a prop, not an astryx bump or patch
- Any `menuWidth` change on either menu

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 (no test covers menu layout; run to confirm no import breakage) |
| Visual pass (acceptance) | user opens the desktop app, clicks the bell and the router icon at the top-right | both menus open leftwards at 320px / 220px; the empty-state copy "当前工作区没有转发中的端口。" reads on one or two lines, not one character per line |

## Done criteria

- [ ] All listed commands pass.
- [ ] `notification-inbox.tsx` and `port-menu.tsx` each pass `alignment="end"` to their `DropdownMenu`.
- [ ] No other file under `apps/desktop/src` changed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular, if
  the installed `@astryxdesign/core` is no longer 0.6.0, or its `DropdownMenu`
  no longer accepts `alignment`.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Any future `DropdownMenu`/`MoreMenu`/`Popover` trigger placed at the window's
  right edge needs `alignment="end"`; the default `start` only works when the
  menu has room to grow rightwards. Bottom-edge triggers likewise need
  `placement="above"`. On 0.6.0+ the viewport guard means a menu that does not
  fit shrinks rather than flips, so a wrong alignment shows up as a squashed
  menu, not an overflow.
- Design-system upgrades must walk every opened menu, not just the triggers:
  the 0.6.0 acceptance checked tooltips and the avatar and missed this.
