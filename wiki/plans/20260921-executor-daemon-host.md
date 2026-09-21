# Plan 20260921-executor-daemon-host: one executor implementation, started by whoever has a runtime

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 6cb4f403..HEAD -- crates/worker crates/supervisor apps/desktop/src/main apps/desktop/package.json apps/desktop/electron.vite.config.ts packages/cli packages/protocol/src/index.ts`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: migration
- Execution: subagent(opus) — departure check, 2026-09-21
- Stop after: implementation — departure check, 2026-09-21
- Plan review: none — `dev:advisor` was consulted twice during exploration and shaped the direction
- Workspace: isolated — cut from `origin/main` into `.claude/worktrees/20260921-executor-daemon-host`
- Planned at: `6cb4f403`, 2026-09-21

## Requirement

Today the executor exists only inside the desktop app's main process. A machine
without Coflux.app running has no executor host, and `coflux executor run` is
refused on the spot (`crates/worker/src/agent_ctl/executor.rs:322`: "this machine's
Coflux.app is not running"). A headless Linux box cannot hand a bounded sub-task
to the executor at all.

**What is true when this is done**: there is exactly **one** executor
implementation, published as an npm package. Any machine with a JS runtime can
host it — a headless Linux daemon installed through npm starts it with its own
`node`, and Coflux.app starts the very same package through `utilityProcess`. The
desktop no longer carries a private copy of the executor and no longer bundles
pi.

**Product conclusion (user, 2026-09-21)**: a single implementation, not a desktop
copy plus a headless copy. This **supersedes** product conclusion 4 of
`wiki/plans/20260912-executor-engine.md` ("only the machine running the desktop
app"). The user further chose (2026-09-21, after seeing `cofluxd up` verify the
four signed binaries) to deliver it as an **npm package** rather than as a fifth
signed binary artifact.

**This plan is macOS-first and does not enable Linux hosting.** The Linux sandbox
is a separate plan (see Scope): `/usr/bin/sandbox-exec` has no Linux equivalent,
and registering a host there without one would mean the SKILL promises the agent
a kernel boundary that does not exist. The npm package and the daemon-side host
are built here; Linux registration stays off until that plan lands.

## Decisions & tradeoffs

- **Delivery is an npm package, not a signed binary artifact**: the executor ships
  as its own package (`@coflux/executor`), depended on by `cofluxd`. Rejected:
  `bun build --compile` into a fifth companion binary — measured 2026-09-21, the
  artifact cannot be signed at all (`codesign` fails with `main executable failed
  strict validation` across adhoc / Apple Development × with and without
  `--options runtime`; `--remove-signature` answers `internal error in Code
  Signing subsystem`), because the appended JS payload breaks the Mach-O
  structure. Rejected: shipping a stock runtime binary as a fifth artifact — it
  signs cleanly, but it would need its own JIT entitlements (measured: the same
  workload runs 6–7× slower, silently, when signed the way
  `.github/workflows/release.yml:197` signs today, because JSC falls back to the
  interpreter with no error), plus changes in roughly ten places that each assume
  the companion artifact is singular (see Landmines). The npm route needs none of
  it. Based on: measurements at `6cb4f403`; `packages/cli/cofluxd.mjs:344` (the
  component list is closed); `scripts/release-sign.mjs:109` (a mandatory
  single-transport check).
- **One package, two hosts, and the daemon wins**: the same package is started
  either by `cofluxd` with its own `node`, or by Coflux.app through
  `utilityProcess`. On a machine where both could, **the daemon's host is
  authoritative and the desktop must not start one**; the desktop starts it only
  when the daemon reports it cannot (no runtime available — the bundled-daemon
  case, where `apps/desktop/scripts/stage-daemon.mjs` ships four Rust/Go binaries
  and no JS runtime, and `runAsNode: false` in `apps/desktop/electron-builder.yml:22`
  is flipped before signing with Gatekeeper keeping it flipped). Rejected: letting
  both register and relying on epoch arbitration — `register_host` resolves a
  conflict by declaring the previous host's unfinished runs `Unknown`
  (`crates/worker/src/agent_ctl/executor.rs:263`), so two eager hosts on one Mac
  would clear each other's tasks on every restart. The election must be explicit,
  not emergent.
- **The runtime path reaches the worker through the service unit**: `cofluxd up`
  writes the absolute `process.execPath` and the package entry point into the
  launchd/systemd unit environment, and the worker reads them from there.
  Rejected: having the worker search `PATH` for `node` — a launchd job's `PATH` is
  not the user's, and picking up an arbitrary version of node found on the system
  is exactly the kind of drift that produces an unreproducible executor. Fix the
  variable names in milestone 1 so milestones 2 and 3 can be built independently.
  Based on: `packages/cli/cofluxd.mjs:406-407` (launchd `EnvironmentVariables`
  carries only `COFLUX_HOME`), `:423` (the systemd unit likewise),
  `crates/worker/src/main.rs:576` (the existing companion is located beside the
  worker's own executable, which a JS entry point cannot rely on).
- **Process structure is unchanged**: a long-lived host process owns the job table
  and spawns one child per task. Rejected: porting `executor-jobs.ts` into Rust —
  the write lock, concurrency caps, reconciliation and the `Unknown` semantics are
  the most expensive part to get wrong and the best covered by existing tests;
  re-deriving them in Rust trades verified code for new risk with no gain. Only
  two transports are rewritten: `process.parentPort` becomes stdio JSONL, and the
  device-channel path becomes that same stdio link. Based on:
  `apps/desktop/src/main/executor-manager.ts:1-13` (the three-way split is
  deliberate, with the pure state machine isolated).
- **The `Principal::Local` gate stays exactly as it is**: the daemon still refuses
  any executor host registration that does not arrive on a local loopback channel.
  The daemon-side host is a child process reaching the worker over inherited
  stdio, so it never needs a device channel, a browser grant, or an Origin
  allowlist entry. Rejected: making the host a second device-protocol client — on
  a headless machine it would need an account session and the P-256 handshake
  that only `packages/client/src/device-router.ts` implements, in a package marked
  `"private": true`. Based on: `crates/worker/src/device.rs:2136-2145`.
- **A worker hot upgrade must not kill running tasks (mechanism is the executor's
  call)**: the transport precedent spawns with `kill_on_drop(true)`
  (`crates/worker/src/tailcat_ipc.rs:55-61`), which here would kill every running
  task on every hot push — strictly worse than today, where a dropped channel
  deliberately leaves the job table alone
  (`apps/desktop/src/main/executor-host.ts:313-316`). Copying it is **rejected**.
  Choose between (a) the supervisor owning the host process and (b) the worker
  spawning it without `kill_on_drop` plus a re-adopt path across worker restarts,
  and record which, with the reasoning, in Maintenance notes. Do **not** take a
  dependency on the unmerged `dev/20260918-ptyd-terminal-custody` branch.
- **`cofluxd` gives up being dependency-free**: it gains one dependency, which
  transitively pulls pi (~56MB on disk). Rejected: installing the executor package
  on demand at first use — a network install inside a daemon start path fails in
  exactly the environments the executor is meant to serve. Rejected:
  `optionalDependencies` — a silently absent executor turns into "Coflux.app is not
  running" on the agent's side, which is the error this plan exists to remove.
  The cost is a larger `npm i -g cofluxd`; state it in the release notes. Based
  on: `packages/cli/package.json` (no `dependencies` field today).
- **Image inputs stay outside the executor's contract**: pi's image path needs
  `photon_rs_bg.wasm` beside the executable, and the executor's input is a task
  description, not a file channel (`crates/worker/src/agent_ctl/executor.rs:46`
  caps a prompt at 32 KiB). Do not ship the wasm; state the boundary in the SKILL.

## Direction

```
cofluxd (npm, has node) ──spawn──> executor host  ← one npm package,
Coflux.app (utilityProcess) ─────> executor host    one implementation
                                     │  job table, write lock, reconcile
                                     └──spawn──> one runner child per task
                                                  └─ sandbox-exec ─> bash
```

The wire between the worker and the host is inherited stdio carrying JSONL — the
messages the device-channel path carries today, minus the device envelope. The
worker's ledger, its `Principal::Local` gate, and the CLI polling path are
unchanged.

### Milestone 1: the executor is its own package

The host, manager, job table and runner move out of `apps/desktop/src/main` into a
package with a stdio entry point and no Electron import anywhere in its module
graph. This milestone also **fixes the two environment variable names** carrying
the runtime path and the entry point, since milestones 2 and 3 meet there. The
desktop still hosts the executor at this point — this is the extraction, not the
move.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0; `pnpm -C apps/desktop test`
-> exit 0 — the existing executor unit tests move with the code and still pass,
with no loss of covered behaviour.

Gates milestones 2, 3 and 4.

### Milestone 2: the worker hosts it

The worker reads the runtime path and entry point from its environment, spawns the
host, speaks the stdio protocol, and registers it under `CAPABILITY_EXECUTOR_HOST`.
It reports to the desktop whether it has a host of its own, so the election in
milestone 4 has something to read. The hot-upgrade decision is implemented and
recorded. Registration stays off on Linux.

Validation: `COFLUX_HOME= cargo test -p coflux-worker` -> exit 0;
`cargo build --workspace` -> exit 0 with zero warnings.

Independent of milestone 3 — disjoint paths (`crates/` here, `packages/cli/`
there), meeting only at the variable names fixed in milestone 1.

### Milestone 3: npm delivery

`cofluxd` depends on the executor package and writes the runtime path and entry
point into the launchd and systemd units it generates, so a freshly installed
daemon can start a host without further configuration.

Validation: `pnpm -C tests test` -> exit 0 (the daemon-start path is exercised by
the existing suites; add a unit assertion that both variables land in a generated
unit).

Independent of milestone 2.

### Milestone 4: the desktop runs the same package

Coflux.app starts the executor from the package instead of its own copy,
`@earendil-works/pi-coding-agent` leaves `apps/desktop/package.json`, and the
`executor-runner` entry leaves `apps/desktop/electron.vite.config.ts`. The
election from Decisions & tradeoffs is implemented: the desktop starts a host only
when the daemon says it has none. The capability constant's cross-language pin
moves with the host (see Landmines). The settings page keeps working against the
account-held configuration.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`
-> exit 0.

Needs milestones 2 and 3.

## Landmines

- **The capability name is pinned across three files.** `CAPABILITY_EXECUTOR_HOST`
  (`crates/worker/src/agent_ctl/executor.rs:33`) and `EXECUTOR_HOST_CAPABILITY`
  (`packages/protocol/src/index.ts:55`) must stay identical, and
  `apps/desktop/test/config.test.ts` enforces it by reading the Rust source. That
  pin was added days ago (`6cb4f403`) precisely because a mismatch **silently
  refuses every registration** and surfaces only as "Coflux.app is not running".
  Move it with the host; do not delete it.
- **A dropped channel must never clear the job table.**
  `apps/desktop/src/main/executor-host.ts:313-316` deliberately leaves running
  tasks alone on disconnect, because re-dispatching a writer would double-write.
  Process-alive and channel-up are different facts; the stdio transport must keep
  them different.
- **The sandbox's network ban is a privilege boundary, not a convenience.**
  `apps/desktop/src/main/executor-sandbox.ts:28-36`: `(deny network*)` also blocks
  the daemon's loopback `/agent` endpoint, which authenticates by self-reported
  pid — any tool process that can reach loopback could otherwise ask the
  *unsandboxed* daemon to run a command for it. `sandbox-exec` is macOS-only
  (`:166`), which is why Linux hosting is out of scope here.
- **`daemon-paths.ts` says "three binaries" and lists four.** The prose at
  `apps/desktop/src/main/daemon-paths.ts:9-12` was not updated when transport was
  added. Read the arrays, not the comments.
- **The release chain assumes exactly one companion artifact.** This plan avoids
  it, and that is deliberate: `crates/protocol/src/ipc.rs:12-20`,
  `scripts/release-sign.mjs:109` (hard-fails without a single `coflux-transport-*`),
  `packages/cli/release-trust.mjs:149` (closed four-component enum),
  `packages/cli/cofluxd.mjs:344`, `.github/workflows/release.yml:196`. If a future
  change moves the executor back to a binary artifact, every one of these is in
  scope.
- **`pnpm -C apps/desktop pack` is intercepted by pnpm's builtin** and emits a tgz;
  use `run pack` for a local smoke build.
- **Black-box test ports are hardcoded**; two suites cannot run on one machine at
  once. Check `grep -h "PORT = " tests/src/*.test.mjs | sort` before adding one.

## Scope

In scope:
- the new executor package and everything moved into it from `apps/desktop/src/main/executor-*`
- `crates/worker/` — host process lifecycle, stdio protocol, ledger wiring
- `crates/supervisor/` — only if the hot-upgrade decision puts the process there
- `packages/cli/{package.json,cofluxd.mjs}`, `packages/protocol/src/index.ts`
- `apps/desktop/{package.json,electron.vite.config.ts,src/main,test/config.test.ts}`
- `packages/cli/skills/coflux/SKILL.md` and its `integrations/claude-plugin` copy (sync with `node scripts/sync-claude-plugin.mjs`)
- `wiki/plans/`

Out of scope:
- **The Linux sandbox** — no `sandbox-exec` equivalent; bwrap/landlock is its own
  engineering effort with its own measurements. Until it lands, the daemon-side
  host is not registered on Linux. Separate plan.
- **The signed-binary release chain** — untouched by design; see Landmines.
- **iOS / `apps/macos`** — no executor surface.
- **The server** — the centre already owns the configuration; the wire contract is unchanged.
- **The executor's own behaviour** — prompt, tools, guard, sandbox profile content
  and terminal semantics are unchanged. This is a relocation.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Desktop types | `pnpm -C apps/desktop typecheck` | exit 0 |
| Desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop build | `pnpm -C apps/desktop build` | exit 0 |
| Server types | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Rust build | `cargo build --workspace` | exit 0, zero warnings |
| Black-box | `pnpm -C tests test` | exit 0 |
| Plugin sync check | `node scripts/sync-claude-plugin.mjs` | exit 0, no diff |
| Headless walkthrough (acceptance) | on a Linux box with npm-installed `cofluxd`, `coflux executor run` with no desktop app | the host registers; a task runs to `succeeded` once Linux sandboxing lands |
| Desktop walkthrough (acceptance) | Coflux.app with the bundled daemon, `coflux executor run` | exactly one host registers; the task runs to `succeeded` |

`COFLUX_HOME=` on the Rust tests is required: this repository's own coflux runtime
otherwise pollutes presence and shell-integration tests into false failures.

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] One package holds the only executor implementation; `apps/desktop` no longer
      depends on `@earendil-works/pi-coding-agent` and has no `executor-runner`
      build entry.
- [ ] On a machine where both could host, exactly one does, and which one is a
      decision the daemon makes — not a race.
- [ ] A worker hot upgrade does not turn a running executor task into `Unknown`,
      and the chosen mechanism is recorded in Maintenance notes.
- [ ] A freshly installed `cofluxd` starts a host with no extra configuration.
- [ ] The capability-name pin still fails a build when either side is renamed.
- [ ] The daemon-side host is not registered on Linux, and the SKILL says where
      the executor is available and what the sandbox guarantees on each platform.
- [ ] `wiki/plans/README.md` status is updated.
- [ ] Superseding notes are added in place to `wiki/plans/20260912-executor-engine.md`
      (decision D1, the job-table location, and product conclusion 4), plus the
      outstanding one for `wiki/plans/20260918-executor-settings-central.md`
      reversing D1's credential premise.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular the
  `Principal::Local` gate (`crates/worker/src/device.rs:2136`), the `runAsNode:
  false` fuse (`apps/desktop/electron-builder.yml:22`), or the unit-environment
  shape (`packages/cli/cofluxd.mjs:406-407`, `:423`).
- The hot-upgrade decision cannot be implemented without depending on the unmerged
  `dev/20260918-ptyd-terminal-custody` branch.
- Electron's `utilityProcess` cannot run the package as published (rather than as
  a bundled entry) — report it rather than reintroducing a desktop-private copy,
  because a second copy is the thing this plan removes.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- **Hot-upgrade ownership: worker-spawned, no `kill_on_drop`, drain on EOF — not
  supervisor-owned, and not re-adopt.** (`crates/worker/src/executor_host.rs`,
  `packages/executor/src/host.ts`.)
  - *Not supervisor-owned*: the supervisor is the component upgraded rarely, and
    putting the host there would mean the whole worker↔host message contract has
    to travel through the UDS frame protocol as well. Every change to the executor
    protocol would then need a supervisor upgrade, which is exactly what that
    component's upgrade cadence exists to avoid.
  - *Not the re-adopt path*: it cannot be built over inherited stdio, because a
    pipe dies with its parent — the successor worker has no way to reattach to the
    predecessor's pipes, and giving the host a socket to be re-found on would make
    it a second local server with its own admission problem. It would also buy
    nothing: the run records live in worker memory, which a hot upgrade discards
    anyway, so there is nothing for a re-adopted host to be reconciled against.
  - *What happens instead*: the child is spawned without `kill_on_drop` (the
    opposite of `tailcat_ipc.rs`, deliberately). The old worker exiting closes the
    child's stdin; the host stops taking work and waits for the tasks it already
    has to finish before exiting. A half-written file cannot be un-written, so
    killing mid-task is strictly worse than losing track of a run. The successor
    worker starts a fresh host, which blocks on the package's own
    `$COFLUX_HOME/executor-host.lock` until the draining one is gone — that lock
    is what keeps two hosts off one workspace during the overlap.
  - *The residual*: a run in flight across a hot upgrade is no longer pollable —
    the new ledger has never heard of it. It does not become `Unknown`; the CLI
    gets "no such run". That is the same loss the desktop host already had, with
    the work itself preserved rather than killed.
- **Deviation: on Coflux.app the host body runs in the Electron main process**,
  importing the package, rather than in a `utilityProcess` of its own. The plan's
  Direction diagram shows a separate host process on both sides; that is not
  buildable on the desktop. `utilityProcess` is a main-process-only API, so a host
  living in one could not fork the per-task runners, and the `runAsNode: false`
  fuse rules out `child_process.fork` as a substitute. The alternative — relaying
  every runner message back through the main process — adds a layer that exists
  only for Electron. The package is still the only copy of the executor; the seam
  used is the `spawnRunner` injection the manager already had, and the runner
  entry Coflux.app forks is the package's published file, not a build entry.
- **Deviation: host↔runner stays a message channel, not stdio JSONL.** Only the
  worker↔host link needed a new transport, because that peer is Rust. The runner
  is forked by JS on both sides, so it uses `process.parentPort` under Electron and
  `child_process.fork`'s IPC channel under node — ten lines of adapter in
  `packages/executor/src/runner.ts` rather than a second framing implementation.
- **Release plumbing still owed, and out of this plan's scope.**
  `@coflux/executor` must be published to npm for `npm i -g cofluxd` to resolve it:
  that needs a Trusted Publisher binding on npmjs.com and a second publish step in
  `.github/workflows/npm-publish.yml`, and the package should join
  `VERSION_FILES` in `scripts/product-version.mjs` so it cannot drift from the
  product version. None of those files are in this plan's scope.
- The executor is macOS-only until the Linux sandbox plan lands. The SKILL must
  not promise a kernel sandbox on a platform that has none.
- `cofluxd` is no longer dependency-free. If its install size becomes a problem,
  the next step to consider is splitting the daemon-only install from the
  executor-capable one — not an on-demand network install, which fails in exactly
  the environments the executor serves.
- This plan supersedes `wiki/plans/20260912-executor-engine.md` on three points:
  decision D1 (pi in the desktop `utilityProcess`), the job table's location, and
  product conclusion 4. Of D1's three pieces of evidence, (3) was already reversed
  by `wiki/plans/20260918-executor-settings-central.md` (the daemon now writes the
  0600 credential cache the desktop reads), (1) is bypassed by shipping the
  runtime through npm rather than reusing Electron's, and (2) — hot upgrade via
  `Child::kill()` — still holds and became this plan's hot-upgrade decision.
