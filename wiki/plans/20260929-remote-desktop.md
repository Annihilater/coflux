# Plan 20260929-remote-desktop: View and control a remote Mac from a native "屏幕" tab

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 00a3fc26..HEAD -- proto/ crates/worker/src crates/protocol apps/server/src apps/desktop packages/client/src transport/tailcat scripts .github/workflows package.json`

## Status

- Priority: P2
- Effort: L
- Risk: HIGH
- Depends on: none
- Category: feature
- Execution: subagent(fable) — departure check in `dev:explore`, 2026-09-29
- Stop after: implementation — departure check (plan audit, then execute without pausing)
- Plan review: audit — departure check
- Workspace: current — already in the linked worktree `/Users/wsq/Workspace/coflux/.claude/worktrees/20260929-remote-desktop` on `dev/20260929-remote-desktop` (inspected `<dev-workspace>`, pending 0)
- Planned at: `00a3fc26`, 2026-09-29

## Requirement

The user wants to use another of their Macs (Home / Work) as a working machine for hours at a time from inside Coflux Desktop — see it, drive it with keyboard and mouse, copy and paste across — without installing any other app. RustDesk and every other external remote-desktop app were explicitly rejected: the feature must be a native Coflux tab.

Product conclusions (confirmed by the user at the product gate; do not reopen):

- **Form.** A new tab kind, 「屏幕」, living in the device detail page's tab strip. Not a separate window, not a separate app.
- **Entry points.** A third item 「屏幕」 in the device page's ＋ / ⌘T new-tab menu; 「打开屏幕」 in the sidebar device row's menu; the command palette. The entry is not offered for the local device, for non-macOS devices, or for devices whose runtime was not started by Coflux Desktop (headless `cofluxd` installs) — i.e. only where the device advertises the screen capability (see Decisions).
- **Tab body.** The remote picture fills the tab. The remote virtual display's resolution follows the tab's size in points, HiDPI, 1:1 — no scaling except transiently while resizing. A thin status bar at the top shows connection state (直连 / 中继 and latency), an 「沉浸」 toggle and 「断开」.
- **Immersive mode.** Hides the sidebar and tab bar and puts the window into full screen; the remote virtual display grows to match. Hovering the top edge reveals the status bar with an exit control.
- **Keyboard.** While the picture has focus, every in-app key combination goes to the remote — including ⌘W, ⌘T, ⌘Q, ⌘1–9, ⌘C/V. Exactly one combination stays local: ⌃⌥⌘F, which toggles immersive mode (decided while planning: toggles both ways, works in tab mode too). The user leaves the picture by clicking the tab strip or sidebar. System-level shortcuts (⌘Tab, ⌘Space, Mission Control) stay with the local OS in this version.
- **Remote display.** Each connection creates a virtual display on the remote Mac as the main display; any lit physical display mirrors it, so both sides see the same thing. This must work with the lid closed or with no physical display awake. While connected, the remote must not idle-sleep or auto-lock. Closing the tab removes the virtual display and restores the remote's previous display arrangement.
- **Lifecycle.** A visible tab connects automatically. A background tab pauses the stream but keeps the session and the virtual display (remote window positions must not be reshuffled by tab switching). Network loss reconnects automatically; the remote keeps an orphaned session for 10 minutes before ending it. Only closing the tab ends the session. After an app restart the tab is restored and reconnects when it becomes visible.
- **Concurrency.** One client at a time per remote device. Opening the screen from a second client takes over; the first shows 「已被其它客户端接管」 with 「重新接管」, the same interaction as a taken-over terminal.
- **States with copy.** Connecting; device offline; remote missing Screen Recording or Accessibility permission (name which one and where to enable it on that Mac; the remote side also raises the system permission request so it can be completed with one click by someone at that Mac; when only Accessibility is missing the picture is shown read-only); remote locked (「需要在那台 Mac 上解锁」 — remote unlock is not supported); taken over; relay (status bar says 中继, quality lowered automatically).
- **MVP.** Picture, keyboard and mouse control, bidirectional clipboard (text and images), virtual display + mirroring, idle-lock prevention, takeover, permission guidance, immersive mode.
- **Non-goals.** Remote audio; choosing among multiple remote displays; intercepting system-level shortcuts; unlocking or the login window; Linux/Windows or headless-`cofluxd` Macs as the controlled side; multiple simultaneous viewers; file drag-and-drop transfer; an agent-facing screenshot/control API.

What the user can observe when done:

1. From one Mac, open Home's screen: with Home's lid closed there is still a picture; typing, clicking and ⌘C/⌘V act on the remote; text on the remote is as crisp as local text.
2. Resizing the window or entering/leaving immersive mode changes the remote resolution to match.
3. Switching away from the tab and back leaves remote windows where they were; closing the tab restores the remote's display arrangement.
4. Opening the same device's screen from a second computer takes over; the first shows the takeover banner.
5. With a permission missing on the remote, the controlling side names it and the remote shows the system request; once granted, the tab connects by itself.

## Decisions & tradeoffs

- **Native, self-built pipeline; no third-party remote-desktop app or library under a copyleft licence.** Rejected: RustDesk integration (AGPL-3.0 vs this repository's MIT licence; its UI cannot be embedded; the user rejected any extra app). Based on: `LICENSE` (MIT); user decision.

- **The controlled side is a new Swift helper, `coflux-screen`, shipped inside Coflux.app next to the other runtime binaries — not part of the worker's hot-upgrade artifact set.** Rejected: adding it to the worker upgrade pair — `release-sign.mjs` requires every component's target set to equal the worker's (Linux included), and this helper is macOS-only; Rust + objc2 — no objc2/ScreenCaptureKit/VideoToolbox bindings exist in the tree today and the private virtual-display classes are far simpler to declare from Swift/ObjC headers; the Go transport — CGO-free by policy. The helper is registered where the desktop runtime's binaries are registered (`DAEMON_BINARIES`, `apps/desktop/src/main/daemon-paths.ts:12`; stage script; `electron-builder.yml` `mac.binaries`; `apps/desktop/test/config.test.ts`) so it is staged into `~/.coflux/desktop-runtimes/<id>/` and signed with the app. The worker learns its absolute path from the environment the desktop runtime sets (the supervisor passes its environment to the worker), because a hot-upgraded worker runs from `~/.coflux/workers/<v>/` and cannot find siblings. Based on: `apps/desktop/src/main/desktop-runtime.ts:282-309` (supervisor spawn and env), `crates/worker/src/tailcat.rs:69-73` (helpers found next to the worker), `scripts/release-sign.mjs:109-122`.

- **Screen Recording / Accessibility are granted to Coflux itself, which is why the helper must be started inside the desktop runtime's process tree.** Measured on macOS 27: tccd attributes every process in the tree Coflux.app spawns (supervisor → worker → children, even an ad-hoc binary in `/tmp`) to `dev.coflux.desktop` (`AUTHREQ_SUBJECT: subject=dev.coflux.desktop`, `responsible_path=/Applications/Coflux.app/Contents/MacOS/Coflux`). The private `responsibility_get_pid_responsible_for_pid` misleadingly reports these processes as self-responsible; only tccd's log is authoritative. A headless `cofluxd` LaunchAgent install would be attributed to the supervisor path instead — another reason it is out of scope. Rejected: capturing from the Electron main process — possible, but it would put capture on a process that is not the device authority. Based on: `apps/desktop/src/main/desktop-runtime.ts:291` (detached supervisor spawn by Coflux.app).

- **The helper's lifetime is decoupled from the worker.** The worker starts it on demand as a detached process and talks to it over a 0600 Unix socket under `$COFLUX_HOME`; the helper owns the screen session, the virtual display, the 10-minute orphan grace and the holder epoch. A worker hot upgrade or restart reconnects to the running helper; the session and the virtual display survive it. The helper exits by itself when it has no session and no worker connection. The worker↔helper protocol has a versioned hello, because the two upgrade independently (the helper with the desktop app, the worker hot). Rejected: a `kill_on_drop` child like `coflux-transport` — a worker upgrade would destroy the virtual display and reshuffle remote windows. This deliberately differs from the ptyd custody model, where only the lifecycle owner (Coflux.app) starts ptyd and the supervisor never does (`docs/architecture.md:102`): do not "correct" it toward that model — the helper is optional per device, needed only on demand, and TCC attribution already holds for anything the worker starts. Resolve the socket location through the worker's existing `$COFLUX_HOME` resolution (as `annotations.rs` / `agent_socket.rs` do). The helper path arrives by environment, which the supervisor passes through unchanged to every worker including hot-upgraded ones (`crates/supervisor/src/manager.rs:375-405` does not clear the environment; `apps/desktop/src/main/desktop-runtime.ts:294` spreads `process.env`). A session left open when the app quits keeps its virtual display and power assertions for the 10-minute grace — by design; release notes should say so. (revised on plan audit) Based on: `crates/worker/src/tailcat_ipc.rs:56-62` (`kill_on_drop` pattern to avoid), `crates/worker/src/executor_host.rs:15-23` (precedent for a child that must survive an upgrade), the ptyd custody precedent (`wiki/plans/20260918-ptyd-terminal-custody.md`).

- **Capability gating (revised on plan audit).** The worker advertises a screen capability only on macOS when the helper path is present and the helper answers its hello. The server carries it to clients on `DaemonInfo` (today clients get `platform` but no capabilities — `proto/coflux/v1/common.proto:10-18`; capabilities are reported on `DaemonAuth`/enrollment, `proto/coflux/v1/daemon.proto:25,38`, and kept server-side as a `Set` on the connection, `apps/server/src/hub.ts:941`, capped by `MAX_CAPABILITY_ENTRIES`, `hub.ts:148`). The capability must be part of the single value every `DaemonInfo` is built from, so that every emission carries it: `hub.ts:883` (`daemonInfoList` spreads `d.info`), `:890` (offline rows), `:970` (`daemonUpdated` on registration), `:2918` and `:3323` (hand-written literals). The client store replaces a daemon wholesale on update (`packages/client/src/store.ts:433-438,981-984`), so one emission site that omits it makes the entry vanish on the next `daemonUpdated` — tsc does not catch this. The UI offers 「屏幕」 only when the capability is present and the device is not the local one; the renderer knows the local device from `useDesktopDaemonState(desktop)?.daemonId` (`apps/desktop/src/renderer/components/workbench/workbench.tsx:283`; main side `apps/desktop/src/main/index.ts:469`). Rejected: gating on `platform == "macos"` alone — it cannot tell a headless install from a desktop runtime.

- **Transport: two dedicated lanes per screen session, owned by the desktop main process, over the existing Tailcat TCP streams, RPC scope.** One lane carries only video; the other carries control, input, cursor and clipboard, so input never queues behind video. Rejected: a datagram/UDP path in the Tailcat helper — the user's everyday path is DERP relay (the Work network is symmetric NAT and only ever relays), and DERP is TCP anyway, so UDP buys nothing where it matters now; it stays a later optimisation. Rejected: a new device scope — the loopback tunnel set the precedent that RPC already implies equivalent power. Based on: `apps/desktop/src/main/index.ts:442-458` (`openOwned` with `DeviceScope.RPC`), `docs/tailcat-transport.md` (`open` = one reliable TCP stream; no datagram op).

- **Video flow control is credit-based with drop-at-source.** The sender never has more video in flight than the receiver has credited; when there is no credit the helper drops captured frames (it never queues them) and the receiver asks for a keyframe when it resumes, reconnects, or the resolution changes. Worker→Tailcat records for one screen channel stay within a quarter of the helper's shared 256-record queue, the same budget the loopback tunnel uses; and the credit also bounds the bytes queued in the channel's own sink, because a failed `entry.sink.try_send` removes the channel outright (`crates/worker/src/device.rs:3205-3212`; sink capacity `CHANNEL_QUEUE_BYTES = MAX_DEVICE_FRAME_BYTES + 2 MiB`, `device.rs:39`, `crates/protocol/src/lib.rs:71`) — an unbounded keyframe burst would close the screen channel itself, not only its neighbours. Rejected: reusing the loopback tunnel's per-frame ack scheme at 64 KiB — it caps throughput at ~27 Mbps over a 150 ms relay and costs ~100 acks/s. Based on: `crates/worker/src/tailcat_ipc.rs:65` (one shared `mpsc::channel(256)` with `try_send`; a failed send breaks the channel), `transport/tailcat/internal/helper/helper.go:82-83` (one shared outbound queue per helper; overflow closes the stream), `crates/worker/src/device_loopback.rs:45-58` (quarter-of-queue budget).

- **Main → renderer frames go over a `MessagePort` with transferable buffers.** Rejected: `webContents.send`, which structured-clones every message and relies on the preload ack loop built for terminal output. Based on: `apps/desktop/src/main/index.ts:79-82,357`, `apps/desktop/src/preload/index.ts:51-65`.

- **Codec: VideoToolbox hardware H.264 (High, no B-frames, real-time, low-latency rate control) decoded by WebCodecs `VideoDecoder` into a canvas.** The codec is negotiated in the protocol so HEVC can be added later. Rate adapts from delivered-frame feedback (credit round-trip time and backlog), not from the direct/relay label alone; the relay label only sets a lower starting point. Measured on an M1 Pro, worst case (full-screen random noise at 2880×1800): 33.5 complete capture fps, 30 Mbps, encode p50 15.7 ms / p95 64 ms — real desktop content is far lighter. Nothing in the renderer's CSP or webPreferences blocks WebCodecs (`media-src 'self'` only affects media elements). Based on: `apps/desktop/src/main/app-protocol-pure.ts:21-33`, `apps/desktop/src/main/window.ts:73-81`.

- **Virtual display.** Created through the private `CGVirtualDisplay` classes (present on macOS 26 and 27), behind an adapter so the macOS 27 SkyLight `SLVirtualDisplay` can replace it. Measured facts the implementation must respect: (1) re-applying settings on the same object changes resolution and keeps the `displayID`; (2) the first apply lands on a 1× mode of doubled point size — the HiDPI mode must be selected explicitly; (3) while every display is asleep (lid closed and external monitor asleep) WindowServer defers all display configuration — create succeeds but capture yields no frames, destroy logs `not found`, and the display appears to linger — and everything is applied the moment the displays wake (`IOPMAssertionDeclareUserActivity`), so the helper wakes the displays and waits for the reconfiguration callback before creating, capturing or destroying; (4) a process exit removes its virtual displays. Rejected: relying on the lid-closed/asleep state being capturable, or treating a lingering display as leaked. Private interface declarations for both APIs are recorded under Maintenance notes.

- **Mirroring is applied with `CGConfigureDisplayMirrorOfDisplay` completed `.forAppOnly`.** Measured: the virtual display becomes main, the physical display mirrors it, and when the process exits the arrangement reverts by itself — so a helper crash cannot leave the remote mirrored. Rejected: `.permanently` / `.forSession` configuration.

- **Keyboard ownership (revised on plan audit).** Page-level app shortcuts are handled in the capture-phase window listener; while a screen picture has focus that listener must yield everything except ⌃⌥⌘F. Main-registered accelerators (⌘Q `role: quit`, ⇧⌘W `role: close`, ⌘R, ⌃⌘F `togglefullscreen`, Edit roles) are switched off for the main window with `webContents.setIgnoreMenuShortcuts(true)` while the picture has focus and back on when it loses focus, driven by one state IPC from the renderer (focus/blur of the picture), not per key. Rejected: `before-input-event` + `preventDefault` — Electron documents that it also cancels the page's keydown/keyup, so the renderer would never see ⌘Q to forward it; rejected: trusting page `preventDefault` alone — never verified for `role:` items. The first thing M4 does is a windowless Electron 44.3.0 probe confirming `setIgnoreMenuShortcuts` also suppresses `role: quit`; if it does not, the STOP condition applies. Keys are sent by physical `KeyboardEvent.code` and mapped to macOS virtual key codes on the remote, so neither side's keyboard layout or input method interferes. The reserved combination's keyup is swallowed with its keydown. Based on: `apps/desktop/src/renderer/components/workbench/use-global-shortcuts.ts:57-183`, `apps/desktop/src/main/menu.ts:25-30,52,65,105,112`, `apps/desktop/src/renderer/components/workbench/terminal-key-ownership.ts:29-47` (keyup hazard); `before-input-event` exists only on browser guests today (`apps/desktop/src/main/browser-host.ts:628,664`).

- **Cursor.** The remote cursor is drawn locally from shape and position sent on the control lane, so pointer feel does not wait for video. If cursor-shape capture proves unreliable on macOS 27 the executor may fall back to cursor-in-video, and must report it. (decided while planning)

- **Clipboard.** Both sides poll for changes while a session is active (Electron has no clipboard-change event; the helper watches `NSPasteboard.changeCount`); text and PNG images are synced; a content hash of the last applied value prevents echo loops. Local reads happen in the main process, not via `navigator.clipboard`. Based on: `apps/desktop/src/main/ipc.ts:106`, `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:857`.

- **Takeover mirrors terminals.** The helper keeps a holder epoch per session; a new open preempts and the old holder is told it was detached; 「重新接管」 re-opens with force. Based on: `proto/coflux/v1/device.proto:436` (`DeviceSessionDetached`), `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:982-989`.

- **Remote permissions and lock state are reported, not worked around.** The helper reports Screen Recording, Accessibility and lock state (`CGSessionCopyCurrentDictionary`) to the client; when a permission is missing it raises the system request on the remote once per session (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions` with prompt). No-Accessibility means read-only picture. While connected the helper holds power assertions preventing idle display sleep and idle lock. Measured on the development Mac: Coflux holds Screen Recording (allowed) and Accessibility (denied).

- **A screen tab needs a workspace; the device page's canonical directory workspace hosts it.** Opening a screen on a device that has no directory workspace yet must create that workspace without starting a shell; the device empty state offers 「打开屏幕」 beside 「新建终端」. Today the only path that creates it is `terminalCreate`, which creates the directory workspace and an IDLE task in one transaction (`apps/server/src/hub.ts:3207-3264`). The client→server operation for "ensure the canonical directory workspace, no task" is part of the Milestone 1 contract, with the same idempotent reuse rule as `terminalCreate`. (decided while planning; revised on plan audit) Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:355-370,807-819,1380-1410`.

- **Direct/relay and latency in the status bar come from the device's existing transport state in the client store.** Main-owned lanes are never probed. Based on: `apps/desktop/src/main/tailcat-transport.ts:167`, `apps/desktop/src/renderer/components/workbench/sidebar.tsx:436-449`.

## Direction

Data path:

```
remote Mac                                                      local Coflux Desktop
coflux-screen (Swift, detached, UDS 0600)                       renderer: 屏幕 tab
  virtual display + mirror + power assertions                     VideoDecoder → canvas, local cursor,
  ScreenCaptureKit → VideoToolbox H.264                           input capture, status/immersive
  CGEvent input, NSPasteboard, permission/lock state                    ▲ MessagePort (transfer)
        ▲ UDS                                                    main: two owned lanes (video, control),
coflux-worker: scope gate, lane ↔ helper bridge,                      clipboard poll, before-input-event
  capability advertisement                                             ▲
        ▲ coflux-transport (Tailcat, TCP) ──────────────────────────────┘
```

### Milestone 1: The contract exists and is carried

The wire contract is defined in `proto/` and generated for all three targets (TS, Rust, and the Swift client under `packages/swift-client/Sources/CofluxProtocol/Generated`, which CI also diff-checks): screen session open/close/resize/pause/resume, video frames with codec negotiation and keyframe requests, credits, input (keyboard by physical code, pointer absolute in display points, scroll), cursor shape/position, clipboard (text, PNG), state reports (permissions, lock, takeover/detached, errors), the worker↔helper hello/version, the client→server "ensure the device's canonical directory workspace without a task" operation — plus the capability on `DaemonInfo`, reported by the worker and carried by the server on every `DaemonInfo` emission. New device envelope fields take numbers after 117. Every new client-originated and worker-originated payload is registered in the worker's hand-maintained scope tables `required_scope` / `response_required_scope` (`crates/worker/src/device.rs:4349-4430`); an unregistered client payload is rejected as `unsupported_payload` at runtime (`device.rs:1929-1935`) while every build stays green. Validation: `buf lint` (in `proto/`), `node scripts/check-protocol-breaking.mjs '../.git#ref=v2.11.0,subdir=proto'`, `buf generate` leaves no diff in the three generated trees, `cargo test -p coflux-protocol`, `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`.

### Milestone 2: The remote helper produces a session

`coflux-screen` builds from the repository with a script wired into the daemon/desktop build, compiles without warnings, and is staged, signed and bundled with the desktop runtime binaries. It serves the UDS contract: wakes displays, creates and resizes the HiDPI virtual display, mirrors physical displays `.forAppOnly`, captures and encodes with credit-gated drop-at-source, injects input, syncs the pasteboard, reports permissions/lock/takeover, holds power assertions, keeps the 10-minute grace, and exits when idle. Pure logic (key-code mapping, mode selection, credit accounting) has unit tests. Validation: the helper's build and its tests exit 0 with zero warnings; `pnpm -C apps/desktop test` (config test covering the binary list) exits 0. Depends on Milestone 1.

### Milestone 3: The worker bridges lanes to the helper

On a macOS desktop runtime the worker advertises the capability, starts or reconnects to the helper, routes the new envelope payloads under RPC scope, bridges the video and control lanes to the helper within the record and sink budgets, and releases a channel's hold on the session whenever the channel goes away without ending the session (the helper's grace decides). Do that the way the loopback tunnel does: the hold lives on the channel entry and is released by its `Drop` (`crates/worker/src/device.rs:583` `entry.loopback: Option<LoopbackTable>`; `crates/worker/src/device_loopback.rs:154` `impl Drop for LoopbackTable`) — every `channels.remove` path then releases it; do not hook removal sites one by one. A worker restart reattaches to a live helper session. Validation: `cargo build` with zero warnings, `COFLUX_HOME= cargo test -p coflux-worker`. Depends on Milestone 1; independent of Milestone 2 given the Milestone 1 contract.

### Milestone 4: The desktop opens, shows and drives a screen tab

First, two windowless Electron 44.3.0 probes (the precedent is the headless probe used by the browser-annotations plan): `setIgnoreMenuShortcuts(true)` suppresses `role: quit`, and `VideoDecoder.isConfigSupported({ codec: "avc1.64001f" … })` reports supported in the app's renderer. Main opens and owns the two lanes per session, bridges them to the renderer over a MessagePort, polls the local clipboard during a session and suppresses main-registered accelerators while the picture has focus. The renderer registers the 「屏幕」 tab kind everywhere a tab kind must be registered (see Landmines), restores it after restart, decodes and draws, captures input, renders every product state and the immersive mode, offers the entry points only where the capability allows, and can open a screen on a device page with no directory workspace. The server handler for the Milestone 1 "ensure directory workspace" operation is part of this milestone (the message itself is not). Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`, `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`. Depends on Milestone 1; independent of Milestones 2–3 until acceptance.

Milestones 2, 3 and 4 are independent of each other once Milestone 1 lands — provided Milestone 1 really froze every message they exchange, including the worker↔helper hello and the workspace operation; none of them may change `proto/`. If one needs a contract change, it stops and the change goes back through Milestone 1. They may run as concurrent work packages; acceptance needs all of them.

## Landmines

- `reconcileLayout` deletes every tab id that is neither a task nor a browser tab on the first snapshot; a new kind must be exempted, and `isTaskTabId` must exclude it or attach logic treats it as a terminal. `apps/desktop/src/renderer/components/workbench/terminal-layout.ts:94-101,705-712`. The full registration list (layout, records module + config key, workbench restore/activate/close/actions, tab strip render and drag ghost, ＋ menu, native menu `DesktopCommand`, global shortcut switch, palette, help table) is spread across `workbench.tsx`, `workspace-terminal.tsx`, `shared/desktop-bridge.ts`, `main/menu.ts`, `use-global-shortcuts.ts`, `command-palette-data.ts`, `dialogs.tsx` — follow how browser tabs were added (`wiki/plans/20260924-desktop-browser-tab.md`).
- The worker's outbound queue to the transport helper is shared by every channel and `try_send` failure breaks the channel (`crates/worker/src/tailcat_ipc.rs:65`, `crates/worker/src/tailcat.rs:472`); the Go helper's outbound queue is likewise shared and overflow closes the stream (`transport/tailcat/internal/helper/helper.go:82-83`). An unbudgeted keyframe burst can take down terminal lanes on the same device.
- The desktop's stdin backlog to its transport helper is one 128 MiB budget with no fairness (`apps/desktop/src/main/tailcat-helper.ts:71`); keep the video lane's budget bounded so input does not wait behind it.
- `DAEMON_BINARIES` is asserted by `apps/desktop/test/config.test.ts:67-91` against `electron-builder.yml` `mac.binaries`, and the runtime id hashes the binaries (`apps/desktop/src/main/desktop-runtime.ts:249-257`) — adding the helper changes the runtime id, which is expected.
- `.github/workflows/desktop-release.yml:61` and `:197` loop over a hard-coded list of the five binaries (staging and signature verification); the Swift build belongs in that file's daemon job (`macos-latest`, around line 32). Conversely `.github/workflows/release.yml:196,218-226` (the daemon release tarballs) must **not** gain the helper — do not copy how ptyd was added there.
- The CI quality gate runs on `ubuntu-latest` only (`.github/workflows/ci.yml:26`) with `RUSTFLAGS=-D warnings`: macOS-only Rust must be `cfg`-gated and still compile on Linux, and checking the Swift helper needs a new macOS job (none exists). The desktop ships arm64 only (`apps/desktop/electron-builder.yml:61-66`).
- `apps/desktop/src/main/daemon-manager.ts:250` `start()` returns early when a runtime is already running: after the first desktop release carrying `coflux-screen` is installed, the running supervisor's environment has no helper path, so the capability appears only after the user updates/restarts the runtime. Say so in release notes and in any "why is 屏幕 missing" guidance.
- The CLT's MacOSX27 SDK `.tbd` files are rejected by the installed clang/ld ("unknown architecture arm64e.x1"); local native builds on this machine used `-sdk …/MacOSX26.5.sdk`. Pin the SDK the build script uses rather than relying on the default.
- The desktop's device path/latency is not measured for main-owned lanes (`apps/desktop/src/main/tailcat-transport.ts:167`); read the device's existing transport state instead of expecting one per lane.
- New clickable elements in a tab strip that touches the window's top edge must be `no-drag` and later in document order (`apps/desktop/src/renderer/components/workbench/drag-region.ts:9-37`); use the Tooltip component, never native `title` (`docs/design-guidelines.md`).
- While all displays sleep, virtual-display operations appear to fail or leak but are only deferred; do not "fix" this by creating displays with fresh serial numbers on every attempt.
- `buf generate` needs network access; `check-protocol-breaking.mjs` needs its baseline argument in the `../.git#ref=…,subdir=proto` form because it runs from `proto/` (`scripts/check-protocol-breaking.mjs:31`).
- A dev desktop build cannot reach remote devices at all: native transport is enabled only when a daemon bundle is present (`apps/desktop/src/main/index.ts:356`, `docs/desktop-acceptance.md:34`), and on the controlled side TCC attribution was measured for `/Applications/Coflux.app` — a dev Electron tree is a different responsible bundle. Both ends of the walkthrough need a packed app. A locally packed app is ad-hoc signed, so macOS may re-ask for Screen Recording/Accessibility after every repack (inferred); tell the person doing the walkthrough.

## Scope

In scope:
- `proto/coflux/v1/` and generated code (`packages/protocol/src/gen`, `crates/protocol/src/gen`, the Swift client generation it already produces)
- `crates/worker/src/` (capability, helper lifecycle, routing, lane bridge)
- `apps/server/src/` (capability on `DaemonInfo`; canonical directory workspace without a shell)
- the new Swift helper (location is the executor's call, e.g. `native/screen/` or `crates/`-adjacent) and its build script under `scripts/`
- `apps/desktop/` (main, preload, shared, renderer, stage script, `electron-builder.yml`, tests)
- `packages/client/src/` where the store/router must learn the new payloads or capability
- `.github/workflows/ci.yml` (new macOS job checking the helper) and `.github/workflows/desktop-release.yml` (build, stage and verify the helper), and root `package.json` scripts
- `packages/swift-client/Sources/CofluxProtocol/Generated` (regenerated only)
- `docs/` entries describing the new helper and protocol surface

Out of scope:
- `transport/tailcat` behaviour (no datagram op) — later optimisation
- iOS client and `packages/swift-client` behaviour beyond regenerated code
- worker hot-upgrade artifact set, `release-sign.mjs` trust domains, `.github/workflows/release.yml` daemon tarballs, npm `cofluxd` — the helper ships with the desktop app only
- Every non-goal listed under Requirement

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint | `buf lint` (in `proto/`) | exit 0 |
| Proto breaking | `node scripts/check-protocol-breaking.mjs '../.git#ref=v2.11.0,subdir=proto'` (the script runs from `proto/`) | exit 0 |
| Generated code current | `buf generate` (in `proto/`) then `git diff --exit-code -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | exit 0 |
| Protocol tests | `cargo test -p coflux-protocol` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Worker tests | `COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Helper build + tests | the helper's build/test command added by this plan | exit 0, zero warnings |
| Black-box (wire protocol touched) | `pnpm -C tests test` | exit 0 |
| Packaged app with bundled runtime (acceptance) | `COFLUX_DESKTOP_DAEMON_DIR=… pnpm -C apps/desktop run pack` | `.app` contains `coflux-screen` |
| Two-Mac walkthrough (acceptance) | install this branch's packed `.app` on **both** Macs; neither the installed release app nor a dev build can stand in | the five observable outcomes under Requirement |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] The five observable outcomes under Requirement hold in the two-Mac walkthrough (pending the user if the verifier cannot run it; report which were not exercised).
- [ ] 「屏幕」 is not offered for the local device, non-macOS devices or headless installs, and stays offered for a capable device after a `daemonUpdated` (every `DaemonInfo` emission carries the capability).
- [ ] Every new payload is registered in `required_scope` / `response_required_scope`; the walkthrough exercises each message family at least once.
- [ ] Killing `coflux-screen` mid-session leaves the remote with no virtual display and its original arrangement (the `.forAppOnly` and process-exit guarantees), and the tab reports the loss and reconnects.
- [ ] A worker restart during a session does not remove the virtual display.
- [ ] A saturated video stream does not close terminal lanes on the same device.
- [ ] ⌘Q, ⇧⌘W, ⌘W, ⌘T, ⌘R, ⌃⌘F, ⌘1–9 reach the remote while the picture has focus; ⌃⌥⌘F toggles immersive and its keyup does not reach the remote.
- [ ] Required tests exist and assert meaningful behaviour (key mapping, mode selection, credit accounting, tab registration/restore).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. TCC no longer attributes the runtime tree to `dev.coflux.desktop`, or `.forAppOnly` mirroring does not revert on exit).
- A virtual display cannot be created on a Mac with no physical display at all (never measured — see Maintenance notes); report instead of shipping a lid-open-only feature.
- Main-registered accelerators cannot be kept from the local app while the picture has focus (the `setIgnoreMenuShortcuts` probe fails for `role:` items).
- WebCodecs does not report H.264 decode as supported in the app's renderer.
- The outcome requires out-of-scope files, or a change to the worker hot-upgrade artifact set.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **Needs the user:** apply to Apple for the `com.apple.developer.persistent-content-capture` entitlement (Persistent Content Capture Entitlement Request form). Without it macOS 15+ re-asks for Screen Recording roughly monthly, which breaks unattended use. On macOS 27 it appears as a separate 「远程桌面」 privacy category. It requires a provisioning profile on the app once granted; not part of this plan.
- **Never measured:** a Mac with no physical display at all (headless Mac mini); WebCodecs decode throughput at 2880×1800@60 on the controlling side; whether `preventDefault` alone already stops main-registered accelerators on Electron 44.3.0.
- Private interfaces (declare them in a local header; the SDK does not ship them):
  - `CGVirtualDisplayDescriptor` (queue, name, maxPixelsWide/High, sizeInMillimeters, vendorID, productID, serialNum, terminationHandler); `CGVirtualDisplayMode initWithWidth:height:refreshRate:`; `CGVirtualDisplaySettings` (modes, hiDPI); `CGVirtualDisplay initWithDescriptor:`, `applySettings:` (Swift: `apply(_:)`), `displayID`.
  - macOS 27 SkyLight: `SLVirtualDisplayConfiguration initWithName:vendorID(uint64):productID(uint64):serialNumber(uint64):sizeInMillimeters({float,float}):maximumSizeInPixels({uint32,uint32}):chromaticities({4×{float,float}}):error:`; `SLVirtualDisplayMode initWithSizeInPixels({uint32,uint32}):sizeInPoints({uint32,uint32}):refreshRate(float):error:`; `SLVirtualDisplaySettings initWithNativeMode:preferredMode:optionalModes:rotations(uint64):error:`; `SLVirtualDisplay initWithConfiguration:error:`, `applySettings:error:`, `destroy`, `displayID`, `+capabilities`.
- Release order when shipping: server (capability on `DaemonInfo`, workspace op) before desktop; the worker half rides a normal hot upgrade; the helper arrives only with a desktop release, and the capability appears only once both are present.
- UDP/datagram transport, HEVC/4:4:4, audio, multiple displays and system-shortcut interception are the natural follow-ups.
- **Accepted deviation (execution):** the worker starts or reconnects to `coflux-screen` when it starts, not on the first screen open, because the capability decision requires the helper's hello before the server handshake; the helper therefore stays resident (idle) on every desktop-runtime Mac, and a helper that fails to answer delays worker start by at most 6 s. The capability is sampled at the handshake: a helper that becomes ready or dies later is reflected only on the next server connection.
- A stale helper (desktop update) keeps serving a live session and exits when it ends; a protocol-incompatible one tears its session down at once. Two helpers never hold virtual displays at the same time — keep it that way.
- `MessagePortMain` cannot transfer ArrayBuffers (only ports), so main → renderer video is a structured clone over the port; there is still no ack loop and no `webContents.send`.
- Local black-box runs need `FORCE_COLOR` unset (not empty), or `contract.test.mjs` fails on ANSI codes in command output.
