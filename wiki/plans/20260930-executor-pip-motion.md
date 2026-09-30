# Plan 20260930-executor-pip-motion: The executor card moves like picture-in-picture

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 59ada94f..HEAD -- apps/desktop/src/renderer/components/workbench/executor-run-card.tsx apps/desktop/src/renderer/components/workbench/executor-run.ts apps/desktop/src/renderer/components/workbench/executor-run.test.ts apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/terminal-paper.tsx apps/desktop/src/renderer/components/workbench/secret-request-card.tsx apps/desktop/src/renderer/index.css`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (builds on the executor card from `20260929-executor-pip.md`, already on main)
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with plan audit)
- Plan review: audit — departure check
- Workspace: isolated — the session was on the main worktree; this plan lives on `dev/20260930-executor-pip-motion` in `.claude/worktrees/20260930-executor-pip-motion`
- Planned at: `59ada94f`, 2026-09-30

## Requirement

The executor picture-in-picture card (the read-only card that appears on the pane of a terminal
whose agent ran `coflux executor run`) works but feels stiff: on release it jumps to a corner with
no motion, a flick toward a corner is not recognised, several runs just stack in a column, and
expanding swaps a small card for a big panel with no transition. The user tuned the intended feel
by hand in a standalone demo during exploration; that demo is archived next to this plan as
**`wiki/plans/20260930-executor-pip-motion.demo.html`** and is the reference for motion, geometry
and parameters. Open it in a browser (it is self-contained, no server needed) to see and feel the
target; its `DEFAULTS` object holds the approved parameter values. Where this plan and the demo
disagree, this plan wins; where this plan is silent on a visual or motion detail, the demo is the
answer.

What is true when this is done — the product conclusions the user confirmed:

1. **Drag.** The deck follows the pointer 1:1 and can be caught mid-flight (grabbing a flying deck
   interrupts its spring). On release the corner is chosen from the release position **plus the
   release velocity projected forward** (a flick picks the far corner), and the deck travels there on
   a spring that starts with the release velocity. Lifting scales the deck up slightly with a deeper
   shadow; dragging past the pane's edge meets rubber-band resistance.
2. **Default corner is top-right.** While cards sit in the top-right corner, the conversation paper's
   toggle button (which lives in that corner) yields — **unless the paper is open**, in which case the
   button stays (it is the paper's close control, and the open paper covers the cards anyway).
3. **Several runs form a carousel deck.** The front card is centred in its slot and upright. The next
   run peeks out on the right, the previous on the left (signed position: `order[1]` is +1, the last
   is −1), at most two layers per side; deeper cards hide behind the second layer. Each layer out is
   slightly smaller, tilted outward (right side clockwise, left side anticlockwise, more per layer),
   plus a small fixed per-card random wobble; the content of cards behind the front one is faded. A
   new run lands at the front. Clicking any peeking edge brings that card to the front. A card that
   has to wrap from one side to the other re-enters from outside its new side (fading in) instead of
   sweeping across the front card.
4. **Hover belongs to the whole deck.** The pointer anywhere over the deck's box (with a few pixels of
   slack for the tilted corners) counts as hovering, whichever card is under it, so switching cards
   under a still pointer never drops hover — no flicker. While hovered:
   - the front card's header shows its controls (the `n/N` counter when there are several runs, stop,
     expand) **in place of** the read/write badge and elapsed time — they overlay that area with a
     fade, they do not reserve width when hidden;
   - two quiet round arrows appear inside the front slot's left and right edges, vertically centred on
     the **log area** (not the whole card). The arrows and two edge fades beneath them (about 30 px
     wide, in the card's own colour) belong to the deck, not to a card: they stay put while cards
     slide underneath. `‹` slides the deck left (the right-hand card comes to the front); `›` slides
     it right. With a single run there are no arrows and no edge fades.
   - While dragging, the arrows and edge fades are hidden.
5. **The collapsed card's log** uses the card's full width and flows top-down. Once full, the newest
   line stays at the bottom, each new line slides the block up by one line, and the oldest lines
   leave through a fade at the top edge; while not yet full, a new line fades in below the previous.
   Long lines end in an ellipsis; there is no left/right fade in the resting state.
6. **Appear and disappear** use a spring scale plus fade; remaining cards spring into their new
   places.
7. **Expand is a morph.** Clicking the front card or its expand button grows that same card, on a
   spring, from its slot into the panel rect (inset 24 px from the pane). For the first moments the
   card's rolling log is still visible and fades out; the full transcript is laid out at the panel's
   final size from the start and fades in once there is room, so it never reflows while the panel
   grows. The pane behind dims (25%) and the other cards step away (fade). Esc, the collapse button,
   or a click on the dimmed backdrop shrinks the panel back into the card's slot. The existing
   retain-after-end rule holds: a run that ends while expanded keeps its panel (final state, close ×)
   until the user closes it; the card then disappears.
8. **Reduced motion.** With the system's "reduce motion" on, every spring lands at its target
   immediately.
9. Scrollbars already use the app's global style (`apps/desktop/src/renderer/index.css:316`); the
   expanded panel's scroll area keeps inheriting it.

Out of scope, by the user's confirmation: remembering the chosen corner across pane remounts (a
remounted pane starts top-right again); redesigning the expanded panel's content (only the morph,
the dim and backdrop-click are new).

## Decisions & tradeoffs

- **Motion engine: hand-written springs in the renderer, no animation library.** A damped oscillator
  parameterised as SwiftUI's `(response, dampingRatio)`, stepped at a fixed 1/240 s substep; release
  corner from `position + velocity × decel/(1−decel)/1000` (iOS projection). Rejected: `motion`
  (framer-motion) / `react-spring` — a new dependency whose spring model and drag projection would
  need the feel re-tuned from scratch, when the tuned numbers already exist in the demo, and the drag
  math (velocity sampling, projection) has to be custom either way. Based on: no animation library
  in `apps/desktop/package.json`; the demo's `Spring` class and `projected()`.
- **Parameters are the demo's `DEFAULTS`, as named constants.** `response 0.42 / damping 0.8`
  (return), `decel 0.997` with an 80 ms velocity window (throw), `grabScale 1.03`, rubber band on,
  `enterResponse 0.32 / enterDamping 0.78 / enterFrom 0.88`, `peek 10 px / scaleStep 0.06 / tilt 3° /
  jitter 1.5° / backDim 0.8`, `switchResponse 0.36 / switchDamping 0.86`, `expandResponse 0.42 /
  expandDamping 0.88 / dim 0.25 / inset 24 px`, deck margin 16 px, card width 320 px, hover slack 8 px,
  two visible layers per side. The user confirmed the defaults, not tuned values. Rejected: a
  runtime settings surface for these — nobody asked for it.
- **Per-frame motion bypasses React.** Position, scale, rotation and opacity are written to element
  styles from a `requestAnimationFrame` loop via refs; React renders card content only. The loop
  stops when every spring has settled and restarts on the next input. Rejected: React state per frame
  — re-rendering the deck (and every card's transcript subtree) at 60–120 Hz; and an always-running
  loop — a pane with a card must not burn frames while idle.
- **The deck owns layout and interaction state; cards own their run.** Order (front first), all
  springs, the corner, hover and drag live at deck level. The switch arrows and edge fades are one
  deck-level overlay positioned over the front slot. The header controls (counter, stop, expand)
  stay on each card, because stop targets that card's run. Rejected: arrows inside each card — they
  change owner on every switch, which is exactly the flicker the user rejected.
- **Hover is computed from the pointer against the deck's box, not from `:hover`.** Rejected: CSS
  `:hover` on cards — it flips as cards slide under a still pointer. Based on: the card layer's root is
  `pointer-events-none` (`executor-run-card.tsx:133`), so the listener cannot live on it. It lives
  either on the pane root next to its existing `onPointerDownCapture` (`terminal-pane.tsx:993`) or on
  `window` filtered by the pane's rect — the executor's call, both are in scope. Either way it is
  cleared on `pointerleave`/window `blur`, and it is re-evaluated **both on pointer events and on
  every animation frame** (the deck slides under a still pointer), which the demo gets for free from
  a loop that never stops and the real loop does not `(revised on plan audit)`.
- **Expanding morphs one element; the collapsed/portal switch goes away.** The expanded panel is the
  card's own element animating its rect between the card's current slot and the inset rect, with the
  transcript laid out at the final size. Rejected: keeping `ExecutorPanel` as a separate portal that
  pops in — no morph is possible, which is the point of this change. Preserved behaviour, each with
  its current anchor: Esc taken on the window capture phase and only by the focused pane
  (`executor-run-card.tsx:117-128`), `onExpandedChange` so the pane yields its shortcuts
  (`terminal-pane.tsx:203,889,1084`), focus moved into the panel and back to the terminal on
  collapse, retain-after-end (`executor-run.ts` `retainAfterEnd`). Two consequences of no longer
  mounting a fresh panel `(revised on plan audit)`: focus is moved into the panel **when expansion
  starts** — today it happens in a mount-only effect (`executor-run-card.tsx:504-506`), which a morph
  never re-runs, leaving focus on the card so a later Esc could reach the shell; and per-expansion
  view state (the prompt fold, stick-to-bottom) starts fresh on each expansion as it does today. The
  full transcript view (markdown, per-fragment entries) is **mounted when expansion starts and
  unmounted when the collapse spring settles**; "laid out at the final size" means its width/height
  are the panel's target size during the morph, not that it exists while collapsed.
- **The paper button yields through a callback, like `onExpandedChange`.** The card layer reports
  whether live cards occupy the top-right corner; `TerminalPane` passes
  `buttonHidden = searchOpen || cardsTopRight` to `TerminalPaper`. The paper already keeps its button
  while open (`terminal-paper.tsx:201`: `showButton = props.open || !props.buttonHidden`), so the
  "unless the paper is open" rule needs no extra term `(revised on plan audit)`. Rejected: moving
  the paper button, or hiding it while the paper is open (it is the paper's close control). Based on:
  `terminal-paper.tsx:201,245` (button at `right-4 top-2 z-50`), `terminal-pane.tsx:1070`.
- **The ⌘F search box sits above the deck** `(decided while planning)`. With the default now
  top-right, the search box (`terminal-pane.tsx:1011`, `right-4 top-2 z-20`) would otherwise open
  underneath the cards (`z-30`). A user-opened, transient control wins over an ambient card. Rejected:
  hiding or moving the deck while searching — more motion for no gain.
- **A card no longer unmounts itself; the deck decides when it leaves** `(revised on plan audit)`.
  Today a card returns `null` on its own when its run ends (`executor-run-card.tsx:230`), and the
  `ended` half of that signal lives only in the card's private transcript state
  (`executor-run-card.tsx:187,192-215`) — the deck cannot see it, so it cannot animate an exit. The
  card reports its end upward (a callback beside `onExpand`); the deck keeps a *leaving* set with a
  retained `ExecutorRunState` snapshot for each leaving run (generalising today's `lastSeen`, which
  covers only the expanded run, `executor-run-card.tsx:98-106`), keeps the leaving card mounted —
  subscription intact — until its exit spring settles, then drops it. Either signal (worker `ended` or
  centre drop) starts the exit; an expanded run is not leaving until its panel is closed and has
  shrunk back. Rejected: lifting the transcript into the deck — every fragment would re-render every
  card.
- **Hidden panes do not animate** `(revised on plan audit)`. An inactive tab's pane is `display:none`
  (`terminal-pane.tsx:991`) while the card layer stays mounted (`terminal-pane.tsx:1076-1077`), so
  its rect is 0×0. A zero-sized pane never retargets the deck, and when its size comes back from zero
  the deck is placed at its corner immediately (snap, no spring). Rejected: the demo's
  retarget-on-every-resize — it would compute negative targets while hidden and fly the deck in from
  off-screen on every tab switch.
- **The card layer clips to its pane** `(revised on plan audit)`. The demo's pane has
  `overflow: hidden`; the app's pane root (`terminal-pane.tsx:990`) and card layer root
  (`executor-run-card.tsx:133`) clip nothing, so a rubber-banded or tilted card would paint over a
  neighbouring split pane or the tab strip. The card layer's root clips.
- **The collapsed card's chrome follows the demo** `(decided while planning)`. The user approved the
  demo's card layout after asking for alignment fixes: a 36 px header on a grid of status glyph /
  title / right cluster, the log at the card's full width, four 18 px lines. Today's header is `h-8`
  (`executor-run-card.tsx:432`). Positions derived from the card's geometry (arrow centre on the log
  area, edge-fade band, the morph's source rect) are computed from the app's real card geometry, not
  copied from the demo's pixel constants. Colours and radii come from the app's tokens, not the
  demo's hex values.
- **Secret request cards sit above the deck** `(decided while planning)`. They live bottom-right at
  `z-30` (`secret-request-card.tsx:36`), the same layer as the deck; a request waiting on the user's
  answer must never be covered by an ambient card thrown into that corner.
- **Tooltips, not `title`.** The arrows and any new icon buttons use `@astryxdesign/core/Tooltip`.
  Based on: `docs/design-guidelines.md` ("Hover hints: use `Tooltip`, not native `title`"); the demo
  uses `title` only because it is a throwaway page.
- **Reduced motion is honoured in JS.** The global CSS rule (`index.css:208`) only shortens CSS
  transitions/animations; the springs need an explicit `matchMedia("(prefers-reduced-motion:
  reduce)")` check that snaps them. Precedent: `clawd-glyph.tsx:213`.
- **Tests: update the existing pure-logic tests, add none by habit.** `DEFAULT_EXECUTOR_CORNER`
  becomes `top-right`; its midline tie-break comment and the `snapCorner` cases in
  `executor-run.test.ts:44-50` change with it. A small pure helper (projection, signed carousel
  position) may get a test only if it is easy to get wrong; the motion itself is accepted by hand.
  Based on: `AGENTS.md` "Test harness" (do not grow tests for what you would notice using the app).

## Direction

The work is renderer-only, inside the executor card layer and its two touch points in the terminal
pane. No protocol, client-store, server or daemon change. The run's existence still comes from the
centre snapshot and its content from the device-channel transcript subscription, exactly as now.

### Milestone 1: The deck moves — spring drag, throw to a corner, carousel, deck hover

Everything in Requirement items 1–6 and 8 for the collapsed state: the deck starts top-right,
follows the pointer, throws to a corner with velocity projection and springs home; several runs form
the carousel with peeks, tilt, wobble and dimmed back content; the deck-level overlay carries the
arrows and edge fades with `‹` sliding left; header controls overlay the badge/time on deck hover;
the rolling log flows top-down with the top fade; cards spring in and out; reduced motion snaps. The
paper button yields per the callback rule and the search box layers above the deck. Validation:
`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

### Milestone 2: Expanding morphs

Requirement item 7: the front card morphs into the inset panel and back, with the dim backdrop
(click to collapse), the other cards stepping away, the crossfade from rolling log to the
full-size transcript, and every preserved behaviour listed under Decisions (Esc capture on the
focused pane, shortcut yielding, focus hand-off, retain-after-end with the close ×). Validation:
`pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

Milestone 2 depends on Milestone 1 (it animates from the deck's slot geometry and reuses its spring
and loop). Both milestones edit `executor-run-card.tsx`: **one sequential work package — do not fan
out.**

## Landmines

- **The card layer's root is `pointer-events-none`** (`executor-run-card.tsx:133`) and sits over the
  xterm host; only cards themselves are `pointer-events-auto`. Deck hover must not turn the whole
  pane into a pointer target (that would steal clicks and selection from the terminal), and it must
  not be computed from an element that never receives events.
- **Split panes**: each pane mounts its own `ExecutorRunCards`; hover, Esc and the backdrop belong to
  that pane only. Esc is already gated on `focused` — keep it that way; the backdrop must cover the
  pane, never the window.
- **Layering against the paper and search**: the paper sits at `z-40` with its button at `z-50`
  (`terminal-paper.tsx:245`); the expanded panel slot is `z-40` today (`executor-run-card.tsx:150`);
  the search box is `z-20` (`terminal-pane.tsx:1011`); secret request cards are `z-30`
  (`secret-request-card.tsx:36`). The backdrop and panel stay below the paper's button but above the
  terminal; the search box and secret request cards end up above the collapsed deck.
- **Buttons inside a draggable card** stop `pointerdown` propagation today
  (`executor-run-card.tsx:331,443`) so a click is not taken as a drag start; header controls keep
  that. The overlay arrows are not inside a card, so they cannot start a drag; what they need is the
  overlay root `pointer-events-none` with only the buttons `pointer-events-auto`, so the overlay
  never blocks the card under it. A click on a *peeking* card is "bring to front", not "expand".
- **Collapsed card ends on either signal** (`retainAfterEnd`: the worker's `ended` batch or the
  centre dropping the run). With the deck, a card leaving must spring out and the rest re-flow; an
  expanded card must stay until closed and then shrink back into its slot before disappearing.
- **The transcript subscription lives in the card component** (`executor-run-card.tsx:192-215`).
  Keep one subscription per run for the card's whole life; the morph must not remount the card (a
  remount re-subscribes from seq 0 and re-renders the whole transcript).
- **`React Compiler` is on** (`babel-plugin-react-compiler` in `apps/desktop/package.json`): mutable
  animation state belongs in refs, not in values the compiler will memoise.
- **No React `style` prop on an element the loop animates** `(revised on plan audit)`. Today the card
  sets `style={dragging ? {…} : undefined}` (`executor-run-card.tsx:411`), and `useElapsed`
  re-renders every card once a second (`executor-run-card.tsx:265-274`); a React-managed `style`
  (or a `className` that sets `transform`/`opacity`) on an animated element is rewritten on the next
  render and fights the loop. Animated elements carry no React `style`, or only a frozen constant.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/executor-run-card.tsx`
- `apps/desktop/src/renderer/components/workbench/executor-run.ts` and `executor-run.test.ts`
- a new sibling module for the spring/deck motion, if the executor wants one
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` — only the paper
  `buttonHidden` wiring, the new callback, the search box's layer, the secret-card layer, and (if the
  executor chooses it) a pointer-move listener on the pane root for deck hover
- `apps/desktop/src/renderer/components/workbench/secret-request-card.tsx` — only its layer, if it
  cannot be raised from `terminal-pane.tsx`
- `apps/desktop/src/renderer/components/workbench/terminal-paper.tsx` — only if the button's hide
  rule cannot be expressed through the existing `buttonHidden` prop
- `wiki/plans/20260930-executor-pip-motion.md`, `wiki/plans/20260930-executor-pip-motion.demo.html`,
  `wiki/plans/README.md`

Out of scope:
- `packages/client`, `packages/protocol`, `apps/server`, `crates/*` — no data or wire change is needed
- the expanded panel's content layout and the transcript renderers (`FragmentEntry`, `ToolEntry`,
  `EndEntry`) — unchanged by the user's scope cut
- persisting the corner — explicitly deferred
- the sidebar's executor indicator

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (fresh worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod`, then in a terminal of that app ask an agent (or run) `coflux executor run --title="…" --prompt="…"`, twice or three times in parallel read-only | cards behave as in the demo |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] A new pane's first card appears top-right; the paper button is hidden while cards are there and
      the paper is closed, and visible again when cards move away or the paper opens.
- [ ] Dragging follows the pointer; a flick picks the corner in the flick's direction; release springs
      home with the release velocity; the deck can be caught mid-flight.
- [ ] With 2–3 runs the deck shows left/right peeks with tilt; `‹` brings the right-hand card forward;
      hovering stays on while switching (no flicker); clicking a peek brings it forward.
- [ ] Expand grows the card into the panel and collapse shrinks it back into the slot; Esc (focused
      pane only), the collapse button and a backdrop click all collapse; a run ending while expanded
      keeps the panel until closed.
- [ ] With reduce-motion on, nothing animates but every state is still reachable.
- [ ] Switching tabs away and back, dragging a split divider, and resizing the window leave the deck
      sitting in its corner — no fly-in from off-screen, no card painting outside its pane.
- [ ] A run ending (by either signal) springs its card out and the rest re-flow; a run ending while
      expanded keeps its panel until closed, then shrinks back and leaves.
- [ ] Expanding and collapsing do not create a new `subscribeExecutorTranscript` call for that run
      (one subscription per run for the card's whole life), and Esc after expanding never reaches the
      shell.
- [ ] No card causes a continuously running animation loop while nothing moves.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example the paper button moved, or
  the card layer is no longer `pointer-events-none`).
- The outcome requires changing `packages/client`, the protocol, the server or the daemon.
- A validation command fails twice after one reasonable fix.
- Achieving the morph would require remounting the card component (and so re-subscribing the
  transcript).

## Maintenance notes

- The demo file is the feel reference for future tuning: change a number there, feel it, then carry
  the constant over. It deliberately uses `title` tooltips and hard-coded colours; do not copy those.
- The executor card has no automated rendering coverage; any later change to its motion needs a hand
  walkthrough with several concurrent runs.
