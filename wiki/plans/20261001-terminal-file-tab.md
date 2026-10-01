# Plan 20261001-terminal-file-tab: ⌘+click a file path in the terminal opens it in a read-only tab

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 11e382e1..HEAD -- proto/coflux/v1/device.proto proto/coflux/v1/common.proto crates/protocol packages/protocol crates/worker/src/device.rs crates/worker/src/ops.rs packages/client/src/device-router.ts packages/client/src/store.ts tests/src/contract.test.mjs apps/desktop/src/renderer/components/workbench/terminal-pane.tsx apps/desktop/src/renderer/components/workbench/terminal-file-references.ts apps/desktop/src/renderer/components/workbench/terminal-link-activation.ts apps/desktop/src/renderer/components/workbench/terminal-layout.ts apps/desktop/src/renderer/components/workbench/browser-tabs.ts apps/desktop/src/renderer/components/workbench/screen-tabs.ts apps/desktop/src/renderer/config.ts apps/desktop/src/renderer/index.css apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/diff-highlight.ts`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — planned from the clean main worktree; this plan lives on `dev/20261001-terminal-file-tab` in `.claude/worktrees/20261001-terminal-file-tab`
- Planned at: `11e382e1`, 2026-10-01

## Requirement

Agents running in a Coflux terminal constantly print file paths (`src/foo.ts:42`, `crates/worker/src/ops.rs:290:5`). The desktop already recognises these (`terminal-file-references.ts`, plan 20260916), underlines them, and ⌘+click **copies the path** — because the workbench had nowhere to show a file. The user wants to see the file itself: ⌘+click opens it in a new tab, at that line. The workbench gains its first view of workspace files.

Product conclusions, confirmed by the user during exploration:

**Links in the terminal**
- Recognition stays the existing `path[:line[:col]]` recogniser. When the pointer hovers a line, each recognised reference on it is checked asynchronously against the device: only a **regular file that exists inside the workspace** becomes a link. A reference that does not exist, lies outside the workspace, or is a directory stays plain text with no styling and no hint — hovering it does nothing.
- Link hover style: **no underline**. While hovered, the link's text turns the link colour (the terminal palette's blue) and the cursor becomes a pointer. The hint reads `⌘ 点击打开 · 右键更多` (modifier glyph from `SHORTCUT_MODIFIER_PREFIX`).
- ⌘+click opens the file tab. A plain click does nothing on a file link (a click without ⌘ is how the user selects text in a terminal). Right-click on a file link adds 「打开文件」 and 「复制路径」 at the top of the terminal context menu. Copy-on-⌘+click is removed.
- Web URLs adopt the same hover style (colour, no underline). Their behaviour is unchanged: plain left click opens the system browser, the existing right-click items (system browser / built-in browser / copy link), the "a drag selection across a link is not a click" gate, and the `0.0.0.0` → `localhost` rewrite all stay.
- Relative paths resolve against the **workspace root**. The daemon does not track the shell's live cwd (no OSC 7), so a relative path printed after `cd sub/` may not be found — accepted limitation.

**The file tab**
```
┌ tab bar ─────────────────────────────────────┐
│ ▸ zsh │ foo.ts ✕ │ localhost:5173 │  ＋        │
├──────────────────────────────────────────────┤
│ src/components/foo.ts                     ⟳  │  ← workspace-relative path; refresh
├──────────────────────────────────────────────┤
│ 40 │ import { bar } from "./bar";             │
│ 41 │                                          │
│ 42 │ export function foo() {   ◀ highlighted  │  ← opens with :line centred
│ 43 │   return bar();                          │
└──────────────────────────────────────────────┘
```
- Read-only. Syntax highlighting with the changes view's shiki theme, line numbers, text selectable and copyable.
- Title is the file name; the full workspace-relative path appears in the header (and as a `Tooltip` on the tab if titles collide or truncate — executor's call, but never a native `title`).
- Opens in the focused group. The same file of the same workspace **reuses its existing tab**: ⌘+clicking it again focuses that tab and jumps to the new line.
- When opened with a line, that line is scrolled to the centre and highlighted.
- Follows disk changes live while it is on screen, keeping the scroll position. Re-reads immediately when re-activated or when its device comes back online.
- Behaves like any other tab: split, drag between groups, ⌘W, and restored across app restarts (like browser tabs).
- States: loading; too large (> 2 MB, the worker's existing cap) 「文件过大，无法预览」; binary 「二进制文件，不预览」; deleted 「文件已不存在」 (the header keeps the path; if the file reappears, live follow shows it again); device offline 「设备离线」, re-read automatically on reconnect; worker too old for this feature — the existing daemon-outdated wording the changes view uses.

**Not in scope**: editing or saving; Markdown or image rendering; ⌘P file search; opening files from the changes view, the ⌘T menu or anywhere other than the terminal; files outside the workspace; following the shell's cwd.

**Done, as the user sees it**: an agent prints an existing path → hovering colours it → ⌘+click opens a file tab at that line; the agent edits the file → the open tab updates by itself; an agent prints a path that does not exist → hovering does nothing.

## Decisions & tradeoffs

- **Two additive protocol changes; the worker ships before the desktop.** (1) A new batched RPC on the Device channel, `fsStat`: request `{request_id, workspace_id, repeated paths}`, response with one entry per requested path carrying whether it exists, whether it is a regular file, its revision, and — for an existing path — its **canonical workspace-relative path** (resolved against the canonicalised root, symlinks and `..` resolved, `~` expanded, absolute inputs inside the root made relative). (2) `fsRead` gains an optional revision precondition on the request; the response gains the file's revision and a **typed status enum** — OK, NOT_MODIFIED, NOT_FOUND, NOT_FILE, TOO_LARGE, ERROR (exact names follow the proto style guide; `UNSPECIFIED = 0` as buf lint requires). When the precondition matches, the worker answers NOT_MODIFIED with empty content. A new worker always sets a non-empty `revision` on an OK answer. The client decides every state from the enum and never from the `error` text, which stays free-form Chinese for humans. Revision is an opaque string the worker derives from file metadata (mtime in nanoseconds, size, inode); the client only compares it for equality. Both sides of the wire are updated together (`proto/` → generated `crates/protocol`, `packages/protocol`, Swift; `buf generate` output committed). Field numbers are new; nothing existing is renamed, renumbered or retyped. **(revised on plan audit)** — the enum was added because today's three failures are distinguishable only by Chinese strings (`ops.rs:292,298,301`), and the wire freezes once the worker ships.
  Rejected: probing existence with `fsList` of the parent directory — no canonical path for dedupe, no file revision, and symlinked entries report `Symlink` rather than what they point at. Rejected: polling unconditional `fsRead` for live follow — re-sends up to 2 MB per tick to a remote device. Rejected: a worker-side file watch subscription — subscription lifecycle across reconnects and lanes for a benefit (sub-second latency) nobody asked for; the worker's own change tracking is already polling (3 s git tick).
  Based on: `crates/worker/src/ops.rs:103` (`safe_resolve`: canonicalise root and target, require target under root; an absolute `rel` replaces the join base, so absolute paths inside the root already work), `crates/worker/src/ops.rs:290` (`read_file_text`, 2 MB cap, lossy UTF-8), `crates/worker/src/device.rs:3354` (fsRead handler), `crates/worker/src/main.rs:811` (3 s poll tick), `proto/coflux/v1/device.proto:552` (`DeviceFsRead`), `proto/coflux/v1/common.proto:160` (`FsReadResult`).

- **The canonical relative path from `fsStat` is the file's identity.** The tab record stores it, the dedupe key is `(workspaceId, canonical relative path)`, the header shows it, and every later `fsRead` uses it. The client never builds its own normalisation of `./`, `..`, `~` or absolute prefixes. (decided while planning) Rejected: client-side string normalisation against `Workspace.path` — cannot see symlinks or `~`, and two spellings of one file would open two tabs.

- **An old worker means no file links and a daemon-outdated file tab on that device, not a fallback.** A worker built before this plan cannot decode `fsStat`: prost leaves the payload empty and the worker answers `empty_payload` without a request id on the elevated lane. Hovering quickly puts several `fsStat` requests in flight, and an old worker answers **each** with its own id-less error, so the attribution follows the **browser-annotations pattern, not the changes pattern**: the router records the channel generation on which `fsStat` proved unsupported plus a count of the stray id-less errors still expected from the requests it failed, swallows those strays, and short-circuits later `fsStat` calls on that generation without sending them (mirror `annotationsUnsupportedNow`). Extending only `isChangesRequest` is wrong: the 2nd..Nth errors would fall through to `reportDeviceError` and raise one global error toast each. The terminal sees only "daemon outdated" from the client and treats references on that device as plain text; generation bookkeeping stays in the router. An old worker still answers `fsRead` but ignores the precondition and sends no status/revision: the client recognises "ok with an empty `revision`" as an old worker and the file tab shows the daemon-outdated state (it does not render that content) — one rule, so the tab and the links agree. The daemon-outdated wording for files is its own copy (the existing `DAEMON_OUTDATED_MESSAGE` talks about 变更). Rejected: an `fsList`-based fallback — a second implementation kept alive for the window the worker hot-push closes anyway; same posture as plan 20260929-changes-file-tree. **(revised on plan audit)**
  Based on: `packages/client/src/device-router.ts:1585-1596` (changes attribution: fails all in flight, no stray count), `:1685-1701` (annotations: `annotationStrayErrors`, `annotationsUnsupportedNow`), `:1357` (`reportDeviceError` for unattributed errors), `:84` (`DAEMON_OUTDATED_MESSAGE`).

- **Existence is checked lazily, per hovered line, with a tri-state cache — and a late answer is never applied to a different line.** The terminal's link provider is only asked about the line under the pointer; that is when the references on it are batched into one `fsStat`. Results are cached per `(workspaceId, raw reference path)`: an existing file for a long TTL, a missing one for a short TTL (an agent may be about to create it), and an RPC failure is not cached. A cache hit answers the provider synchronously. When the answer arrives asynchronously, the provider's callback is invoked only if the pointer is still on that buffer line **and** the line's text equals the text captured at request time (output scrolling at the scrollback cap shifts every line number by one); otherwise the callback is **never called** — not even with `undefined`, which would also be written into the new line's reply map. The next hover hits the cache. TTL values are the executor's call. Rejected: scanning output as it streams — RPC traffic proportional to output volume for links nobody hovers. **(revised on plan audit)**
  Based on: xterm `src/browser/Linkifier.ts:135-148` (`_askForLink` in `@xterm/xterm` 6.1.0-beta.304): a late `provideLinks` callback is written into whatever `_activeProviderReplies` is current, with the position captured at request time — it does not check that the pointer is still on that line.

- **Hover is a colour decoration, not an underline, for both kinds of link.** Every link the terminal provides sets `decorations.underline = false` (pointer cursor stays on). On hover, the link's cell range gets an xterm decoration whose foreground is the terminal palette's blue, `#6b9bd1`, held in one named constant; on leave (and on dispose) it is removed. Not the CSS `--accent` token: in this app it is the dark hover-surface colour `#262624` and would make the link vanish on the `#0a0a0a` terminal paper, and decorations only take a literal `#RRGGBB` anyway. Web URLs therefore move off `WebLinksAddon` onto a provider written here, because the addon's links carry no `decorations` and xterm then always underlines; every current URL behaviour listed under Requirement is preserved. The addon's `LinkComputer` is not exported from its built package, so the URL matcher (regex plus walking wrapped lines, as the addon does) is rewritten in-repo; do not deep-import the addon's TS sources. **(revised on plan audit)**
  Based on: `apps/desktop/src/renderer/index.css:103` (`--accent: #262624`), `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:312` (palette `blue: "#6b9bd1"`), `:341-372` (current URL wiring and its documented `window.open` reasons), `:375-412` (current file-reference provider), `@xterm/xterm` `typings/xterm.d.ts:644-692` (`IDecorationOptions.foregroundColor`, `layer`), `@xterm/addon-webgl` `src/CellColorResolver.ts:76,183` (the WebGL renderer applies decoration foreground colours), `@xterm/addon-web-links` `lib/` (exports only `WebLinksAddon`).

- **A file tab is a layout entry with a local record, exactly like a screen tab.** A new id prefix beside `BROWSER_TAB_PREFIX` and `SCREEN_TAB_PREFIX`; records `{workspaceId, path, line?}` under a new `coflux_file_tabs:${SERVER_URL}` key in `config.ts`, pure module with injected storage, orphans pruned in both directions on restore, a record written no later than the layout that references it. Never synced to the account. The closest twin is `screen-tabs.ts` with `openScreenTab`/`closeScreenTab` in `workbench.tsx`; follow it. Rejected: putting the path into the tab id — ids are sanitised (`createBrowserTabId`) and paths are not id-safe. **(revised on plan audit)**
  Based on: `apps/desktop/src/renderer/components/workbench/terminal-layout.ts:94,105`, `apps/desktop/src/renderer/components/workbench/screen-tabs.ts`, `apps/desktop/src/renderer/components/workbench/workbench.tsx:609-650`, `apps/desktop/src/renderer/config.ts:33-43`.

- **The viewer must not block the main thread on a large file.** Above a size/line threshold the viewer renders plain text without shiki; rows are windowed so a 2 MB file scrolls smoothly. No new dependency: the desktop has no virtual-list library, and the windowing is written in-repo (fixed row height makes it simple). Threshold and technique details are the executor's call. **(revised on plan audit)** Binary detection is client-side: a `\0` in the first 8000 characters of the content means binary (git's heuristic); no proto field.
  Based on: `apps/desktop/src/renderer/components/workbench/diff-highlight.ts:1-5` (shiki core + JS regex engine, single dark theme), `crates/worker/src/ops.rs:305` (lossy UTF-8 keeps NUL bytes).

- **Live follow polls the conditional read only while it can matter.** A file tab polls `fsRead` with its last revision only while it is on screen, the window has focus, and its device is online (read from the store's daemon `online` flag as `browser-view.tsx:294` / `screen-view.tsx:83` do — offline is never inferred from an RPC failure or timeout, which mean "unreachable or slow", `device-router.ts:90`); it reads immediately on becoming visible again, on window focus, and on reconnect. A not-modified answer changes nothing on screen. An update keeps the scroll position (and the selection where practical). Poll interval is the executor's call (order of 1–2 s).

## Direction

Data flows: terminal hover → `fsStat` (via `@coflux/client`, routed to the workspace's device) → link or no link → ⌘+click / 「打开文件」 → workbench opens-or-focuses the file tab with `(workspaceId, canonical path, line)` → the tab reads with `fsRead` and keeps polling while visible.

Preflight: the worktree has no `node_modules`; run `pnpm install` before any TS validation.

Milestones are **sequential, one work package — do not fan out**: M2 needs M1's generated types; M3 and M4 both need M2's client API, and M3's open action is M4's entry point (they meet in `workbench.tsx` / the terminal pane's props).

### Milestone 1: the worker answers `fsStat` and conditional `fsRead`

`device.proto` (and `common.proto` if the result type lives there) carry the additions; `buf generate` output is committed for every target. The worker answers `fsStat` (anchored and scoped like `fsRead`, both directions mapped in the scope tables, batch size capped) and honours the revision precondition. `tests/src/contract.test.mjs` — the retained exec/fs wire-contract suite — gains cases for: `fsStat` on an existing file (canonical relative path, revision), a missing path, a directory, a path escaping the root, an absolute path inside the root; and `fsRead` returning not-modified for a matching revision and full content after the file changes.
Validation: `cd proto && buf lint`; after the generated output is committed, `buf generate` again and `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` → empty; `node scripts/check-protocol-breaking.mjs ".git#ref=11e382e1,subdir=proto"` run from `proto/` with the path adjusted as CI does (`../.git#ref=…`) → exit 0; `cargo build` → zero warnings; `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker` → exit 0.

### Milestone 2: `@coflux/client` exposes stat and conditional read per workspace

Store-level functions in the style of `listWorkspaceChanges` / `readWorkspaceChangeFile`, resolving the workspace's device and returning typed results that distinguish, from the status enum: ok, not-modified, too large, missing, not a file, daemon-outdated (including "ok with empty revision"), and a generic failure. Online/offline is not a result kind — views read the daemon flag. `fsStat` gets annotations-style old-worker attribution.
Validation: `node --import tsx --test packages/client/src/*.test.ts` → exit 0, including `device-router.test.ts` cases proving: with three `fsStat` requests in flight, three id-less `empty_payload` errors on the elevated lane fail all three with the daemon-outdated code, reach `onError` zero times, and leave heartbeat state untouched; a later `fsStat` on the same generation fails immediately without being sent; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 3: terminal links are existence-gated and coloured on hover

File references become links only once `fsStat` confirms a regular file; URLs and file links share the colour hover; the right-click items and ⌘+click open are wired to an "open file" callback the workbench supplies. The pure parts — the existence cache and its TTL/failure rules, the stale-reply guard — get unit tests next to `terminal-file-references.test.ts` only where they encode a rule a regression could silently break.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

### Milestone 4: the file tab

The tab kind, its persisted records and pruning, open-or-focus with line jump, the viewer with its states, and live follow, all as in Requirement and Decisions. Unit tests for the record module mirror `browser-tabs.test.ts` (round trip, pruning both directions, corrupt storage).
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **Late `provideLinks` replies land on the wrong line** — see the existence decision. Symptom if missed: hovering quickly across lines leaves links (and hover colour) at stale cell ranges.
- **Decoration placement needs a marker on an arbitrary buffer line.** `registerDecoration` anchors to an `IMarker`; `registerMarker(offset)` is relative to the cursor line (`buffer.active.baseY + cursorY`), so the offset for a scrollback line is negative. `registerMarker` does **not** refuse an out-of-range offset (`CoreBrowserTerminal.ts:773` adds the marker unconditionally); the caller must keep the target line inside the buffer, or it creates a marker that never renders and never auto-disposes. Dispose decoration and marker on leave.
- **Tab kinds are dispatched by hand in many places, and one of them silently deletes unknown tabs.** `terminal-layout.ts:112` `isTaskTabId` is a deny-list of prefixes, and `reconcileLayout` (`:717`, removal near `:725`) removes every tab id that is neither browser nor screen and not in the task list — a file tab missing from those checks survives restore and is then deleted when the first task list arrives. Other dispatch points: `workbench.tsx` around `:351-353` (restore order browser → screen), `:460`, `:470`, `:479-481`, `:538-542`, `:752`, `:1189`, `:1211`, `:1393-1397`; `workspace-terminal.tsx:893-894`. Grep for `isScreenTab`/`SCREEN_TAB_PREFIX` and treat every hit as a place the file kind must be handled.
- **The terminal context menu's link items are fed by one untyped ref.** `menuLink` comes from `hoveredLinkRef`, written only by URL hover (`terminal-pane.tsx:222,361,975`). File-link hover must record a typed value (URL vs file with its canonical path), or right-clicking a file shows the three URL items.
- **`WebLinksAddon`'s default activation is broken in this app** — the comment at `terminal-pane.tsx:345-351` explains why activation must call `window.open(url, "_blank", "noopener")` with the URL; keep that when replacing the addon.
- **Old-worker attribution is shared with heartbeat, annotations, executor and changes** (`device-router.ts:1550-1600`). Extend the existing elevated-lane branch; do not add a new branch that claims id-less errors on the session lane.
- **The worker's scope tables are exhaustive by hand.** A new payload not listed in `required_scope` / the response mapping (`crates/worker/src/device.rs:4735`, `:4805`) is rejected or unrouted; the request-id get/set/clear tables near `:4623`, `:4654`, `:4874` must list the new pair too.
- **Never `display: none` a `<webview>` or its ancestors** (`docs/design-guidelines.md`): if the file tab's mounting touches the shared view-hosting code in `workbench.tsx`, do not change how hidden browser tabs are kept alive.
- **Desktop UI rules** in `docs/design-guidelines.md`: `Tooltip` instead of native `title`; type scale 13/12/11 px; lucide icons; file icons only from the vendored Catppuccin set (if the tab shows one, use `changes-file-icon.tsx`).
- `clippy` is not a gate in this repository; do not chase its baseline errors.
- Black-box suites hardcode ports: never run two `pnpm -C tests test` at once on one machine.

## Merge and deploy

- **Release order: worker before desktop.** A desktop from this branch against an old worker shows no file links (by design) — not broken, but the feature is invisible until the worker hot-upgrades. No server change, no migration, no centre deployment.
- The fsRead wire contract changed: `pnpm -C tests test` (contract suite) must pass before merge; CI runs only the compile-level gates.
- Release notes must mention the behaviour change: ⌘+click on a file path now **opens** it instead of copying it (copy moved to the right-click menu), and terminal links no longer underline on hover.
- Rollback: revert the desktop; the protocol additions are inert for an older desktop.

## Scope

In scope:
- `proto/coflux/v1/device.proto`, `proto/coflux/v1/common.proto`, and the committed generated output in `crates/protocol/src/gen`, `packages/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `crates/worker/src/device.rs`, `crates/worker/src/ops.rs`
- `packages/client/src/` (device router, store, their tests)
- `tests/src/contract.test.mjs`
- `apps/desktop/src/renderer/components/workbench/` (terminal pane and link helpers, layout, new file-tab modules, workbench wiring, tests)
- `apps/desktop/src/renderer/config.ts` (the file-tab storage key)

Out of scope:
- `apps/server` — the Device channel is end-to-end; the centre does not parse payloads
- `apps/desktop/src/main` and the preload bridge — reading goes through the device RPC, no new IPC
- iOS / Swift client code beyond regenerated protocol files
- `apps/desktop/package.json` and the lockfile — no new dependency (windowing and URL matching are written in-repo)
- Editing, Markdown/image rendering, ⌘P search, other entry points — product non-goals
- `crates/supervisor` / shell integration (OSC 7 cwd tracking) — accepted limitation

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + generate | `cd proto && buf lint && buf generate` then `git status --porcelain` on the three generated dirs | exit 0, no diff |
| Protocol breaking | from `proto/`: `node ../scripts/check-protocol-breaking.mjs "../.git#ref=11e382e1,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Wire contract (acceptance) | `pnpm -C tests test` (needs local Postgres via `pnpm dev:pg`) | exit 0 |
| UI walkthrough (acceptance) | desktop dev preview against a local stack running this branch's worker (desktop-preview skill); done by the user | the "done, as the user sees it" list holds |

## Done criteria

- [ ] All listed commands pass (acceptance rows by the verifier; the UI walkthrough is the user's).
- [ ] Hovering an existing workspace file reference colours it with no underline; ⌘+click opens a file tab scrolled to and highlighting the line; a second ⌘+click on the same file (any spelling that resolves to it) focuses the same tab.
- [ ] A missing path, a directory, and a path outside the workspace produce no link, no colour and no hint.
- [ ] URLs keep every current behaviour and lose the underline.
- [ ] An open file tab updates within a poll interval after the file changes on disk, keeping scroll position; not-modified polls repaint nothing.
- [ ] The too-large, binary, deleted, offline and daemon-outdated states each render their copy.
- [ ] File tabs survive an app restart **and the arrival of the first task list after it** (the `reconcileLayout` path); a tab whose workspace is gone is pruned.
- [ ] Right-clicking a file link shows 「打开文件」/「复制路径」, never the URL items; right-clicking a URL still shows the URL items.
- [ ] Against an old worker: no file links, no error toast however fast the pointer moves, and an open file tab shows the file-specific daemon-outdated copy.
- [ ] The contract suite covers `fsStat` and the conditional read; the router test covers old-worker attribution of `fsStat`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (in particular: the old-worker answer to an unknown payload carries a request id or a code other than `empty_payload`; xterm's `Linkifier` already guards late replies; the WebGL renderer ignores decoration foreground colours).
- The outcome requires out-of-scope files (e.g. a main-process IPC or a server change).
- A validation command fails twice after one reasonable fix.
- `buf breaking` reports a breaking change — the additions were meant to be purely additive.

## Maintenance notes

- Plan audit (fable, 2026-10-01) revised: typed `fsRead` status enum; hover colour pinned to `#6b9bd1` (not `--accent`); annotations-style old-worker attribution with stray counting and an "ok with empty revision" rule for `fsRead`; stale-reply guard never calls back and also compares line text; screen-tabs as the twin and `config.ts` in scope; no new dependency; tab-kind dispatch, context-menu ref and `registerMarker` landmines; `pnpm install` preflight; generate-validation wording; offline from the daemon flag. No finding was rejected.

- `fsStat` is the general "does this workspace path exist, and what is it canonically" primitive; future entry points (⌘P, changes view "open file") should reuse it and the file tab rather than grow parallel paths.
- If OSC 7 cwd reporting is ever added to the shell integration, relative-path resolution should prefer the terminal's live cwd; the canonical-path identity stays the same.
