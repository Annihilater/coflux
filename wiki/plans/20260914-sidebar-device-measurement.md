# Plan 20260914-sidebar-device-measurement: Restore always-on sidebar device measurement

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 0e31df00..HEAD -- packages/client/src/device-router.ts packages/client/src/device-router.test.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/sidebar.tsx apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts apps/desktop/src/main/tailcat-transport.ts apps/server/src/tailcat-rendezvous.ts transport/tailcat/internal/backend/backend.go wiki/plans/20260912-tailcat-transport.md`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug
- Execution: subagent opus — from the departure check
- Stop after: implementation — the user reviewed the advisor-revised plan and authorized execution
- Workspace: isolated — `dev/20260914-sidebar-device-measurement`
- Planned at: `0e31df00`, 2026-09-14

## Requirement

In the macOS desktop sidebar, a device that the user has not selected never
shows its latency or transport path. Its dot stays muted grey and its tooltip
reads「中心在线」; the moment the user clicks into that device, the dot turns
green and shows `· 45ms` with a direct/relay icon. To the user this reads as
"device status only refreshes when I click into the device's tab" — a bug.

Online/offline itself is fine: the server pushes `daemonUpdated` and the store
applies it (`packages/client/src/store.ts:775`). What is broken is measurement.
`Workbench` retains every online device for measurement
(`apps/desktop/src/renderer/components/workbench/workbench.tsx:381`), but that
call has been a no-op for desktop users since commit `746f5c39` ("make Tailcat
the default remote transport"). Precisely: measurement demand was already
disabled on the Tailcat path before that commit — the old gate read
`(!options.nativeRemote && route.measureCount > 0)` — so making Tailcat the
default is what changed the user-visible behaviour, and `746f5c39` then deleted
the dead non-native branch. This is therefore a Tailcat design decision being
reversed, not a coding slip being repaired. `measureCount` is
now incremented and decremented but never read
(`packages/client/src/device-router.ts:1880`, `:1891`), so
`deviceTransports[daemonId]` stays `undefined` for every unselected device and
the sidebar falls back to `daemon.online ? muted : hollow`
(`apps/desktop/src/renderer/components/workbench/sidebar.tsx:443`, `:457`).

**Product outcome (settled with the user during exploration).** The sidebar
measures every *online* device continuously, whether or not it is selected:

- Each online device row shows the same latency/path vocabulary the selected
  device shows today — coloured dot by latency band, ⚡ direct / 📡 peer / ☁️
  relay shape by path, `· NNms` in the tooltip title.
- Shortly after login every online device passes through the existing
  `probing` state (blue pulsing dot) before its first reading arrives. This is
  expected, not a defect: the connection is genuinely being established.
- Offline devices are unchanged: hollow ring,「中心离线」, no measurement.
- A device that cannot be measured — unreachable, or beyond the connection
  budget below — keeps the current un-measured appearance (muted dot,
  「中心在线」). It must not flicker between probing blue and error red, and it
  must not raise errors.
- Beyond the measurement budget (see the budget decision; ~14 online devices),
  the surplus devices deterministically stay un-measured. The user has 3
  devices; this is a correctness boundary, not a visible one today.
- Nothing in the sidebar's layout, copy vocabulary, or interaction changes.
  Only the *availability* of readings changes.

The user accepted the cost explicitly: one standing Tailcat tunnel per online
device, and with it the battery/data cost of its UDP hole-punching and DERP
heartbeat.

## Decisions & tradeoffs

- **Measurement is restored as a first-class lane demand, not as an on-hover
  probe or a server-side proxy measurement.** Sidebar rows are measured
  continuously for every online device. Rejected: measuring only while the
  tooltip is open — the first hover then waits seconds for a cold connection
  and the sidebar can never be scanned at a glance; rejected: having the server
  ping each daemon and broadcasting the RTT — that measures 设备↔中心, not
  我↔设备, and the hub currently records no RTT at all, only `lastSeenAt`
  (`apps/server/src/hub.ts:3653`), so it would mean new protocol, server,
  daemon and client surface for a weaker number. Based on: there is no
  connectionless path to a device — channels are only `direct` (loopback) and
  `remote` (Tailcat) (`packages/client/src/device-router.ts:173`), and both
  latency sources require an established connection
  (`packages/client/src/device-router.ts:1324`,
  `transport/tailcat/internal/backend/backend.go:205`).

- **The fix restores demand, it does not add a second measurement mechanism.**
  `measureCount > 0` must once again make a route demand a session lane, and
  the admission gates that today require `routeHasFullDemand` must admit a
  measurement-only route to open and to recover a **remote** lane. Rejected:
  leaving `routeHasFullDemand` as the gate and adding a separate measurement
  timer, poller, or parallel lane type — the route state machine already
  carries exactly one session lane per route and the heartbeat rides it
  (`packages/client/src/device-router.ts:1604`). Based on: the pre-Tailcat code
  worked this way — `sessionLaneDemand` counted `measureCount` while
  `routeHasFullDemand` did not — and `746f5c39` removed only the
  `options.nativeRemote` guards around it.

- **`routeHasFullDemand` keeps its current meaning: only interactive demand
  satisfies it.** A measurement-only route must therefore continue to skip
  loopback/direct attempts (`packages/client/src/device-router.ts:909`), skip
  `pairInBackground` (`:740`), and skip the 3s session-catalog poll (`:1595`).
  Rejected: making measurement satisfy `routeHasFullDemand` — that would make
  every idle sidebar device attempt a loopback connection every few seconds,
  which is pointless for every device except the local one, and would poll all
  of them for session catalogs. Based on: those three gates already encode the
  measurement/interaction split and their comments say so
  (`packages/client/src/device-router.ts:1594`).

  This bans *initiating* loopback for measurement; it does not ban *holding* a
  direct lane. A route that already has a direct lane and then loses its
  interactive demand keeps that lane — tearing down a working loopback
  connection to dial a Tailcat tunnel in its place would be absurd — and an
  in-flight direct promotion that lands on a now-measurement-only route is
  allowed to land (`probeDirectPromotion` at
  `packages/client/src/device-router.ts:1683` already keys its guard off
  `sessionLaneDemand`, `:1713`). The local machine's own daemon is never
  measurement-only in practice: the executor bridge holds a permanent full
  retain on it (`apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:30`),
  so it keeps showing「本机直连」.

- **Interactive connections outrank measurement connections under the 16-device
  cap, by pre-emption and not by reservation.** Sixteen concurrently connected
  devices is a hard cap enforced twice: in the desktop main process
  (`apps/desktop/src/main/tailcat-transport.ts:107`, which trips first and
  throws the bare string「同时连接的设备过多」with no error code) and again in
  the Go helper (`transport/tailcat/internal/backend/backend.go:27`, `:177`,
  whose message conflates the cap with a malformed address). The client can
  therefore not diagnose the cap from the error it gets back, so it must not
  reach it: the client keeps its own budget constant, spends at most
  `budget - 2` slots on measurement, and when interactive demand arrives for a
  device with no slot left, closes a measurement-only route to make room. A
  route may be evicted **only** when `routeHasFullDemand(route)` is false.
  Rejected: reserving a fixed number of slots for interaction — interactive
  demand is not one device at a time (the selected device plus every hidden
  terminal whose session is still `desired`, see
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:370`), so any
  fixed reservation is either wasteful or wrong. Rejected: relying on the
  account being small — the user has 3 online devices today, which is exactly
  why a cap failure would not surface until much later, as "I cannot open this
  device". Note that measurement and interaction on the *same* daemon share one
  slot (`apps/desktop/src/main/tailcat-transport.ts:105-114` keys devices by
  daemonId and refcounts users), so the conflict only exists above the budget.

- **A measurement route fails quietly, which means quiet in the sidebar and not
  merely quiet in the error channel.** Four properties, all required, because
  the current failure path satisfies none of them for an unattended route:
  1. No user-visible error. Rejected: letting measurement failures reach
     `options.onError` (`packages/client/src/device-router.ts:1458`) — with
     every online device connected, one unhappy device becomes recurring
     toasts. The codebase already establishes this rule for the heartbeat
     against old daemons, reasoning spelled out at `:1363-1367`.
  2. A failed measurement route publishes the **un-measured** state, not the
     error state. Today both failure paths publish `offline` (`:826`, `:1113`),
     which the sidebar renders as a red dot and「Device route 离线」
     (`apps/desktop/src/renderer/components/workbench/sidebar.tsx:443`, `:457`)
     — the opposite of the quiet muted dot this plan promises.
  3. Retrying does not repaint. `ensureSessionLane` publishes `probing` on
     every attempt (`:805`), so an unreachable device under the existing
     recovery schedule would pulse blue then red every few seconds, forever.
     After a measurement route's first failure, retries must not publish
     `probing` again.
  4. Measurement retries on their own, slower schedule, and not at all while
     the control connection is down. Rejected: reusing `RECOVER_BASE_MS` /
     `RECOVER_MAX_MS` (`:1126`) for measurement — that ladder tops out around
     5s and never stops, which is right for a terminal the user is staring at
     and wrong for a sidebar row. Reconnect already re-drives demanded routes
     when control returns (`:2237`, `:2253`), so measurement must not also
     retry in the dark.

- **The Tailcat plan's "idle sidebar entries do not create tunnels" is
  overturned, deliberately.** `wiki/plans/20260912-tailcat-transport.md:269`
  (design constraint) and `:366` (acceptance item) forbid exactly what this
  plan restores. The user weighed the cost and chose the standing tunnels. The
  measured footprint that makes this acceptable: ten simultaneously demanded
  connections took the client helper from 9 to 49 FD records and back to 9
  after dropping them, with idle RSS 25–46 MiB and 0% CPU
  (`wiki/plans/20260912-tailcat-transport-evidence.md:62`, `:172`); the daemon
  side accepts many clients on one `tailcat.Server`
  (`transport/tailcat/internal/backend/backend.go:119`), so the cost is
  concentrated on the desktop. Rejected: silently contradicting the old plan —
  a future reader hitting that acceptance item must find the reversal recorded.

- **The renderer's measurement retentions are maintained per device, not
  rebuilt as a set.** (decided while planning) Today the retain effect depends
  on a joined, sorted id string and releases every retention in its cleanup
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:380-385`), so
  *any* change to the online set — one laptop sleeping, one device enrolling —
  tears down and re-dials every other device's tunnel. That was tolerable when
  the retention opened nothing; with standing tunnels it means one flapping
  daemon makes the whole sidebar blink `probing`, and it stacks redials against
  the hub's per-connection rendezvous limit of 32 per second
  (`apps/server/src/tailcat-rendezvous.ts:142-146`).
  The effect must keep a per-device map of release handles and only retain
  devices that appeared and release devices that disappeared. Rejected: keeping
  the set-rebuild and treating the churn as acceptable — the sorted-string
  dependency was introduced to *prevent* retain/release churn on every
  broadcast, and it only achieves that while the set is unchanged.

- **Measurement is not suspended when the window is hidden.** (decided while
  planning) Rejected: releasing measurement routes on window hide to save
  battery — re-entering then costs a seconds-long cold connect and shows
  `probing` on every row, which is the exact experience this plan exists to
  remove. Based on: cold attach is a budgeted, non-instant operation with its
  own p95 acceptance gate
  (`wiki/plans/20260912-tailcat-transport.md:371-373`).

- **Scope is the TS client and the desktop renderer only.** `@coflux/client`
  has exactly one consumer, `apps/desktop` (no other workspace imports it). iOS
  has an independent Swift implementation with its own measurement retention
  (`packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift:879`),
  deliberately scoped to "while the devices page is on screen"; it is not
  touched here and its behaviour is not evidence about this bug.

## Direction

The change lives in the device router's demand model plus the test that froze
the regression. The milestones are **not independent** — they touch the same
state machine and the same test file, and milestones 2 and 3 build on
milestone 1. Execute this plan as a single work package.

### Milestone 1: A measurement retention establishes and keeps a remote lane

After this milestone, `retainDevice(id, { measureOnly: true })` on an online
device opens a remote lane, keeps it alive across recovery, and publishes
transport state with an RTT; releasing the retention tears it down again, and a
route with neither measurement nor interactive demand stays idle as before. A
measurement-only route still performs no loopback/direct attempt, no
`pairInBackground`, and no session-catalog polling. `measureCount` is a read
field again — no dead writes remain.

The existing test `packages/client/src/device-router.test.ts:1222` ("sidebar
measurement does not open local or native channels") encodes the regression as
a contract and must be rewritten to the new contract: measurement opens a
`remote` channel, and still opens no `direct` channel and triggers no pair
call. The neighbouring test at `:1230` asserts that dropping the interactive
retention leaves the measurement idle and closes the direct lane; under this
plan the correct assertion is the opposite — the direct lane **survives**, per
the loopback decision — so restate it rather than delete it.

This milestone also closes a gap that this change promotes to the main path:
promoting a measured route to interactive demand must start the session-catalog
poll. `sendCatalogRequest` / `maintainCatalogTimer` run only from
`activateSessionLane` (`packages/client/src/device-router.ts:1067-1068`) and
from `releaseIdle`'s else branch (`:2335`), while `ensureSessionLane`
short-circuits on an existing covering channel (`:776-778`) — so entering a
device that measurement already connected would leave the session catalog
un-polled, and the orphan-session list stale, until some unrelated request
happened to call `releaseIdle`. Any measure→full transition must start the poll
immediately, and a test must cover it: retain `measureOnly`, resolve the remote
channel, retain fully, assert a `sessionCatalogRequest` goes out.

Validation: `node --import tsx --test packages/client/src/*.test.ts` -> exit 0.

### Milestone 2: The budget holds and failure is quiet

After this milestone, interactive demand cannot be starved by measurement
demand under the 16-device cap, and a measurement route that cannot connect —
or that receives a device error frame — settles into the un-measured
appearance instead of oscillating or raising errors.

The existing harness supports all of this directly (it exposes `errors` from
`onError`, `states` from every `publish`, `adapter.opens`, `fail()` / `emit()`,
and a fake clock), so each property gets a test that fails today:

- Unreachable device: retain `measureOnly`, fail the remote open, assert
  `errors` is unchanged and the last published mode is the un-measured one
  (**not** `offline`); advance the clock two minutes and assert the retry count
  stays within the measurement schedule and that no further `probing` state was
  published.
- Device error frame: resolve the remote channel, emit an error frame with no
  requestId, assert `errors` is unchanged.
- Budget: retain `measureOnly` for more devices than the budget allows and
  assert the number of distinct daemons with an open or in-flight remote lane
  stays within it; then take an interactive retention on a device that has no
  slot and assert it gets its channel and that whatever was evicted was a route
  without full demand.

Validation: `node --import tsx --test packages/client/src/*.test.ts` -> exit 0.

### Milestone 3: The renderer maintains retentions per device, and the record matches the code

After this milestone, the workbench retain effect adds and drops measurement
retentions per device instead of rebuilding the whole set whenever the online
set changes, so one device coming or going leaves every other device's
measurement untouched. If the diffing is extracted as a pure function, it
carries a test; if it stays inside the effect, the milestone rests on
typecheck plus the desktop suite.

Also after this milestone:
`apps/desktop/src/renderer/components/workbench/workbench.tsx:376-381`
describes what `measureOnly` now does (its current comment describes the
pre-Tailcat relay behaviour and is wrong today), the stale English comment at
`packages/client/src/device-router.ts:1143` is gone or corrected, and
`wiki/plans/20260912-tailcat-transport.md` carries a short, dated note at both
`:269` and `:366` recording that this plan supersedes the "no tunnels for idle
sidebar entries" constraint, with a pointer to this plan.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` ->
exit 0.

## Landmines

- `packages/client/src/device-router.test.ts:1222` asserts the bug as intended
  behaviour. A run that leaves it untouched and green means the fix did not
  land.
- Four gates were changed together by `746f5c39` and must be reasoned about
  together; fixing a subset leaves measurement half-alive (for example, a lane
  that opens but is never recovered after a drop):
  `packages/client/src/device-router.ts:778` (open),
  `:1125` (recover), `:1885` (retain triggers open), and `sessionLaneDemand`
  at `:1144`.
- `releaseIdle` (`packages/client/src/device-router.ts:2321`) decides teardown
  from `sessionLaneDemand`. Once measurement counts there, "release the
  interactive retention" no longer means "close the lane" — anything that
  assumed `releaseIdle` tears down a measured route needs rechecking.
- The default device-error path is `options.onError`
  (`packages/client/src/device-router.ts:1458`). With every online device
  connected, an unhappy device now reaches the user through the sidebar rather
  than only when they enter it.
- `daemons` is a fresh array on every broadcast, and `workbench.tsx:380`
  collapses it to a sorted id string so the retain effect does not churn on
  every push. That protection covers only broadcasts where the online *set* is
  unchanged; when the set changes, the effect's cleanup releases every
  retention and the next run re-dials all of them. Preserve the
  same-set protection while removing the whole-set rebuild.
- Session-catalog polling starts in exactly two places
  (`packages/client/src/device-router.ts:1067-1068` and `:2335`), and
  `ensureSessionLane` short-circuits on an existing covering channel (`:776`),
  so "lane already up, demand just became interactive" bypasses both.
- The executor bridge holds a permanent full retain on the local daemon
  (`apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:30`).
  It is not a measurement retention, it predates any sidebar selection, and it
  consumes one of the 16 slots — do not model the local machine as an idle
  sidebar row.
- The 16-device cap is enforced in two places and neither is diagnosable from
  the client: `apps/desktop/src/main/tailcat-transport.ts:107` trips first with
  the bare string「同时连接的设备过多」, and
  `transport/tailcat/internal/backend/backend.go:177` conflates the cap with a
  malformed address. Neither carries an error code, so the client must stay
  under the cap rather than react to hitting it.

## Scope

In scope:
- `packages/client/src/device-router.ts`
- `packages/client/src/device-router.test.ts`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` — the retain
  effect's per-device diffing, plus the stale comment above it
- `wiki/plans/20260912-tailcat-transport.md` (supersession note only)
- `wiki/plans/README.md`

Out of scope:
- `apps/desktop/src/renderer/components/workbench/sidebar.tsx` — it already
  renders latency and path correctly once `deviceTransports` has an entry; no
  UI change is required or wanted.
- `transport/tailcat/**` and `apps/desktop/src/main/tailcat-transport.ts` — the
  16-device cap stays where it is; the client keeps its own budget below it
  rather than raising or re-plumbing either enforcer.
- `packages/swift-client/**`, `apps/ios/**` — independent implementation,
  separate decision about when the devices page measures.
- `apps/server/**`, `proto/**` — no server-side or protocol change; the fix is
  entirely in client demand accounting.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Client unit tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop against production (acceptance) | `pnpm dev:desktop:prod` | sidebar shows latency and path for every online device without selecting it |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] An unselected online device in the sidebar shows a latency-coloured dot,
      a path icon, and `· NNms` in its tooltip, without being selected.
- [ ] Selecting a device and leaving it does not change whether it is measured.
- [ ] Offline devices are still hollow,「中心离线」, and unmeasured.
- [ ] Entering a device still works when measurement holds connections, and
      entering one that measurement already connected starts session-catalog
      polling.
- [ ] A device that cannot be measured keeps the un-measured appearance: no
      error surfaces, and it does not alternate between probing and error.
- [ ] One device going offline or coming online does not disturb the other
      devices' measurements.
- [ ] `measureCount` has at least one read site; no field is written and never
      read.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files — in particular, if the guarantee
  "interactive demand outranks measurement demand" cannot be met inside
  `packages/client`, stop and report rather than editing either cap enforcer
  (the desktop main process or the Go helper).
- A validation command fails twice after one reasonable fix.
- Restoring measurement demand turns out to require changing what
  `routeHasFullDemand` means; that contradicts a recorded decision.

## Maintenance notes

- This plan deliberately reverses an acceptance item of
  `wiki/plans/20260912-tailcat-transport.md`. If a future transport change
  makes standing per-device tunnels expensive again, the cheap fallback the
  user already rejected once — measuring only while the tooltip is open — is
  the first thing to reconsider, and that is a product decision, not a
  refactor.
- The 16-device helper cap is the first thing to check if a user with a large
  fleet reports "I cannot open this device" or missing sidebar readings.
- iOS still measures only while its devices page is on screen. If the two
  clients should ever agree, that is a separate decision with its own battery
  tradeoff on a phone.
