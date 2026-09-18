# Plan 20260918-desktop-cmd-keys-native-menu: ⌘ keys belong to the app, not to the terminal

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 392387f4..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts apps/desktop/src/main/menu.ts apps/desktop/package.json`

## Status

- Priority: P1
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — departure check; the review ran and its findings are folded in (the ⌘A regression it caught changed the rule from a boolean to a three-way decision)
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260918-desktop-cmd-keys-native-menu` on `dev/20260918-desktop-cmd-keys-native-menu`
- Planned at: `392387f4`, 2026-09-18

## Requirement

Since 2.1.0, ⌘C and ⌘V do nothing inside an agent TUI such as Claude Code, and
⌘V additionally **types a literal `v` into the TUI**. In a plain shell in the
same app both keys still work. The owner hit this the day 2.1.1 landed.

The cause is not the menu and not the clipboard code. It is that the terminal
now swallows ⌘ keys before the application ever sees them:

- 2.1.0 turned on the kitty keyboard protocol
  (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:240`,
  `vtExtensions: { kittyKeyboard: true }`, introduced with the xterm
  6.0 → 6.1.0-beta.304 move in `5a6c2d1a`). The protocol is what lets a TUI
  distinguish Shift+Enter, and it is **negotiated at runtime by the program in
  the PTY** — Claude Code negotiates it, a plain shell does not. That is exactly
  why the bug is TUI-only.
- Once negotiated, xterm encodes **every** key as a CSI u sequence and treats
  `metaKey` as the kitty SUPER modifier bit (`KittyKeyboard.evaluate`, shipped
  xterm sources: `src/common/input/KittyKeyboard.ts:212`), then calls
  `preventDefault()`.
- A key the page consumes never flows back to the browser, so the accelerators
  on the native 「编辑」 menu's `role: "copy"` / `role: "paste"` items never
  fire (`apps/desktop/src/main/menu.ts:60-70`). The menu itself is intact and
  unchanged since plan 103 — it is starved of events, not broken.
- Claude Code receives the CSI u sequence for `v` with the SUPER bit set,
  ignores the modifier and inserts `v`.

The blast radius is wider than the two keys the owner noticed: every native
editing shortcut is affected inside a kitty-negotiating TUI — ⌘X, ⌘Z, ⌘A would
likewise arrive as bare `x`, `z`, `a`. **⌘R is in the same boat**: plan
`20260918-desktop-reload-shortcut` gave the packaged app a `role: "reload"`
item, and inside a kitty-negotiating TUI that accelerator is starved the same
way — reloading the window from inside Claude Code does not work today either.
That is the cheapest prediction to falsify this diagnosis with (see Maintenance
notes).

What is true when this is done:

- In a TUI that negotiates the kitty protocol, ⌘C copies the terminal selection
  and ⌘V pastes, exactly as they do in a plain shell today, and **no stray
  character reaches the program in the PTY**.
- ⌘X / ⌘Z / ⌘R likewise reach the native menu rather than the TUI.
- **⌘A still selects the terminal buffer** — in a plain shell exactly as it does
  today, and in a kitty TUI as well, where it currently types an `a`. This is
  the one ⌘ key that keeps a terminal-side effect; see its decision below.
- Shift+Enter and the rest of the kitty protocol keep working: the protocol
  stays enabled, only ⌘ combinations are withheld from the terminal.
- Keys the workbench already owns (⌘T, ⌘W, ⌘N, ⌘[, ⌘], ⌘1-9, ⌘,, ⌘/, ⌘F,
  ⌘↑, ⌘↓) behave exactly as before — they never reach xterm in the first place.
- Ctrl-prefixed keys are untouched: Ctrl+C still interrupts, Ctrl+D still sends
  EOF, and with the kitty protocol active they still go out as CSI u sequences.

This is a restoration, not a new feature: it returns the app to its 2.0.2
behaviour for ⌘ keys while keeping what 2.1.0 gained.

## Decisions & tradeoffs

- **Where the fix sits**: `attachCustomKeyEventHandler` on the xterm instance,
  returning `false` for the keys the terminal must not consume. Rejected:
  another `window` capture-phase listener alongside the two that exist — a
  capture listener would have to re-implement "let the native menu have it",
  and its `preventDefault`/`stopPropagation` idiom is the opposite of what is
  needed here. Based on: xterm runs the custom handler as the first statement
  of `CoreBrowserTerminal._keyDown` and returns immediately when it yields
  `false`, so neither the kitty encoder nor `preventDefault()` runs; the
  un-prevented event then flows back to the browser, which is what lets a menu
  accelerator match. `attachCustomKeyEventHandler` is currently unused in the
  codebase — only named in a comment at
  `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts:25`.

- **Which keys are withheld from the terminal**: every key event with
  `metaKey` set and neither `ctrlKey` nor `altKey` set — **the whole class, not
  a ⌘C/⌘V allowlist**. Rejected: handling only ⌘C and ⌘V — it would leave
  ⌘X/⌘Z/⌘R broken in exactly the same way and guarantee a second round of this
  bug report. `shiftKey` is deliberately **not** excluded: ⇧⌘ is equally an
  application-level layer on macOS and the menu already registers ⇧⌘W
  (`apps/desktop/src/main/menu.ts:56`). `ctrlKey` and `altKey` are excluded
  because Ctrl and ⌥ carry terminal semantics (Ctrl+C, and ⌥ as the Meta/ESC
  prefix) that the TUI must keep receiving.

- **⌘A keeps selecting the terminal buffer** *(revised on advisor review)*: the
  rule is not a plain boolean. ⌘A — `metaKey`, no Ctrl, no ⌥, **no Shift** —
  first calls the terminal's public `selectAll()` and only then yields to the
  menu; every other ⌘ combination yields immediately. Rejected: folding ⌘A into
  the plain yield case — that would be a **regression in a plain shell**, where
  ⌘A works today. Based on: xterm's legacy encoder maps exactly that modifier
  shape to `KeyboardResultType.SELECT_ALL` (shipped sources
  `src/common/input/Keyboard.ts:360-363`, identical in 6.0.0 and
  6.1.0-beta.304), and `_keyDown` runs `selectAll()` for it **without**
  cancelling the event — so in 2.0.2, and in a non-kitty shell today, ⌘A both
  selects the buffer and reaches the native `role: "selectAll"`. Yielding after
  `selectAll()` reproduces that pair exactly. `selectAll()` is public API,
  already used by the context menu (`terminal-pane.tsx:810`). ⇧⌘A is not
  special-cased, matching the upstream condition.

- **The rule reads modifiers only, never the event type** *(revised on advisor
  review)*: the same decision applies to `keydown`, `keyup` and `keypress`.
  Rejected: guarding on `event.type === "keydown"` — xterm calls the custom
  handler from `_keyUp` and `_keyPress` as well, and a TUI that negotiated the
  kitty `REPORT_EVENT_TYPES` flag would then receive a release event for a key
  whose press it never saw.

- **Deliberate departures from 2.0.2** *(revised on advisor review)*: ⌘Enter,
  ⌘⌫ and ⌘Esc used to reach the program as plain CR / DEL / ESC — the legacy
  encoder ignored the ⌘ and sent the base key (`Keyboard.ts:84-115`). Under this
  rule they yield to the menu, which has no item for them, so they become
  no-ops. Accepted rather than special-cased: nothing in this app depends on
  them, and "⌘ does not reach the terminal" is the macOS convention. Flag them
  as intended if they come up during the walkthrough.

- **The kitty protocol stays on**: `vtExtensions: { kittyKeyboard: true }` is
  not touched. Rejected: disabling it to make the bug go away — it is what
  encodes Shift+Enter and similar combinations for the TUI, which is the reason
  2.1.0 enabled it (`terminal-pane.tsx:237-240`).

- **The native menu keeps ownership of copy and paste**: the fix restores the
  path through `role: "copy"` / `role: "paste"`; the renderer does not take the
  keys over itself. Rejected: binding ⌘C/⌘V to the existing `copySelection` /
  `pasteFromClipboard` functions
  (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:751-763`)
  — that is the right-click menu's path, it would fork clipboard behaviour into
  two mechanisms with different failure modes, and it would still leave
  ⌘A/⌘X/⌘Z needing the yield rule. Those two functions and the context menu
  stay exactly as they are.

- **No platform branch** *(decided while planning)*: the condition is written
  on `metaKey` alone, with no `isMac` guard. The app is packaged for macOS only
  (`apps/desktop/package.json:15-16`, `electron-builder --mac`), and on the
  other platforms `metaKey` is the Super/Win key, which carries no terminal
  semantics either. A platform branch would be untestable dead weight here.

- **The rule lives in its own `.ts` module with a sibling `.test.ts`**
  *(decided while planning; tightened on advisor review)*: a pure function over
  the modifier flags, returning the three-way decision, imported by
  `terminal-pane.tsx`. Not the executor's call, and **not an exported function
  inside `terminal-pane.tsx`**: the desktop test script globs `*.test.ts` only
  (`apps/desktop/package.json:13`), and `terminal-pane.tsx:7` imports
  `@xterm/xterm/css/xterm.css`, which Node cannot load — anything imported from
  that file into a unit test crashes the run. Every existing test in this
  directory imports from a `.ts` sibling for exactly this reason
  (`terminal-ime-patch.ts`, `terminal-fit.ts`, `osc52-clipboard.ts`).

## Direction

A new rule module plus its test, and the wiring in `terminal-pane.tsx`. One
milestone. Nothing here is independent: do not fan out.

The xterm instance created in `terminal-pane.tsx:201` gets a custom key event
handler whose only job is to apply the rule: yield (`false`) for the ⌘ class,
`selectAll()` then yield for ⌘A, and let xterm proceed for everything else, so
the kitty encoder, the IME patch (`applyImeCommittedInputPatch`,
`terminal-pane.tsx:440`) and ordinary typing are unaffected. Keep the handler
itself thin enough to read at a glance — the decision belongs to the pure
function, not to the closure.

### Milestone 1: ⌘ keys reach the native menu from inside a kitty-negotiating TUI

After this milestone the rule function exists in its own module, is covered by
unit tests asserting every branch (⌘ combinations yield, including a ⇧⌘ case
and a `keyup` case; ⌘A returns the select-all decision; Ctrl-, ⌥- and
unmodified keys reach the terminal), and is wired into the terminal instance.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0, and
`pnpm -C apps/desktop test` -> exit 0 with the new cases included.

## Landmines

- **The two existing capture-phase shortcut listeners run before xterm and are
  not part of this fix**: `use-global-shortcuts.ts:107` (⌘T/⌘W/⌘N/⌘[/⌘]/⌘1-9,
  ⌘, and ⌘/) and `terminal-pane.tsx:794` (⌘F, ⌘↑, ⌘↓) both listen on `window`
  with `{ capture: true }` and call `preventDefault()` + `stopPropagation()`.
  Those keys therefore never reach the xterm handler at all. Do not duplicate
  them in the yield rule and do not "fix" them — they already work.

- **`preventDefault()` in the custom handler would defeat the whole fix**: the
  native accelerator can only match an event the page left unhandled. The
  handler must yield by returning `false` and nothing else.

- **xterm compares the return value with `=== false`**: the signature is
  `(event: KeyboardEvent) => boolean`
  (`@xterm/xterm/typings/xterm.d.ts:1202`). A handler that falls off the end
  returning `undefined` does **not** yield — it silently lets xterm proceed, and
  the bug looks unfixed. Typecheck catches the shape, not the intent.

- **Three comments in this repository state the opposite mechanism, and they
  are wrong on macOS**: `menu.ts:12-14`, `menu.ts:78` ("主进程注册的
  accelerator 优先于页面，终端抢不走它") and `shortcut-modifier.ts:1-4` all
  describe main-process accelerators as winning over the page. The evidence says
  otherwise. Electron documents `before-input-event` as firing "before
  dispatching the `keydown` and `keyup` events in the page", where
  `preventDefault` "will prevent the page `keydown`/`keyup` events **and the
  menu shortcuts**", with `setIgnoreMenuShortcuts` offered to suppress only the
  latter (`electron.d.ts:16125-16130`, electron 44.3.0) — page and menu sit on
  one interruptible chain, menu last. And `registerAccelerator` is documented
  `@platform linux,win32` (`electron.d.ts:22440-22442`), so it does nothing on
  macOS: those menu items have had their accelerators registered all along, and
  they avoid double-firing only because the capture-phase listeners call
  `preventDefault()` first. This bug is itself the third piece of evidence. Do
  **not** read those comments as grounds to stop, and do not rewrite them here —
  `menu.ts` is out of scope.

- **The copy path needs a selection to exist**: xterm's `copy` listener is
  guarded by `hasSelection()` (shipped sources: `CoreBrowserTerminal.ts:370-373`),
  and a fullscreen TUI holding mouse tracking suppresses plain drag-selection.
  The gesture in that case is ⌥+drag, already enabled by
  `macOptionClickForcesSelection: true` (`terminal-pane.tsx:209`). ⌘C over an
  empty selection legitimately does nothing — that is not a regression of this
  plan.

- **⌘V keeps flowing through the image-paste interceptor**: `handlePaste` is
  attached on the host element in the capture phase and only acts on
  `image/*`, leaving text to xterm (`terminal-pane.tsx:556-593`). Keyboard image
  paste therefore comes back with the native paste role — that is the 2.0.2
  behaviour returning, not a new capability to suppress.

- **`terminal.reset()` keeps the handler attached** — it is explicitly carried
  across the internal re-setup (shipped sources
  `CoreBrowserTerminal.ts:1106,1115`). Gap recovery resets the terminal (see the
  note at `terminal-pane.tsx:237-240`), so this matters: do not add
  re-attachment logic on recovery, it would only stack handlers.

- **`macOptionIsMeta` is not set**, so ⌥ never surfaces as `metaKey` — the
  `altKey` exclusion in the rule is about the ⌥ key itself, not about a Meta
  aliasing mode.

- **The bug is invisible to every automated gate.** Nothing in the desktop
  suite drives a real xterm against a kitty-negotiating program, and the
  renderer has no UI test tier. Unit tests pin the predicate; the actual
  restoration is confirmed by hand, by the owner.

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` (wiring
  only)
- a new rule module and its test under
  `apps/desktop/src/renderer/components/workbench/`
- `wiki/plans/README.md` (status row)

Out of scope:
- `apps/desktop/src/main/menu.ts` — the menu is correct as it stands; no item,
  role, label or accelerator changes.
- `copySelection` / `pasteFromClipboard` and the right-click menu
  (`terminal-pane.tsx:751-820`) — unchanged.
- `vtExtensions` / the kitty protocol, the OSC 52 handler, the IME patch, the
  selection and mouse-tracking behaviour — all stay as they are.
- The terminal tab title showing `Claude Code` instead of Claude Code's own
  task summary — the owner reports it as intermittent and the evidence is not
  in hand. Recorded under Maintenance notes; explicitly not fixed here.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Real-machine walkthrough (acceptance) | desktop dev preview, `desktop-preview` skill | the owner confirms, inside Claude Code: ⌘C copies an ⌥+drag selection, ⌘V pastes with no stray character, ⌘A selects the buffer, ⌘R reloads; and in a plain shell that ⌘C/⌘V/⌘A are unchanged |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] A ⌘ key event with no Ctrl and no ⌥ is withheld from xterm; Ctrl-prefixed,
      ⌥-prefixed and unmodified keys still reach it — both directions asserted
      by unit tests.
- [ ] Unit tests additionally assert: a **⇧⌘** combination yields (copying
      `use-global-shortcuts.ts:47`'s shift-excluding prefix would pass every
      other case and still leave ⇧⌘ broken), a **`keyup`** event yields on the
      same rule, and **⌘A** returns the select-all decision while ⇧⌘A does not.
- [ ] `grep -n "preventDefault\|stopPropagation"` over the new module and the
      new handler returns nothing.
- [ ] The rule lives in a `.ts` module with a sibling `.test.ts`; nothing is
      imported from `terminal-pane.tsx` into a test.
- [ ] `vtExtensions: { kittyKeyboard: true }` is still set, and no menu item,
      clipboard function or context-menu entry changed.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular, the
  custom handler no longer short-circuits `_keyDown`, the kitty encoder no
  longer runs behind it, or xterm's legacy encoder no longer maps ⌘A to
  `SELECT_ALL`.
- Making ⌘ keys work would require touching the native menu or the clipboard
  functions this plan puts out of scope.
- `pnpm -C apps/desktop test` or `typecheck` fails twice after one reasonable fix.

## Maintenance notes

- **The cheapest way to falsify the whole diagnosis**, if it is ever doubted:
  in 2.1.x, press ⌘R inside Claude Code. Under this plan's model the kitty
  encoder eats it and the window does not reload; if it *does* reload, then
  "a page-consumed key starves the menu accelerator" is wrong and the fix needs
  rethinking rather than adjusting. Nothing in the plan depends on running this
  first — it is the tie-breaker if the walkthrough surprises someone.
- **This is an xterm-upgrade tripwire.** The fix depends on
  `attachCustomKeyEventHandler` running first in `_keyDown` and on a `false`
  return suppressing the kitty encoder. The next time the xterm beta cohort
  moves, re-check both — together with the internals drift test in
  `terminal-ime-patch.test.ts`, which already guards the neighbouring patch.
- **The kitty protocol takes every key it is given.** Any future key the
  workbench wants to own must either be withheld here or intercepted in the
  capture phase; adding a plain bubble-phase listener will not work while a TUI
  has the protocol negotiated.
- **Open, not fixed: the terminal tab title.** The owner reports tabs showing
  `Claude Code` rather than Claude Code's generated task summary, intermittently.
  Two candidates, both unverified: (a) 2.1.0's supervisor injects
  `TERM_PROGRAM=coflux` (`crates/supervisor/src/sessions.rs:59`) and `SSH_TTY`
  (`1b92415d`), either of which an agent CLI may branch on — and because the
  supervisor does not take a hot upgrade, only terminals opened after a runtime
  restart carry them, which would explain the intermittency; (b) Claude Code's
  own title behaviour, unrelated to coflux. Evidence to collect on the next
  occurrence: `echo $TERM_PROGRAM` in the affected terminal — `coflux` points at
  (a), empty points at (b). Titles reach the tab via the supervisor's OSC
  capture (`crates/supervisor/src/sessiond.rs:228-253`) and the session
  checkpoint, rendered at
  `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:431`.
