# Plan 20260914-terminal-copy-clipboard: Copying works inside fullscreen TUIs, and a remote OSC 52 lands in the local clipboard

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 01e16982..HEAD -- apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/dialogs.tsx apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc-sanitize.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/preload/index.ts apps/ios/Coflux/Views/TerminalHostView.swift crates/supervisor/src/sessiond.rs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug
- Execution: subagent opus — from the departure check
- Stop after: implementation — from the departure check's autopilot item
- Plan review: advisor — substituted. `dev:advisor`'s required tier
  (`claude-fable-5-1`) is unavailable on this account (HTTP 404
  `model_not_found`), so at the user's direction the review was run by the local
  Codex CLI in a read-only sandbox instead, checking the plan's claims against
  the code. Seven findings: five adopted (see the `(revised on advisor review)`
  markers), two declined with reasons under Maintenance notes.
- Workspace: isolated — `dev/20260914-terminal-copy-clipboard`
- Planned at: `01e16982`, 2026-09-14

## Requirement

In the desktop app, running an agent TUI that takes over the screen — Claude
Code or Grok in fullscreen mode — makes copying impossible. Dragging the mouse
across the output selects nothing, so there is nothing for ⌘C to copy. Outside
fullscreen mode the same drag works fine.

### Why

Fullscreen mode means the alternate screen buffer plus mouse tracking (DECSET
1000/1002/1003). Once an application turns mouse reporting on, xterm.js stops
building a local selection and forwards every mousedown/drag to the application
instead:

```js
if (coreMouseService.areMouseEventsActive && !selectionService.shouldForceSelection(ev)) {
  /* send to the application, then cancel the event */
}
```

Every terminal emulator keeps one escape hatch out of that: a modifier that
forces a local selection anyway (⌥ on macOS in iTerm2 and Terminal.app, Shift
elsewhere). xterm.js has it too, but on macOS it is gated behind an option that
defaults to off, and our `new Terminal({...})` never turns it on. So on macOS
there is currently **no way at all** to select text while an application holds
mouse tracking.

The second half of copying is the application's own: a TUI that wants to put
something in your clipboard writes OSC 52 to its terminal. The desktop app
drops those — xterm 6.0.0 ships OSC handlers for 0/1/2/4/8/10/11/12/104/110/
111/112 and no 52, and `@xterm/addon-clipboard` is not installed. The iOS app
already supports it (SwiftTerm hands OSC 52 to `clipboardCopy`, wired to
`UIPasteboard`), so the desktop client is the one missing half a capability.
The transport is already in place and needs no change: the supervisor hands the
PTY's raw bytes straight through, so an OSC 52 emitted on a remote machine
arrives at the desktop intact.

### Product conclusions (settled during exploration; do not reopen)

1. ⌥+drag forces a local selection in any program holding mouse tracking; ⌘C
   then copies it through the existing Edit ▸ Copy path.
2. Without ⌥ held, the mouse still goes to the TUI. Claude Code's own mouse
   interaction changes in no way.
3. ⌥+click no longer injects arrow keys into the TUI.
4. A remote program's OSC 52 write lands in the local desktop system clipboard,
   silently — no toast, no terminal notice.
5. Only the panel that is both visible and holds control responds to OSC 52. A
   background tab cannot rewrite a clipboard the user is using elsewhere.
6. An OSC 52 *query* is answered with nothing, ever. The read path iOS
   currently leaves open is closed too; its write path stays.
7. The shortcut help panel (⌘+/) gains one line documenting ⌥+drag.

### Observable when done

- In a desktop terminal running `claude` in fullscreen, holding ⌥ and dragging
  highlights text; ⌘C then pastes that exact text elsewhere.
- Dragging without ⌥ still drives the TUI's own mouse handling.
- ⌥+click sends nothing to the PTY.
- Running `printf '\033]52;c;%s\a' "$(printf hello | base64)"` in a desktop
  terminal puts `hello` in the local clipboard. The same with
  `中文 emoji 🎉 trailing space ` round-trips byte-for-byte, including the
  spaces and any newlines — this is the case that separates a correct
  implementation from one that writes `atob()`'s raw output.
- A malformed payload (`printf '\033]52;c;!!!notbase64\a'`) leaves whatever was
  already in the clipboard untouched.
- The same valid sequence in a background tab, or in a panel that does not hold
  control, leaves the clipboard untouched.
- `printf '\033]52;c;?\a'` produces no reply on either desktop or iOS.

The transport hop itself needs no acceptance: the supervisor copies PTY bytes
through verbatim (`crates/supervisor/src/sessiond.rs:429`), so a sequence
emitted over SSH inside a local terminal exercises the same renderer path as
one from a Coflux remote device. *(clarified on advisor review)*

## Decisions & tradeoffs

- **The selection escape hatch is ⌥+drag, via xterm's own option**: set
  `macOptionClickForcesSelection: true` on the `Terminal` construction.
  Rejected: a bespoke "selection mode" toggle or a terminal context menu — both
  add UI for something every terminal already solves with a modifier, and
  neither is what a user coming from iTerm2 reaches for.
  Based on: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:192`
  constructs the terminal without it; xterm's `shouldForceSelection` reads
  `isMac ? ev.altKey && rawOptions.macOptionClickForcesSelection : ev.shiftKey`,
  and the option defaults to false (`macOptionClickForcesSelection:!1` in
  `node_modules/@xterm/xterm/lib/xterm.js`).

- **⌥+click must stop moving the cursor**: set `altClickMovesCursor: false` on
  the same construction. This is not optional polish — it is the direct
  conflict created by the decision above. Rejected: leaving xterm's default
  (`altClickMovesCursor:!0`) as VS Code does — VS Code's users work at a shell
  prompt where jumping the cursor pays for itself; ours work inside agent TUIs
  where the same gesture injects a burst of arrow keys into the application.
  Based on: xterm's `_handleMouseUp` fires
  `triggerDataEvent(moveToCellSequence(...))` when the selection is ≤ 1
  character, the press lasted < 500 ms, `altKey` is held, and
  `altClickMovesCursor` is on.

- **OSC 52 is parsed by our own handler, not by `@xterm/addon-clipboard`**:
  register it through `terminal.parser.registerOscHandler(52, ...)`. The
  invariant that decides this: **a query must produce zero bytes back to the
  application** — when the payload is `?`, the handler consumes it and returns
  `true` without writing anything to the PTY. The addon answers queries by
  design (a provider returning an empty string still yields an OSC 52 reply,
  and a reply is exactly what must not happen), and the three behaviors this
  plan actually needs — silent drop, the visibility/control gate, the size cap
  — all live in the handler anyway. Rejected: adding the dependency and
  supplying a custom provider. Based on: `registerOscHandler` is public, stable
  API (`node_modules/@xterm/xterm/typings/xterm.d.ts:1864`), so
  `allowProposedApi: false` at `terminal-pane.tsx:193` does not restrict it;
  the installed xterm registers no handler for 52. (Do not restate the older
  claims that the addon forces `navigator.clipboard` on a custom provider or
  that it leaves base64 decoding to the caller — both were wrong, and neither
  is needed to reach this decision. *(revised on advisor review)*)

- **The payload is decoded base64 → bytes → UTF-8 text, and anything that
  fails that chain is dropped whole** *(revised on advisor review)*: the
  clipboard receives a proper Unicode string, never the Latin-1 binary string
  a bare `atob()` produces. Malformed base64, invalid UTF-8, and an empty
  payload all result in the clipboard being left untouched — never a partial
  or mojibake write. Rejected: writing `atob()`'s output directly — it happens
  to look correct for pure ASCII, so `hello` would pass acceptance while every
  Chinese character, emoji, or accented letter in the user's clipboard would
  be corrupted. Which OSC 52 selection parameters are honored is the
  executor's call, but the choice must be explicit in code, not incidental —
  `c` (clipboard) is the one that matters here. Based on: iOS already applies
  exactly this contract — `String(data:encoding:.utf8)` with no write on
  failure, `apps/ios/Coflux/Views/TerminalHostView.swift:230`.

- **The clipboard write goes through IPC to the main process, never through
  the Web Clipboard API**: the renderer hands the decoded text to the main
  process, which calls Electron's `clipboard.writeText()`. Rejected:
  `navigator.clipboard.writeText()` — OSC 52 arrives on the PTY output stream
  with no transient user activation behind it, and the call is rejected
  whenever the page is not focused, which is exactly when a background agent
  finishes work and copies something. Based on:
  `apps/desktop/src/main/index.ts:163` grants `clipboard-sanitized-write` as a
  *permission*, which does not lift the user-gesture requirement;
  `clipboard-read` is not granted at all, so the read direction is independently
  impossible in the renderer.

- **The new IPC channel follows the existing send-shaped convention**: a name
  in the `IPC` map, a `ipcMain.on` handler that returns early unless
  `isTrusted(event)`, a `sanitize*` function for the payload, a method on the
  bridge type, and its implementation in preload. Fire-and-forget (`send`), not
  `invoke` — nothing waits on the result. Rejected: reaching for
  `clipboard` from the renderer directly, or an `invoke` round trip. Based on:
  `apps/desktop/src/main/ipc.ts:75` (`IPC.notify`) is the shape to copy;
  channel names live in `apps/desktop/src/shared/ipc.ts`, payload cleaning in
  `apps/desktop/src/main/ipc-sanitize.ts`, the bridge contract in
  `apps/desktop/src/shared/desktop-bridge.ts`, its implementation in
  `apps/desktop/src/preload/index.ts`.

- **OSC 52 writes are gated on `active && controlState === "owned"`**: the same
  condition `onData` and the paste handler already use, read through the
  existing `liveRef` mirror. A panel that is merely receiving output — a
  background tab, or one whose control was taken over — must not touch the
  clipboard. Rejected: gating on `active` alone, or not gating at all: several
  panels stream output at once, and the clipboard is a single global the user
  may be using in another application entirely. Based on:
  `terminal-pane.tsx` gates both `terminal.onData` and `handlePaste` on
  `active && controlState === "owned" && sessionId`.

- **The payload is bounded before it is decoded, and the main process checks
  again**: the bytes come from whatever runs on the remote machine and are
  attacker-shaped input. Reject on the **encoded** length first — before
  allocating a decode — and have the IPC sanitizer enforce its own limit on the
  decoded text, dropping rather than truncating at both points. Rejected: a
  single check after decoding (it allocates the thing it is protecting against),
  and truncation (a silently half-copied value is worse than no copy). The exact
  numbers are the executor's call; they are two distinct limits, not one reused
  twice. Based on: `crates/supervisor/src/sessiond.rs:205` bounds OSC titles at
  the source for the same reason (`MAX_TITLE_BYTES`), while the live output path
  at `crates/supervisor/src/sessiond.rs:429` copies the raw bytes through
  unbounded — nothing upstream limits an OSC 52 payload for us.
  *(revised on advisor review)* This cap protects the clipboard and the IPC
  hop; it does **not** protect against xterm buffering the sequence, which
  happens before our handler is ever called — see Landmines.

- **iOS closes the read direction only**: `clipboardRead` returns `nil`;
  `clipboardCopy` keeps writing to `UIPasteboard`. Rejected: leaving it as is
  for symmetry with "we only changed the desktop" — it is the same silent
  read-out of the user's clipboard by remote code, and it is two lines to
  close. Based on: `apps/ios/Coflux/Views/TerminalHostView.swift:235` currently
  returns `UIPasteboard.general.string`, `:230` writes it.

## Direction

Everything lands in the desktop renderer, its IPC seam, and one iOS file. The
server, worker, protocol, and supervisor are untouched: the PTY bytes already
arrive intact.

Milestones 1 and 2 both edit `terminal-pane.tsx`, so they are **not**
independent — run them as one sequential work package, milestone 1 first. Do
not fan this plan out. Milestone 3 touches only Swift and could in principle
run alone, but it is two lines and is not worth a separate package.

### Milestone 1: ⌥+drag selects inside a mouse-tracking TUI

The terminal is constructed with the selection escape hatch on and ⌥+click's
cursor movement off. The shortcut help panel documents the gesture in one row,
worded for macOS (the option has no effect on other platforms, where xterm uses
Shift instead).

Validation: `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 2: a remote OSC 52 write reaches the local clipboard

An OSC 52 sequence arriving on the PTY stream is parsed in the renderer; when
it carries a base64 payload within the encoded-size cap that decodes to valid
UTF-8, and the panel is both visible and in control, that text is handed to the
main process over the new IPC channel and written to the system clipboard. A
query payload (`?`) is consumed and answered with nothing. Anything malformed,
oversized, empty, or arriving at a panel that fails the gate leaves the
clipboard exactly as it was.

The payload parse — selection parameter, encoded-size cap, base64, UTF-8,
query — is a pure function with no Electron dependency and belongs in its own
module with its own test. Put both where the existing globs reach them
(Landmines): `src/renderer/components/workbench/`. Whether the IPC sanitizer
also gets cases in `src/main/ipc.test.ts` is the executor's call.

Validation: `pnpm -C apps/desktop test` -> exit 0, and
`pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 3: iOS stops answering clipboard reads

`clipboardRead` returns `nil`; the write path is unchanged.

Validation: covered by the acceptance build — there is no Swift check in the
desktop commands. Confirm by reading the diff: exactly one behavior changed in
one function.

## Landmines

- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx` builds the
  xterm instance in a mount effect that runs **once** (`taskId` is the React
  key), so props captured directly in that closure go stale. Everything that
  must read "the value right now" — `active`, `controlState`, `sessionId` —
  goes through the `liveRef` mirror the file already maintains. The OSC 52
  handler is registered inside that same one-shot effect and must read the gate
  through `liveRef`, not through a captured prop.
- The same file carries `patchImeCommittedInput`, which reaches into xterm
  6.0.0's private internals (`_core._inputEvent`, `_compositionHelper`) to work
  around an upstream full-width punctuation bug. It is load-bearing and
  version-pinned. Do not disturb it, and do not "clean up" the private-type
  declaration above it.
- `macOptionClickForcesSelection` is macOS-only: on other platforms xterm's
  `shouldForceSelection` reads `ev.shiftKey` and ignores the option entirely,
  so the help-panel row must not promise ⌥ to a non-macOS user. **There is no
  existing helper for this.** `shortcut-modifier.ts:8` is a hardcoded `["⌘"]`
  shared by every row in the panel — changing it to add platform logic would
  rewrite the modifier shown on all of them. The platform is available on the
  bridge instead (`readonly platform: string`,
  `apps/desktop/src/shared/desktop-bridge.ts:82`, fed from `process.platform`
  at `apps/desktop/src/main/index.ts:314`); branch the new row on that.
  *(revised on advisor review)*
- OSC handlers registered with `registerOscHandler` may return a promise, and
  returning `false` lets a previously registered handler try. Return `true` for
  every sequence this handler consumes — including a dropped one — so nothing
  falls through to another handler.
- **xterm buffers the whole OSC sequence before calling the handler**, with its
  own limit (documented at `node_modules/@xterm/xterm/typings/xterm.d.ts:1849`).
  Our size cap therefore runs *after* that buffering and cannot prevent it. Do
  not describe the cap as protection against a memory-exhaustion payload; it
  bounds what reaches the clipboard and the IPC hop, nothing earlier.
  *(revised on advisor review)*
- **The `test` script's globs are not recursive**
  (`apps/desktop/package.json:13` lists `src/main/*.test.ts`,
  `src/renderer/*.test.ts`, `src/renderer/components/settings/*.test.ts`,
  `src/renderer/components/workbench/*.test.ts`, `test/*.test.ts`). A new test
  placed in a deeper directory, a `__tests__/` folder, or named `.test.tsx` is
  silently never run — and `pnpm -C apps/desktop test` still exits 0, so the
  Done criteria would pass on a test nobody executed. Put renderer tests in
  `src/renderer/components/workbench/` and main-process tests in `src/main/`
  next to the existing ones, or extend the script deliberately.
  *(revised on advisor review)*
- **Changes to `src/main/` or `src/preload/` need the dev client restarted** —
  renderer HMR does not carry them. A new IPC channel that "does nothing" is
  usually just a stale main process. *(revised on advisor review)*

## Scope

In scope *(list corrected on advisor review — it is a closed list, so what the
plan's own milestones require had to be in it)*:
- `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx`
- `apps/desktop/src/renderer/components/workbench/dialogs.tsx`
- a new renderer module for the OSC 52 payload parsing, placed so the existing
  test globs reach its test (see Landmines) — the pure function under test
  should not have to be exported out of the component file
- `apps/desktop/src/shared/ipc.ts` — the channel name
- `apps/desktop/src/shared/desktop-bridge.ts` — the bridge method
- `apps/desktop/src/preload/index.ts` — its implementation
- `apps/desktop/src/main/ipc.ts` — both the `IpcActions` type (`:23`) and the
  `ipcMain.on` handler
- `apps/desktop/src/main/ipc-sanitize.ts` — the payload sanitizer
- `apps/desktop/src/main/index.ts` — **required**, not conditional: the
  `registerIpc({...})` call at `:311` supplies every action, so a new one has
  to be wired there
- `apps/desktop/src/main/ipc.test.ts` — existing file; extend it if the new
  sanitizer is tested
- new test files in `src/main/` or `src/renderer/components/workbench/`
- `apps/ios/Coflux/Views/TerminalHostView.swift`
- `wiki/plans/README.md` and this plan file — the status update the Done
  criteria require

Out of scope:
- `crates/**`, `apps/server/**`, `packages/protocol/**` — the PTY bytes already
  arrive intact; nothing on the wire changes.
- Two-way sync of the remote machine's *system* clipboard (`pbcopy`/`pbpaste`)
  — a different feature with a much larger privacy surface; explicitly not this
  plan.
- A tmux-style selection mode or a terminal context menu — rejected above.
- iOS selection behavior under mouse tracking — only the OSC 52 read path
  changes there.
- `navigator.clipboard` permissions in `index.ts:163` — the granted
  `clipboard-sanitized-write` is left alone; this plan simply does not use it.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install deps (this worktree starts empty) | `pnpm install` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Real-machine walkthrough (acceptance) | `pnpm dev:desktop:prod`, then the observable list above | user confirms by hand |
| iOS build (acceptance) | Xcode build of `apps/ios` | user confirms by hand |

This worktree has no `node_modules` — both checks fail with `MODULE_NOT_FOUND`
until dependencies are installed. `dev:execute-plan` does this at preflight;
anyone running the checks by hand does it first. *(added on advisor review)*

`pnpm dev:desktop:prod` covers the local terminal path end to end, which is
where every decision in this plan lives. Restart it after touching
`src/main/` or `src/preload/` (see Landmines). Per project convention, UI
behavior is accepted by the user on a real machine, not by the agent.

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] ⌥+drag builds a selection while a TUI holds mouse tracking; a plain drag
      still reaches the TUI; ⌥+click sends nothing to the PTY.
- [ ] An OSC 52 write from a visible, in-control panel reaches the system
      clipboard; from a background or non-owning panel it does not.
- [ ] An OSC 52 query gets no reply, on desktop and on iOS.
- [ ] Non-ASCII text (Chinese, emoji), embedded newlines, and leading/trailing
      whitespace round-trip byte-for-byte — not just ASCII.
- [ ] A payload that is malformed base64, invalid UTF-8, empty, or above the
      size cap leaves the previous clipboard contents in place: dropped whole,
      never partially or incorrectly written.
- [ ] The new tests are actually executed by `pnpm -C apps/desktop test` —
      confirm they appear in its output, not merely that it exits 0.
- [ ] The help panel documents the gesture without promising ⌥ off macOS.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular, if
  `@xterm/xterm` has moved off 6.0.0 and `registerOscHandler`'s signature,
  `shouldForceSelection`'s modifier logic, or the two option defaults changed.
- Making the OSC 52 write work would require granting `clipboard-read` or
  loosening the renderer's permission set.
- The outcome requires touching `crates/**` or the protocol.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The ⌥ gesture is invisible until someone needs it. The help-panel row is the
  only discoverability affordance, deliberately — see the rejected alternatives
  above before adding a hint layer.
- The OSC 52 read direction is closed on both clients by choice, not by
  omission. If a future TUI asks for clipboard reads, that is a product
  decision about letting remote code read the user's clipboard silently, not a
  bug to fix.
- `patchImeCommittedInput` in `terminal-pane.tsx` pins this file to xterm
  6.0.0's internals. An xterm upgrade must re-verify it, the two option
  behaviors relied on here, and the OSC handler registration together.
- iOS and desktop now agree on OSC 52 semantics (write yes, read no). Keep them
  in step: a change on one side without the other reopens the asymmetry this
  plan closed.

### Found during real-machine testing (2026-09-16)

Two things surfaced when this was exercised against a real TUI. Neither is a
defect in what this plan shipped; both are recorded here because the next
person will hit them.

- **Agent CLIs do not emit OSC 52 in a coflux terminal, so this receiver sits
  idle until a follow-up lands.** grok picks its clipboard route by asking
  whether it can reach the user's clipboard directly: `grok doctor` reports
  `native: local (pbcopy)` / `osc 52: off` / `status: confirmed`, and it writes
  to the clipboard **of the machine the PTY runs on** — invisible to a user
  watching from another device, while reporting success. Injecting a remote
  session signal flips it: with `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` set,
  the same `grok doctor` reports `native: remote (pbcopy)` and states "Grok
  sends OSC 52". Claude Code follows the identical pattern — its binary carries
  `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY` alongside both `]52;c;` and `pbcopy`.
  But `crates/supervisor/src/sessions.rs:856-897` injects only `TERM` and the
  `COFLUX_*` variables — **nothing tells the program it is being watched from
  elsewhere**, and in coflux that is always possible, since any terminal can be
  opened from another device at any time. Declaring the session remote is the
  follow-up; it belongs in its own plan because it changes the runtime
  environment of every program in every terminal (programs that branch on SSH
  also stop auto-opening browsers, and so on). A narrower per-CLI switch was
  investigated and rejected: grok's only other lever, `GROK_OSC52_SINK`, marks
  OSC 52 `supported` but leaves `native: local`, so it does not redirect the
  route — and it is undocumented.
- **⌘C never copied a terminal selection, on any version of this app.** xterm
  copies through a `copy` listener on its container
  (`addDisposableListener(this.element, "copy", …)` → `copyHandler` →
  `clipboardData.setData("text/plain", selectionService.selectionText)`), which
  needs the browser to dispatch a `copy` event. xterm's selection is its own
  model, not a DOM selection: the only mirror into the textarea is
  `onLinuxMouseSelection` (Linux primary-selection semantics, never macOS), and
  `_syncTextArea` mirrors the cursor row instead. Meanwhile `menu.ts:64`'s
  `{ role: "copy" }` carries no `registerAccelerator: false` — unlike the
  `pageShortcut` helper at `menu.ts:18-21` — so ⌘C is swallowed by the menu and
  runs `webContents.copy()`, which finds no DOM selection and copies nothing.
  Independent of fullscreen, mouse tracking, and this plan. Not fixed here: the
  user's actual need was the cross-machine path above, and the fix (let ⌘C
  reach the page, then route a terminal selection through the `writeClipboard`
  IPC this plan added) is a separate change with its own UI surface.

### Review findings not adopted

- *The drift-check command should also surface uncommitted and untracked
  changes.* Not adopted: the drift check answers "did another commit move these
  files since planning"; in-flight edits are caught one step earlier, by
  `dev:execute-plan`'s clean-worktree preflight, which stops before the drift
  check runs.
- *Acceptance should require a packaged build to exercise the native remote
  transport.* Not adopted: every decision in this plan lives in the renderer,
  and the supervisor copies PTY bytes verbatim
  (`crates/supervisor/src/sessiond.rs:429`), so a local terminal — over SSH if a
  remote emitter is wanted — drives the identical code path. Standing up a
  packaged-build environment is disproportionate to a renderer-side parser.

*(This plan was reviewed against the code by an external reviewer — the local
Codex CLI 0.154.0 on its configured default model, in a read-only sandbox —
rather than by `dev:advisor`, whose required tier is unavailable on this
account. Seven findings; five adopted above, two recorded here.)*
