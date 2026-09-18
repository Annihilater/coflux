# Plan 20260918-terminal-marker-and-paper: The command marker is one line tall, and the terminal's paper fills its cell

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 392387f4..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/index.css apps/desktop/src/renderer/components/workbench/terminal-fit.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check, 2026-09-18
- Stop after: implementation — departure check autopilot item (advisor review, then execute)
- Plan review: advisor — departure check autopilot item
- Workspace: isolated — cut from the main worktree at plan time (`pending: 0`)
- Planned at: `392387f4`, 2026-09-18

## Requirement

Two visual defects in the desktop terminal, both reported by the owner as "hard
to describe": a vertical bar on the **left** edge that looks like a scrollbar,
and a strange **black band** along the bottom.

Both were reproduced and measured in a probe that loads the exact production
cohort (`@xterm/xterm` 6.1.0-beta.304 + `@xterm/addon-fit` 0.12.0-beta.301 +
`@xterm/addon-webgl` 0.20.0-beta.300 + Maple Mono CN at 12px / 1.25) with the
same host markup the renderer uses. The probe was deleted after measuring; its
numbers are recorded under Decisions & tradeoffs.

**The left bar** is the OSC 133 command marker. `paintCommand()` sets
`element.style.height = "100%"` on the decoration element, but
`.xterm-decoration` is `position: absolute` and its containing block is
`.xterm-screen` (`position: relative`), so `100%` is the **whole screen**, not
one line. Measured: a decoration anchored at `top 608` rendered
`height 740px`, ending at `bottom 1348` — a 3px bar drawn from its prompt row
all the way past the bottom of the window. Several commands stack into one
continuous strip down the left edge, which is exactly what a scrollbar looks
like. It only appears in sessions with OSC 133 shell integration, hence "in
some situations".

**The black band** is `.xterm-viewport`'s upstream default. xterm 6.1 ships
`.xterm:not(.allow-transparency) .xterm-viewport { background-color: #000 }`,
and at runtime it paints the theme background onto `.xterm` and onto
`.xterm-scrollable-element`'s dom node but not onto the viewport element, which
lies `absolute; inset: 0` on top of both and stays pure black. Whenever the rendered screen is shorter than its container (mid-attach,
inside the 100ms fit debounce, while a remote resize is still in flight, or
simply because rows never divide the container height evenly), that pure black
shows through below the screen as a band against the `#0a0a0a` paper. Today a
second bug partly hides it: FitAddon over-counts the rows by one, so the screen
usually overflows instead of falling short — which is why the band comes and
goes.

Product conclusions, confirmed by the owner before this plan (do not reopen):

1. The command marker keeps its function and colour semantics (running `#6a6a6a`,
   success `#4fae6e`, failure `#e05c6a`, unknown `#c9a227`) and takes the
   Cursor-style form: a 3px wide, **one line tall** block at the start of the
   prompt row. Several commands read as a column of separate small blocks, not
   a continuous line.
2. The terminal's paper (`--terminal`, `#0a0a0a`) fills the whole terminal cell:
   the padding around the text is paper-coloured too. When the row count and the
   container height do not divide evenly, the leftover shows as paper-coloured
   breathing room — never as a band in a different colour.

When this is done: the marker is a one-line block; there is no off-colour band
at any window height; and the last row is fully visible instead of being sliced
by the panel's bottom edge.

## Decisions & tradeoffs

- **The command marker does not override the height xterm already computed**:
  `paintCommand()` stops setting `height`. xterm's `BufferDecorationRenderer`
  sets `style.height = (options.height || 1) * cell.height + "px"` **before** it
  fires `onRender`, so leaving it alone yields exactly one line at any dpr or
  font size. Rejected: computing a pixel height in the callback — it would have
  to re-derive `cell.height` and re-run on every dpr/font change, which is the
  renderer's job. Rejected: keeping a full-height bar as a "command separator" —
  the owner chose the one-line block. Position (`marginLeft: -9px`), width
  (`3px`), radius and colours stay exactly as they are.
  Based on: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:344-350`
  (`paintCommand`), `terminal-pane.tsx:378` (`registerDecoration({ marker, x: 0, width: 1 })`),
  and the xterm css rule `.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute }`
  against `.xterm .xterm-screen { position: relative }`.

- **`.xterm-viewport` is painted with the terminal paper colour, as an inline
  style set after `terminal.open()` — not through a CSS rule**
  `(revised on advisor review)`: after opening the terminal, the renderer
  assigns the paper colour to the `.xterm-viewport` element's
  `style.backgroundColor`, using the same value as `theme.background` (hoist it
  to one constant rather than writing `#0a0a0a` twice). This is what makes the
  fix robust — any moment where the rendered rows do not fill the container
  degrades to paper-coloured padding instead of a black band, so the result
  never depends on pixel-perfect row arithmetic. Rejected: overriding it from
  `index.css` — xterm's stylesheet is imported from `terminal-pane.tsx:7` and
  lands in the lazily-loaded `terminal-panes-*.css` chunk, which loads **after**
  `index.css`, and neither is in an `@layer`; the upstream selector scores
  (0,3,0), so the two natural spellings both lose silently (`.xterm
  .xterm-viewport` on specificity, a verbatim copy on order) and no gate would
  catch it. Rejected: `background: inherit` — `background-color` does not
  inherit, and the upstream declaration is explicit. Rejected:
  `allowTransparency: true` — it disables the upstream rule but costs rendering
  performance and would make the padding show the app floor `#0f0f0f`, not the
  paper, contradicting product conclusion 2. Rejected: leaving the viewport
  alone and only fixing the row count — measured, that leaves an 11px pure-black
  band at the probe's window height, and the band simply moves around as the
  window resizes.
  Based on: `.xterm:not(.allow-transparency) .xterm-viewport { background-color: #000 }`
  at `@xterm/xterm@6.1.0-beta.304/css/xterm.css:103`; the runtime's
  `onChangeColors` painting `this.element` (`.xterm`) and
  `this._scrollableElement.getDomNode()` but **not** the viewport element, which
  sits `absolute; inset: 0` on top of both; `theme.background: "#0a0a0a"` at
  `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:242`; and
  `--terminal: #0a0a0a` at `apps/desktop/src/renderer/index.css:97`.

- **The terminal's inner padding belongs to the `.xterm` element, not to the
  host container**: the host div drops its padding and `.xterm` carries it
  instead (same values: 8px top, 12px bottom, 12px left, 0 right).
  `FitAddon.proposeDimensions()` reads
  `getComputedStyle(terminal.element.parentElement).height/width` and then
  subtracts only **`terminal.element`'s** own padding. The host is
  `box-sizing: border-box` (Tailwind preflight), and Chrome returns the
  border-box height for such an element, so padding placed on the host is
  counted as available space: measured 20px of vertical padding bought a whole
  extra row (`rows` 37 where 36 fit), the screen overflowed the usable area by
  9px, the bottom breathing room shrank from 12px to 3px, and the last row was
  sliced. With the padding on `.xterm`, FitAddon's subtraction is correct and —
  because `.xterm-viewport` is `absolute; inset: 0` against `.xterm`'s **padding
  box** — the viewport covers the padding as well, which is precisely product
  conclusion 2. The same over-count applies horizontally to the 12px left
  padding and to `cols`. The padding is declared on the existing `.xterm` rule
  in `index.css` `(revised on advisor review)`: `terminal.element` is created by
  xterm, so a Tailwind utility cannot be spelled on it from JSX, and the
  alternative — `classList.add` at runtime — puts layout values somewhere no
  one reading the stylesheet would look. Upstream declares no padding on
  `.xterm`, so this rule wins with nothing to fight.
  Based on: the FitAddon 0.12.0-beta.301 body (`parseInt(getComputedStyle(parentElement).height)`
  minus `terminal.element`'s padding), `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:855`
  (host `absolute inset-0 pb-3 pl-3 pt-2`), and `apps/desktop/src/renderer/index.css:313-315`
  (`.xterm { height: 100% }`).

- **No new automated tests (decided while planning)**: all three changes are
  layout and paint behaviour of a real xterm instance plus WebGL; the repo's
  desktop tests are pure-value unit tests (for example
  `apps/desktop/src/renderer/components/workbench/terminal-ime-patch.test.ts`,
  `terminal-fit.test.ts`), and nothing here has a value-level decision to
  assert. Do not invent a jsdom test that asserts a CSS string — it would
  restate the implementation and pass for a wrong one. Acceptance is the
  owner's real-machine walkthrough, per the project's standing rule that
  frontend changes are not visually verified by the agent.

## Direction

One work package, three serial changes across two files. Milestone 1 and
milestone 2 both touch `terminal-pane.tsx`, so they are **not** independent —
do not fan this plan out.

The renderer keeps its current structure: the host div stays
`absolute inset-0` (it is the ContextMenu trigger's grid cell and the drop
target), `.xterm` keeps `height: 100%`, and `terminal-fit.ts`'s debounce
decision is untouched. Both landing sites are fixed by Decisions & tradeoffs —
the padding on the existing `.xterm` rule in `index.css`, the viewport colour as
an inline style after `terminal.open()` — because both have a silent-failure
mode. What stays the executor's call: how the paper colour is shared between
`theme.background` and the viewport assignment, and where in the mount effect
the assignment sits.

### Milestone 1: the command marker is one line tall

`paintCommand()` no longer overrides the decoration's height; markers render as
3px × one-line blocks at the prompt row, keeping their existing position, radius
and state colours. Validation: `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 2: the paper fills the cell and the row count matches it

The inner padding moves from the host container to the `.xterm` element, and
`.xterm-viewport` is painted with the terminal paper colour. The rendered screen
no longer exceeds the usable area (no sliced last row, the bottom breathing room
is back), and any leftover below the last row is paper-coloured.
Validation: `pnpm -C apps/desktop test` -> exit 0, and
`pnpm -C apps/desktop build` -> exit 0.

## Landmines

- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:349` — the
  containing block for `.xterm-decoration` is `.xterm-screen`, not the
  decoration's own line box. Any percentage height there means "the whole
  screen". Do not re-add a "defensive" height in the `onRender` callback.
- The `onRender` callback runs **after** xterm's `_refreshStyle`, so anything
  written there wins over xterm's computed geometry and will not follow dpr or
  font-size changes. Only paint colour/width/offset there.
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:350` — the
  marker's `marginLeft: -9px` is calibrated against a 12px left padding: it
  places the 3px bar at x=3 inside the padding. If the left padding value
  changes, the marker either leaves the panel or covers the first column.
- Moving the padding onto `.xterm` **without** repainting the viewport makes
  things worse, not better: `.xterm-viewport` is `absolute; inset: 0` against
  `.xterm`'s padding box, so the whole inner border would render pure black.
  The two halves of milestone 2 ship together.
- xterm's stylesheet loads **after** `index.css`: it is imported from
  `terminal-pane.tsx:7` and Vite emits it into the lazily-loaded
  `terminal-panes-*.css` chunk, while `index.css` carries only
  `.xterm { height: 100% }` and the canvas rule. Neither file is in an
  `@layer`. So a rule in `index.css` beats an upstream one only on specificity:
  `.xterm .xterm-viewport` (0,2,0) loses to the upstream (0,3,0), and a verbatim
  copy ties and then loses on order. Nothing in the build warns about this —
  which is why the viewport colour is an inline style, not a rule.
- `.xterm { height: 100% }` combined with `box-sizing: border-box` means adding
  padding to `.xterm` does not change its outer height — the content area
  shrinks on its own. Do not compensate with `calc()`.
- The host div is also the ContextMenu trigger's grid cell and the drag-and-drop
  target (`terminal-pane.tsx:838-860`); it must keep `absolute inset-0` and its
  `cursor-progress` upload state.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/src/renderer/index.css`

Out of scope:
- `apps/desktop/src/renderer/components/workbench/terminal-fit.ts` — the
  debounce decision is orthogonal and correct.
- Terminal typography (font, size, line height) and the theme palette — settled
  in 2.1.1, do not touch.
- The supervisor/PTY side of the resize protocol — the renderer already sends
  the corrected dimensions through the existing path.
- `apps/web`, `apps/mobile` — frozen, out of the repository.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (this worktree starts empty) | `pnpm install --frozen-lockfile` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Real-machine walkthrough (acceptance) | desktop dev preview, run by the owner | marker is a one-line block; no off-colour band at any window height; last row fully visible |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] The OSC 133 marker renders as a one-line, 3px block at the prompt row, with
      its existing position and state colours.
- [ ] No off-colour band appears below the last row at any window height; the
      leftover is terminal paper colour.
- [ ] The rendered screen no longer exceeds the panel: the last row is complete
      and the bottom breathing room is present.
- [ ] The viewport's paper colour is an inline style assigned after
      `terminal.open()`, not a CSS rule (a rule would lose to the upstream one
      and fail silently — see Decisions & tradeoffs).
- [ ] No new tests were invented for CSS strings (see Decisions & tradeoffs).
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (in particular, the
  xterm cohort in `apps/desktop/package.json` changing under this branch).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Removing the marker's height override makes it disappear entirely rather than
  become one line tall — that would mean xterm stopped setting the height before
  `onRender`, and the decision needs revisiting.

## Maintenance notes

- Both root causes are upstream-shaped: re-check them when the xterm cohort
  moves. Specifically, whether `.xterm-viewport` still ships a hardcoded `#000`
  while the runtime's `onChangeColors` paints `.xterm` and the scrollable
  element but skips the viewport, and whether `FitAddon.proposeDimensions()`
  still reads the parent's computed height (border-box under
  `box-sizing: border-box`) and subtracts only `terminal.element`'s padding. If
  xterm ever paints the viewport itself, the inline assignment becomes dead
  weight and should go.
- The inline viewport colour is a workaround for load order, not a preference:
  should `xterm.css` ever be imported from `index.css` (or either file move into
  an `@layer`), a plain rule becomes viable and is the better home.
- The same bottom band was reported on 2026-09-11 and shelved after the
  investigation reached "FitAddon counts the host's padding as usable height"
  without finding the black itself; the viewport background is the missing half.
- The terminal renderer may eventually be replaced (the Ghostty overlay spike is
  archived and its plan never landed in this repository). These changes are a
  dozen lines and carry no sunk cost either way.
