# Plan 20260921-handle-miss-signals: A mistyped device id says so, instead of reporting an outage

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat f037003d..HEAD -- apps/server/src/hub.ts apps/server/src/interface/client-command apps/server/src/store.ts apps/server/src/local-control.ts packages/cli/skills integrations/claude-plugin/skills tests/src/contract.test.mjs`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: `wiki/plans/20260914-entity-handles.md` (DONE, merged 2026-09-17) — this plan repairs two gaps it left, and must not change the handle grammar it settled
- Category: bug
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (advisor review, then straight to execution)
- Plan review: advisor — departure check; the review ran and its findings are folded in
- Workspace: isolated — cut from the main worktree at plan time
- Planned at: `f037003d`, 2026-09-21

## Requirement

An agent that writes a device id wrong is told the device is offline.

`coflux device exec a995b364 --cmd='…'` — the first dash-delimited group of a real,
online device's UUID — fails with `设备离线，无法执行该操作`. The device is online;
the string is simply not an id the centre knows. Every other entity kind in the same
server answers this case accurately (`终端 <id> 不存在或不属于当前账号`,
`apps/server/src/hub.ts:4254`; the same sentence for projects at `:4042` and workspaces
at `:4083`). Devices are the single exception, because `requireOnlineDaemon` reads only
the live-connection map and collapses "not connected", "belongs to another account" and
"no such device" into one outage sentence (`:3862`).

The cost is a wrong diagnosis, not just a clumsy message: an agent reading "offline"
investigates connectivity — pinging the daemon, asking the user to check the machine —
when the fix is three characters of prefix. Nothing downstream can recover the real
cause, because it was discarded at the point where it was still known.

The second half is why the wrong id was written at all. The skill documents the handle
grammar in full (`packages/cli/skills/coflux/SKILL.md:171-228`) — including that
`<short>` is "the first 8 hexadecimal characters of the entity's UUID — its first
dash-delimited group". That sentence invites the inference that the 8 characters alone
are usable, and nothing contradicts it: the section's three failure modes (no match,
several matches, wrong kind) all presuppose a well-formed handle. A bare prefix is a
fourth case the reader is never warned about — it is not parsed as a handle at all
(`apps/server/src/interface/client-command/entity-handle.ts:55`, `if (!handle) return
{ ok: true, value: input }`), so it travels on as a literal id and fails somewhere with
a message that says nothing about id syntax.

### Product conclusions (settled in exploration — do not reopen)

- **Consumer**: an agent running inside a coflux terminal, holding the `coflux` CLI and
  this skill. The gap is "why did my id not work, and what do I do about it", surfacing
  as a wasted connectivity investigation.
- **Both halves ship together**. Fixing only the skill leaves the misleading signal in
  place, and an agent that reads "设备离线" does not go back to the documentation to
  re-read id syntax. Fixing only the message leaves the inviting sentence uncorrected.
  The user chose both after seeing that tradeoff.
- **The handle grammar does not change.** A bare prefix stays not-a-handle: the kind
  token is the entire point of a handle (`wiki/plans/20260914-entity-handles.md`), and a
  bare prefix is indistinguishable from a real id that happens to be short. This plan
  makes the failure legible; it does not make the input legal.
- **Scope of the message fix is the two account-API entry points that take a device id
  from the user**, not device addressing in general.
- **Non-goals**: no new CLI flag, no `resolve` command, no change to what a successful
  call returns, no change to the desktop or iOS surfaces.

### Observable outcome

`coflux device exec a995b364 --cmd='true'` answers with a sentence naming the id and
saying it is not a device of this account — the same sentence shape terminals, projects
and workspaces already use — while a genuinely disconnected device still reports an
outage. An agent reading the skill's handle section learns, before it makes the mistake,
that the `coflux:<kind>:` prefix is mandatory and that omitting it produces an error
which will not mention id syntax.

## Decisions & tradeoffs

- **Existence is answered by the exact-match `store.getDevice(id)`** (`apps/server/src/store.ts:489`,
  `SELECT * FROM devices WHERE id = $1`), with the caller checking `revoked` and `accountId`
  itself — exactly the shape `apps/server/src/local-control.ts:118-120` already uses for the
  same question. Rejected: `store.listIdsByPrefix("device", accountId, id, 1)` — its contract
  states `prefix` is "validated hex upstream, so it carries no LIKE wildcard"
  (`store.ts:984`), and the string arriving here is validated only as
  `z.string().min(1).max(256)` (`client-command.contract.ts:4`). Feeding it to
  `id LIKE ${prefix}%` would make `coflux device exec '%'` match an arbitrary device of the
  account and report it as *existing but offline* — a second wrong answer in the exact place
  this plan exists to fix. Rejected: a new `deviceExists` store method — `getDevice` already
  is one. `(revised on advisor review — the pre-review plan specified `listIdsByPrefix`)`

- **The new sentence is the one this file already uses for every other entity kind**:
  `设备 <id> 不存在或不属于当前账号`, carrying the offending id, matching
  `hub.ts:4042` (project), `:4083` (workspace) and `:4254` (terminal) word for word apart
  from the noun. Rejected: a freshly worded message such as 「找不到设备」 — it would make
  devices the odd one out a second time. Rejected: copying `local-control.ts:120`'s
  「设备不存在或不属于本账号」 — same meaning, but it drops the id and says 本账号 where
  every sentence in `hub.ts` says 当前账号; the file being edited sets the convention.
  `(the first clause decided while planning; the local-control exclusion added on advisor review)`

- **Which of the two failures occurred is read from the live map, never from the error
  string**: `requireOnlineDaemon` returns only `{ ok: false, error: string }`
  (`hub.ts:295`, `:3862`) and its signature is fixed, so the caller distinguishes "absent
  from the live map" from "connected but lacking the capability" by consulting
  `this.daemons` directly — a synchronous `Map` lookup, no database access. Rejected:
  comparing `error` against the outage sentence — it couples two call sites through a
  user-facing string that this very plan is in the business of changing.
  `(revised on advisor review)`

- **The database lookup runs on the failure path only**: it happens after
  `requireOnlineDaemon` has already decided the call cannot proceed *and* the live-map
  check above showed the daemon is absent. A successful `device.exec` performs exactly the
  queries it performs today. Rejected: validating the id up front at the handler boundary,
  the way handles are resolved — that adds a round trip to every successful cross-device
  call to improve a message nobody sees on the happy path.

- **`requireOnlineDaemon` keeps its current signature, its current message, and its six
  other callers**: `hub.ts:3860` stays synchronous and stays the outage sentence. Nine
  occurrences of the name exist in the file: one definition (`:3860`) and eight calls
  (`:3978`, `:4048`, `:4103`, `:4152`, `:4267`, `:4328`, `:4356`, `:4443`). Two of those
  calls take a user-supplied id; the other six receive a `daemonId` read off an entity that
  already exists (`project.daemonId` at `:4048`, `ws.daemonId` at `:4103`,
  `initialWorkspace.daemonId` at `:4152`, `task.daemonId` at `:4267`, `:4328`, `:4356`) —
  for them the device is known to exist and "offline" is accurate, so a lookup there would
  be dead weight and making the helper `async` would ripple through six call sites for
  nothing. `(count corrected on advisor review — the pre-review plan said seven)`

- **The two entry points are `execOnDeviceForAccount` (`hub.ts:4443`, `device.exec`) and
  `importProjectForAccount` (`:3978`, `project.import`)** — the complete set of places a
  user-supplied device id reaches `requireOnlineDaemon` through the account API. Based on:
  the handler resolves a device handle for exactly these two operations
  (`apps/server/src/interface/client-command/client-command.handler.ts:56-70`), and
  `terminal.*` addresses devices only through an already-persisted task.

- **The answer never distinguishes "no such device" from "another account's device"**:
  both produce the same sentence, because the account check is the security boundary that
  keeps an id from becoming an existence oracle. Same rule the handle resolver states at
  `entity-handle.ts:9-13`, and a `revoked` device reads as not-of-this-account, matching
  what `listDevices` shows (`store.ts:508`). Rejected: a more specific message for a device
  that exists under a different account.

- **`terminal.stop`'s own outage sentence at `hub.ts:4390` (`设备离线，无法停止终端`) is
  out of scope and unchanged**: its `daemonId` comes from the task being stopped, so the
  device provably exists and the sentence is accurate.

- **The skill gains a fourth failure case, in the section that already enumerates the
  other three** (`packages/cli/skills/coflux/SKILL.md:207-224`, "When a handle does not
  resolve"): a string without the `coflux:<kind>:` prefix is not a handle, is forwarded as
  a literal id, and fails with a message that will not mention id syntax. Rejected: putting
  the warning only next to the grammar — the reader who needs it is the one holding an
  error message, and that reader is in the failure-modes section.

- **Both copies of the skill change together and stay byte-identical**:
  `packages/cli/skills/coflux/SKILL.md` is the sole source, mirrored into
  `integrations/claude-plugin/skills/coflux/SKILL.md` by `node scripts/sync-claude-plugin.mjs`,
  and CI fails on drift (`.github/workflows/ci.yml:152`, `--check`). Editing either file by
  hand without running the sync is a red build.

- **The skill text is English, the quoted error strings stay Chinese**: `AGENTS.md`
  requires English documentation while preserving literal protocol values, and the skill
  already quotes runtime sentences verbatim (`SKILL.md:531`).

- **One black-box assertion is added to the existing `tests/src/contract.test.mjs`**, next
  to the handle assertions already there (`:418-431`). This is the exception `AGENTS.md:68-80`
  allows, not a habit: the regression it guards is invisible while using the product,
  because the distinction only shows on a mistyped id, and when it does regress it presents
  as the very symptom this plan removes — an agent investigating the wrong thing. The file
  already logs in and wraps `accountCommand()` (`:31`) and exposes the live `stack.daemonId`
  (`:41`), so no new file and no new port is involved. Rejected: a new test file — the suite
  was deliberately cut to five files on 2026-09-13.

## Direction

The centre keeps the information it already has at the moment it is still known: when a
device id cannot be turned into a live connection, the two account-API entry points that
received that id from a human or an agent say which of the two things went wrong.
Everything else about device addressing is untouched. In parallel, the skill stops implying
that a bare prefix is usable and tells the reader what a bare prefix actually does.

The two milestones are **independent**: their file sets are disjoint, neither consumes the
other's output, and each validates on its own. The one thing they share — the exact new
sentence — is fixed above under Decisions, not produced by either milestone, so they may be
fanned out into concurrent work packages. When they are, the orchestrator, not the packages,
updates `wiki/plans/README.md` and this file.

### Milestone 1: A device id that names nothing says so

`device.exec` and `project.import` answer a device id that matches no device of the
requesting account with `设备 <id> 不存在或不属于当前账号`, while a device that exists but
is not connected still reports the outage, and a connected device lacking the required
capability still reports the upgrade message. No extra query runs on a successful call, and
`requireOnlineDaemon` keeps its signature and its six other callers' behaviour.

Files: `apps/server/src/hub.ts`, `tests/src/contract.test.mjs`.

Validation: `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0;
`pnpm -C tests test` -> exit 0, with an assertion in `tests/src/contract.test.mjs` showing
that a device id belonging to no device — a fresh `randomUUID()`, and the bare 8-hex prefix
of the live `stack.daemonId` — fails with the not-found sentence rather than the outage one.

### Milestone 2: The skill warns about the bare prefix before it is written

Three places in the skill, all of them:

1. The handle section's failure-mode list (`SKILL.md:207-224`) covers the case where the
   input was never a handle: the `coflux:<kind>:` prefix is mandatory, a bare id prefix is
   forwarded as a literal id, and the resulting error will not point at id syntax.
2. `SKILL.md:531` quotes `设备离线，无法执行该操作` and glosses it "(that device is not
   connected)". After milestone 1 that gloss is only half the story: the line must carry
   both sentences — the outage one for a device that exists but is disconnected, and
   `设备 <id> 不存在或不属于当前账号` for an id that names no device of the account.
3. `SKILL.md:551` lists the CLI's own failures for `device exec` ("device offline, that
   device's daemon too old, …"). That summary gains the new case.

Both copies of the skill are byte-identical afterwards.

Files: `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin/skills/coflux/SKILL.md`.

Validation: `node scripts/sync-claude-plugin.mjs --check` -> exit 0.

## Landmines

- **`store.listIdsByPrefix` must not be used for this check.** Its contract says `prefix`
  is validated hex (`apps/server/src/store.ts:984`) and it interpolates into `id LIKE
  ${prefix}%` (`:996`). The id on this path carries no such validation, so `%` or `_` would
  match an arbitrary device of the account. It is the obvious-looking reuse — the handle
  resolver right next door calls it — and it is wrong here.

- **`SKILL.md:531` and `:551` are far from the handle section** that milestone 2 is
  otherwise editing, inside the `project.import` and `device exec` documentation. They are
  the second and third places in the skill that describe this behaviour and the easiest to
  miss; they are listed in milestone 2 for that reason.

- **`tests/src/contract.test.mjs:427-430` asserts the opposite of this change for a
  neighbouring case**, under the comment 「不是 handle 的字符串原样透传，走原来的归属校验，
  措辞不变」. The assertion itself is about `terminal.read` and stays true; the comment's
  general claim ("the wording does not change") no longer holds for devices. Leave the
  terminal assertion alone and do not let its comment stand as a statement about every kind.

- **Two black-box suites cannot run on one machine at once**: ports in `tests/src/*.test.mjs`
  are hardcoded (`AGENTS.md:96-102`), so a concurrent run steals them and fails as a timeout
  that reads like a code bug. The suite also needs the dedicated local Postgres
  (`pnpm dev:pg`, `127.0.0.1:5432`); when Docker is half-dead the whole suite times out for
  reasons that have nothing to do with this change.

- **`store.getDevice` filters on neither account nor `revoked`** (`store.ts:489-492`): it is
  a bare primary-key read. The caller supplies both checks, as `local-control.ts:119` does.
  Dropping either one turns the message into a lie about another account's device.

## Scope

In scope:
- `apps/server/src/hub.ts` — the two account-API entry points only
- `tests/src/contract.test.mjs` — one added assertion
- `packages/cli/skills/coflux/SKILL.md` and `integrations/claude-plugin/skills/coflux/SKILL.md`

Out of scope:
- `apps/server/src/interface/client-command/entity-handle.ts` — the handle grammar is settled by `20260914-entity-handles`; a bare prefix stays not-a-handle
- `apps/server/src/store.ts` — `getDevice` is used as it is; no new store method
- `hub.ts:3860` `requireOnlineDaemon` itself, and `hub.ts:4390` `terminal.stop`'s outage sentence — accurate for their callers
- `hub.ts:2882`, `:2981` — the desktop WebSocket channel's equivalent collapse (`daemon 不在线或不属于本账号`); see Maintenance notes
- Both CLIs (`crates/cli`, `packages/cli/*.mjs`) — they forward the centre's sentence unchanged
- Desktop and iOS surfaces — no client renders these two sentences differently

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Black-box suite | `pnpm -C tests test` | exit 0 |
| Skill copies match | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |

This worktree has no `node_modules` — `pnpm install` at preflight is what makes the first
and third commands resolvable. The black-box suite's `pretest` builds three Rust crates and
the test transports into this worktree's own `target/`, so its first run takes considerably
longer than the ~1 minute the steady-state suite takes. It also needs `pnpm dev:pg` running
and no other black-box suite on the machine.

## Done criteria

- [ ] All listed commands pass.
- [ ] A device id matching no device of the account fails with `设备 <id> 不存在或不属于当前账号` on both `device.exec` and `project.import`.
- [ ] A device that exists but is disconnected still reports the outage sentence; a connected device without the capability still reports the upgrade message.
- [ ] The diff touches neither `hub.ts:3860-3865` nor any of the six entity-derived call sites (`:4048`, `:4103`, `:4152`, `:4267`, `:4328`, `:4356`).
- [ ] Every `getDevice` call this change introduces sits inside a `!daemon.ok` branch — no database access is added to a path that succeeds.
- [ ] Which failure occurred is determined from `this.daemons`, not by comparing the error string.
- [ ] The skill covers the not-a-handle case, and both `SKILL.md:531` and `:551` are consistent with the new behaviour.
- [ ] Both skill copies are byte-identical.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular if `requireOnlineDaemon` has gained or lost callers (eight at planning time, two of them user-supplied), or if `store.getDevice` no longer reads by primary key.
- Making the distinction would require changing the handle grammar, or making a bare prefix resolve.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- The asymmetry this plan removes came from `requireOnlineDaemon` being written for callers
  that hold a known device. Any future entry point that takes a device id directly from a
  caller inherits the same trap and needs the same treatment — the helper cannot give it for
  free without the cost recorded under Decisions.
- **The account API is consistent after this change; the desktop WebSocket channel is not.**
  `hub.ts:2882` (`projectImport`) and `:2981` (`terminalCreate`) make the same collapse with
  their own sentence, `daemon 不在线或不属于本账号`. They stay as they are because their
  `daemonId` comes from the sidebar rather than from typing, so the misdiagnosis this plan
  fixes cannot arise there — but do not read "the server is consistent now" into this plan.
  `hub.ts:2861` (`clientUpgradeDaemon`) already gets it right, via `getDevice` first.
- `workspace.*` and `terminal.*` already answer accurately for a non-existent id. If a future
  entity kind is added with its own live map, check it against the
  `不存在或不属于当前账号` sentence before shipping.
- The skill now documents four failure modes for one grammar. If a fifth appears, the list is
  the place readers look; the grammar paragraph is not.
