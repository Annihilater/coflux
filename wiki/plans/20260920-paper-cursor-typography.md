# Plan 20260920-paper-cursor-typography: The conversation paper reads at Cursor's measure

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat f037003d..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-paper.tsx apps/desktop/src/renderer/index.css`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plain autopilot)
- Plan review: none — departure check; a pure className pass over one file gives an advisor nothing to hold on to
- Workspace: isolated — cut `dev/20260920-paper-cursor-typography` at `.claude/worktrees/20260920-paper-cursor-typography` from the main worktree
- Planned at: `f037003d`, 2026-09-20

## Requirement

The "conversation paper" overlay (plan `20260919-terminal-paper-overlay`) caps its
measure at `max-w-[68ch]`. Because this repository runs an IDE type scale where
`text-base` is **13px** (`apps/desktop/src/renderer/index.css:68`), that measure
renders at roughly **490px**. On the maintainer's 3840px display the page is a
ribbon of text down the middle of a terminal pane many times wider, which is the
reported problem: *the paper is far too narrow on a large screen.*

The fix is to adopt Cursor's conversation typography wholesale. The reference is
Cursor 3.20.17 as installed at `/Applications/Cursor.app`; every number below was
read out of its shipped `workbench.desktop.main.{css,js}` and
`workbench.glass.main.{css,js}`, not estimated.

**Product conclusions settled with the user — do not reopen:**

| surface | target (Cursor) | today |
| --- | --- | --- |
| measure | **840px**, centred (`--composer-max-width`) | `68ch` ≈ 490px |
| body text | **15px** (`--cursor-font-size-lg`) | 13px (`text-base`) |
| body line height | **24px** (`--cursor-line-height-lg`), i.e. 1.6 at 15px | 24px (`leading-[1.85]` at 13px) |
| block spacing | `margin-top: 0; margin-bottom: 1em` (15px) | `my-3` (12px both sides) |
| list indent | `padding-left: 2em` (30px) | `pl-5` (20px) |
| list item gap | `margin-bottom: .25em` (≈4px) | `space-y-1` (4px) — already matching |
| h1 / h2 | **1.214em** ≈ 18px | 15px / 13px |
| h3–h6 | body size, weight alone separates them | 13px / 12px |
| code block | **0.85em** ≈ 13px, line height 1.4 | 12px, `leading-relaxed` |
| inline code | 0.8em = 12px | 12px — already matching |
| blockquote | 3px left rule, `padding-left: 1em`, `margin: .5em 0` | 2px rule, `pl-4`, `my-3` |
| table | `margin: 1em 0`, cell padding `.5em` | `my-3`, `px-2 py-1` |
| rule (`hr`) | `margin: 1em 0` | `my-6` |
| person's turn | right-aligned, **1px stroke + input-coloured fill + 12px radius**, padding 8px/12px | solid `bg-accent`, 8px radius, `px-4 py-2.5` |
| person's turn width | ≤ ~83% of the measure | `max-w-[80%]` — already equivalent |
| tool-call landmark | one dim truncated line | one dim truncated line — form unchanged |

**Observable when done.** Open the paper in a wide terminal pane: the column of
prose is 840px wide instead of a ribbon, set at 15px on a 24px rhythm, and a
person's own turns read as outlined cards rather than solid blocks. In a pane
narrower than the measure nothing overflows — the column simply fills the pane
minus its padding, exactly as before.

**Not in this build.** The expand/collapse motion, the paper's surface colour,
the transcript reader, the button, Esc ownership, focus handling — all settled by
plan `20260919-terminal-paper-overlay` and untouched here.

## Decisions & tradeoffs

- **The measure is a fixed 840px, not a fraction of the pane and not the full
  pane.** `mx-auto max-w-[840px]` replaces `max-w-[68ch]`; the horizontal padding
  stays, so a pane narrower than the measure keeps behaving exactly as it does
  today. Rejected: a percentage width, a `clamp()` that keeps growing with the
  pane, or removing the cap so prose fills the pane — on a 3840px display those
  produce 100+ character lines, which is unreadable in the other direction, and
  Cursor itself pins a constant at every window size.
  Based on: `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.css`
  (`--composer-max-width:840px` on `.monaco-workbench`, consumed by
  `.composer-bar[data-composer-location=bar]`, `.composer-plan-content`,
  `.composer-sticky-title__text` and the agent-panel header — the whole
  conversation column, not one widget).

- **Body text moves to the existing `text-lg` step; no new type token, and
  `index.css` is not touched.** The scale already carries `--coflux-text-lg: 15px`
  (`apps/desktop/src/renderer/index.css:69`), which is exactly Cursor's
  `--cursor-font-size-lg`. Rejected: adding a paper-specific size token or a
  hard-coded `text-[15px]` — the step exists, and a second source of truth for
  "15px" is how a type scale rots. Rejected equally: changing any `--coflux-text-*`
  value — those are shared by the whole renderer, and this plan changes one page.

- **The 24px line height survives the size change as a ratio, not as a
  coincidence.** Today's `leading-[1.85]` at 13px and Cursor's `24px` at 15px are
  the same rendered rhythm; at 15px the ratio must therefore become 1.6. The
  executor may write it as a ratio or as a length, but 15px text on 24px lines is
  the outcome — keeping `leading-[1.85]` would silently inflate the rhythm to
  27.75px.

- **Block spacing adopts Cursor's one-sided rule: `margin-top: 0`,
  `margin-bottom: 1em`.** This applies to `p`, `ul`, `ol`, `blockquote`, `table`
  and `hr` alike; headings keep symmetric `.5em` margins, which is what Cursor
  does (`h1..h6 { margin-bottom:.5em; margin-top:.5em }`). The existing
  `last:mb-0` guard stays and still earns its keep — a lone paragraph inside a
  list item or table cell must not add a trailing gap. The `first:mt-0` guards
  become inert once the top margin is zero; dropping them is fine, keeping them is
  fine, but no block may end up with a non-zero top margin.
  Rejected: keeping the symmetric `my-3` rhythm and only scaling it — symmetric
  margins collapse differently between siblings and nested blocks, which is why
  the reference uses a one-sided rule.
  Based on: `workbench.desktop.main.css`, `.vs-markdown-container .rendered-markdown p{margin-bottom:1em;margin-top:0}`
  and the matching `ol,ul` rule.

- **Only `h1` and `h2` grow; `h3` through `h6` sit at body size.** Cursor's
  composer overrides exactly two levels (`.composer-message-markdown.markdown-root h1,h2{font-size:1.214em}`)
  on top of a base where every heading inherits its size
  (`.vs-markdown-container .rendered-markdown h1..h6{font-size:inherit}`), so
  deeper headings are separated by weight alone. 1.214em of 15px is 18.2px, which
  is the existing `--coflux-text-2xl: 18px` step (`index.css:71`).
  The current file's one-level tag demotion — a Markdown `#` renders as `<h2>`,
  because the page's own title lives in the header bar — is a separate decision
  from plan `20260919` and **stays**: this plan changes sizes, not tags.

- **The person's turn keeps its geometry and changes its skin.** It stays right
  aligned, stays capped near 80% of the measure, and becomes an outlined card:
  1px stroke, the input surface as fill, 12px radius, 8px block / 12px inline
  padding. Cursor's own cap is
  `width: calc(100% - max(32px, clamp(0px,(100% - 480px)*0.4,20%)))`, which at an
  840px measure resolves to 696px ≈ 82.9% — near enough to the existing
  `max-w-[80%]` that reproducing the formula buys nothing. Rejected: porting the
  `clamp()` inset, and rejected equally: dropping the bubble for a flat
  left-aligned block — the bubble is the scroll anchor plan `20260919` settled on.
  Based on: `workbench.desktop.main.css`, `.composer-human-message{background-color:var(--vscode-input-background);border:1px solid var(--cursor-stroke-secondary);border-radius:var(--cursor-radius-xl)}`,
  `--cursor-radius-xl:12px` (`workbench.desktop.main.js`), and
  `.composer-messages-container[data-project-send-message-layout]` for the inset
  formula.

- **Cursor's negative block inset is not ported.** The reference lets code blocks
  and other block elements bleed ~10px wider than the prose
  (`--conversation-glass-block-inset: -10px`). It is a glass-mode detail that
  needs a second inset variable threaded through every block element, for an
  effect nobody asked for. The paper keeps one column edge for everything.
  *(decided while planning)*

- **The tool-call landmark moves one step up the scale, to 12px, and changes in
  no other way.** Body text grows 13→15px, so leaving the landmark at
  `text-xs` (11px) would widen the contrast the page was tuned with. It keeps the
  monospace face, the muted colour, the `⏺` prefix and the single truncated line —
  Cursor sets its equivalent in the UI face at 13px, but these lines carry shell
  commands, and this repository's own convention renders commands in
  `Maple Mono CN`. Rejected: 13px and/or the sans face — that makes a deliberate
  signpost compete with the prose.
  *(decided while planning)*

## Direction

One file, one pass: `apps/desktop/src/renderer/components/workbench/terminal-paper.tsx`.
The work is entirely in Tailwind class strings — the measure wrapper at `:220`,
the person's-turn bubble at `:290`, the tool line at `:283`, and the
`MARKDOWN_COMPONENTS` map plus `MarkdownPre` / `MarkdownCode` below `:370`. No
new component, no new prop, no state, no dependency.

Update the comments that assert the old numbers as you go — several of them state
the rationale in terms of the current values (the "单栏窄版心" comment above the
measure wrapper, and the `first:mt-0 last:mb-0` note above `MARKDOWN_COMPONENTS`).
A comment left describing 68ch is worse than no comment.

Single milestone; nothing here is independent of anything else, so this runs as
one work package — do not fan out.

### Milestone 1: the paper is set at Cursor's measure and scale

Every row of the Requirement's table holds in the rendered page, and the file
carries no stale numbers in prose or comments.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0, no regression against the 241-test
baseline; `pnpm -C apps/desktop build` -> exit 0.

## Landmines

- **`text-base` is 13px here, not 16px.** `apps/desktop/src/renderer/index.css:68`
  redefines the whole scale for IDE density (`2xs` 10, `xs` 11, `sm` 12, `base`
  13, `lg` 15, `xl` 16, `2xl` 18), and `@theme inline` at `:139-141` wires those
  into Tailwind. Any figure derived from Tailwind's stock scale will be wrong by
  about 20%, and `ch`-based widths inherit the same error — that is precisely how
  the current measure ended up at 490px.
- **`border-border` is too dark to read as Cursor's stroke.** `--border: #242422`
  against the paper's `--popover: #1b1b1a` is roughly a 3% step, while Cursor's
  `--cursor-stroke-secondary` is `color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent)`
  — about 12% of the foreground, four times the contrast. An outlined bubble drawn
  with `border-border` reads as no outline at all. Use a foreground-mixed stroke
  (Tailwind's `border-foreground/12` compiles to the same `color-mix`) rather than
  the flat border token. The tokens are at `index.css:76` (`--foreground`), `:79`
  (`--popover`), `:91` (`--border`) and `:92` (`--input`).
- **12px is not in the radius scale.** `--radius` is `0.375rem` (6px) and
  `@theme inline` only defines `sm`/`md`/`lg` from it (`index.css:98`, `:125-127`),
  so `rounded-lg` is 8px. Reaching 12px means Tailwind's stock `rounded-xl`
  (0.75rem, untouched by the theme block) or an explicit arbitrary value — verify
  whichever you pick actually renders 12px rather than assuming.
- **The measure wrapper is also the sticky header's width source.** `PaperHeader`
  renders inside the `mx-auto max-w-[…]` div, so widening the measure widens the
  header with it; its `pr-10` exists to clear the close button and only matters
  when the pane is narrower than the measure. Do not move the header out of the
  wrapper to "fix" the gap.
- **No automated gate renders this page.** The desktop suite covers the transcript
  parser and the terminal helpers, not the overlay's layout. Typecheck and tests
  passing says nothing about whether the page looks right; that is the user's
  walkthrough, listed under Commands as acceptance.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-paper.tsx`

Out of scope:
- `apps/desktop/src/renderer/index.css` — the type, colour and radius scales are
  shared by the whole renderer; this plan consumes existing steps and adds none
- `apps/desktop/src/renderer/components/workbench/terminal-transcript.ts` — how
  the conversation is read and parsed is untouched
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` — the
  button, the overlay's mounting, Esc ownership and focus restoration
- The overlay's motion, clip-path geometry and surface colour — settled by plan
  `20260919-terminal-paper-overlay`

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop unit tests | `pnpm -C apps/desktop test` | exit 0, 241/241 baseline holds |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Visual walkthrough (acceptance) | `pnpm dev:desktop:prod`, open a terminal running Claude, click the top-right paper button | the column is 840px wide and centred, prose at 15px/24px, person's turns are outlined cards |

The walkthrough needs a daemon that reports `agentSessionId` (worker 2.2.0 or
newer) for the button to appear at all. If the button is missing in
`dev:desktop:prod`, this machine's daemon predates that field — run the local
stack instead (`pnpm dev:pg`, `pnpm dev:server`, this branch's `pnpm dev:daemon`,
`pnpm -C apps/desktop dev`), per plan `20260919`'s acceptance note.

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every row of the Requirement's table holds in the rendered page.
- [ ] The person's turn is an outlined card: visible 1px stroke, input-coloured
      fill, 12px radius — and the stroke is actually visible against the paper.
- [ ] Comments in the file describe the new numbers; none still argue for 68ch,
      13px, or symmetric block margins.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- Reaching any target in the table requires editing `index.css` or any file
  outside Scope.
- A validation command fails twice after one reasonable fix.
- The 241-test desktop baseline regresses.

## Maintenance notes

- The reference values were read from Cursor **3.20.17**. A later Cursor may move
  them; this plan is the record of what was copied and when, so a future
  "re-align with Cursor" starts by re-reading `--composer-max-width`,
  `--cursor-font-size-lg` and `--cursor-line-height-lg` rather than trusting this
  table.
- Cursor's glass mode raises the body step to 15px/24px
  (`workbench.glass.main.css`) over a 14px/22px default in
  `workbench.desktop.main.js`. The larger pair was taken deliberately: glass mode
  is what ships on by default, and it is what the maintainer sees.
- 840px at 15px is about 56 CJK characters or 110 latin characters per line —
  long by classical typographic advice and deliberately so, because matching
  Cursor was the requirement. If lines ever feel too long in practice, the measure
  is one constant in one file.
