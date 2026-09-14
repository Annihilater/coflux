# Plan 20260914-ios-device-sessions: Reach device-level sessions from iOS

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 9e47df6c..HEAD -- apps/ios/Coflux/Views packages/swift-client/Sources/CofluxClientCore packages/swift-client/Tests/CofluxClientCoreTests apps/server/src/hub.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/components/workbench/terminal-attach.ts packages/client/src/store.ts crates/worker/src/ops.rs proto/coflux/v1/common.proto proto/coflux/v1/client.proto`

## Status

- Priority: P2
- Effort: M
- Risk: LOW — iOS view layer plus one pure helper in the Swift client; no protocol, server, daemon, or desktop change
- Depends on: none
- Category: feature
- Execution: subagent opus — from the departure check
- Stop after: implementation — from the departure check's autopilot item
- Plan review: advisor — from the departure check's autopilot item
- Workspace: isolated — `.claude/worktrees/20260914-ios-device-sessions`, branch `dev/20260914-ios-device-sessions`, cut from main `9e47df6c` with a clean tree
- Planned at: `9e47df6c`, 2026-09-14
- Current state: DONE on `dev/20260914-ios-device-sessions` (implementation `b9c710ac`..`90091387`, no revision rounds). Verified by the orchestrator: `swift test --package-path packages/swift-client` exit 0 with 98 tests, 93 of them the baseline measured on `17fff5c1` before dispatch and 5 new in `DirWorkspaceTests`; `node scripts/build-ios-transport.mjs` exit 0; `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` → `** BUILD SUCCEEDED **` with no errors and no warnings in the touched files; `git status --porcelain` empty; the diff touches only the five in-scope files, with `proto/`, `apps/server/`, `apps/desktop/`, `crates/` and `transport/` at zero diff. The tie-break test asserts both list orders, so an implementation that ordered by `createdAt` alone would fail it. Released to TestFlight as build 978 on 2026-09-14 from this branch (`release.sh` exit 0: native transport framework, `xcodebuild archive`, and upload to App Store Connect all succeeded; ASC processing takes 10–30 minutes before the build appears). Not done: the behavioural done criteria — they are the user's device walkthrough (device panel → a device → read a session, create the first terminal on a device that has none and confirm it comes up running, offline device shows the disabled action); merge to main; release. Executor note accepted: `wiki/plans/README.md` was left to the orchestrator, since the dispatch forbids the executor touching it.

## Requirement

### Problem

A *device-level session* is a terminal running in a device's **directory
workspace** — the workspace whose `projectId` is empty, rooted at the daemon
user's HOME. On desktop it is a first-class surface: the sidebar's device
section, click a device, and the main area renders that device's directory
workspace (`apps/desktop/src/renderer/components/workbench/workbench.tsx:245`).

On iOS those sessions are unreachable. The workspace list renders only
workspaces that match a project (`apps/ios/Coflux/Views/WorkspaceListView.swift:17`),
and a directory workspace belongs to no project, so it lands in no section and
appears nowhere. The device panel that does exist
(`apps/ios/Coflux/Views/DevicesView.swift`) is a deliberately read-only health
view — its header comment states「行三层，无详情页」— with no way in.

The data has been on the device all along: the server sends every workspace and
task of the account in the snapshot (`apps/server/src/hub.ts:2692`-`2707`), and
`CofluxClient` stores them whole (`packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift:519`).
This is a missing entry point, not a missing capability.

### What is true when this is done

The owner, away from the desk, opens the iOS app, taps the device panel, taps a
machine, and is in that machine's task deck — reading what an agent has been
doing there, typing into it, or opening the very first terminal on a machine
that never had one.

### Product conclusions (settled with the user during exploration; do not reopen)

1. **Entry**: project page → top-right 💻 → device panel; each device row is
   tappable as a whole with a trailing chevron, drilling into that device's task
   deck. This reverses `DevicesView`'s original "no detail page" decision, but
   the three-line health layout of the row itself is unchanged.
2. **With sessions**: reuse the existing task deck `WorkspaceDetailView` as-is
   (tab strip, full-page paging, control pad, push-to-talk dictation). No new
   paradigm. The navigation title shows the **device name** (falling back to
   `host` when `name` is empty, the same rule as `DevicesView.swift:69`) instead
   of the directory workspace's `name`, which is the bare string `~`.
3. **Without sessions**: an empty state matching the desktop's wording —
   "在「<设备名>」上开一个终端" / "终端会打开在这台设备的 HOME 目录" — with a
   「新建终端」button that resolves the device's HOME absolute path, creates the
   directory workspace, and turns into the task deck in place, with that first
   terminal **already running** — tapping「新建终端」yields a usable terminal,
   not a task waiting behind a manual「启动」banner.
4. **Device row**: on top of the current three lines (name + latency / host ·
   platform / path + version), the row shows the count of running sessions at
   its trailing edge, in the same vocabulary as the workspace rows on the
   project list (green dot + number).
5. **Offline devices**: still tappable, existing sessions still readable (same
   as desktop). 「新建终端」is disabled with "设备当前离线，上线后才能新建终端".
6. **Not in scope**: no device section on the project list home; no delete or
   rename entry for directory workspaces.

## Decisions & tradeoffs

- **The canonical directory workspace is resolved by the server's own
  idempotence rule**: among workspaces where `projectID` is empty and `daemonID`
  matches, take the one with the smallest `createdAt`, breaking ties by
  ascending `id`. Rejected: "the first match found", and ordering by `createdAt`
  alone — the latter is what the desktop does
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:245`-`248`,
  no tie-break), so copying the desktop would copy a rule that is one degree
  looser than the server's reuse query. Whichever row the server reuses is the
  one that receives new terminals, so the client must resolve the same one (the
  DB's `uq_workspaces_directory_device` is a last line of defence, not a
  guarantee the client can lean on). Based on: `apps/server/src/hub.ts:2949`-`2951`;
  `packages/client/src/store.ts:263`-`266`.

- **`isDirWorkspace` is defined once in `CofluxClientCore` and exported**: views
  never write `workspace.projectID.isEmpty`. Rejected: a local check inside the
  iOS view — the TypeScript client states the rule explicitly at
  `packages/client/src/store.ts:263`-`264`「判定在客户端收敛于此一处，勿在 UI 层散落
  裸比较」, and the Swift client is the same layer. Based on:
  `packages/client/src/store.ts:263`-`266`; no such helper exists in
  `packages/swift-client/Sources/CofluxClientCore` today.

- **Both the predicate and the canonical resolution live in `CofluxClientCore`
  as pure, testable functions**, exercised by `CofluxClientCoreTests`. Rejected:
  putting the resolution in the SwiftUI view as a computed property — the
  tie-break rule above is exactly the kind of thing that silently drifts from
  the server, and the view layer has no tests. Based on:
  `packages/swift-client/Tests/CofluxClientCoreTests/` (nine existing test
  files, including `ReducerTests.swift` for state-shaping logic).

- **First creation goes `listDeviceDirectory(daemonID, "~")` → `terminalCreate`
  with the returned absolute path**: the client never sends `~` onward.
  Rejected: sending `path: "~"` directly — the server performs no resolution on
  `TerminalCreate.path`, storing it verbatim as the workspace's path
  (`apps/server/src/hub.ts:2926`-`2928`, `:2961`), so a `~` would become the
  literal workspace path; the fs-list route is where expansion legitimately
  happens (`crates/worker/src/ops.rs:85`-`93`, `:103`-`105`) and desktop already
  treats the resolved `FsListed.path` as the contract
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:455`-`466`).
  Based on: `CofluxClient.swift:911` (`listDeviceDirectory` with
  `browseHome: true`); `CofluxClient.swift:897` (`terminalCreate` is already on
  the workbench-command allowlist); `proto/coflux/v1/client.proto` `TerminalCreate
  { daemon_id, path }`.

- **The terminal this page creates is started, not left idle**
  *(revised on advisor review)*: after the page's own `terminalCreate`, when the
  canonical directory workspace appears, the page starts that workspace's single
  task via `client.startTask(taskID:cols:rows:)` with the deck's default 80×24,
  so the user lands on a live terminal rather than a「任务尚未启动」banner.
  Rejected: leaving it to the user's tap — the server creates the task as
  `TaskStatus.IDLE` (`apps/server/src/hub.ts:2969`), desktop auto-starts an IDLE
  task on activation
  (`apps/desktop/src/renderer/components/workbench/terminal-attach.ts:162`-`163`),
  and the deck's own self-created-task path does exactly this with the same
  defaults (`apps/ios/Coflux/Views/WorkspaceDetailView.swift:285`-`292`, whose
  comment states that without this send the task stops at the manual-start
  banner) — but that path keys off the deck's private
  `knownTaskIDsBeforeCreate`, which a caller cannot reach. This applies **only
  to the task produced by this page's own creation**: an IDLE task that already
  existed, or one created elsewhere, is left alone and keeps its manual
  「启动」banner (`WorkspaceDetailView.swift:596`-`604`). Based on the four
  citations above.

- **Success is observed as the canonical workspace appearing, not as a
  correlated reply**: `terminalCreate` has no request/response pairing, and the
  server creates the workspace *and* one task in the same transaction
  (`apps/server/src/hub.ts:2926`-`2961`), so the arrival of the canonical
  directory workspace in the client snapshot is the completion signal, and the
  deck then already has one tab. Rejected: the desktop's "record the set of
  known ids before sending, adopt the new one" pattern — that exists for
  `workspaceCreate`, where several workspaces of a device are indistinguishable;
  here at most one directory workspace per device exists by construction, so
  the extra bookkeeping would add a failure mode without adding information.
  Based on: `CofluxClient.swift:698`-`708` (the same no-correlation note for
  `taskCreate`); `apps/server/src/hub.ts:2941`-`2972` (workspace and task
  created in one transaction).

- **Failure is rendered by the page itself, and a server rejection is
  recognised by a change in `client.lastError.id`** *(revised on advisor
  review)*: no iOS view renders `client.lastError` today — `grep lastError
  apps/ios/Coflux` returns nothing — so "the error surfaces through the client"
  would mean the user sees a spinner that never resolves. The page must capture
  `client.lastError?.id` before sending, treat any later change of that id as
  this attempt's failure (the same device the desktop uses at
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:470`-`473`),
  and also clear busy when `sendWorkbenchCommand` returns `false`. Rejected:
  handling only the thrown `DeviceRouteError` from the HOME listing — the
  server's rejections (「终端目录路径为空」, 「daemon 不在线或不属于本账号」)
  arrive as an `error` broadcast, not as a throw. Based on:
  `CofluxClient.swift:606`-`609` (error → `lastError`); `CofluxClient.swift:894`-`909`
  (`sendWorkbenchCommand` returns `false` and reports locally when the control
  plane is not authenticated); `apps/server/src/hub.ts:2932`, `:2936`.

- **The page is addressed by device id and derives *both* the device and the
  workspace from live client state on every render, never capturing either**
  *(extended on advisor review)*: a directory workspace can disappear while the
  page is open (the desktop can remove it; removal only deletes the record,
  `apps/server/src/hub.ts:3146`), and the device itself can go offline, be
  renamed, or be removed. A page holding a `Coflux_V1_DaemonInfo` value would
  keep offering an enabled「新建终端」for a device that is gone — the tap then
  returns the server's「daemon 不在线或不属于本账号」— and would not track the
  online flag the button's disabled state depends on. Rejected: passing the
  workspace or the daemon as a value, or resolving either in `onAppear` and
  holding it. When the device is no longer in `client.daemons`, the page must
  not present creation at all. Based on: `apps/server/src/hub.ts:3146`;
  `CofluxClient.swift:566` (`workspaceRemoved`); `CofluxClient.swift:539`-`549`
  (`daemonRemoved` drops the daemon, its workspaces and its tasks together);
  `CofluxClient.swift:533`-`535` (`online` flips through `daemonUpdated`);
  `apps/server/src/hub.ts:2932`.

- **The running-session count on a device row counts only tasks of that
  device's canonical directory workspace**, not every running task of the
  device. Rejected: counting all tasks with a matching `daemonID` — the row's
  number would then disagree with what tapping the row shows (a device with
  four project-workspace terminals and one device-level session would read "5"
  and open a deck with one tab), which is worse than no number. Based on: the
  deck's own membership rule, `apps/ios/Coflux/Views/WorkspaceDetailView.swift:78`-`82`
  (`tasks.filter { $0.workspaceID == workspace.id }`).

- **The device-name title is resolved inside `WorkspaceDetailView` from
  `isDirWorkspace`, not passed in by the caller**: "a directory workspace is
  titled by its device" is a property of the workspace kind, not a caller
  preference, and a title parameter would let a future caller title it anything.
  Rejected: adding a `title` / `titleOverride` parameter. Based on:
  `apps/ios/Coflux/Views/WorkspaceDetailView.swift:257` (the title is currently
  `branch.isEmpty ? name : branch`, which yields the bare `~` for a directory
  workspace); `apps/ios/Coflux/Views/DevicesView.swift:69` (the
  `name.isEmpty ? host : name` fallback to reuse).

- **No protocol, server, desktop, or daemon change**: every capability this
  needs already exists client-side. Based on: full snapshot of workspaces and
  tasks (`apps/server/src/hub.ts:2692`-`2707`, `CofluxClient.swift:519`),
  `listDeviceDirectory` (`:911`), the `terminalCreate` allowlist (`:897`), and
  `createTask` (`:700`).

## Direction

Three milestones, **strictly serial** — M2 renders a link into the view M3
creates, and both depend on M1's helpers. Execute as a single work package; do
not fan out.

### Milestone 1: the directory-workspace rule exists once, in the client core

`CofluxClientCore` exports the `isDirWorkspace` predicate and the canonical
resolution (given a daemon id and the workspace list, the earliest-`createdAt`
directory workspace of that device, ties broken by ascending `id`), both pure
and covered by tests in `CofluxClientCoreTests` — including the tie-break and
the "no directory workspace" case.

Validation: `swift test --package-path packages/swift-client` -> exit 0, new
cases green.

### Milestone 2: a device's sessions are reachable and countable from the panel

Each row of the iOS device panel drills into that device's session page, with a
trailing chevron, keeping the existing three-line health layout and its
measurement lifecycle intact. The row shows the count of that device's
canonical directory workspace's tasks whose `status == .running`, when greater
than zero, in the project list's green-dot-plus-number vocabulary
(`apps/ios/Coflux/Views/WorkspaceListView.swift:147`-`156`).

Validation: `swift build --package-path packages/swift-client` -> exit 0;
iOS app target compiles (see Commands).

### Milestone 3: the device session page reads and creates

The device session page resolves the device and its canonical directory
workspace from live client state on every render. With a workspace, it renders
the existing task deck, titled by device name — and only the deck sets that
title, so the page never competes with it. Without one, it renders the empty
state with the「新建终端」action described in the Requirement, disabled and
explained when the device is offline.

The action resolves HOME through the device browse route (a call that may take
seconds on a cold lane, so it needs its own busy state) and issues
`terminalCreate`. Every failure path ends visibly on this page — a thrown route
error, an `FsListed` with `ok == false`, a refused send, and a server rejection
recognised through `client.lastError.id` — never in a spinner that never
resolves. When the workspace arrives, the page starts that workspace's task and
turns into the deck.

Validation: iOS app target compiles (see Commands); the behaviour itself is
acceptance-tier and belongs to the user's device walkthrough.

## Landmines

- **`FsListed` reports failure in-band, not by throwing**:
  `listDeviceDirectory` returns a `Coflux_V1_FsListed` whose `ok` may be false
  with an `error` string, and whose `path` is `optional`
  (`proto/coflux/v1/common.proto:139`-`146`). Checking only for a thrown
  `DeviceRouteError` would let a failed listing proceed to `terminalCreate` with
  an empty path, which the server rejects with「终端目录路径为空」
  (`apps/server/src/hub.ts:2936`). Check `ok`, `hasPath`, and non-empty
  before sending — desktop does the same at `workbench.tsx:461`-`465`.
- **The iOS app target cannot link without the native transport archive**:
  `node scripts/build-ios-transport.mjs` produces a ~45 MB xcframework that is
  gitignored and absent from CI and from a fresh worktree; skip it and
  `xcodebuild` fails at link time, not at configure time
  (`wiki/plans/20260913-ios-tailcat-transport.md:22`, `AGENTS.md:29`).
- **Do not touch `project.pbxproj`**: the project uses
  `PBXFileSystemSynchronizedRootGroup` at objectVersion 70
  (`apps/ios/Coflux.xcodeproj/project.pbxproj:34`), so a new `.swift` file under
  `apps/ios/Coflux/` joins the target automatically. The file also carries local
  signing state that `release.sh` deliberately refuses to modify
  (`apps/ios/release.sh:8`).
- **`DevicesView`'s RTT measurement is released when the panel disappears**:
  `onDisappear` releases every retained measure (`DevicesView.swift:53`, `:178`), so pushing the session page stops measurement and popping back
  restarts it. That is correct — but it means the pushed page has no latency
  reading of its own unless it retains one, and it must not be assumed to
  inherit one.
- **The HOME listing rides the elevated lane and dials on demand**:
  `listDeviceDirectory` issues its request on `lane: .elevated`, which requires
  the control plane online and establishes the lane itself if it is cold
  (`packages/swift-client/Sources/CofluxClientCore/DeviceRouter.swift:1391`,
  `:1408`-`1411`), so the first call after opening the app can take seconds and
  can time out. It is independent of the device panel's measurement lane, so
  the busy state must be the page's own. A `DeviceError` envelope comes back as
  a thrown `DeviceRouteError` (`DeviceRouter.swift:1511`-`1514`) while a listing
  failure comes back in-band — both paths need handling.
- **Reinstantiating the deck for a different workspace keeps the old view's
  state unless it is given an identity**: `WorkspaceDetailView.init` seeds
  `@State` from the workspace id (`WorkspaceDetailView.swift:65`-`69`), and
  `activeTaskID` / `knownTaskIDsBeforeCreate` are instance state. Inside an
  `if let` branch the structural identity does not change when the resolved
  workspace changes id — which happens if a directory workspace is removed from
  the desktop and a new one is created while the page is open — so the deck
  branch needs `.id(workspace.id)` to be rebuilt rather than reused.
- **`NavigationStack` ownership**: `DevicesView` is itself pushed from
  `WorkspaceListView`'s toolbar (`WorkspaceListView.swift:51`-`58`) and declares
  no stack of its own; the new page must be pushed into the same stack, not
  wrapped in a second `NavigationStack`.
- **Task membership is by workspace id, not device id**: `Coflux_V1_Task` carries
  both, and the deck filters by `workspaceID`
  (`WorkspaceDetailView.swift:78`-`82`). Counting by `daemonID` is the mistake
  the row-count decision above exists to prevent.

## Scope

In scope:
- `apps/ios/Coflux/Views/DevicesView.swift`
- `apps/ios/Coflux/Views/WorkspaceDetailView.swift` (title rule only)
- one new view file under `apps/ios/Coflux/Views/` for the device session page
- `packages/swift-client/Sources/CofluxClientCore/` (the predicate and canonical
  resolution; placement within the module is the executor's call)
- `packages/swift-client/Tests/CofluxClientCoreTests/`
- `wiki/plans/README.md` (status row)

Out of scope:
- `proto/`, `apps/server/`, `apps/desktop/`, `crates/`, `transport/` — no
  capability is missing on any of them
- `apps/ios/Coflux/Views/WorkspaceListView.swift` — the product decision keeps
  the home list project-only
- delete / rename entries for directory workspaces — not part of this
  requirement
- the dictation, control-pad, and paging internals of the task deck — reused
  unchanged
- `apps/ios/release.sh` and anything release-related — shipping this to
  TestFlight is a separate, user-driven step

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Swift client tests | `swift test --package-path packages/swift-client` | exit 0 |
| Swift client build | `swift build --package-path packages/swift-client` | exit 0 |
| Native transport archive (prerequisite of the next row) | `node scripts/build-ios-transport.mjs` | exit 0, xcframework produced |
| iOS app compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` | exit 0 — if it stalls on signing, append `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`; this row is a compile check, not a signing check |
| Device walkthrough (acceptance) | TestFlight / physical device: device panel → a device → read a session, open the first terminal on a device that has none, offline device shows the disabled action | user-run |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Tapping a device row in the iOS device panel opens that device's session
      page; the row still shows its three health lines.
- [ ] A device with device-level sessions shows them in the existing task deck,
      titled by device name, with the tab strip and control pad working as they
      do for project workspaces.
- [ ] A device with no directory workspace shows the empty state and can create
      its first terminal from iOS, landing in the deck without a manual refresh
      and with that terminal **running** — no「任务尚未启动」banner to dismiss.
- [ ] Every failure of the creation action is visible on the page itself — a
      route error, a listing that returns `ok == false`, and a server rejection
      — and none of them leaves the button spinning.
- [ ] An offline device opens, shows any existing sessions, and presents the
      creation action as disabled with the offline explanation.
- [ ] A device row shows the count of its directory workspace's `.running`
      tasks only.
- [ ] `isDirWorkspace` and the canonical resolution exist once in
      `CofluxClientCore` with tests; no view tests `projectID` for emptiness
      (comparing `projectID` against a project's id, as the workspace list does
      for grouping, is a different question and stays as it is).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed (`proto/`, `apps/server/`, `apps/desktop/`,
      `crates/`, `transport/` have zero diff).
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular the
  server's canonical-reuse ordering (`apps/server/src/hub.ts:2949`-`2951`) or
  the `terminalCreate` allowlist entry (`CofluxClient.swift:897`).
- The outcome appears to require a protocol, server, or daemon change: that
  contradicts the plan's central premise; stop and report rather than widen.
- A validation command fails twice after one reasonable fix.
- `node scripts/build-ios-transport.mjs` cannot produce the archive in this
  environment — report it; do not work around it by editing the Xcode project.

## Maintenance notes

- The canonical directory-workspace rule now exists in three places: the server
  (`hub.ts`), the TypeScript client (`workbench.tsx`), and the Swift client.
  They must agree; if the server's idempotence rule ever changes, all three
  move together. Note the desktop's copy is already one degree looser — it
  orders by `createdAt` with no `id` tie-break
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:248`) — which
  only bites if a device ever ends up with two directory workspaces sharing a
  timestamp. Tightening it is out of scope here and worth doing separately.
- Auto-starting the created terminal is a property of *this page's* creation
  flow, not of the deck. If the deck ever grows a general "an IDLE task you
  open gets started" rule the way desktop has
  (`apps/desktop/src/renderer/components/workbench/terminal-attach.ts:162`-`163`),
  this page's explicit start becomes redundant and should be removed rather
  than left to double-fire.
- The device session page is the second caller of `WorkspaceDetailView`. Any
  future feature added to the deck that assumes a git branch, a project, or a
  diff will be wrong for directory workspaces — the deck is already free of
  project assumptions today (`projectID` appears nowhere in it), and that is
  worth preserving.
- Real-device acceptance for this plan is the user's; automated verification
  stops at compilation, per the standing convention that agents do not perform
  UI walkthroughs.
