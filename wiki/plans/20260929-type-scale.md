# Plan 20260929-type-scale: no text in the desktop app is too small to read comfortably

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat bcb91b3b..HEAD -- apps/desktop/src/renderer docs/design-guidelines.md`

## Status

- Priority: P2
- Effort: M
- Risk: LOW — renderer styling only; the risk is dense layouts overflowing
- Depends on: none (parallel group with `20260929-annotation-polish`; see `wiki/plans/README.md`)
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; the group's plans live on `dev/20260929-annotation-polish` (`.claude/worktrees/20260929-annotation-polish`); as a parallel-group member, `dev:execute-plan` runs this plan in its own worktree cut from that branch and merges it back there. Do not work in the annotation-polish plan's worktree
- Planned at: `bcb91b3b`, 2026-09-29

## Requirement

The user finds "quite a few places with very small text" in the desktop app and wants typography treated with more care. The renderer's scale is 10 / 11 / 12 / 13 / 15 / 16 / 18 px (`--coflux-text-2xs` … `--coflux-text-2xl`), with 13 px as the body size, but 10 px (`text-2xs`, `text-[10px]`, `text-[9px]`) and 11 px (`text-xs`, `text-[11px]`) are used for ordinary reading text — comments, captions, meta lines, menu details — across the sidebar, the changes view, terminal chrome, dialogs and more.

When this is done:

1. **The scale has a floor**: body text 13 px; secondary text (meta lines, captions, group headings, hints, timestamps, shortcut hints inside rows) 12 px; **11 px only for badges** — counts, numbers inside pills, keycap glyphs, status chips; nothing in the UI renders at 10 px or below.
2. **Every existing use is judged, not bulk-replaced**: each `text-2xs`, `text-[9px]`/`text-[10px]`/`text-[11px]` and `text-xs` in the files this plan owns is classified as body, secondary or badge and set accordingly; dense layouts (sidebar rows, file tree, tab strips, menus) still fit — a larger size may need a line-height, truncation or spacing adjustment, never a return to a smaller size.
3. **The rule is written down** in `docs/design-guidelines.md` so later work does not reintroduce small text.

Terminal content (xterm's font size, `terminal-pane.tsx:266`) is not UI text and is out of scope. The browser tab and every annotation surface are handled by the parallel plan `20260929-annotation-polish` with the same numbers.

## Decisions & tradeoffs

- **Remove the 10 px rung instead of re-pointing it**: delete `--coflux-text-2xs`, and **unregister** the `text-2xs` utility in coflux's `@theme` with `--text-2xs: initial;` (and `--text-2xs--line-height: initial;`) — the Tailwind v4 way to drop an upstream theme key. Merely deleting coflux's alias is not enough *(revised on plan audit)*: `index.css:10` imports `@astryxdesign/core/tailwind-theme.css`, which itself defines `--text-2xs: var(--font-size-2xs)` (`node_modules/@astryxdesign/core/src/tailwind-theme.css:174`), so `text-2xs` would survive at whatever `--font-size-2xs` resolves to. Also point astryx's `--font-size-2xs` (and the smaller `--font-size-3xs`/`--font-size-4xs`, which astryx defines at 7 px / 6 px and coflux does not override today) at the 11 px floor, so no astryx component can render below it. Rejected: redefining `2xs` as 11 px — two names for one size invite the next person to pick the "smaller-sounding" one. Based on: `apps/desktop/src/renderer/index.css:10`, `:82-88`, `:149-151`; `apps/desktop/src/renderer/main.tsx:26-47` (astryx token overrides, must be set in the theme, not in CSS — see the comment above them); astryx defaults in `node_modules/@astryxdesign/core/dist/astryx.css` (`--font-size-2xs:0.5rem;--font-size-3xs:0.4375rem;--font-size-4xs:0.375rem`).
- **Headings never sit at the badge size**: astryx's `--text-heading-6-size` maps to `--font-size-xs` (11 px) through coflux's override; raise it to the 12 px secondary size. Based on: `apps/desktop/src/renderer/main.tsx:47`.
- **11 px (`text-xs`) stays in the scale, restricted by rule to badges**: the token remains because badges need it; the guideline, not the token set, carries the restriction. Rejected: deleting `text-xs` — badges would fall back to arbitrary values.
- **No arbitrary pixel font sizes in the renderer**: `text-[Npx]` for font size is replaced by the token utilities (`text-xs`/`text-sm`/`text-base`/…). Based on: `apps/desktop/.claude/CLAUDE.md` ("Tokens for every value … no hardcoded/arbitrary value").
- **The guideline entry** in `docs/design-guidelines.md` is one rule with its rationale, in the file's style: the floor, the three roles and their sizes, the badge-only use of 11 px, no arbitrary font-size values, terminal content excluded. Based on: `docs/design-guidelines.md:1-3` (one rule and its rationale per entry).
- **No tests**: the change is visual and reversible; a test would restate class names (`AGENTS.md`, "Test harness"). The grep in Commands is the gate.
- **Left to the executor**: the body/secondary/badge classification of each use, line-height or spacing adjustments that keep dense rows fitting, and whether a meta line that no longer fits truncates or wraps.

## Direction

A token change in `index.css`/`main.tsx`, then a file-by-file pass over the renderer (excluding the files owned by `20260929-annotation-polish`), then the guideline. Current small-text sites (at `bcb91b3b`): `text-2xs`/`text-[9–11px]` in `account-footer.tsx`, `changes-diff-pane.tsx`, `changes-file-tree.tsx`, `port-menu.tsx`, `secret-request-card.tsx`, `sidebar.tsx`, `terminal-pane.tsx`, `workbench.tsx`; `text-xs` additionally in `dialog-footer.tsx`, `changes-view.tsx`, `command-palette.tsx`, `daemon-onboarding.tsx`, `dialogs.tsx`, `notification-inbox.tsx`, `terminal-paper.tsx`, `workspace-terminal.tsx`, `index.css`, `main.tsx` (sidebar has the most, 13). Re-run the grep in Commands rather than trusting this list.

### Milestone 1: scale and sweep

The 10 px rung is gone, astryx cannot go below 11 px, heading-6 is 12 px, and every owned use is reclassified. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`, and the small-text grep below returns nothing.

### Milestone 2: guideline

`docs/design-guidelines.md` carries the type-scale rule. Validation: the entry exists and names the floor, the three roles and the badge-only 11 px.

Milestones are sequential and small — one work package, do not fan out.

## Landmines

- **astryx token overrides only work in the theme object**: overriding `--font-size-*` in `index.css` never matched (the scope root is the theme name), which is why `main.tsx` carries them (`apps/desktop/src/renderer/main.tsx:20-25`).
- **A leftover `text-2xs` class does not fail the build** — once unregistered it simply emits no rule; the source grep and the built-CSS check are what catch it. The parallel plan owns `browser-view.tsx` and `browser-annotations*` (and names any new file `browser-annotations-*`); those files still contain `text-2xs` until that plan merges — exclude them from this plan's source grep, and never edit them. The built-CSS check therefore only passes after both plans are merged; run it as the group exit gate.
- **Do not edit `wiki/plans/README.md` from the member worktree**: both members' rows sit next to each other and would conflict at merge; the orchestrator updates statuses after merging.
- **Sidebar and file-tree rows have fixed heights**: raising their meta text from 10–11 px to 12 px can clip descenders or push rows taller; check each changed row renders fully in `pnpm dev:desktop:prod`.
- **`terminal-pane.tsx:266` `fontSize: 12`** is the terminal's content size (a deliberate user choice), not UI chrome — do not touch it.

## Scope

In scope:
- `apps/desktop/src/renderer/index.css`, `apps/desktop/src/renderer/main.tsx`
- `apps/desktop/src/renderer/components/**`, except the files listed out of scope
- `docs/design-guidelines.md`
- This plan (`wiki/plans/README.md` is updated by the orchestrator after merge, not by the member)

Out of scope:
- `apps/desktop/src/renderer/components/workbench/browser-view.tsx`, `apps/desktop/src/renderer/components/workbench/browser-annotations*` — owned by `20260929-annotation-polish`
- `apps/desktop/src/main/**` (including the annotation page script) — owned by `20260929-annotation-polish`
- Terminal content font size; iOS

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (first) | `pnpm install --frozen-lockfile` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Small text gone | `grep -rn -e text-2xs -e 'text-\[[89]px\]' -e 'text-\[1[01]px\]' -e coflux-text-2xs apps/desktop/src/renderer --exclude=browser-view.tsx --exclude='browser-annotations*'` (no `\|` alternation: in this shell `grep -E` treats `\|` literally and the gate would always be empty; at `bcb91b3b` this finds the sites listed under Direction) | no output |
| Remaining 11 px uses are badges | `grep -rn text-xs apps/desktop/src/renderer --exclude=browser-view.tsx --exclude='browser-annotations*'` | every hit is a badge/count/keycap/chip |
| Group exit gate (after both group members are merged) | `pnpm -C apps/desktop build && grep -l 'text-2xs' apps/desktop/out/renderer/assets/*.css` | no output |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` | the user reviews sidebar, changes view, terminal chrome, menus, dialogs, settings |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] `text-2xs` is unregistered (`--text-2xs: initial`), not merely un-aliased;
- [ ] No token, utility or arbitrary value in the renderer resolves to ≤ 10 px; astryx's `2xs`/`3xs`/`4xs` resolve to the 11 px floor; heading-6 is 12 px.
- [ ] Every remaining `text-xs` in owned files is a badge-class element.
- [ ] Dense rows (sidebar, file tree, tab strips, menus) still fit without clipping.
- [ ] `docs/design-guidelines.md` has the type-scale rule.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Fixing a layout requires editing an out-of-scope file.
- A dense layout cannot fit the new sizes without a structural redesign — report the case instead of shrinking text back.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- On the next astryx upgrade, re-check its default `--font-size-*` values and whether new components use a rung below `xs`.
- iOS has its own type scale; this rule does not cover it.
