# Plan 20261002-runtime-launcher-merge: One replaceable runtime behind a minimal launcher

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat fe64fcf3..HEAD -- crates/ apps/desktop/src/main apps/desktop/scripts apps/desktop/electron-builder.yml apps/server/src/auto-update.ts apps/server/src/hub.ts packages/cli scripts/release-sign.mjs scripts/release-statement.mjs .github/workflows tests/src proto/`
> (changes from `20261002-runtime-follows-app` are expected inside these paths.)

## Status

- Priority: P2
- Effort: L
- Risk: HIGH
- Depends on: wiki/plans/20261002-runtime-follows-app.md
- Category: refactor
- Execution: subagent(fable) — departure check, 2026-10-02
- Stop after: implementation — departure check ("plan audit, then execute")
- Plan review: audit — departure check
- Workspace: isolated — `.claude/worktrees/20261002-runtime-launcher-merge` on `dev/20261002-runtime-launcher-merge`
- Planned at: `fe64fcf3`, 2026-10-02

## Requirement

Each device runs `coflux-ptyd` (owns every PTY, near-zero change rate),
`coflux-supervisor` (sessiond: VT/history/holder/sequence authority, PTY
environment assembly, worker version management, download/verify,
probation/rollback) and `coflux-worker` (center connection, git/exec/fs,
local gateway, channels, executor host), plus the paired Go
`coflux-transport` and, on macOS desktop, the Swift `coflux-screen`. The
supervisor/worker split existed so that the process holding PTYs never had to
restart; ptyd now carries that guarantee, so the split only costs a second
UDS hop on the terminal data path (ptyd → supervisor → worker), a
supervisor↔worker version-compatibility matrix, and two update mechanisms
(center-pushed worker vs. manually restarted supervisor).

When this plan is done, a device runs **ptyd + launcher + runtime**:

- The **runtime** is one process that holds sessiond and everything the
  worker does, talks to ptyd directly, and is the unit that gets updated.
- The **launcher** is a small, rarely changing Rust process that owns the
  version pointer, spawns the runtime, decides probation/commit, rolls back a
  crash-looping or pseudo-healthy candidate, falls back to the builtin
  runtime, and owns `runtime.sock` / `runtime.lock`. Both the desktop app and
  the `cofluxd`-generated service start the launcher; nothing else changes
  versions.

Accepted product cost (user, 2026-10-02): every runtime update — automatic
center pushes included — rebuilds sessiond from ptyd, so terminals pause
briefly, attached clients reattach (holders are reclaimed on reattach), and
the create/stop de-duplication ledger is reset. This was previously true only
of manual supervisor updates.

Product conclusions (confirmed 2026-10-02):

1. **Desktop**: after an app update restart, a runtime that differs from the
   bundled one is replaced automatically (the trigger, once-per-launch rule and
   「更新未能应用」/「重试」 surface come from `20261002-runtime-follows-app`).
   Terminals survive. A version that fails to start **or starts and then
   crash-loops or never becomes healthy** is rolled back to the previous one
   automatically. 「更新终端组件」 (ptyd itself) stays separate and confirmed.
2. **Desktop-hosted daemons** never accept center pushes; their runtime
   version equals the app version.
3. **Headless** (Linux, npm-installed Macs): the center pushes the whole
   runtime automatically, with the same probation/rollback guarantees as
   today's worker push; terminals survive with a brief pause. `cofluxd update`
   / `restart` are needed only when the launcher, ptyd or the CLI change.
4. **Migration**: the first release with this plan switches a desktop over
   automatically and losslessly (the running supervisor supports `leave`).
   Headless machines need one manual `npm i -g cofluxd@latest && cofluxd update
   && cofluxd restart`, terminals kept. Machines that never do it stay on their
   last worker and receive no further automatic updates.
5. **Non-goals**: `coflux-transport` (Go), `coflux-screen` (Swift), `coflux`
   and `cofluxd` are not merged into anything; ptyd's binary and its v1
   protocol are not changed.
6. **Acceptance**: desktop update → terminals present, no click; after a
   release, a headless device moves to the new runtime by itself with
   terminals present; a deliberately crash-on-start (and a deliberately
   never-ready) runtime is rolled back automatically on both desktop and
   headless.

## Decisions & tradeoffs

- **Direction of the merge**: the worker absorbs sessiond (`sessiond.rs`,
  `sessions.rs`), PTY environment assembly and shell integration
  (`shell_integration.rs`, `shell/`), and the FDA probe; it connects to ptyd
  itself. The supervisor crate becomes the launcher and keeps only: version
  store and pointer, spawning the runtime, probation/commit, rollback, builtin
  fallback, `runtime.sock` / `runtime.lock`. Rejected: the worker swallowing
  the supervisor entirely with no launcher — nothing could roll back a
  crash-looping version on headless devices (launchd/systemd restart a fixed
  path). Rejected: putting the launcher role into ptyd — ptyd's contract is
  that nothing that changes per release goes into it, and changing ptyd ends
  terminals. Based on: `crates/supervisor/src/` file inventory,
  `docs/architecture.md:102` (ptyd contract),
  `packages/cli/service-unit.mjs` (fixed-path `KeepAlive` / `Restart=always`).
- **One launcher, shared**: the desktop starts the Rust launcher (not the
  runtime) and asks it to switch versions; `apps/desktop/src/main/runtime-replace.ts`,
  the TS crash watchdog in `daemon-manager.ts` and the desktop's own
  leave/start replacement path are deleted, not kept alongside. The automatic
  follow decision from the previous plan (`runtime-follow.ts`) is kept and
  now ends in a launcher switch request. Rejected: a
  TS launcher on desktop plus a Rust one on headless — two implementations of
  the same rollback logic. This also closes a current hole: the TS watchdog
  restarts the same marker directory every 10 s and never rolls back a version
  that crash-loops after starting. The desktop still spawns the launcher
  itself so the daemon tree stays attributed to the app for TCC. Based on:
  `apps/desktop/src/main/runtime-replace.ts:27-58`,
  `apps/desktop/src/main/daemon-manager.ts:150-170,262-291`,
  `apps/desktop/src/main/desktop-runtime.ts:271-316`.
- **`runtime.sock` / `runtime.lock` belong to the launcher**, so the
  desktop's "running" derivation and the single-instance lock never flip
  during a runtime swap. Its `status` keeps reporting what the desktop needs
  (instance id, runtime id/version, custody); `stop` ends all terminals;
  `leave` (or its successor) lets the launcher itself be replaced with
  terminals kept; a new switch operation asks the launcher to stage-and-switch
  to a given local runtime. Exact op set is the executor's call. Based on:
  `crates/supervisor/src/runtime_control.rs:1-80`,
  `apps/desktop/src/main/daemon-manager.ts:128`.
- **Health / probation invariant (center-independent; revised on plan
  audit)**: a candidate runtime commits only when the launcher has
  *independently* checked, not merely been told, that (a) the runtime has
  taken over every live session in ptyd — the launcher compares ptyd's own
  read-only session list with the set the runtime reports as rebuilt and
  served, (b) the local gateway port accepts a connection, and (c) the runtime
  echoed the launcher-issued per-spawn nonce — and the runtime then survives
  the observation period. A self-reported "ready" alone is never sufficient. Alive-but-silent, a wrong nonce, "ready" sent before the
  rebuild completes, or crashing past the budget never commits and leads to
  rollback; restart after an interrupted probation never ends up committed to
  a pseudo-healthy version (falls back to the last good one or builtin). A
  device with no center connection must still be able to commit. Rejected:
  "connected to the center" as the health signal — offline devices could
  never update. Based on: `crates/supervisor/src/manager.rs:485-512`
  (today's nonce + `ResyncApplied` rule), `tests/src/worker-upgrade.test.mjs:162-290`.
- **Artifact identity (security-critical)**: the runtime is a new release
  component with its own name and its own release-statement domain (distinct
  from `coflux-worker-release-v1` and every other domain), and **no legacy
  raw-binary signature**. Invariant: no existing (pre-plan) supervisor can
  ever verify, install or run a runtime artifact, through any path. The
  manifest becomes `schemaVersion: 3` with a `runtime` component (paired
  transport carried as today's worker entry carries it); new releases do not
  carry a `worker` component. The server parses both 2 and 3. Rejected:
  reusing the worker component/domain — an old supervisor would accept the
  runtime as a worker and run it as one. Concretely (revised on plan audit):
  no `*.sig` raw-signature asset is emitted for the runtime and runtime
  manifest entries carry no `signature` field; a runtime `releaseSignature`
  must fail verification against the worker-domain statement built from
  identical metadata; and looking up the `worker` component in a schema-3
  manifest throws. The worker-domain constant stays in the test code so (b)
  can be asserted. Based on:
  `crates/supervisor/src/upgrade.rs:32,105-120` (worker domain; raw signature
  still checked for legacy), `packages/cli/release-trust.mjs:6-22`,
  `scripts/release-sign.mjs:44,74-151`, `apps/server/src/auto-update.ts:47-60`.
- **Who gets pushed**: the center pushes a `runtime` only to daemons that
  advertise a launcher capability, never to desktop-managed ones (capability
  from `20261002-runtime-follows-app`), on both the automatic sweep and
  `clientUpgradeDaemon`. Daemons without the launcher capability receive
  nothing new. Inversely (revised on plan audit), a schema-2 `latest` pushes
  its worker only to daemons *without* the launcher capability — otherwise a
  rolled-back `latest` throws worker artifacts at launcher daemons until the
  attempt cap. Field mapping with no proto change: `worker_version` carries
  the runtime version (the push compares it with `latest.version`),
  `supervisor_version` carries the launcher version. Based on: `apps/server/src/auto-update.ts:175-212`,
  `apps/server/src/hub.ts:1042-1044,3215-3236`.
- **Download and verification stay in the runtime** (they evolve with the
  manifest format); the launcher owns persisting the active version and the
  remote release floor, and refuses to switch a remote-initiated candidate at
  or below the floor (strict SemVer, equal precedence rejected, as today).
  Local switches requested by the desktop or `cofluxd` are administrator
  actions not bound by the remote floor (as today). Remote-initiated switches
  reach the launcher only over the private launcher↔runtime channel and
  administrator switches only over `runtime.sock`; the floor rule is bound to
  the channel, not to a flag a caller could set (revised on plan audit). Rejected: verification in
  the launcher — it would have to change whenever the manifest or statement
  format does, defeating "rarely changes". Based on:
  `docs/hot-upgrade-design.md` §3-§4.
- **Environment pass-through**: everything the desktop or service puts in the
  supervisor's environment today and that the worker or PTY environment reads
  (`COFLUX_HOME`, `TMPDIR` → terminal-data, `COFLUX_CLAUDE_PLUGIN_DIR`,
  `COFLUX_SCREEN_HELPER` / `COFLUX_SCREEN_VERSION`, the desktop-managed
  marker, `COFLUX_WORKER_PUBKEY` in tests) reaches every runtime the launcher
  starts, including center-pushed ones that run from the version store.
  Capabilities that describe the host rather than the code — the launcher
  capability, `transport_pair_v1` (today derived from `COFLUX_TRANSPORT_PAIR=1`
  injected by the supervisor, `crates/supervisor/src/manager.rs:375-378`,
  `crates/worker/src/main.rs:168-170`), desktop-managed — come from
  launcher-provided environment, never hardcoded, so a bare runtime started
  outside a launcher does not claim them (revised on plan audit).
  Based on: `apps/desktop/src/main/desktop-runtime.ts:303-306`,
  `apps/desktop/src/main/daemon-paths.ts:13-25`.
- **Launcher self-update**: the runtime leaves (terminals stay in ptyd), the
  launcher restarts, and relaunches the runtime from its pointer. On desktop
  this happens without confirmation when the bundled launcher changed; on
  headless through `cofluxd restart`. ptyd updates keep their separate
  confirmed action (`cofluxd restart --ptyd`, 「更新终端组件」).
- **Degraded replay batching (decided while planning)**: the runtime-side ptyd
  client stops paying one UDS round trip per ring chunk when rebuilding a
  session without a checkpoint blob — by pipelining id-tagged `read` requests
  or larger reads — **without any change to ptyd or its protocol**. If that is
  impossible client-side, leave it and record why. Based on:
  `wiki/plans/20260918-ptyd-terminal-custody.md:688-692` (~1.3 s/session,
  cause is the round trip), `crates/ptyd/src/client.rs:316`
  (`read(session, from_offset, max_bytes)`).
- **Left to the executor**: how sessiond's std-thread design folds into the
  tokio runtime; binary and crate names (subject to the distinct-identity
  decision); the launcher↔runtime channel; the version-store layout and
  whether the desktop's `desktop-runtimes/<id>` and `workers/<v>` stores
  unify; how `cofluxd status` presents the new pieces.

## Direction

### Milestone 1: the runtime and the launcher exist and pass the upgrade contract

The runtime binary holds sessiond and talks to ptyd; the launcher spawns it,
runs probation with the nonce rule, commits, rolls back, and falls back to
builtin; `runtime.sock` is served by the launcher. The black-box harness
starts ptyd + launcher. `worker-upgrade.test.mjs` is rewritten for the
launcher and keeps every case it has today (good commit; crash-loop rollback;
alive-but-silent; read-but-not-applied; wrong nonce; restart with the pointer
on a pseudo-healthy version → falls back), adding a stub runtime that echoes
the nonce correctly but serves none of ptyd's sessions (never commits) and one
whose gateway never listens (never commits). `ptyd-custody` and `ptyd-reduced-ops` still pass (runtime
replacement keeps terminals, sequences contiguous). `contract.test.mjs` passes
unchanged. Validation: `cargo build` (zero warnings),
`COFLUX_HOME= cargo test --workspace` → pass.

### Milestone 2: releases sign and the center pushes the runtime

Manifest schema 3 with a `runtime` component and its own statement domain, no
raw signature, no `worker` component; `release.yml` / `desktop-release.yml` /
`stage-daemon.mjs` / `electron-builder.yml` / the R2 mirror layout handle the
new binaries; `cofluxd` (`release-trust.mjs`) verifies and installs them; the
server parses 2 and 3 and pushes `runtime` only to launcher-capable,
non-desktop-managed daemons on both paths. `signed-upgrade`, `release-sign`
and `cli-release-trust` are adapted, keeping every negative case and adding the
three cross-component assertions listed under "Artifact identity". Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0,
`node --test scripts/release-mirror.test.mjs` if the mirror layout is touched → pass.
Depends on milestone 1 (binary identity).

### Milestone 3: desktop and cofluxd drive the launcher; docs follow

The desktop starts ptyd + launcher, stages the bundled runtime and asks the
launcher to switch (keeping the automatic trigger, once-per-launch rule and
failure surface from the previous plan); the TS replace/rollback/watchdog code
is gone. First launch after upgrading from a pre-plan app migrates a running
leave-capable supervisor to the launcher without ending terminals.
`cofluxd up/update/restart/status/doctor` and the generated launchd/systemd
units target the launcher; `update` reports when the launcher, ptyd or CLI
changed and says the runtime now updates itself. `docs/architecture.md`,
`docs/hot-upgrade-design.md`, `docs/RELEASING.md`, `AGENTS.md` (crate list
and daemon description), `CONTRIBUTING.md`, `Dockerfile`, the
`desktop-preview` skill and `apps/desktop/README.md` describe the new shape.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test &&
pnpm -C apps/desktop lint && pnpm -C apps/desktop build` → exit 0.
Depends on milestones 1 and 2.

Milestones are strictly sequential — run as one work package, do not fan out.

## Landmines

- **Raw signatures are the legacy back door.** Old supervisors still check
  the raw-binary signature of a worker artifact
  (`crates/supervisor/src/upgrade.rs`, "legacy raw signature" in
  `docs/hot-upgrade-design.md` §4). If the runtime artifact carried a raw
  signature under the same key, the cross-component invariant would rest on
  the release-statement check alone. Do not emit one.
- **Old `cofluxd` fails closed on schema 3** — `parseReleaseManifestEntry`
  requires `schemaVersion === 2` (`packages/cli/release-trust.mjs:168`). That
  is the desired failure, but it means the headless migration step must
  upgrade the npm package first; the release notes must say so.
- **Silent push refusal**: `hub.ts` `sendWorkerUpgrade` returns `false`
  without `transport_pair_v1` (`apps/server/src/hub.ts:1061`) and
  `maybeUpgrade` returns silently on `!ok`. If the runtime stops advertising it
  after the merge, pushes stop with no log line.
- **One `v*` release carries desktop and daemon assets**
  (`.github/workflows/release.yml:26,350`) and the center's poller reads
  `/releases/latest` (`apps/server/src/auto-update.ts:4`); the R2 mirror's
  `releases/latest.json` and desktop feed are hard-coded by clients
  (`scripts/release-mirror-layout.mjs:3-7`).
- **`scripts/release-sign.mjs:139-151`** uses the worker target set as the
  equality baseline for cli/transport/ptyd; dropping `worker` means rewriting
  that baseline around `runtime`, not deleting the check.
- **The black-box `pretest` builds by crate name**
  (`tests/package.json`, `-p coflux-supervisor -p coflux-worker`); renaming a
  crate breaks the suite at verification unless it is updated.
- **Sessiond rebuild order**: today the supervisor rebuilds from ptyd before
  starting the worker (`docs/hot-upgrade-design.md` §1). In one process the
  local gateway and the center connection must not serve sessions before the
  rebuild finishes, or clients attach to half-rebuilt state.
- **Executor host and transport pairing live in the worker today**
  (`crates/worker/src/executor_host.rs:14-23` drain,
  `crates/worker/src/tailcat_ipc.rs:60` `kill_on_drop`); a runtime restart now
  also happens on every update — keep the drain semantics.
- **The local gateway port is reused across swaps**
  (`LOCAL_GATEWAY_PORT`, `crates/worker/src/main.rs:46,585`); a swap that starts
  the new runtime before the old one released the port must still converge.
- **Local tests**: run the supervisor-era crates with `COFLUX_HOME=` cleared,
  or shell-integration tests fail spuriously inside a Coflux terminal. Black-box
  ports are hardcoded — never two suites at once. Postgres at 5432
  (`pnpm dev:pg`). The Bash tool runs zsh (`set -e` ineffective; write
  `${VAR}:path`, not `$VAR:path`).
- `clientUpgradeDaemon` has no first-party caller left (only generated
  protocol code), but it is a live wire path and must obey the same gating.

## Merge and deploy

- Release order: **deploy the server first** (it must parse schema 3 and know
  the launcher capability before a schema-3 release becomes `latest`), then
  tag the release (desktop + daemon + npm at one version).
- The first schema-3 release stops automatic pushes to every pre-plan daemon.
  Release notes (English, no CJK characters) must say: desktop applies it
  automatically with terminals kept; headless runs `npm i -g cofluxd@latest &&
  cofluxd update && cofluxd restart` once, terminals kept; afterwards runtime
  updates (including terminal/session logic) arrive automatically with a brief
  pause; only ptyd changes still need a confirmed restart.
- Rollback: making a schema-2 release `latest` again (GitHub latest plus
  re-pointing the R2 mirror with `scripts/release-mirror.mjs`) resumes worker
  pushes for pre-plan daemons only; launcher-based daemons keep their
  committed runtime. Treat this as an emergency path, not a routine one.
- Real-machine acceptance with production signatures (TCC attribution of the
  launcher-spawned runtime, AMFI on the ad-hoc re-signed launcher in
  `~/.coflux/bin`) cannot be shown by CI.

## Scope

In scope:
- `crates/supervisor`, `crates/worker`, `Cargo.toml` / `Cargo.lock`
- `crates/protocol` except `src/ptyd.rs` — including deleting the supervisor↔worker record types (`SupervisorToWorker` / `WorkerToSupervisor`) and their frame code; `packages/protocol/src/index.ts` where it mirrors that frame contract
- `tests/package.json` (`pretest` crate names)
- `apps/desktop/src/main` (keeping `runtime-follow.ts`), `apps/desktop/src/shared/desktop-bridge.ts`, `apps/desktop/src/renderer/components/workbench/daemon-view*`, `apps/desktop/scripts/stage-daemon.mjs`, `apps/desktop/electron-builder.yml`, `apps/desktop/test/config.test.ts`
- `apps/server/src/auto-update.ts`, `apps/server/src/hub.ts`, `apps/server/src/daemon-capabilities.ts`
- `packages/cli/cofluxd.mjs`, `packages/cli/release-trust.mjs`, `packages/cli/service-unit.mjs`, `packages/cli/package.json`
- `scripts/release-sign.mjs`, `scripts/release-statement.mjs`, `scripts/release-mirror*.mjs`, `.github/workflows/{ci,release,desktop-release}.yml`, `package.json`, `Dockerfile`
- `tests/src/harness.mjs`, `worker-upgrade`, `signed-upgrade`, `release-sign`, `cli-release-trust`, `ptyd-custody`, `ptyd-reduced-ops`, `cofluxd-service`, `service-unit` test files
- Docs listed in milestone 3

Out of scope:
- `crates/ptyd` and the ptyd protocol in `crates/protocol/src/ptyd.rs` — changing ptyd ends terminals; its `subscribe` blocking send stays a known hazard.
- `transport/tailcat`, `native/screen`, `crates/cli` behaviour — not merged.
- `proto/` — unless a new wire message is truly required; prefer reusing `workerUpgrade` with the runtime artifact (old supervisors are already excluded by capability gating and the distinct domain). If a proto change is made, run the buf breaking check against `main`.
- iOS / Swift client.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test --workspace` | pass |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop lint && pnpm -C apps/desktop build` | exit 0 |
| Protocol checks (if proto touched) | the CI protocol job's commands: `buf lint`, `buf generate` with no diff, `node scripts/check-protocol-breaking.mjs` with a `main` baseline (`.github/workflows/ci.yml:49-117`) | exit 0 |
| Black-box (acceptance) | `pnpm dev:pg` then `pnpm -C tests test` | all pass |
| Desktop walkthrough (acceptance) | packaged app over a running pre-plan runtime | migrates without ending terminals; later switch automatic |
| Headless walkthrough (acceptance) | `cofluxd update && cofluxd restart` on a Linux box, then a later push | terminals kept; runtime advances by itself |

## Done criteria

- [ ] All listed non-acceptance commands pass; the black-box suite passes at verification.
- [ ] Device process set is ptyd + launcher + runtime (+ transport, + screen on desktop); no supervisor↔worker UDS hop remains on the terminal data path.
- [ ] Probation invariant holds as launcher-side checks (ptyd session takeover, gateway connect, nonce), proven by stubs that echo the nonce but serve no sessions or never listen; post-start crash-loop rollback works on both desktop and headless.
- [ ] No pre-plan supervisor can verify or run a runtime artifact: no raw signature emitted or carried; a runtime `releaseSignature` fails against the worker-domain statement for identical metadata; a schema-3 `worker` lookup throws — each asserted by a test.
- [ ] Server pushes `runtime` only to launcher-capable, non-desktop-managed daemons and schema-2 workers only to non-launcher daemons, on both push paths; host capabilities come from launcher env.
- [ ] Desktop TS replace/rollback/watchdog code is deleted; desktop migration from a running leave-capable supervisor keeps terminals.
- [ ] ptyd binary and protocol unchanged (`git diff fe64fcf3 -- crates/ptyd crates/protocol/src/ptyd.rs` empty).
- [ ] Docs and release-note items updated.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires changing ptyd or its protocol.
- Keeping the probation invariant requires the center (offline devices could not commit).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The launcher's change rate is the point: anything that needs to change per
  release (manifest format, statement format, sessiond, env assembly) belongs
  in the runtime.
- Holders and the create/stop de-duplication ledger reset on every runtime
  update by design (accepted 2026-10-02); do not "fix" this by persisting the
  ledger into ptyd.
- The ptyd `subscribe` blocking-send hazard remains open
  (`wiki/plans/20260918-ptyd-terminal-custody.md:683-687`).
