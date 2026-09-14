# Plan 20260913-ios-tailcat-transport: Restore iOS remote device connectivity on the native Tailcat stack

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 0e31df00..HEAD -- transport/tailcat packages/swift-client/Sources apps/ios proto/coflux/v1/client.proto apps/desktop/src/main/tailcat-transport.ts apps/server/src/hub.ts docs/tailcat-transport.md docs/RELEASING.md docs/architecture.md scripts`

## Status

- Priority: P1 — the user named working iOS an important goal; today the app can log in and list devices but cannot reach a single one
- Effort: M
- Risk: MED — the blast radius is confined to the iOS app (server, worker, desktop and proto are untouched), but the work crosses Go/C ABI/Swift/Xcode and its final acceptance can only happen on a physical device
- Depends on: none
- Category: feature
- Execution: subagent opus (user decision at the departure check); verification and code review by the orchestrator
- Stop after: implementation (autopilot chosen at the departure check)
- Workspace: isolated — `.claude/worktrees/20260913-ios-tailcat-transport`, branch `dev/20260913-ios-tailcat-transport`, cut from main `0e31df00` with a clean tree
- Current state: DONE on `dev/20260913-ios-tailcat-transport` (implementation `c6cee3a6`..`b03c003b`, no revision rounds). Verified by the orchestrator: `CGO_ENABLED=0 go test ./internal/...` and `go vet ./...` exit 0; `swift build` exit 0; `swift test` exit 0 with 93 tests (65 at baseline, 28 new); `node scripts/build-ios-transport.mjs` exit 0 producing a 45 MB `ios-arm64` static-library xcframework that `git status` does not see. The handshake was confirmed three ways independently — `crates/worker/src/tailcat_auth.rs:129-135`, the Swift implementation, and a separate HMAC computation — all agreeing on transcript and proof. The grant scopes the client demands match what `apps/server/src/tailcat-rendezvous.ts:9-10,69` actually issues for each lane. `apps/server`, `crates/`, `proto/` and `apps/desktop` have zero diff. Released to TestFlight as build 953 on 2026-09-14 from this branch (`xcodebuild archive` + upload succeeded; the app target's Release build and its link against the Go static library were verified first, producing a 42 MB bundle with a 44 MB binary — within the 30–60 MB the plan estimated). Export needed a fix of its own: macOS has replaced `/usr/bin/rsync` with openrsync, which rejects the `-E` flag Xcode's `CreateIPAStep` passes, so `exportArchive` failed as "Copy failed" after re-signing; `uploadSymbols` is now off and `release.sh` prints the retained dSYM path (`025697cb`). Not done: merge to main, and the physical-device acceptance row below, which needs a deployed server and a real device.
- Planned at: `0e31df00`, 2026-09-13

## Requirement

### Problem

Coflux 2.0 retired the custom relay and WebRTC transports and moved remote
connectivity onto Tailcat/Tailscale with a self-hosted stock DERP region. The
migration commit `746f5c39` deleted the Swift client's entire remote transport
along with them — `P2PFraming.swift` and `P2PRouteTests.swift` removed outright,
`P2PDeviceTransport.swift` gutted, `DeviceRouter.swift` down 251 lines — leaving
only the loopback `LocalDeviceTransportProvider` boundary behind. The iOS app
never injects such a provider (`apps/ios/Coflux/CofluxApp.swift:32` constructs
`CofluxClient` without `localDeviceProvider`, and no iOS device runs a local
Supervisor anyway), so every attempt to reach a device lands on
`DeviceRouter.swift:766` or `:1254` and throws `remote_unavailable`. The device
list renders "远程连接暂不可用" and nothing can be opened.

The result is an app that authenticates fine and is otherwise inert. This was a
deliberate, documented non-goal of the migration (`wiki/plans/20260912-tailcat-transport.md:309-312`),
not a regression — but it was always meant to be reopened once a native provider
existed. This plan builds that provider.

Note what is *not* broken: the Swift client already speaks control protocol 2
(`packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift:993` reports
2, `:439` requires the server to be at least 2), so it is admitted by
`apps/server/src/hub.ts:3348` like any current client. Only the device data
plane is missing.

### Product conclusions (settled at the exploration product gate; do not reopen)

- **Positioning.** Not a new feature — the capability 2.0 removed, put back. iOS
  is a connecting party only: it never serves, never captures system traffic,
  and must not prompt for VPN authorization.
- **Flow.** Log in → device list → workspace/terminal → live read/write. A
  failure surfaces a readable reason and stays retryable. Backgrounding
  disconnects and foregrounding rebuilds, per the existing plan 044 lifecycle.
- **UI.** No interface redesign. The third line of the device row swaps
  "远程连接暂不可用" back for real transport state — direct/DERP plus RTT.
- **Capabilities.** Terminal read/write and the file/RPC lane (upload, voice
  input) come back together; they share one provider and were always one switch.
- **Non-goals.** iOS does not serve, gets no NAT/DERP tuning UI, and no existing
  interaction paradigm changes.
- **Observable acceptance (physical device, run by the user).** On cellular, a
  cold start reaches a terminal that prints output; a dropped network
  reconnects; background→foreground rebuilds the connection.

## Decisions & tradeoffs

- **Where the Tailcat client runs**: inside the iOS app process, as Go compiled
  to a c-archive static library. Rejected: a helper subprocess like desktop's —
  iOS forbids spawning one, which is exactly why the migration plan listed iOS
  as out of scope. Rejected: routing iOS device traffic through the center as a
  thin relay — it would reopen retired proto fields (`proto/coflux/v1/client.proto:157-166`
  reserves them precisely so they are never reused), make the center a data
  plane again, and force a second remote-admission path into the worker
  alongside the HMAC channel-grant one. Based on: `AGENTS.md:29`;
  `wiki/plans/20260912-tailcat-transport.md:309-312`.

- **No NetworkExtension, no VPN entitlement**: the upstream library runs a
  userspace gVisor network stack and hands out TCP connections directly, so an
  in-process client needs no tunnel interface and no VPN profile. Rejected: a
  Packet Tunnel Provider — it would demand a VPN authorization prompt for a
  product that only ever dials out, and would additionally subject the transport
  to the network extension memory ceiling. Based on:
  `$(go env GOMODCACHE)/github.com/tailscale/tailcat@v0.6.1-0.20260909154426-91dc4979bd4a/tailcat.go:94`
  (`tailscale.com/wgengine/netstack`), `:67-70` (gVisor `gonet`/`stack`/`tcp`),
  and `backend.go:194-199` dialing via `DialTCPPort` to a plain `net.Conn`.

- **Upstream dependency boundary**: the iOS target reuses
  `transport/tailcat/internal/backend`, the package whose own doc comment calls
  it "the sole dependency boundary to the pinned Tailcat library"
  (`transport/tailcat/internal/backend/backend.go:1`). A new
  `package main` under `transport/tailcat/cmd/` builds it with
  `-buildmode=c-archive`. Rejected: a second, iOS-specific call site into
  `github.com/tailscale/tailcat` — it would fork the DERP region validation and
  the version pin that desktop and Linux devices share. `internal/ipc` and
  `internal/helper` stay untouched: they implement the subprocess IPC framing
  and lifetime that iOS has no use for.

- **Verified feasibility, not assumed**: at this baseline, on this machine,
  `GOOS=ios GOARCH=arm64 CGO_ENABLED=1` with the iPhoneOS 26.5 SDK compiles
  `./internal/backend` (and therefore its whole dependency graph — netstack,
  wireguard-go, gVisor) with zero errors, and the same settings produce a
  working `.a` + `.h` pair from a minimal `-buildmode=c-archive` main package.
  The local toolchain is go 1.26.6 and `transport/tailcat/go.mod:3` requires
  1.27.1, so the build relies on Go's automatic toolchain download.

- **Data plane crosses the language boundary as a socketpair fd, not as framed C
  calls**: Go bridges the `net.Conn` from `backend.Dial` onto one end of a unix
  socketpair and hands the other descriptor to Swift, which reads and writes it
  with its own I/O. Rejected: per-record C functions with a Go callback for
  inbound data — Swift would then own Go's callback threading and backpressure
  on the hot path. With the socketpair, the language boundary is crossed only by
  low-frequency events (prepare, dial, close, probe) and Go moves bytes
  verbatim. Based on the shape the router already consumes:
  `packages/swift-client/Sources/CofluxClientCore/ClientContracts.swift:44-51`.

- **The channel handshake happens in Swift, on the socketpair, never in Go**:
  the grant's 32-byte proof key is used to answer the worker's challenge inside
  Swift and is zeroed immediately after. Rejected: passing the proof key into Go
  to let the bridge authenticate — it would push a live credential across the
  language boundary for no gain, since the handshake is four messages on a
  connection Swift already holds. The proof key is never written to the Keychain
  and never logged. Based on the sequence desktop performs at
  `apps/desktop/src/main/tailcat-transport.ts:140-147`.

- **Control-plane grants reuse the app's existing WebSocket**: the provider
  receives an `authorize` closure and never opens a socket of its own.
  `DeviceRouter` already injects exactly that closure — it passes
  `requestTransportControl` into `localProvider.open`
  (`packages/swift-client/Sources/CofluxClientCore/DeviceRouter.swift:775-778`),
  and the provider protocol already declares the parameter
  (`LocalDeviceTransport.swift:16-17`). Rejected: desktop's design of a second
  dedicated control connection (`apps/desktop/src/main/tailcat-transport.ts:51`)
  — it exists to keep secrets out of the Electron renderer, a boundary that does
  not exist in a single-process iOS app.

- **Lifecycle follows plan 044 unchanged**: backgrounding tears the connection
  down and additionally drops the Go-side client for that device; foregrounding
  rebuilds. Rejected: background keep-alive or a background networking
  entitlement — the app already decided to disconnect on background
  (`apps/ios/Coflux/CofluxApp.swift:48-50`) and nothing here argues for
  reopening that.

- **The framework is built locally and is not committed**: a script produces the
  `.xcframework`; the binary stays out of git. CI is unaffected because CI never
  builds iOS at all — `.github/workflows/ci.yml` is a single `ubuntu-latest`
  job with no Swift or Xcode step, despite `docs/RELEASING.md:107` still
  claiming "Swift/iOS build checks" (drift introduced by `87e7a65b`). Correct
  that sentence as part of this work.

- **(decided while planning) The record framing on the socketpair is the
  upstream record framing**: `u32be payloadLength || payload`, length excluding
  the header, zero-length and oversized rejected — the exact format
  `transport/tailcat/internal/ipc/frame.go:102-126` reads and writes on a
  Tailcat TCP stream. Go therefore forwards bytes without reinterpreting them,
  and Swift does its own framing to satisfy the message-boundary contract of
  `TransportConnection`. This is a genuine difference from a WebSocket-backed
  local provider, which gets message boundaries for free.

## Direction

One Go bridge, one Swift provider, one injection point in the app, one build
script. **The milestones are strictly serial** — M2 cannot be designed against
an ABI M1 has not defined, M3 has nothing to inject until M2 exists, and M4
packages M1's output. `dev:execute-plan` must run this as a single work package;
do not fan it out.

Keep the provider's surface the shape `DeviceRouter` already consumes. It calls
exactly one entry point today — `openDirectChannel`
(`DeviceRouter.swift:772-785`) — behind a single gate at
`openPreferredChannel:765-770`. Reaching remote devices means that gate resolves
to a remote provider; it does not mean redesigning the router.

### Milestone 1: Go exposes a Tailcat client to Swift over a C ABI

A new `package main` under `transport/tailcat/cmd/` builds with
`-buildmode=c-archive` for `ios/arm64` and reuses `internal/backend` for every
upstream call. It offers the client-side operations desktop uses — per-device
key preparation, dial to a granted address, cancel/close, per-device teardown,
path probe, plus DERP health — and returns a socketpair descriptor for each
opened stream, forwarding bytes in both directions until either side closes.
Device and stream ceilings match the backend's own (`backend.go:26-27`:
port 43927, `MaxDevices = 16`). Nothing in this milestone reads or holds a proof
key. Errors cross the boundary as codes or sanitized strings; addresses, keys
and grants never appear in them.

Validation: `CGO_ENABLED=0 go -C transport/tailcat test ./internal/...` -> exit
0; the iOS cross-build and c-archive emission commands below -> exit 0 with
`.a` and `.h` produced.

### Milestone 2: The Swift client can open a remote channel

A remote provider in `packages/swift-client` implements the same contract shape
as `LocalDeviceTransportProvider` and produces a `TransportConnection` over the
socketpair: length-prefixed records per the framing decision, the four-message
channel handshake, and idempotent close. `DeviceRouter`'s gate resolves to it,
and a channel opened through it is not labelled as local — today
`openDirectChannel:783` hardcodes `local: true` and `relayHost: nil`, and
`startReceiveLoop:797` hardcodes the disconnect text "本机直连". Transport
diagnostics report the probe's mode and latency through the existing
`onDeviceTransport` callback (`DeviceRouter.swift:42`).

Validation: `swift build --package-path packages/swift-client` -> exit 0;
`swift test --package-path packages/swift-client` -> exit 0, including new
coverage for record framing (including a split read and an oversized length),
the handshake's proof construction against a known-answer vector, and the
failure paths that must close the channel rather than hang.

### Milestone 3: The app connects to real devices

`CofluxApp` injects the provider, the device row reports real transport state
instead of the unavailable placeholder, and the background/foreground path
drops and rebuilds the Go-side client alongside the existing teardown. Failure
text stays readable and retryable.

Validation: `swift build --package-path packages/swift-client` -> exit 0. The
app build and physical-device behaviour are acceptance-tier and belong to the
user.

### Milestone 4: The framework builds from a script, and the docs stop lying

A script under `scripts/` produces the `.xcframework` from M1 with the
toolchain settings recorded here, the artifact is ignored rather than
committed, and `docs/RELEASING.md:107` no longer claims a CI iOS build that
does not exist. `docs/tailcat-transport.md:6-7`, `docs/architecture.md:159` and
`:326`, and `AGENTS.md:29` all currently state that Swift/iOS has only a local
provider and reports remote as unavailable; update them to match what ships.

Validation: running the script from a clean checkout -> exit 0 and an
`.xcframework` on disk; `git status --porcelain` -> the artifact does not appear.

## Landmines

- **The channel handshake is exact, and the worker rejects anything else.** On a
  freshly opened stream the client sends `{"channelId":"<id>"}` as one record,
  receives a 32-byte nonce, replies with
  `HMAC-SHA256(proofKey, "coflux-tailcat-channel-v1\0" || u32be(len(channelId)) || channelId || nonce)`,
  and must receive the literal `ok` before the channel carries any
  DeviceEnvelope. Desktop implements it at
  `apps/desktop/src/main/tailcat-transport.ts:140-147`; the acceptance window is
  five seconds and the grant is consumed atomically on the worker side. Getting
  the domain separator, the length prefix or the ordering wrong fails with a
  closed stream and no useful diagnostic.
- **Order of operations before the dial.** Per device: `prepare` first for a
  distinct public key, then `deviceTailcatConnect` carrying that key with the
  channel id, client instance, transport generation, `DEVICE_PROTOCOL_VERSION`
  and scope, then wait for `deviceTailcatResult` (address, 32-byte proof key,
  expiry) before opening. A failed open must report `deviceTailcatFailed` so the
  center can recover. Independent backends must not share one DERP identity —
  `docs/tailcat-transport.md:44-47` is explicit about this.
- **`TransportConnection` is message-oriented, the socketpair is not.**
  `ClientContracts.swift:44-51` promises whole binary messages, one waiter at a
  time, and a close that does not let a stale `receive` swallow a later
  connection's data. Partial reads across record boundaries are the normal case.
- **The router's direct path is labelled local in three places.** `local: true`
  and `relayHost: nil` at `DeviceRouter.swift:783`, and the hardcoded "本机直连"
  disconnect reason at `:797`. A remote channel inheriting those labels would
  make the UI and the diagnostics describe a DERP path as a loopback one.
- **`DEVICE_PROTOCOL_VERSION` stays 1.** Only the control protocol moved to 2
  (`crates/protocol/src/lib.rs:61-62`). The envelope version the Swift client
  already sends (`DeviceRouter.swift:7`, `:997`) is correct — do not "fix" it.
- **Control-plane loss degrades rather than kills.** Desktop keeps only
  `SESSION_READ`/`SESSION_CONTROL` traffic flowing while control is down
  (`apps/desktop/src/main/tailcat-transport.ts:155`), matching the router's
  15-second grace. The Swift side has its own grace handling already; do not let
  the new provider bypass it.
- **CGO must be enabled for iOS, and only for iOS.** The shipped helper builds
  `CGO_ENABLED=0` (`AGENTS.md:29`); the c-archive requires `CGO_ENABLED=1` plus
  an `-isysroot`/`-miphoneos-version-min` pair in both `CGO_CFLAGS` and
  `CGO_LDFLAGS`. Do not disturb the existing helper build.
- **Host cgo builds are broken on this machine; iOS cross-builds are not.**
  Verified at baseline: `go test ./internal/...` with cgo enabled fails to link
  because the Command Line Tools macOS SDK advertises an `arm64e.x1-macos`
  architecture the active clang's tapi rejects as "unknown architecture"
  (`internal/ipc` is pure Go and passes; `backend` and `helper` do not). With
  `CGO_ENABLED=0` all three pass, which is also the project's documented build
  mode for the helper (`AGENTS.md:29`). The iOS cross-build is unaffected — it
  resolves its SDK through `xcrun --sdk iphoneos` from Xcode, not from the
  Command Line Tools. Do not read a host-side cgo link failure as a code defect.
- **The local Go is older than the module requires.** go 1.26.6 against
  `go 1.27.1` in `transport/tailcat/go.mod:3`; builds work only because
  `GOTOOLCHAIN` fetches the newer toolchain. A sandbox without network access
  will fail here for reasons that have nothing to do with the code.
- **Simulator slices are a separate build.** The verified commands target
  `ios/arm64` against the iPhoneOS SDK. Anything that must run in the Simulator
  needs its own slice built against the iPhoneSimulator SDK; decide from whether
  the app is actually run there, and do not assume one slice covers both.

## Scope

In scope:
- `transport/tailcat/cmd/` — the new c-archive target
- `packages/swift-client/Sources/` and `packages/swift-client/Tests/`
- `apps/ios/`
- `scripts/` — the framework build script
- `docs/RELEASING.md`, `docs/tailcat-transport.md`, `docs/architecture.md`, `AGENTS.md` — statements about iOS remote support and CI's iOS coverage
- `wiki/plans/README.md`

Out of scope:
- `apps/server/`, `crates/worker/`, `proto/` — the center admits this client
  today (`clientKind` is consulted only at `apps/server/src/hub.ts:3353`, for the
  desktop build-id exemption; the `deviceTailcatConnect` family does not branch
  on client kind) and the worker's remote admission is already the one this
  client will satisfy. Needing to change any of them means an assumption here
  was wrong — see STOP conditions.
- `transport/tailcat/internal/ipc`, `transport/tailcat/internal/helper` —
  subprocess IPC, unused by iOS
- `apps/desktop/` — desktop's transport is working and is only a reference
- iOS serving, NAT/DERP tuning UI, and any change to existing iOS interaction
  paradigms — product non-goals
- Release, TestFlight upload, merging to main

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Go unit tests | `CGO_ENABLED=0 go -C transport/tailcat test ./internal/...` | exit 0 |
| Go vet (host) | `CGO_ENABLED=0 go -C transport/tailcat vet ./...` | exit 0 |
| iOS cross-compile | `SDK=$(xcrun --sdk iphoneos --show-sdk-path); CLANG=$(xcrun --sdk iphoneos --find clang); GOOS=ios GOARCH=arm64 CGO_ENABLED=1 CC="$CLANG" CGO_CFLAGS="-isysroot $SDK -miphoneos-version-min=17.0 -arch arm64" CGO_LDFLAGS="-isysroot $SDK -miphoneos-version-min=17.0 -arch arm64" go -C transport/tailcat build ./...` | exit 0 |
| c-archive emission | same environment with `-buildmode=c-archive -o <out>.a` on the new cmd package | exit 0, `.a` and `.h` produced |
| Swift build | `swift build --package-path packages/swift-client` | exit 0 |
| Swift tests | `swift test --package-path packages/swift-client` | exit 0 |
| Framework script | the new `scripts/` entry point | exit 0, `.xcframework` produced, nothing added to `git status` |
| iOS app build (acceptance) | Xcode build of `apps/ios` against the produced framework | builds and launches |
| Physical device (acceptance) | cellular cold start to terminal output; network drop and recovery; background→foreground rebuild | all three hold |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] A remote device opens from the iOS client: terminal read/write and the
      file/RPC lane both work through the same provider.
- [ ] The device row shows real transport state (direct/DERP plus RTT), and the
      "远程连接暂不可用" placeholder is gone.
- [ ] A remote channel is never labelled local in diagnostics or disconnect text.
- [ ] The proof key is zeroed after use, never persisted, never logged.
- [ ] Backgrounding drops the Go-side client; foregrounding rebuilds it.
- [ ] Swift tests assert record framing, the handshake's known-answer proof, and
      the failure paths that must close rather than hang.
- [ ] No file outside Scope changed; `apps/server`, `crates/worker` and `proto`
      have zero diff.
- [ ] Docs no longer claim iOS remote is unavailable or that CI builds iOS.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome appears to require a change under `apps/server/`,
  `crates/worker/`, or `proto/` — that contradicts a load-bearing assumption of
  this plan; stop and report rather than widening scope.
- The iOS cross-compile or c-archive emission fails at this baseline (both were
  verified working during planning).
- A validation command fails twice after one reasonable fix.
- The handshake cannot be completed against a real worker and the cause is not
  in this client's framing or proof construction.

## Maintenance notes

- The Go bridge and desktop's `NativeTailcatTransport` implement the same client
  protocol against the same worker. A change to the handshake, the grant fields,
  or the record framing has to land in both, and `internal/backend` is the shared
  floor beneath them.
- The Tailcat version pin lives in `transport/tailcat/go.mod`. Bumping it now
  moves iOS too, and the iOS build is not covered by CI — verify the cross-build
  by hand when that pin changes.
- **The proof key is zeroed only in its working copy.** `TailcatDeviceTransportProvider`
  resets the bytes it holds, but Swift's `Data` is copy-on-write: while the
  decoded grant still references the same buffer, the reset allocates a fresh
  copy and clears that, leaving the original bytes to be freed without being
  overwritten. It is never persisted and never logged, and the key is
  single-use with a 30-second window that the worker consumes atomically, so
  the residue is short-lived — but do not read the `defer` as a guarantee that
  no copy survives.
- **`coflux_tailcat_health` structurally reports 0 on a client.** `backend.Health`
  is gated on the region installed by `Serve`, which a connect-only backend
  never calls. The symbol exists for parity with the helper's operation and is
  deliberately not wired into Swift; wiring it would render a false "DERP
  unreachable".
- **The iOS framework build emits no notices file.** Release archives and
  Desktop bundles carry third-party notices for the Go dependency graph; the
  app now links that same graph with no equivalent surface. Worth closing
  before any wider distribution.
- The app's binary size and cold-start cost were never measured against this
  library. If either becomes a complaint, measure before redesigning: the
  userspace stack is the reason no VPN prompt exists, and that tradeoff was
  deliberate.
