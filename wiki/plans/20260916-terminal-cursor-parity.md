# Plan 20260916-terminal-cursor-parity: Desktop terminal feel on par with Cursor

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- apps/desktop/src/renderer/components/workbench apps/desktop/src/main/index.ts apps/desktop/package.json crates/supervisor/src/sessions.rs crates/supervisor/src/sessiond.rs crates/supervisor/src/main.rs`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: dx
- Execution: subagent(opus) — departure check, 2026-09-16
- Stop after: implementation — departure check autopilot item (advisor review, then execute)
- Plan review: advisor — departure check autopilot item
- Workspace: isolated — cut from the main worktree at plan time
- Planned at: `ebca9085`, 2026-09-16

## Requirement

The desktop terminal feels worse to use than Cursor's. An advisor pass compared
our implementation against the Cursor build installed on this machine
(`/Applications/Cursor.app`, a VS Code 1.128.0 fork) and reduced that subjective
complaint to a list of concrete, verified mechanical differences.

Two findings reframe the problem and must not be undone by this work:

- **Cursor has no local echo or typeahead.** `localEcho`, `typeAhead` and
  `latencyThreshold` all have zero hits in its bundle, and no
  `terminal.integrated.localEcho*` setting exists. Its responsiveness comes from
  a two-process, one-IPC-hop data path, not from predicting keystrokes. We must
  not introduce prediction in the name of parity.
- **WebGL is already at parity.** Cursor defaults `gpuAcceleration` to `"auto"`
  and falls back to DOM; we already load `WebglAddon` dynamically, handle
  `onContextLoss`, and keep the DOM renderer when it fails
  (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:234-247`).
  Nothing to do here.

What is true when this is done: a user typing in a coflux terminal gets a UTF-8
locale and truecolor-capable environment; emoji-heavy TUIs (Claude Code above
all) render at the right cell widths without cursor drift or trailing garbage;
modifier-key combinations such as Shift+Enter reach the application; resizing the
window does not storm the PTY with SIGWINCH; ⌘F, a right-click menu, OSC 52
clipboard and file-path links exist; command boundaries our shell integration
already emits become navigable in the UI; and high-throughput output is less
likely to overflow into a gap-and-repaint.

This is a feel change the user perceives directly. Acceptance is a real-machine
walkthrough by the user; this repository does not ask agents to verify UI.

## Decisions & tradeoffs

- **Session shells get an explicit UTF-8 locale and color environment, not `-l`**:
  inject `LANG` (and `COLORTERM`, `TERM_PROGRAM`) explicitly when absent.
  Rejected: switching to a login shell (`zsh -l`) the way Cursor does — it would
  additionally run the user's `.zprofile`, whose side effects we neither control
  nor want to inherit into agent sessions, and
  `crates/supervisor/src/shell/zprofile.zsh` documents the non-login shell as a
  deliberate property of our model. Based on: `crates/supervisor/src/sessions.rs:855-858`
  copies `std::env::vars()` and then overrides only `TERM`/`COFLUX_HOME`/`PATH`/`COFLUX_*`;
  measured in a live coflux terminal on this machine: `LANG=[]`, `COLORTERM=[]`,
  `LC_CTYPE="C"`.

- **Locale injection is all-or-nothing, in a fixed precedence** (revised on advisor review): check `LC_ALL`,
  then `LC_CTYPE`, then `LANG` in the supervisor's own environment. If **any** of
  the three is set, inject nothing and pass the parent's locale through verbatim —
  including a deliberately non-UTF-8 one such as `LANG=C`. Only when all three are
  empty does the supervisor inject a UTF-8 default. Rejected: unconditionally
  setting a fixed locale — it overrides a user who deliberately runs a non-UTF-8 or
  non-English locale. The bug being fixed is an *empty* locale, not a wrong one, so
  "preserve the parent locale" wins over "guarantee UTF-8" whenever the two
  conflict. Based on: `crates/supervisor/src` has zero mentions of `LANG` or
  `COLORTERM` today; both `C.UTF-8` and `en_US.UTF-8` exist in `/usr/share/locale`
  on macOS, so the default value is the executor's call between them.

- **Environment additions go after the `std::env::vars()` copy**: the same
  ordering constraint the existing `PATH` and `COFLUX_*` overrides document.
  Based on: `crates/supervisor/src/sessions.rs:858-880` — the comments state that
  writing before the copy lets the supervisor's own environment override them.

- **Upgrade the whole xterm stack to the 6.1 beta cohort**: `@xterm/xterm`
  `6.1.0-beta.304` plus `addon-fit 0.12.0-beta.301`, `addon-web-links 0.13.0-beta.301`,
  `addon-webgl 0.20.0-beta.300`, `addon-unicode11 0.10.0-beta.301`,
  `addon-search 0.17.0-beta.301`, `addon-clipboard 0.3.0-beta.303`. Rejected:
  staying on the 6.0.0 stable cohort — Unicode 11, search and OSC 52 are all
  available there (`unicode11@0.9.0`, `search@0.16.0`, `clipboard@0.2.0`), but the
  kitty keyboard protocol exists only from 6.1, and xterm addons are version-locked
  to the core, so kitty forces the whole cohort. The user chose kitty over staying
  on stable at the departure check. Tradeoff accepted: the terminal renderer runs
  on a beta dependency.

- **`allowProposedApi` flips to `true`** (revised on advisor review): required, not
  optional. The Unicode
  handling interface is marked `(EXPERIMENTAL)` in the typings
  (`apps/desktop/node_modules/@xterm/xterm/typings/xterm.d.ts:855-858`) and
  `allowProposedApi: false` makes any proposed-API use throw (ibid. `:27-32`).
  `addon-unicode11` calls `terminal.unicode.register` (`Unicode11Addon.ts:14`), so
  it cannot work while the flag is false — and the flag is currently explicitly
  `false` (`terminal-pane.tsx:189`). Note the narrow blast radius: `registerDecoration`
  does **not** check the proposed API in either 6.0.0 or the beta
  (`public/Terminal.ts:173-176`), so Milestone 7 does not depend on this flag.
  Consequence to accept knowingly: this opens the proposed API surface generally,
  so any future proposed-API use stops failing loudly at runtime.

- **All four visual defaults align to Cursor**: `lineHeight` 1.25 → 1,
  `cursorStyle` `bar` → `block`, `cursorBlink` true → false,
  `minimumContrastRatio` 1 → 4.5, and `rescaleOverlappingGlyphs` on. Rejected:
  keeping our line height and bar cursor as deliberate design choices — put to the
  user at the departure check, who chose full alignment. The font family is
  *not* changed: ours already resolves to Menlo in practice (`SFMono-Regular`,
  `Consolas` and `Liberation Mono` are all absent on macOS; the PostScript name of
  `/System/Library/Fonts/SFNSMono.ttf` is not reachable from CSS), which is exactly
  what Cursor uses.

- **Resize debouncing goes inside `controller.fit`, and only the expensive case is
  debounced** (revised on advisor review): a `fit()` on a small buffer stays
  immediate; column changes on a large buffer debounce. Rejected: a flat debounce on every `fit()` — it would add
  latency to the common cheap case (a fresh, near-empty terminal) for no benefit.
  Rejected: debouncing at the `ResizeObserver` callback — there are six `fit()`
  entry points, not one (mount rAF, WebGL load at `terminal-pane.tsx:245`, DPR
  change, the `[props.active]` effect, and `terminal-attach.ts:106,140,337`), so
  gating only the observer leaves the rest storming, while pushing the debounce
  into `controller.fit` covers all six without widening scope. The
  "deferred while not visible" third of Cursor's behavior **already exists** —
  `terminal-pane.tsx:255-263` returns early when `!active` or the host measures
  zero — so it is not work, only a property to preserve. No protocol change:
  `resizeSeq` already gives last-write-wins semantics
  (`packages/client/src/device-router.ts:2126-2140`).
  *Unverified*: Cursor's exact 200-line / 100ms constants — its
  `TerminalResizeDebouncer` is minified in the shipped bundle. Treat them as a
  starting point to tune, not as a specification to match.

- **Input during `attaching` is let through to the client, not queued in the
  renderer** (revised on advisor review): widen the pane's gate (`terminal-pane.tsx:287-289`) so keystrokes
  reach `sendInput` while attaching, and let the client's existing bounded
  retention carry them until the holder epoch lands. Rejected: building a queue in
  `terminal-pane.tsx` — the router already retains unacknowledged input with both a
  count and a byte bound (`packages/client/src/device-router.ts:2089-2110`, limits
  at `:72-73`), so a renderer-side queue would be a second, unbounded-by-default
  copy of a mechanism that exists. Known gap left open deliberately: `:2092`
  returns false when the session is `detached`, so a force-claim flow still drops
  those keys; closing that is client-side work outside this plan's scope, and the
  executor records it rather than fixing it here.

- **Output coalescing happens in the supervisor, near the PTY read**: merge PTY
  reads over a short window (Cursor uses 5ms) before emitting a `PtyOutput` frame.
  Rejected: coalescing in the worker or the client — the frame count is what
  pressures the worker's bounded channel, so merging must happen upstream of it.
  Based on: `crates/supervisor/src/sessions.rs:1173` reads 8KB and emits per read;
  `crates/worker/src/device.rs:33-38` bounds each channel at
  `CHANNEL_QUEUE_RECORDS = 256` *and* `CHANNEL_QUEUE_BYTES`, so record count is a
  real and independent overflow dimension.

- **Backpressure stays gap-based; only its frequency and its blast radius are
  reduced**: no pause-based flow control. Rejected: Cursor's model (pause the PTY
  above 100000 unacknowledged characters, never drop). On a relay link, pausing the
  PTY binds the writing process to the network RTT, which is a worse failure than a
  repaint. The gap → snapshot → `terminal.reset()` path is the correct fallback for
  our architecture and is out of scope to change.

- **The snapshot history limit rises toward the client's scrollback**: raise
  `DEFAULT_HISTORY_LINE_LIMIT` from 2_000 so a gap recovery does not truncate a
  10_000-line scrollback to 2_000. Rejected: leaving it — every gap silently costs
  the user 80% of their scrollback. The executor picks the value against memory
  cost per session and keeps the existing env override and its tests working.
  Based on: `crates/supervisor/src/main.rs:54` and `:62`; xterm `scrollback: 10_000`
  at `terminal-pane.tsx:194`.

- **OSC 133 is consumed in the renderer only; the supervisor is untouched**
  (citation corrected on advisor review): the
  marks already flow through the PTY byte stream to xterm, where no handler is
  registered and they are ignored. Rejected: adding a second emission path or
  changing shell integration. Based on: the marks are emitted by the rc templates
  under `crates/supervisor/src/shell/*.zsh` in the form
  `\x1b]133;A|C|D;coflux=<secret>` (the literals at
  `crates/supervisor/src/shell_integration.rs:514-521` are a test helper asserting
  that shape, not the emission site), and `crates/supervisor/src/sessiond.rs:512`
  consumes them via `OscCapture::with_secret` without stripping them from the stream.

- **The mark secret is not a new exposure, but must not be widened**: the secret
  already reaches the renderer inside the byte stream today. Registering a handler
  makes it readable from JS, so the renderer must use it only to authenticate marks
  and must never log it, put it in component state, or include it in error
  messages. Rejected: stripping the secret in the supervisor — that would mean
  rewriting the output stream, which risks corrupting byte offsets the gap/resume
  path depends on.

## Direction

Two tracks that touch disjoint files and can run as concurrent work packages.
**Within each track the milestones are strictly serial** — every renderer
milestone edits `terminal-pane.tsx`, and both supervisor milestones edit
`sessions.rs`, so fanning out inside a track would conflict. Milestone 3 in
particular is load-bearing for the rest of Track B: it changes the xterm API
surface every later milestone builds on.

- **Track A (supervisor, Rust)**: Milestone 1 → Milestone 2.
- **Track B (renderer, TypeScript/React)**: Milestone 3 → 4 → 5 → 6 → 7.

Track A and Track B are independent of each other: no file, type or command is
shared, and neither track's validation needs the other's outcome.

### Milestone 1: Session shells start with a usable locale and color environment

`LANG` (or the locale variables generally) and `COLORTERM` are populated for PTY
sessions when the supervisor's own environment does not already provide them, and
`TERM_PROGRAM` identifies coflux. A shell started by the supervisor reports a
UTF-8 `LC_CTYPE` instead of `C`.

Validation: `cargo test -p coflux-supervisor` (see the Commands baseline note),
including a new test that asserts against the **constructed spawn environment as a
pure value** — given a simulated parent environment, the resulting variables are
correct — for both the all-empty case and each of the three preserve cases. Do not
write this test by starting a real shell and reading its `locale`: three existing
tests in this crate already fail exactly that way on a developer machine.

### Milestone 2: High-throughput output is coalesced and gap recovery keeps more scrollback

PTY reads are merged over a short window before being emitted as frames, cutting
the frame rate that pressures the worker's bounded channel; and the snapshot
history limit no longer truncates a client's scrollback by 80% on recovery.

Validation: `cargo test -p coflux-supervisor` (see the Commands baseline note),
including tests that a burst of small PTY reads within the window produces fewer
frames than reads, that the window and byte budget bound how long output is held
back, that emitted frames remain sequence-contiguous, and that the history-limit
default stays consistent with its env override and the `MAX_HISTORY_LINE_LIMIT`
clamp (`crates/supervisor/src/main.rs:57`, with `HISTORY_WRAP_FACTOR` at
`crates/supervisor/src/sessiond.rs:11` governing the memory cost of raising it).

### Milestone 3: The renderer runs on the 6.1 beta cohort with Unicode 11 and kitty

`@xterm/xterm` and every addon move to the beta cohort named under Decisions,
`allowProposedApi` is `true`, `addon-unicode11` is loaded and activated, and the
kitty keyboard protocol is enabled through `vtExtensions.kittyKeyboard`. Emoji
occupy two cells. **`patchImeCommittedInput` has been re-derived against the beta's
internals and is proven to still be active** — see the first landmine; a patch that
silently no-ops is the default outcome of this milestone if nobody checks.

Validation: `pnpm -C apps/desktop typecheck` and `pnpm -C apps/desktop test` ->
exit 0. Neither can catch the IME regression: add an assertion that the patch
applied (rather than hitting its early return) so the failure is loud.

### Milestone 4: Visual defaults match Cursor

`lineHeight` 1, `cursorStyle` block, `cursorBlink` false, `minimumContrastRatio`
4.5, `rescaleOverlappingGlyphs` on. Font family unchanged. The existing theme's
dim colors become readable rather than being left at their authored contrast.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 5: Resize is debounced and attach no longer eats keystrokes

Window drags no longer produce one resize frame per observer callback, and
keystrokes typed while a pane is `attaching` arrive once ownership lands instead
of vanishing.

Validation: `pnpm -C apps/desktop typecheck` and `pnpm -C apps/desktop test` ->
exit 0. The desktop test runner is plain Node with no DOM
(`node --import tsx --test`), so cover the debounce's decision logic by extracting
it as a pure function and testing that; the DOM wiring itself is acceptance-tier.

### Milestone 6: Search, clipboard, context menu and file links exist

⌘F search over the scrollback, OSC 52 clipboard support, a right-click menu with
at least copy/paste (macOS right-click currently does nothing at all, since
Electron provides no default menu), link hover feedback, and `file:line` links
that open in the workbench where that is meaningful. The clipboard **read**
permission is granted in `main/index.ts` as part of this milestone — see the
landmine; without it paste and OSC 52 queries fail silently.

Validation: `pnpm -C apps/desktop typecheck` and `pnpm -C apps/desktop test` ->
exit 0; behavioral check is acceptance-tier.

### Milestone 7: Command boundaries become navigable

The renderer registers an OSC 133 handler, authenticates marks by the shared
secret, and turns them into command decorations plus navigation: jump to the
previous/next command, and copy the last command's output. This milestone does
**not** need `allowProposedApi` — `registerDecoration` is not gated — so it is not
blocked if Milestone 3 has to back off.

Validation: `pnpm -C apps/desktop typecheck` and `pnpm -C apps/desktop test` ->
exit 0; behavioral check is acceptance-tier.

## Landmines

- **The 6.1 beta silently disables our IME fix, and nothing in CI will say so.**
  `patchImeCommittedInput` (`terminal-pane.tsx:64-68`) guards on six private
  `_core` fields including `core.cancel`, and returns early — falling back to
  upstream behavior — if any is missing. In `6.1.0-beta.304` `CoreBrowserTerminal`
  no longer has a `cancel` method (verified against the published sources:
  `_inputEvent` moved to `protected` at `CoreBrowserTerminal.ts:1029` and its
  return value is discarded by the listener at `:429`). The regression is exactly
  the upstream bug the patch exists for (xtermjs/xterm.js#5887): full-width CJK
  punctuation such as `？！` must be typed twice to produce one character. Every
  field is optional in `XtermCoreInternals`, so this typechecks clean and passes
  every milestone validation in this plan. Milestone 3 must re-derive the patch
  against the beta internals, and the walkthrough must type CJK punctuation.
- `allowProposedApi: false` is the very first option in the `Terminal`
  constructor (`terminal-pane.tsx:189`) and silently blocks `addon-unicode11`: the
  failure is a thrown error at addon activation, not a degraded render. Flip it in
  the same change that adds the addon or Milestone 3 fails at runtime while
  typechecking cleanly.
- **The supervisor's snapshot width table is Unicode 17, not 11 — moving the
  renderer to 11 narrows the divergence but does not close it.** `Cargo.toml:21-22`
  patches `vt100` to the vendored copy; `vendor/vt100/src/cell.rs:51` uses
  `unicode_width::UnicodeWidthChar` from `unicode-width 0.2.2`, whose
  `tables.rs:165` declares `UNICODE_VERSION = (17,0,0)`. xterm's built-in table is
  Unicode 6 and `addon-unicode11` is 11 (`UnicodeV11.ts:195`). So characters added
  in Unicode 12–17 — which includes emoji Claude Code uses — stay 2 cells wide in
  the snapshot and 1 cell wide in the renderer. Snapshots are stitched line by line
  with `\r\n` (`vendor/vt100/src/term.rs:33`), so a width disagreement becomes a
  *line-break position* disagreement on gap recovery. Do not spend the milestone
  trying to close this; record the residual and move on.
  `@xterm/addon-unicode-graphemes@0.5.0-beta.301` exists in the same cohort and may
  narrow it further — its Unicode version is unverified.
- kitty keyboard mode is negotiated by the application at runtime and is not part
  of the snapshot. After a gap-driven `terminal.reset()`, a TUI that had enabled it
  will be talking to a terminal that has forgotten it. Protocol-level mode
  persistence is out of scope; record the limitation.
- Environment overrides written **before** the `std::env::vars()` copy in
  `sessions.rs:855-858` are silently undone by the copy. Two existing comments warn
  about exactly this for `PATH` and the `COFLUX_*` variables.
- `terminal-pane.tsx` creates xterm once on mount and reads live props through a
  `liveRef` mirror because the closure only captures mount-time values
  (`:160-183`). Any new handler added by Milestones 5–7 that needs current props
  must go through that same mirror, not through a closure over props.
- The OSC 133 payload carries the mark secret
  (`shell_integration.rs:514-521`). `shell_integration.rs:606-610` has a test
  asserting the secret only ever appears inside an OSC 133 payload — do not break
  that property, and do not let the renderer surface the secret anywhere.
- `fit()` has six entry points, three of them in another file
  (`terminal-attach.ts:106,140,337`) — see the resize decision. Debouncing only the
  `ResizeObserver` leaves the rest storming; debouncing indiscriminately can break
  the WebGL-load fit, which exists precisely to correct a sub-pixel metric
  difference (`terminal-pane.tsx:245`).
- **Right-click paste and OSC 52 *reads* need an Electron permission we currently
  deny.** `apps/desktop/src/main/index.ts:163-165` allows only `fullscreen` and
  `clipboard-sanitized-write`; `setPermissionCheckHandler` rejects everything else.
  `navigator.clipboard.readText()` — which `@xterm/addon-clipboard` 0.3.0-beta.303
  uses on its read path (`ClipboardAddon.ts:72-73`) — needs `clipboard-read`. Write
  paths (copy, copy-last-output) are unaffected. This is why `main/index.ts` is in
  scope; without it the milestone ships a paste that fails silently.
- `pnpm-lock.yaml` is shared: `tests/package.json:12` depends on
  `@xterm/headless ^6.0.0`. The lockfile will legitimately carry both 6.0.0 and the
  6.1 beta after this change. Do not "tidy" that by bumping the tests package —
  that is a different surface with its own risk.
- `apps/desktop/package.json` currently uses caret ranges (`^6.0.0`). Pin the beta
  cohort exactly. (The reason is release hygiene, not a semver quirk: `^6.1.0-beta.304`
  would legitimately match later 6.1.0 prereleases and the eventual 6.1.0 release,
  which is not what we want while riding a beta.)

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/src/renderer/components/workbench/terminal-attach.ts` (the three
  `fit()` entry points the debounce must cover)
- `apps/desktop/src/renderer/components/workbench/terminal-link-activation.ts`
- `apps/desktop/src/main/index.ts` — **permission set only**: add the clipboard
  read permission Milestone 6 needs. Nothing else in the main process.
- New renderer test files under `apps/desktop/src/renderer/components/workbench/`,
  plus any pure module extracted to make logic testable without a DOM
- `apps/desktop/package.json` (xterm cohort), and `pnpm-lock.yaml`
- `crates/supervisor/src/sessions.rs`
- `crates/supervisor/src/sessiond.rs`
- `crates/supervisor/src/main.rs` (history limit)

Out of scope:
- Local echo / typeahead — Cursor does not have it; parity does not mean adding it.
- Pause-based backpressure and any wire-protocol change — breaks the relay link.
- `packages/client/src/device-router.ts`, `crates/worker/` — `resizeSeq` and the
  gap mechanism already provide what this plan needs.
- Sticky scroll (off by default in Cursor's stable channel) and terminal suggest
  (default false).
- Font family — already equivalent in practice.
- `apps/ios`, `apps/server` — no terminal-feel surface in this plan.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-supervisor` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop walkthrough (acceptance) | `pnpm dev:desktop:prod` | user drives it |

There is no lint script for `apps/desktop` and no linter configured in the
repository — do not go looking for one.

**Run the Rust tests with `COFLUX_HOME` emptied, or three of them fail for reasons
that have nothing to do with this plan.** A plain `cargo test -p coflux-supervisor`
on a developer machine gives `81 passed; 3 failed`:
`shell_integration::tests::{zsh_function_translates_the_variable_into_plugin_dir,
bash_function_translates_the_variable_into_plugin_dir,
zsh_chain_runs_user_rc_in_order_including_a_user_set_zdotdir}`. They start a real
shell, which then picks up the machine's own installed coflux rc chain and its
`~/.coflux/agent-integrations/<sha>` plugin dir instead of the one the test created.
Emptying `COFLUX_HOME` makes the rc chain's `claude` wrapper stand down (it gates on
`test -n "$COFLUX_HOME"`) and the suite goes green at 84/84. Empty the variable —
`COFLUX_HOME= cargo test …` — rather than unsetting it with `env -u`, which the
Bash guard rejects in this session. Setting `COFLUX_CLAUDE_PLUGIN_DIR` does not
help. CI runs the plain command (`.github/workflows/ci.yml:182`) in a clean
environment where all 84 pass.

Two adjacent traps when running any of these: `cargo test` is fail-fast across
crates, so a red supervisor crate silently skips the ones after it; and piping a
command into `tail` hands you `tail`'s exit code, so a failing run reports
`exited with code 0`. Redirect to a file and check the status separately, or read
`$pipestatus[1]`.

## Done criteria

- [ ] All listed non-acceptance commands pass, including the Rust suite at 84/84
      with `COFLUX_HOME` emptied.
- [ ] When the parent environment has no `LC_ALL`/`LC_CTYPE`/`LANG`, a spawned
      shell gets a UTF-8 locale and a non-empty `COLORTERM`; when the parent sets
      any one of them — `LANG=C` included — the child gets that value verbatim and
      no injected locale.
- [ ] Emoji and CJK punctuation occupy the correct cell count in the renderer, and
      the residual divergence against the snapshot's Unicode 17 table is recorded
      in this plan's Maintenance notes.
- [ ] **Full-width CJK punctuation (`？` `！`) produces one character per keypress**
      in the walkthrough — the IME patch survived the beta upgrade.
- [ ] Coalescing has an explicit upper bound: a test asserts both that a burst
      produces fewer frames than reads **and** that the merge window and byte
      budget cap how much is held back, and that emitted frames stay
      `from_seq`/`to_seq` contiguous (`crates/worker/src/device.rs:2938-2946`
      raises a gap otherwise, which would turn this optimization into the very
      problem it is meant to reduce).
- [ ] Dragging the window does not emit one resize per observer callback, and the
      "no fit while inactive" property still holds.
- [ ] Keystrokes typed during `attaching` reach the PTY after ownership lands.
- [ ] ⌘F, right-click copy **and paste**, and command navigation are reachable in
      the UI — paste actually pastes rather than failing silently.
- [ ] The mark secret appears nowhere in renderer logs, state, or error messages.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No files changed outside the In scope list.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The 6.1 beta cohort cannot be installed as a consistent set, or the beta core
  breaks an addon we already depend on (webgl, fit, web-links). Report rather than
  mixing cohorts.
- `addon-unicode11` still throws after `allowProposedApi` is enabled.
- The outcome requires out-of-scope files — in particular, any need to touch the
  wire protocol or `crates/worker/`.
- A validation command fails twice after one reasonable fix — excluding the three
  documented `shell_integration` baseline failures, which are not this plan's and
  must not trigger a stop.
- The IME patch cannot be re-derived against the beta internals. Report rather than
  shipping the upstream regression: the user types Chinese in this terminal daily,
  and that trade was never authorized.

## Maintenance notes

- The beta dependency is the main ongoing cost: when `@xterm/xterm` 6.1 reaches
  stable, move the whole cohort back to stable in one change.
- Two differences from Cursor are deliberate and permanent, and future readers
  should not "fix" them: we have no typeahead (neither does Cursor), and our
  backpressure drops and repaints rather than pausing the PTY (required by the
  relay link).
- If gap-driven repaints turn out to be frequent in daily use even after output
  coalescing, the next lever is a direct local lane with pause-based flow control —
  a protocol-level change that was explicitly excluded here.
- The advisor's original report cited the worker channel bound as a plain 256-record
  queue; it is in fact bounded on records *and* bytes
  (`crates/worker/src/device.rs:33-38`), so frame-count reduction is only one of two
  overflow dimensions.
- **Measured width residual**: the renderer now reads Unicode 11 while the snapshot
  path reads Unicode 17 (`unicode-width 0.2.2`, `tables.rs:165`). Characters added in
  Unicode 12–17 — emoji Claude Code uses — are still 2 cells in the snapshot and 1 in
  the renderer, and because snapshots are stitched with `\r\n`, that shows up as a
  line-break disagreement after a gap recovery, not as a width glitch. The real fix is
  for xterm's table to catch up, not for us to patch either side. Both this and the
  kitty-mode-after-reset residual are also commented in place in `terminal-pane.tsx`.

- **Echo now costs one coalescing window.** Output merging is unconditional: a single
  echoed keystroke waits out `OUTPUT_COALESCE_WINDOW` (5ms) before it is delivered,
  because the merge starts when the first chunk arrives. Cursor's `TerminalDataBufferer`
  behaves the same way, so this is not worse than the thing we set out to match — but
  our path is longer than its one IPC hop, so the 5ms lands on top of more. If a
  real-machine walkthrough says typing feels sluggish, this window is the first knob;
  the structural alternative is to deliver the first chunk immediately and only merge
  while chunks arrive back-to-back, which would give interactive echo zero added latency
  and keep the benefit for bursts. That was not built here because the plan's decision
  named Cursor's shape.

- **`cancelEvents` is off and always was.** The old IME patch called
  `core.cancel(ev)`, which checks an internal `cancelEvents` option that defaults to
  `false` and that this app never sets — so that call was a no-op for its entire life.
  The option and the `cancel` method are both gone in 6.1. The patch therefore does not
  cancel the input event, and `terminal-ime-patch.test.ts` asserts `preventDefault` and
  `stopPropagation` are never called. Anyone "restoring" that call would be adding
  behavior, not preserving it.

- **Two deliberate narrowings.** `TERM_PROGRAM=coflux` is set unconditionally rather
  than only-when-absent (inheriting `Apple_Terminal`/`vscode` into a coflux PTY is
  simply wrong, and the adjacent `TERM` is unconditional too). And M6's file links copy
  the `path:line:col` to the clipboard instead of opening an editor: the workbench has
  no editor surface, and opening one would need a main-process IPC this plan's scope
  does not allow.

- **OSC 133 marks authenticate by trust-on-first-use.** The session secret has no
  out-of-band channel to the renderer, so the first well-formed mark establishes it and
  later marks must match verbatim. Shell integration emits `A` before the first prompt,
  so nothing user-controlled gets to speak first. Worst case if that were ever beaten is
  that command navigation stops working — the secret still never leaves the closure.
- This plan was revised on advisor review before execution. The review's
  substantive catches, all verified against the code: the beta upgrade silently
  disabling the IME patch; right-click paste needing an Electron permission we deny;
  three `shell_integration` tests failing on a developer machine before any change;
  the client already retaining unacknowledged input, making a renderer-side queue
  redundant; the snapshot width table being Unicode 17 rather than an unknown; and
  `registerDecoration` *not* requiring the proposed API, which the plan had
  asserted. No finding was rejected.
