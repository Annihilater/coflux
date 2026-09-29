# Plan 20260929-browser-annotations: annotate elements in the built-in browser tab and hand them to the workspace's agents

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 90095a31..HEAD -- proto crates/protocol crates/worker/src crates/cli/src packages/protocol packages/client/src packages/cli apps/server/src/hub.ts apps/desktop/src packages/cli/skills integrations/claude-plugin docs/design-guidelines.md`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH — new wire messages, the first per-workspace on-disk store in the worker, and script injection into guest pages
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives on `dev/20260929-browser-annotations` in `.claude/worktrees/20260929-browser-annotations`
- Planned at: `90095a31`, 2026-09-29

## Requirement

While looking at a workspace's dev server in the desktop's built-in browser tab, the user wants to point at "this element, change it like so" and have the workspace's coding agent (Claude Code, Codex in a coflux terminal) pick it up with enough context to find the code — instead of describing the element in words or pasting screenshots by hand. The idea comes from web-annotator (a fork of Vibe Annotations: a Chrome extension + a local Node MCP server on port 3846). **None of its code is reused**: upstream switched from MIT to PolyForm Shield 1.0.0 in `1cf069c` (2026-03-25), whose noncompete clause forbids exactly this kind of competing product, and the fork deleted the required notices without changing the terms. Its architecture does not fit either (MCP was removed from coflux; a second resident server; Chrome-only APIs). Only the ideas carry over: element picking, element context with framework source identity, a markdown hand-off shape, and the "agent resolves, user reviews" loop.

### Product conclusions (confirmed with the user)

1. **Who and when**: someone in the desktop app with a workspace's page open in a browser tab, who wants to mark precise changes for that workspace's agent.
2. **Form**: persistent annotations **owned by the workspace**, stored by the worker on the device that hosts the workspace, surviving app and daemon restarts until confirmed or deleted. Every desktop of the account that opens the workspace sees them, including for remote workspaces. Any http(s) page in the browser tab can be annotated, not only localhost.
3. **Content of one annotation**: the comment; auto-captured element context (a locator, DOM path, text excerpt, key computed styles, page URL); **source identity** — React/Vue component name chain, plus file and line when the page exposes them (React ≤ 18 dev builds), omitted when unavailable; **images** — an automatic screenshot of the element on save plus reference images the user pastes or attaches, stored on the workspace's device.
4. **Interaction**:
   - A toggle button with a count (「✎ n」) in the browser toolbar. When on: hovering highlights elements, clicking one opens a comment card anchored to it; several elements can be annotated in a row; Esc leaves the mode.
   - Existing annotations show as numbered pins on their elements, following them as the page scrolls.
   - A right-hand side panel lists all of the workspace's annotations grouped by page; each can be edited, deleted, or clicked to navigate to its page and element. The panel offers 「复制为 markdown」.
5. **Lifecycle**: `pending` → the agent runs `coflux annotations resolve <id> --note "<what changed>"` → **resolved**: the pin switches to a check style and the panel shows the agent's note. The user then either **confirms** (deletes it), or **reopens** it with an added comment (back to `pending`); 「清除全部已完成」 deletes every resolved one.
6. **Agent side**: `coflux annotations list` (the current workspace's pending annotations as markdown, images as absolute file paths), `coflux annotations watch` (blocks until there are new pending annotations — hands-free mode), `coflux annotations resolve <id> --note`. The coflux skill documents them. The side panel's 「交给 agent ▾」 lists the workspace's terminals that are running an agent; choosing one types a short instruction (e.g. 「处理 coflux 批注」) into that terminal without stealing focus or switching tabs.
7. **States**: empty (the panel says to turn on annotate mode and click an element); device offline (list is read-only from what was last loaded, with an offline notice, no new annotations); screenshot or source identity failure (silently omitted, never blocks saving); save failure (the card keeps its input, retry possible); element not found on the current page (no pin; the panel marks it 「元素未找到」); device running an older coflux (a readable 「该设备 coflux 版本过旧」 notice instead of a broken panel).
8. **Non-goals**: the design-tweak panel (live property editing, pending_changes diffs) and Variants — later slices; MCP or any separate server; the system browser / a Chrome extension; iOS; .html/.json export and import; agents creating annotations from inside the page (`window.__annoAnnotations`); reusing web-annotator code.
9. **Observable when done**: in a local and a remote workspace's browser tab, annotate two elements each with comments and an attached image — pins appear, the panel lists them, and they are still there after restarting the app; a second desktop opening the same workspace sees them; 「交给 agent」 into an agent terminal makes the agent run `list` and receive the annotations with image paths and component names; after the agent edits code and runs `resolve`, the pin turns into a check within seconds; confirming removes the annotation; reopening returns it to pending.

## Decisions & tradeoffs

- **Native implementation, ideas only**: build everything inside coflux; do not copy, translate file-by-file, or vendor web-annotator code, and do not load it as an Electron extension. Rejected: `session.extensions.loadExtension` of the upstream build — license (PolyForm Shield noncompete + notice requirement), a second resident server on :3846, and Chrome-only screenshot APIs that Electron lacks. Based on: upstream `LICENSE` at `1cf069c` of github.com/myWsq/web-annotator; `apps/desktop/src` has no `loadExtension` use; `wiki/plans/20260924-desktop-browser-tab.md:56` (extensions a non-goal).

- **Custody on the workspace's device, in the worker, on disk**: annotations and their image files live under `$COFLUX_HOME/annotations/<workspaceId>/` (an index file plus one file per image), written atomically (temp file, fsync, rename, directory fsync — the stronger of the two existing local copies, `crates/worker/src/local_auth.rs:833-865`; its byte-level write is bound to `encode_store`/`LocalState` today, so extract that part into a shared helper — a small refactor — rather than writing a third copy). Owner-only permissions. Deleting an annotation deletes its image files. Rejected: storing on the desktop — agents could not read annotations while the desktop is closed and other desktops could not see them. Rejected: the center/Postgres — see the next decision. Based on: the worker persists nothing per workspace today (only `credentials.json`, `conn-state.json`, `executor-settings.json`, … under `$COFLUX_HOME`); `crates/worker/src/executor_settings.rs:121-146` is the weaker copy.

- **Content travels only end to end over the device channel; the center never sees comment text, context, or images**: desktop ↔ worker CRUD and image read/write are new, dedicated request/response `DeviceEnvelope` payloads. None of them may be listed in `worker_operation_id`, because listed responses are reported to the center as `DeviceOperationReport.result_frame`; for the same reason images must **not** travel as `fsWrite`/`fsRead` (`FsWrite` is in that list). Rejected: fanning content out through the center as a snapshot (the `SessionAgents` shape) — the center would hold user content; reusing fs payloads for images — leaks to the center. Based on: `proto/coflux/v1/device.proto:865-923` (envelope oneof; tags ≥ 100 free), `crates/worker/src/device.rs:3963-3968` (`worker_operation_id`, `FsWrite` listed) and `:2995` (`report_operation`), `packages/client/src/device-router.ts:1939` (generic `request`), `:2213-2222` (`fsRead`/`fsWrite`).

- **Annotation requests use scope `SESSION_CONTROL`, not `RPC`** *(revised on plan audit)*: a local workspace's annotations must keep working when the center is unreachable (local-first), and `RPC` exists only while the worker holds an online center lease; the local offline grant carries only `SESSION_READ + SESSION_CONTROL`. `SESSION_CONTROL` already lets its holder type into every terminal, so granting it annotation read/write widens nothing. Reach a device the user has not selected the way `answerSecret` does (transient demand on the session lane). Consequence: with the center down, a local workspace's panel still loads, saves and resolves; only cross-desktop live refresh (the summary) pauses. Rejected: `RPC` like fs — adds a center dependency to a purely local loop. Based on: `crates/worker/src/local_auth.rs:565-579` (lease scopes only while `server_online`), `:617-619`, `apps/server/src/local-control.ts:152`, `crates/worker/src/device.rs:4118-4125` (executor host and `SecretAnswer` chose `SessionControl` for this reason), `packages/client/src/device-router.ts:2244-2262` (`answerSecret` transient demand).

- **"Older worker" is recognised only from its explicit reply, never from a timeout** *(revised on plan audit)*: an older worker answers an undecodable payload with `DeviceError{code:"empty_payload"}` **without a request_id**, which today surfaces as a generic error toast while the pending request waits out its 20 s timeout. The router must attribute a request-id-less `empty_payload` arriving on the lane while annotation requests are in flight to those requests, fail them with a distinct "unsupported" result, remember it for that route, and not raise the generic toast for it — the classification the loopback tunnel already uses. A timeout is always "unreachable/slow", never "unsupported". Based on: `crates/worker/src/device.rs:1878-1884`, `packages/client/src/device-router.ts:43` (`DEVICE_REQUEST_TIMEOUT_MS`), `:1476-1490`, `:1566` (`reportDeviceError`), `apps/desktop/src/main/loopback-tunnel.ts:89-98` (`classifyLaneError`).

- **Live updates: a metadata-only snapshot through the center, content fetched over the device channel**: the worker publishes, per workspace, a revision number and pending/resolved counts — no text, no ids that reveal content — as an idempotent full snapshot sent on change and unconditionally after auth, exactly like `SecretRequests`/`PortsUpdate`. The center keeps it in memory only, validates workspaces against its catalog, clears it on daemon disconnect, re-sends it on client subscribe, and forwards it to the account's clients. The center validates each workspace id asynchronously (`store.getWorkspace` plus a `daemonId` match — there is no in-memory workspace catalog) and re-checks that the connection is still the daemon's current one after the await before writing its map, so a reconnect race cannot resurrect a stale snapshot. A desktop showing that workspace refetches over the device channel when the revision changes; the toolbar count comes from the snapshot, so it needs no device lane. Rejected: device-channel push — lanes exist only while a route has demand, so desktops without an open lane would miss changes. Based on: `proto/coflux/v1/daemon.proto:107` (`SecretRequests`) and `:333`, `crates/worker/src/main.rs:1527-1528` (publish after auth), `apps/server/src/hub.ts:540`, `:1917-1933`, `:2369` (accept/validate/broadcast), `:1002-1012` (workspaces read from the store; `isCurrentDaemon` re-check), `packages/client/src/device-router.ts:1197` (`releaseIdle`).

- **Page instrumentation: the main process drives the guest over CDP (`webContents.debugger`), in an isolated world**: the in-page script is registered with `Page.addScriptToEvaluateOnNewDocument` into a named isolated world (and evaluated into the current document when turned on); the guest → main channel is a `Runtime.addBinding` scoped to that world's execution context; framework source identity is read by main in the page's **main** world on the resolved node (`DOM`/`Runtime.callFunctionOn`), so no request/response handshake is exposed to page scripts. The in-page script only does hover highlight, hit-testing, rect reporting and pins (inside a closed shadow root). The comment card, attachments and the side panel are renderer UI (coflux components) layered over the `<webview>`, anchored to rects the page reports. The element screenshot reuses main's existing capture + `cropRectInPixels` crop (DPR handled there) rather than a second capture path. **Only the top-level frame is annotatable** in this slice (cross-origin iframes are separate CDP targets). The guest keeps **no preload** and `gateWebview`'s hardening stays exactly as is. Rejected: a guest preload — undoes the hardening; `executeJavaScript` injection — has no guest → main channel short of polling; an in-page floating toolbar (web-annotator style) — splits the UI system and blocks the page; the comment input inside the page — IME and design-system consistency are the renderer's. Based on: `apps/desktop/src/main/browser-host.ts:644-670` (`gateWebview` deletes preload), `:865-899` (`capturePage`), no `debugger`/`executeJavaScript` use in `apps/desktop/src` today, `apps/desktop/src/renderer/components/workbench/browser-view.tsx:925-962` (existing overlay over the webview), `apps/desktop/src/main/browser-host.ts:875-897` (capture + crop). A headless Electron 44.3.0 probe during the plan audit confirmed: world-scoped script + binding work, the binding is invisible to the main world, both survive navigation, and a detached DevTools did not detach the debugger — the app's docked `setDevToolsWebContents` variant is still unverified.

- **Workspace identity is the coflux workspace id, matched exactly** *(decided on plan audit)*: a browser tab's annotations belong to the tab's `workspaceId`; an agent sees the annotations of its **effective** workspace (cwd longest-prefix match). An agent that moved into a worktree workspace therefore sees that worktree's annotations, not its parent's — intended. 「交给 agent ▾」 lists terminals running an agent in the tab's workspace; `list` always prints which workspace it resolved, so an empty result is self-explaining. Based on: `crates/worker/src/agent_ctl.rs:718-748`.

- **Agent commands over the local agent socket, Rust CLI first**: `coflux annotations list|watch|resolve` are `annotations.*` actions on `/agent` via `$COFLUX_HOME/ipc/agent.sock`, resolved to the caller's **effective workspace** with the same rules as other local commands; the npm CLI forwards `annotations` to the native binary like it does `agent`/`secret`. `watch` has the `terminal wait` shape: the worker blocks each round ≤ 20 s on a change signal, the CLI loops until something new is pending or its overall timeout ends. `list` prints markdown by default (per annotation: comment, component chain / source, page, locator, element excerpt, image paths labelled as current-state screenshot vs reference) and `--json` for machines; it also tells the agent to `resolve` each annotation after implementing it and to map raw values to the project's design system. Rejected: MCP — removed from coflux; any path through the center — local-first. Based on: `crates/cli/src/gateway.rs:319-347` (`agent_post`, socket first), `crates/worker/src/hook.rs:471-651` (`handle_agent`), `crates/worker/src/agent_ctl.rs:718-748` (`resolve_scope`), `:985-1040` (`wait_in_session`, `WAIT_ROUND_MAX`), `packages/cli/coflux.mjs:12-25` (forward list).

- **Protocol changes are additive, defined once in `proto/`, generated for Rust, TS and Swift**; `DEVICE_PROTOCOL_VERSION` and `CONTROL_PROTOCOL_VERSION` do not change. An older worker answers the new device payloads with `DeviceError{code:"empty_payload"}` — the desktop turns that into the "version too old" state. An older center ignores the new daemon message (its `switch (msg.payload.case)` has no default), so no capability gate is needed for the snapshot. Based on: `crates/protocol/src/lib.rs` (`DEVICE_PROTOCOL_VERSION = 1`, `CONTROL_PROTOCOL_VERSION = 2`), `proto/coflux/v1/device.proto:761-763`, `apps/server/src/hub.ts:2178`.

- **No new black-box test**: every break here is visible the first time the feature is used, and "the center never sees content" is guaranteed structurally by the snapshot having no content fields. Cheap Rust unit tests for the store (round trip, atomic replace, image cleanup on delete, id/path validation) and TS unit tests for pure helpers (markdown rendering, locator scoring) are welcome; desktop unit tests must be named `*.test.ts` in a directory the `test` glob covers. Based on: `AGENTS.md` "Test harness"; `apps/desktop/package.json:13` (test glob).

- **Left to the executor**: which locator fields to store and how to re-find an element (selector, DOM path, text fingerprint, scoring); message and field names; image encoding and size budget (one device frame is ≤ 30 MiB, `crates/protocol/src/lib.rs` `MAX_DEVICE_FRAME_BYTES`; the terminal paste path compresses to 3.5 MiB, `terminal-pane.tsx:86`); highlight/pin/check visuals per `docs/design-guidelines.md`; how 「交给 agent」 delivers its text (desktop input path or a worker-side path), subject to: no focus steal, no tab switch, a readable error when a human holds the terminal; how the offline read-only list is cached (memory is enough).

## Direction

Data flow:

```text
page (isolated world: highlight, hit-test, rects, pins)
   │ Runtime.addBinding                    ▲ Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate
   ▼                                        │
desktop main (webContents.debugger, capturePage, main-world source read) ──IPC──▶ renderer (toggle, card, side panel)
renderer ──device channel (RPC, E2E): list/get/put/delete/resolve-by-user, image read/write──▶ worker
worker ──disk: $COFLUX_HOME/annotations/<workspaceId>/ (atomic index + images)
worker ──AnnotationsSummary {workspace, revision, pending, resolved} (no content)──▶ center (memory) ──▶ desktops
agent ──coflux annotations list|watch|resolve──▶ CLI ──agent.sock──▶ worker (effective workspace)
```

Follow existing conventions: the idempotent-snapshot pattern of `SecretRequests`; the typed device-router methods (`fsRead`/`fsWrite`, `answerSecret`) and their store wrappers; the browser-host IPC style (channel names in `apps/desktop/src/shared/ipc.ts`, `isTrustedRendererUrl` + `hostWebContents === sender` checks, preload wrappers, bridge types in `apps/desktop/src/shared/desktop-bridge.ts`); `docs/design-guidelines.md` (Tooltip component, never a native `title`; never `display:none`, move or re-key a `<webview>`); English for new code comments, the skill and docs.

### Milestone 1: protocol, worker store and agent commands

The new device payloads and the summary snapshot exist in `proto/` and are generated for all targets. The worker stores annotations per workspace on disk, serves the device requests, publishes the summary (on change and after auth), and serves `annotations.list|watch|resolve` on `/agent` for the caller's effective workspace; the Rust CLI has `coflux annotations list|watch|resolve` (markdown and `--json`), and the npm CLI forwards `annotations`. Every new request/response pair is registered in all of the worker's dispatch tables (`request_id`, `set_response_request_id`, `clear_request_id`, `required_scope`, `response_required_scope` in `crates/worker/src/device.rs:3985-4172`) — a missing entry fails as a missing request id or `unsupported_payload`. Validation: `cd proto && buf lint && buf generate` leaves no diff in the generated dirs; `node scripts/check-protocol-breaking.mjs "../.git#ref=90095a31,subdir=proto"` (run from `proto/`) passes; `cargo build --release -p coflux-worker -p coflux-cli` has zero warnings; `cargo test -p coflux-protocol -p coflux-worker -p coflux-cli` passes (see the landmine on `COFLUX_HOME`).

### Milestone 2: center fan-out and client store

The center accepts, validates, keeps in memory, clears on disconnect, re-sends on subscribe and forwards the summary; `packages/client` exposes per-workspace annotation summaries in its store and typed device-router + store methods for every annotation request, surfacing an older worker's `empty_payload` as a distinct "unsupported" result per the decision above; the new payloads are registered in `requestIdOf`, `responseRequestId` and `normalizePayload` (`packages/client/src/device-router.ts:2562-2606`). Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` passes; `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` reports no errors outside `src/connection.test.ts` (red at the baseline — do not touch it).

### Milestone 3: page instrumentation in the desktop main process

Main can, per browser guest: attach the debugger, install the isolated-world script so it survives navigations, relay hover/pick/rect/pin-click events to the renderer, render/refresh pins for a given set of annotations, capture an element screenshot, and read framework source identity in the main world — all behind new trusted IPC channels. Detach cleanly when the guest goes away. Must coexist with the docked DevTools (see landmine). Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` pass.

### Milestone 4: desktop UI and 「交给 agent」

The toolbar toggle with count, annotate mode, the anchored comment card with attachments (paste/choose; automatic element screenshot), the side panel (grouped by page, edit/delete/navigate, resolved section with the agent's note, confirm / reopen-with-comment / 清除全部已完成, 复制为 markdown), 「交给 agent ▾」, and every state in Requirement 7. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` pass.

### Milestone 5: skill

`packages/cli/skills/coflux/SKILL.md` documents `coflux annotations` — when to use it, the resolve-after-implementing discipline, that images are local paths, design-system mapping, `watch` for hands-free mode — in English, without repeating what the CLI help already says; the plugin copy is synced and the plugin version bumped. Validation: `node scripts/sync-claude-plugin.mjs` leaves both skill copies identical.

Dependencies: milestone 1 gates everything (generated types, the wire). After it, milestones 2, 3 and 5 are independent of each other; milestone 4 needs 2 and 3.

## Landmines

- **CDP vs. the docked DevTools on the same guest.** The browser tab's DevTools is a second `<webview>` wired with `setDevToolsWebContents`/`openDevTools` (`apps/desktop/src/main/browser-host.ts:905-921`). Verify first, before building on it, that `webContents.debugger.attach` succeeds and keeps working while that DevTools is open and after it is closed/reopened, in Electron 44 (`apps/desktop/package.json:49`). If it cannot coexist, that is a STOP: the isolated-world/binding direction needs revisiting.
- **Attaching the debugger before the guest has a frame hangs**: in the audit probe, `sendCommand("Page.enable")` on a guest that had not loaded any URL never returned. Main receives the guest at `did-attach-webview` (`apps/desktop/src/main/browser-host.ts:129`, `:672`), before navigation. Attach only after the guest's first `dom-ready`/`did-navigate`, bound every `sendCommand` with a timeout, and redo it for every new `webContents` id.
- **The in-page script runs at document start**: the DOM may not exist yet; it must wait for it. Same-process iframes also receive the script — it must act only in the top-level frame.
- **`packages/client` typecheck is red at the baseline** (errors in `src/connection.test.ts` at `90095a31`); judge only new errors.
- **The guest is re-created on some moves**: a `<webview>` must never be hidden with `display:none`, moved or re-keyed, and preparation must finish before navigation (`docs/design-guidelines.md:40-42`; `browser-view.tsx:329-374`). Debugger attachment and script registration must follow the guest's lifetime (new `webContents` id → attach again), not the tab's.
- **`worker_operation_id` leaks to the center**: any payload listed there has its result frame reported to the center (`crates/worker/src/device.rs:3963`, `:2948`, `:2995`). Annotation responses must not be listed.
- **The worker's workspace table is not persisted** and is filled only from the center's `WorkspaceList` (`crates/worker/src/main.rs:113-115`, `:1727-1735`). The store must key by workspace id and must not require the table to read or list existing annotations; resolving a workspace root is only needed for effective-workspace matching of agent callers.
- **Remote workspaces**: images must be written to and read from the workspace's device (the agent there reads them by path), and a remote tab's `localhost` is that device — the element screenshot is still taken on this Mac by `capturePage` and then shipped over the device channel.
- **Source identity is best effort**: React 19 removed `_debugSource`; only component names are available there. Do not add a build plugin or require one. Reading page internals must never throw into the page or block saving (bounded time).
- **Local cargo tests are polluted by running inside coflux**: run worker/supervisor tests as `COFLUX_HOME= cargo test …`; `cargo test` fail-fast skips later crates, and piping output hides the exit code.
- **Desktop unit test glob skips `.tsx`** and only covers the directories listed in `apps/desktop/package.json:13`.
- **Plugin delivery**: the skill's only source is `packages/cli/skills/coflux/SKILL.md`; the plugin copy is generated by `node scripts/sync-claude-plugin.mjs` and CI checks they match; bump `integrations/claude-plugin/.claude-plugin/plugin.json`. Everything in the plugin directory must be English.
- **Bash in this environment is zsh**: `"$VAR:path"` triggers modifiers — write `${VAR}:path`.

## Scope

In scope:
- `proto/coflux/v1/*.proto` and the generated `crates/protocol/src/gen`, `packages/protocol/src/gen`, `packages/swift-client/**/Generated`
- `crates/worker/src/**` (new store module, device handlers, agent actions, summary publishing, shared atomic-write helper)
- `crates/cli/src/**`, `packages/cli/coflux.mjs`
- `apps/server/src/hub.ts` (and server files it needs for the summary)
- `packages/client/src/**`
- `apps/desktop/src/**`, `apps/desktop/package.json` (only to extend the `test` glob)
- `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin/**` (sync + version bump)
- `wiki/plans/README.md`, this plan

Out of scope:
- `crates/supervisor/**`, `transport/**`, `apps/server` persistence/migrations — the summary is memory-only
- `tests/**` — no new black-box test (see Decisions)
- iOS / Swift client code beyond regenerated protocol files
- Design-tweak panel, Variants, export/import, in-page agent API — non-goals
- Any web-annotator code

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (first) | `pnpm install --frozen-lockfile` | exit 0 |
| Proto lint / generate | `cd proto && buf lint && buf generate && git diff --exit-code -- ../crates/protocol/src/gen ../packages/protocol/src/gen` (after committing generated code) | exit 0 |
| Proto breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=90095a31,subdir=proto"` | exit 0 |
| Rust build | `cargo build --release -p coflux-worker -p coflux-cli` | exit 0, zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker -p coflux-cli` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | no errors outside `src/connection.test.ts` (baseline red) |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Skill sync | `node scripts/sync-claude-plugin.mjs && git diff --exit-code -- integrations/claude-plugin` | exit 0 |
| Black-box core | `pnpm -C tests test` (protocol touched) | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` with a daemon built from this branch, per `docs/desktop-acceptance.md` | the user walks through Requirement 9 |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Every product conclusion in Requirement is implemented, including all states in 7; nothing from 8 is.
- [ ] Annotation content (comment, context, images) never appears in any center-bound message; the summary carries only workspace id, revision and counts.
- [ ] Annotations persist across a worker restart; deleting or confirming removes their image files.
- [ ] `coflux annotations list` in a coflux terminal returns only the caller's effective workspace's pending annotations, with absolute image paths and source identity when available; `resolve` flips the pin to resolved on every open desktop.
- [ ] Guests still have no preload and `gateWebview` is unchanged; the debugger coexists with docked DevTools.
- [ ] An older worker yields the readable version-too-old state from its `empty_payload` reply, with no generic error toast; a timeout never yields that state.
- [ ] With the center unreachable, a local workspace's annotations still load, save and resolve.
- [ ] Images never travel as `fsWrite`/`fsRead`, and no annotation payload is in `worker_operation_id`.
- [ ] No web-annotator code is present.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- `webContents.debugger` cannot coexist with the docked DevTools (`setDevToolsWebContents`), or cannot inject into an isolated world with a binding, in the shipped Electron version.
- The outcome requires out-of-scope files (e.g. supervisor, server persistence).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Later slices (design-tweak panel with pending_changes diffs, Variants) extend the same store and the same hand-off; keep the annotation record extensible (optional fields) so they need no migration of existing files.
- If annotations ever need to reach the account CLI across devices (`--remote`), it must go end to end like `device exec`, never by storing content in the center.
- Iframe content is not annotatable in this slice; supporting it means `Target.setAutoAttach` and per-target scripts.
- Upstream web-annotator may be read for ideas only; do not paste or port its code (PolyForm Shield 1.0.0 since `1cf069c`).
