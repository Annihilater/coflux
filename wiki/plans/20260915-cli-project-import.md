# Plan 20260915-cli-project-import: Import a local folder as a project from the account CLI

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- apps/server/src/interface/client-command apps/server/src/hub.ts apps/server/src/prepared-operation-convergence.service.ts apps/server/src/prepared-operation.service.ts apps/server/src/store.ts crates/cli/src packages/cli crates/worker/src/git.rs packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check ("直接自动执行")
- Plan review: none — departure check chose plain autopilot
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260915-cli-project-import` on `dev/20260915-cli-project-import`
- Planned at: `ebca9085`, 2026-09-15

## Requirement

The capability "turn a local folder into a Coflux project" already exists end to
end in the centre: the desktop wizard sends `projectImport`, the centre runs a
prepared `projectValidate` on the device, and convergence creates the project
plus its main workspace. **Only the desktop has an entry point.** The account
CLI's operation whitelist has no project write operation at all
(`apps/server/src/interface/client-command/client-command.contract.ts:6-22`);
`coflux project list` is just a filtered view of the `snapshot` operation. The
zero-credential local family (`AgentControlRequest`,
`proto/coflux/v1/daemon.proto:200-218`) has no project operation either.

So an agent on a machine can create a workspace under an *existing* project
(`workspace new`) and register a same-repository worktree (`workspace enter`),
but cannot turn a *new* repository into a project — it has to stop and ask the
user to click Import in the desktop app. This plan closes that gap with one
account command.

### Product conclusions (settled with the user in exploration — do not reopen)

Command: `coflux project import <path>`, part of the account CLI family, prints
one line of JSON.

- `<path>` is **required**. The user explicitly rejected defaulting to the
  current directory.
- `<path>` must be **absolute or start with `~/`**. A relative path is rejected
  locally with a message telling the caller to pass an absolute path — same
  convention as `device exec --cwd`
  (`packages/cli/skills/coflux/SKILL.md:460-462`). Importing the current
  directory is written explicitly: `coflux project import "$PWD"`.
- `--device <id>` selects the device. When omitted it falls back to the
  `COFLUX_DEVICE_ID` environment variable; when that is empty the command fails
  asking for an explicit `--device`.
- `--name <n>` overrides the project name. Without it the name is whatever the
  existing import path already produces: the namespace/project derived by the
  worker from the git remote, falling back to the repository directory name
  (`apps/server/src/prepared-operation-convergence.service.ts:105-113`).
- A path inside a repository imports the repository root
  (`git rev-parse --show-toplevel`), exactly like the desktop wizard
  (`crates/worker/src/git.rs:202-241`).
- Success prints one JSON object carrying at least: `projectId`, `name`,
  `repoPath`, `defaultBranch`, the main workspace's `workspaceId` and `path`,
  and `alreadyImported`.
- Failure is one readable sentence on stderr and a non-zero exit: a non-git
  directory surfaces the daemon's own wording ("不是 git 仓库"), an offline
  device surfaces the existing "设备离线，无法执行该操作" wording, and a
  submitted-but-unfinished operation reuses `createWorkspaceForAccount`'s
  phrasing, pointing the caller at `coflux project list`
  (`apps/server/src/hub.ts:3838-3842`).
- Importing the same repository root twice returns the **existing** project with
  `alreadyImported: true` and exit 0.

Observable when done: in a repository that was never imported, one command makes
the project card appear in the user's desktop sidebar, `coflux project list`
shows it, and `coflux workspace new --project <new id> --branch x` works against
it; running the same command a second time does not produce a second card.

### Non-goals (settled)

`project remove` / `project rename` in the CLI; a zero-credential local track for
import; importing a non-git folder as a directory workspace; detecting and
refusing a linked worktree (as on the desktop, it may become its own project).

## Decisions & tradeoffs

- **Entry point**: a new account operation `project.import { daemonId, path,
  name? }` on `/api/client/command`, with a new `importProjectForAccount` on the
  hub that uses `preparedOperations.prepareServer` (metadata carrying
  `initiator: SERVER_INITIATOR`) and then `waitOperation`. Rejected: extending
  the zero-credential `AgentControlRequest` family — that requires a daemon wire
  protocol change on both protocol crates plus a worker roll-out, and only ever
  reaches the local machine. Rejected: driving the existing client-initiated
  `projectImport` path — its last hop hands the frame to a connected client, and
  the CLI is not one. Based on: `apps/server/src/hub.ts:3805-3847`
  (`createWorkspaceForAccount` is exactly this shape),
  `apps/server/src/prepared-operation.service.ts:41,83-85,625`.
- **The client-initiated path stays untouched**: the desktop keeps sending
  `projectImport` through `apps/server/src/hub.ts:2829-2850`. Rejected: routing
  the desktop through the new server-initiated helper — a larger blast radius
  than this requirement justifies. Based on:
  `apps/desktop/src/renderer/components/workbench/workbench.tsx:451`.
- **Daemon admission is identical to `workspace.new`**: online, same account, and
  the `prepared_execute` capability, via `requireOnlineDaemon`. Rejected: a
  bespoke check — the frame is dispatched over the same prepared channel, so a
  daemon without that capability would silently never execute it. Based on:
  `apps/server/src/hub.ts:3789-3794`,
  `apps/server/src/daemon-capabilities.ts:10`.
- **Idempotence lives in the convergence layer, for both entry points**: inside
  the `project.import` branch's transaction, look for an existing project on the
  same `daemonId` with the same `repoPath` reported by the daemon; on a hit, do
  not `createProject` — report the existing project and its main workspace as the
  effect. This establishes the invariant **one repository root on one device has
  exactly one project**. Rejected: gating the dedup on `metadata.initiator` so the
  desktop keeps its old behaviour — one convergence point with two meanings is a
  trap for the next reader. Rejected: a `UNIQUE (daemon_id, repo_path)` database
  constraint — existing production rows may already violate it and the `deleting`
  flag makes the uniqueness semantics ambiguous. The user explicitly accepted the
  resulting desktop behaviour change (repeated desktop imports no longer produce a
  second card). Based on:
  `apps/server/src/prepared-operation-convergence.service.ts:98-133`,
  `apps/server/src/store.ts:695-699` and
  `apps/server/src/infra/database/schema-migrations.ts:208,669` (no uniqueness on
  `repo_path` today).
- **Dedup must ignore projects being deleted** *(decided while planning)*: a
  candidate whose row is in the `deleting` state is **not** a hit — the import
  proceeds and creates a new project. Rejected: reusing it — the caller would get
  back a project that is in the middle of disappearing. The convergence
  transaction already holds the device parent row lock
  (`claimActiveDevice`), so concurrent imports on one device are serialised and a
  plain read inside that transaction is sufficient; `tx` is a full `Store`, so the
  existing project/workspace queries are available. Based on:
  `apps/server/src/prepared-operation-convergence.service.ts:84-92`,
  `apps/server/src/store.ts:274`.
- **`alreadyImported` is derived, not transported**: the hub generates the
  candidate `projectId` before preparing the operation and reports
  `alreadyImported: true` when the converged project's `id` differs from it. No
  new field on the effect, the prepared metadata contract, or the wire protocol.
  Rejected: adding a flag to the convergence effect — it would have to cross the
  desktop's broadcast path too, for no consumer. Accepted edge: when two imports
  of the same path race, the second one resumes the first one's prepared operation
  and therefore also reports `alreadyImported: true` — correct in substance ("this
  repository is already a project"), and not a bug to be fixed by weakening the
  derivation. Based on: `apps/server/src/hub.ts:3837-3846`,
  `apps/server/src/prepared-operation.service.ts:536-543`.
- **Reuse still broadcasts**: on a dedup hit the effect carries the existing
  project and workspace, so `projectCreated` / `workspaceCreated` go out as usual.
  Rejected: suppressing the broadcast — the client store upserts by id, so the
  broadcast is a no-op for correctness and keeps the daemon's workspace list push
  on one path. Based on: `apps/server/src/hub.ts:1857-1866`,
  `packages/client/src/store.ts:789-792`.
- **Path validation happens in the CLI, expansion happens on the device**: both
  CLIs reject a path that is neither absolute nor `~/`-prefixed, and neither
  canonicalises it locally. Rejected: expanding `~` or resolving a relative path
  CLI-side — the path belongs to the *target device*, and the worker already
  expands `~` and resolves the repository root. Based on:
  `crates/worker/src/git.rs:202-208`, `packages/cli/skills/coflux/SKILL.md:460-462`.
- **Device defaulting**: `--device` omitted falls back to `COFLUX_DEVICE_ID`, and
  an empty value is a readable error, never a guess. Rejected: defaulting to "the
  only online device" — silently importing onto the wrong machine is worse than an
  error. Based on: `packages/cli/skills/coflux/SKILL.md:88-96` (COFLUX_* are
  daemon-issued, trusted coordinates).
- **Both CLIs ship the command**: the Rust CLI (bundled by the desktop app) and
  the npm CLI (shipped in `cofluxd`) are two independent implementations of the
  account command surface and must not drift. Rejected: shipping only the Rust one
  — a machine installed from npm would silently lack the command. Based on:
  `crates/cli/src/account.rs:284-308`, `packages/cli/account-client.mjs:111-127`.
- **No new automated tests**: acceptance is manual, per the repository's test
  discipline; nothing here touches the daemon wire contract, release signing, or
  the hot-upgrade path. Existing Rust CLI unit tests still must pass, and new
  pure-function helpers (path validation) may carry a unit test in the existing
  `mod tests` of the file they live in if that is the natural place. Rejected:
  adding a black-box suite file — explicitly discouraged by `AGENTS.md`. Based on:
  `AGENTS.md` ("Test harness": a test belongs there only if a break would stay
  invisible while using the product).
- **Plugin delivery is out of this change**: `packages/cli/skills/coflux/SKILL.md`
  is the single source and `node scripts/sync-claude-plugin.mjs` refreshes
  `integrations/claude-plugin`; bumping `.claude-plugin/plugin.json` and handing
  the SHA to the plugins-builder session is the user's release step, not part of
  this plan. Based on: `AGENTS.md`, `scripts/sync-claude-plugin.mjs:12-18`.

## Direction

One server-side change opens the operation, the two CLIs expose it, and the skill
documents it. Milestone 1 fixes the operation's field names and semantics, so
milestone 2 depends on it; milestone 3 documents the final surface and depends on
both. The work is one sequential package — **do not fan it out**.

### Milestone 1: the centre accepts and converges `project.import`

The new account operation exists on `/api/client/command`, the hub drives it
through the prepared-operation channel as a server-initiated operation and returns
a structured outcome (project, main workspace, and whether it already existed),
and the convergence layer enforces "one repository root on one device has exactly
one project" for both entry points. Validation:
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0.

### Milestone 2: both CLIs expose `coflux project import <path>`

`coflux project import <path> [--device <id>] [--name <n>]` works on the Rust CLI
and the npm CLI with identical argument rules, error wording, and JSON output, and
both help texts list it. Path and device validation fail locally with a readable
sentence before any network call. Validation:
`cargo test -p coflux-cli` -> exit 0, `cargo build` -> exit 0 with zero warnings,
`node --check packages/cli/account-client.mjs` -> exit 0, and
`node packages/cli/coflux.mjs --help | grep -q "project import"` -> exit 0.

### Milestone 3: the skill documents the command

The account CLI table in `packages/cli/skills/coflux/SKILL.md` lists the command
with its path rule, device defaulting, idempotence, and one-line JSON output, and
the plugin delivery copy matches. Validation:
`node scripts/sync-claude-plugin.mjs --check` -> exit 0.

## Landmines

- **The `--device` guard blocks the new command outright.** Both CLIs refuse any
  non-`snapshot` operation that carries `--device`
  (`crates/cli/src/account.rs:315-319`, `packages/cli/account-client.mjs:127`).
  `project.import` needs an exception, in the same shape as the existing
  `terminal.new` exception for `--workspace`; without it the command is unusable.
- **Routing already works, dispatch does not.** Both CLIs already treat every
  `project` invocation as an account command
  (`crates/cli/src/account.rs:170-173`, `packages/cli/account-client.mjs:39`), so
  `handles` needs no change — but the operation `match`/`if` chains only know
  `("project", "list")` and fall through to "未知账号命令"
  (`crates/cli/src/account.rs:309-314`, `packages/cli/account-client.mjs:126`).
- **The prepared `targetId` is the caller's raw path, not the repository root**
  (`apps/server/src/hub.ts:2844`: `` `${daemonId}:${path}` ``), so two imports of
  different subdirectories of one repository are *not* merged by
  `findActivePreparedOperation`
  (`apps/server/src/prepared-operation.service.ts:536-543`). The convergence-layer
  dedup is what makes them converge on one project; do not try to make the
  `targetId` carry the repository root, which the centre cannot know before the
  daemon answers.
- **Wait on the operation id that `prepareServer` returned**, not the one that was
  generated locally: a resumed operation comes back with a different id, and
  waiting on the local one hangs until the timeout
  (`apps/server/src/hub.ts:3836-3837` shows the correct pattern).
- **`~` expansion belongs to the worker** (`crates/worker/src/git.rs:204-207`).
  A CLI-side expansion would resolve the *caller's* home against a possibly
  different device.
- **The Rust CLI's positional layout**: `positional(1)` is the subcommand and
  `positional(2)` is the path; the npm CLI destructures the same slots as
  `[command, sub = "list", id]` (`packages/cli/account-client.mjs:44`). The
  existing `target()` / `id()` helpers report "缺少目标 ID", which is the wrong
  wording for a missing path.
- **`defaultBranch` can be absent from the validation report** and falls back to
  the branch the repository is on at import time
  (`apps/server/src/prepared-operation-convergence.service.ts:114-115`,
  `crates/worker/src/git.rs:249-257`). The CLI must not invent a value.

## Scope

In scope:
- `apps/server/src/interface/client-command/client-command.contract.ts`
- `apps/server/src/interface/client-command/client-command.handler.ts`
- `apps/server/src/hub.ts`
- `apps/server/src/prepared-operation-convergence.service.ts`
- `crates/cli/src/account.rs` (and the help text in `crates/cli/src/main.rs` /
  `crates/cli/src/text.rs` if the command list lives there)
- `packages/cli/account-client.mjs`
- `packages/cli/coflux.mjs` (help text)
- `packages/cli/skills/coflux/SKILL.md`
- `integrations/claude-plugin/skills/coflux/SKILL.md` (generated by the sync script)
- `wiki/plans/20260915-cli-project-import.md`, `wiki/plans/README.md`

Out of scope:
- `proto/**`, `crates/protocol`, `packages/protocol`, `crates/worker` — no daemon
  wire change is needed; the existing `projectValidate` frame carries everything.
- `apps/desktop/**` — the wizard keeps its current entry point and code path.
- Database migrations — the invariant is enforced in the convergence transaction,
  not by a constraint.
- `project remove` / `project rename`, and a zero-credential local import track.
- `integrations/claude-plugin/.claude-plugin/plugin.json` version bump and the
  marketplace release — the user's step, after this lands.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Rust CLI unit tests | `cargo test -p coflux-cli` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| npm CLI syntax | `node --check packages/cli/account-client.mjs` | exit 0 |
| npm CLI help lists the command | `node packages/cli/coflux.mjs --help \| grep -q "project import"` | exit 0 |
| Skill copies match | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Import against a live stack (acceptance) | `coflux project import "$PWD"` in an unimported repository, then again | first run creates the project card, second prints `alreadyImported: true` and creates nothing |

## Done criteria

- [ ] All non-acceptance commands above pass.
- [ ] `coflux project import <abs-path>` on both CLIs returns one JSON line with
      `projectId`, `name`, `repoPath`, `defaultBranch`, `workspaceId`, `path`,
      `alreadyImported`.
- [ ] A relative path, a missing path, and a missing/empty device each fail
      locally with a readable sentence and a non-zero exit, before any request.
- [ ] Importing the same repository root twice yields one project, the second run
      reporting `alreadyImported: true` with exit 0.
- [ ] A non-git path and an offline device surface the existing daemon/centre
      wording rather than a generic failure.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular
  `createWorkspaceForAccount`'s server-initiated prepared pattern, the
  `project.import` convergence branch, or the absence of a `repo_path` uniqueness
  constraint.
- The outcome would require touching `proto/**`, the worker, or the desktop
  renderer.
- A validation command fails twice after one reasonable fix.
- The convergence-layer dedup cannot be expressed without changing the effect or
  metadata contract shared with the desktop path.

## Maintenance notes

- This plan deliberately changes desktop behaviour in one way: a repeated import
  of an already-imported repository now returns the existing project instead of
  creating a duplicate card. That was confirmed with the user; the invariant is
  "one repository root on one device has exactly one project", enforced in the
  convergence transaction rather than by a database constraint. If a constraint is
  ever added, existing duplicates have to be reconciled first.
- A zero-credential local `project import` (the `AgentControlRequest` family) was
  considered and deferred, not rejected on principle: it is the right shape for a
  headless machine with no desktop app, where the account CLI needs
  `coflux login`. It requires a daemon wire protocol change plus a worker
  roll-out.
- After this lands, the Claude plugin needs a version bump and a
  plugins-builder release for the new SKILL text to reach installed agents.
