# Plan 20261002-account-agent-settings: Agent launch settings belong to the account, not the Mac

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat aa65d982..HEAD -- proto/coflux/v1/client.proto apps/server/src/hub.ts apps/server/src/store.ts apps/server/src/infra/database/schema-migrations.ts packages/client/src/store.ts apps/desktop/src/renderer/components/settings apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/config.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none (reverses one decision of `wiki/plans/20261001-desktop-agents.md`)
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261002-account-agent-settings` on `dev/20261002-account-agent-settings`
- Planned at: `aa65d982`, 2026-10-02

## Requirement

Plan 20261001-desktop-agents (released in 2.14.0) lets the user enable Claude Code, Codex, Cursor
and Grok in Settings → Agents, each with a launch command, and launch them from the ⌘T 「Agent ▸」
flyout. It stored that configuration in renderer `localStorage`, "this Mac only". That was the wrong
call: the launch command is typed into a shell and resolved through `PATH`, so it does not depend on
which Mac it was configured on, and a user with several Macs has to configure every one of them.
This plan makes the configuration **one copy per account, stored on the center**.

Product conclusions (confirmed with the user — do not reinterpret):

1. **One account-level configuration**: per catalog agent, `enabled` + launch command, stored on the
   center. No per-device or per-workspace override. The Settings → Agents layout, the 「Agent ▸」
   flyout, the "effective = on and non-blank command" rule, and the launch behaviour stay exactly as
   in 2.14.0.
2. **Online**: every change saves to the account immediately (no save button). Every other online
   desktop of the same account updates live — its Settings section and its ⌘T flyout — without a
   reload. Two desktops editing at once: last write wins.
3. **Offline** (the control connection is not `connected`): ⌘T keeps working from the last
   configuration this desktop received, including after a cold start while the center is
   unreachable. Settings → Agents is read-only — switches and inputs disabled — with the hint
   「配置存在账号上，离线时可以照常使用，但改不了」 (same behaviour as the executor section,
   `components/settings/executor-section.tsx:50`, `:152-154`).
4. **Write failure while online**: the error is shown locally, and the UI shows the account's value
   again. It never looks saved when it was not.
5. **Copy**: the section no longer claims the configuration stays on this Mac; it says it is stored
   on the account and shared by every device.
6. **Values stored by 2.14.0 are discarded** (the user's choice): after the upgrade every agent is
   off and the user re-enables and refills them once. The release notes must say so.
7. **Non-goals**: an agent menu on iOS; per-device commands; moving the tab identity record (task id
   → agent id, `components/workbench/agent-tabs.ts`) — it **stays local**: on another Mac an agent's
   tab shows the presence glyph while the agent runs and the plain terminal icon after it exits.

Observable when done: on Mac A enable Claude Code and type `claude` → Mac B, already open, shows
「Agent ▸ Claude Code」 in ⌘T without a reload. Take B offline → its ⌘T still offers Claude Code and
Settings → Agents is greyed with the hint. Bring B back online and switch Claude Code off there →
A's 「Agent」 item disappears.

## Decisions & tradeoffs

- **Transport is the client control WebSocket** (`proto/coflux/v1/client.proto`). On subscribe the
  center sends the account's full agent configuration after the state snapshot; a change made by any
  client is broadcast as the full configuration to every subscribed client of the account, the
  writer included. Rejected: an HTTP endpoint — it cannot push, so live sync would need polling.
  Rejected: the executor-settings route (center → daemon downlink → device cache file → desktop main
  process) — that path exists because the executor runs on the daemon; the only consumer here is the
  desktop renderer, which already holds a live connection to the center. This overrides the
  maintenance note in `20261001-desktop-agents.md` ("move the store behind the executor-settings
  path"). Based on: subscribe sends the snapshot and then the notification inbox
  (`apps/server/src/hub.ts:3045-3070`); `broadcast` reaches the account's subscribed clients
  (`hub.ts:899`); a request/response write that also broadcasts and replies to an unsubscribed writer
  (`notificationRead`, `hub.ts:3127-3136`).
- **A write changes exactly one agent** and carries a `request_id`; the center answers that request
  with success or an error. Rejected: writing the whole configuration — two desktops editing
  different agents would overwrite each other. Last-write-wins applies per agent.
- **Storage: one row per (account, agent id)**, created by a new migration 9 that only adds a table
  (no change to existing tables), so rolling the server back to a build without it stays safe.
  Rejected: one JSON document per account — it forces whole-document writes (see the previous
  decision). Based on: latest migration is 8 `device_join_keys`
  (`apps/server/src/infra/database/schema-migrations.ts:1378`).
  (revised on plan audit) The table follows the existing account-scoped shape: schema-qualified
  `coflux.…`, `account_id TEXT NOT NULL REFERENCES coflux.accounts(id) ON DELETE CASCADE`, unique on
  (account, agent id), a `*_SCHEMA_SQL` constant plus a migration entry like `device_join_keys`
  (`schema-migrations.ts:1308-1319`). Local mode is covered: it uses account `"default"`
  (`apps/server/src/config.ts:87`), whose row is created at boot (`apps/server/src/plugins/store.plugin.ts:32`).
  A migration's `definition` is checksummed into the ledger (`schema-migrations.ts:786-788`), so it
  is immutable once merged.
- **The center does not know the agent catalog.** It treats the agent id as an opaque bounded token
  (charset and length limits) and enforces only safety limits: newlines stripped from the command,
  command at most 1000 characters (the client's existing cap, `components/settings/agent-settings.ts`
  `MAX_COMMAND_LENGTH`), and a small cap on rows per account. Validation precedent:
  `validBoundedText` (`hub.ts:5143`); request/reply-by-`requestId` precedent: `createJoinKey`
  (`hub.ts:4244-4249`). Adding a fifth agent later is a
  desktop-only change. The desktop ignores ids it does not know.
- **`AuthOk` carries a capability flag** saying this center serves agent settings. Precedent:
  `notification_inbox` (`client.proto` `AuthOk`, `hub.ts:3846`, client handling at
  `packages/client/src/store.ts:873-877`). The client uses it to tell "center too old" apart from
  "account has nothing configured". Against a center without the flag the configuration is empty
  (nothing in ⌘T) and Settings → Agents is read-only with a hint that the server needs updating;
  "no rows yet" means all off and editable.
- **The configuration lives in `@coflux/client`'s store**, the sole TS client source of truth.
  The renderer's `agent-settings-store.ts` stops reading or writing `localStorage` and becomes a
  view over the client store. The catalog, the effective-agent rule and the logos stay in the
  renderer. The client store also exposes the write as an awaitable request (success / error), like
  `authorizeDevice` or the join-key request.
- **Offline cold start uses the plan-103 offline catalog.** The configuration is saved with it and
  restored from it (`packages/client/src/store.ts:297-370`) **without** bumping
  `OFFLINE_CATALOG_VERSION`: a cache written before this change simply has no agent configuration
  (all off), the same tolerance `loginName` gets. That cache is already cleared on logout, auth
  failure and account switch, which is exactly the lifetime the configuration needs.
- **The 2.14.0 value is removed, not migrated**: the old key (`AGENT_SETTINGS_KEY = "coflux_agents"`,
  `apps/desktop/src/renderer/config.ts:60`) is deleted from `localStorage` (failure tolerated) and
  never read. Rejected: uploading it to an empty account — the user chose to discard.
- **Write cadence**: a switch writes at once; the command text writes after a short pause in typing
  (at most 500 ms) or on blur. While the command input has focus it keeps a local draft that a
  broadcast — including the echo of this desktop's own write — does not overwrite; the draft
  reconciles with the account value on blur or after its write settles. Rejected: one write per
  keystroke with the input bound straight to the account value — the echo of an earlier keystroke
  would rewrite the field under the caret.
  (revised on plan audit) A pending debounced command write is **flushed** when the input blurs or
  the Settings section unmounts while online, and **dropped** when the connection leaves `connected`
  or the account changes. A dropped write shows the account value again; it is not queued for
  later.
- **Write errors surface through Astryx's `useToast`** (`@astryxdesign/core/Toast`, precedent
  `components/workbench/changes-view.tsx:155`, provider under `LayerProvider` in `main.tsx:108`),
  **never through `client.reportLocalError` / `lastError`.** Setting `lastError` stops every
  terminal that is mid-attach and drops in-flight creates (the agent launch notices in
  `components/workbench/use-agent-launches.ts` were moved off `lastError` for the same reason). Do
  not build a third notice mechanism. (revised on plan audit)
- **Old desktops are unaffected**: a 2.14.0 desktop ignores the new server payload
  (`packages/client/src/store.ts:1242`, `default: break`) and keeps its local configuration.
  (verified on plan audit) The other consumers tolerate the new messages too: no Rust code outside
  `crates/protocol/src/gen` matches on `ServerToClient`/`AuthOk`; Swift has `default:`
  (`packages/swift-client/Sources/CofluxClientCore/CofluxClient.swift:675`); the black-box harness
  decodes with the regenerated codec and waits on predicates (`tests/src/harness.mjs:1052`).

Left to the executor: table, column and proto message names; the id charset and the row cap; the
exact debounce; the "server needs updating" copy; whether `agent-settings.test.ts` is rewritten or
reduced; how the Settings section receives the client (the executor section takes it as a prop,
`settings-page.tsx:180`).

## Direction

Three milestones. M1 (wire contract and center) gates M2 (client store); M3 (renderer) needs M2's
store API. Strictly serial — do not fan out.

### Milestone 1: The center stores and pushes the account's agent configuration

`client.proto` has the set request, the full-configuration update and the `AuthOk` flag, and the
three generated trees are regenerated and committed (`cd proto && buf generate`). Migration 9 adds
the table; the hub validates and persists a set, broadcasts the account's full configuration, replies
to the writer by `request_id`, and sends the configuration to every client right after its subscribe
snapshot.
Validation: `cd proto && buf lint && buf generate && git status --porcelain -- ../packages/protocol/src/gen ../crates/protocol/src/gen ../packages/swift-client/Sources/CofluxProtocol/Generated` shows only intended changes, committed;
`node scripts/check-protocol-breaking.mjs "../.git#ref=main,subdir=proto"` → exit 0;
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0;
`cargo build --workspace` → zero warnings.

### Milestone 2: `@coflux/client` holds, caches and writes the configuration

The client store exposes the account's agent configuration, whether the center supports it, whether
it has been received on this connection, and an awaitable per-agent write. It reads the `AuthOk`
flag, replaces the configuration on every update, survives reconnects, resets on account switch and
logout, and is saved to and restored from the offline catalog.
Validation: `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` → exit 0.

### Milestone 3: The desktop reads and writes the account configuration

Settings → Agents and the ⌘T flyout read from the client store; the section writes through it with
the cadence and draft rules above, is disabled with the right hint offline or against an old center,
and shows failures as a local notice. The section's copy says the configuration is on the account.
The old `localStorage` key is removed. Catalog order, effectiveness rule, launch, tab identity and
logos are unchanged.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **Received vs. empty**: between `authOk` and the first configuration push, the client does not
  know the account's configuration yet. It must keep what it already had (memory or offline cache)
  rather than flash "all off", and the Settings section must not accept edits until the first
  configuration of this connection has arrived — an edit based on stale data would be broadcast as
  truth.
- **The offline cache is rewritten between `authOk` and the first push** (revised on plan audit):
  `authOk` falls through to `persistOfflineCatalog()` (`packages/client/src/store.ts:890`, `:1245`),
  which serializes the current state on a microtask (`:551-575`). If "not received yet" is modelled
  by clearing the configuration at `authOk`, that persist overwrites the cache with "all off".
  Constraint: "received on this connection" is a separate field; the configuration in state is
  replaced only by a push or reset by an account change — never zeroed at `authOk` or on disconnect.
- **Subscribe tail ordering**: everything after the snapshot is sent with `sendClientNow`
  (`hub.ts:3077-3095`); the configuration send follows the same path. `sendClient` in that window
  lands in the backlog (`hub.ts:845-866`).
- **The flyout has no client prop**: `NewTabMenu` (`workspace-terminal.tsx:228-249`) does not
  receive the client, its enclosing component does (`:185`), and the renderer has no client
  context. Thread the client down or select higher up.
- **Selector stability**: select the configuration object from the client store and derive the
  effective list in render. A `useStore` selector that returns a fresh `effectiveAgents(...)` array
  makes `useSyncExternalStore` re-render forever.
- **`agent-tabs.ts:11` imports `isAgentId` from `agent-settings.ts`**: refactoring that module must
  keep the tab identity record working unchanged.
- **Account switch**: the notification inbox resets per account (`packages/client/src/store.ts:867-872`).
  The agent configuration must reset the same way; a different account must never see, or launch,
  the previous account's commands.
- **Pending writes across a disconnect**: a write in flight when the connection drops must settle
  (as failure) rather than hang, and the field shows the account value again after reconnect.
  Precedent: `failJoinKeys` called from `onStatus` (`packages/client/src/store.ts:793`) and from
  `logout` (`:1327`).
- **Subscribe ordering**: a set that commits between the subscribe's reads and the snapshot send is
  either already in the read or lands in the snapshot backlog (`hub.ts:3048-3052`). Read the
  configuration inside that same window, not after the backlog is flushed, or an update can be lost
  for that client.
- **The launch path reads the configuration imperatively**: `workbench.tsx:1600` calls
  `effectiveAgents(agentSettingsStore.getState().settings)` at launch time, and
  `workspace-terminal.tsx:251` reads it through a hook. Both must move to the new source; a leftover
  read of the old module would silently offer nothing.
- **`lastError` is a blast radius, not an error channel** (see Decisions). This applies to every new
  error path in this plan, in the client package as well as the renderer.
- **`buf generate` writes three trees** (TS, Rust, Swift; `proto/buf.gen.yaml`) and CI fails if any is
  out of date (`.github/workflows/ci.yml:115-124`). The Swift tree must be committed even though iOS
  does not use the new messages.
- **Zsh in the Bash tool**: `set -e` does not apply and `"$VAR:path"` modifiers eat paths; chain
  multi-step commands with `&&`.
- **The worktree has no `node_modules`**: run `pnpm install` (lockfile only, no new dependency) and
  establish a green baseline before editing.

## Merge and deploy

- **Order: deploy the center first, then release the desktop.** Migration 9 only adds a table; take
  the usual pre-deploy backup (`docs/deployment.md`). A rollback to the previous server is safe; the
  new table is simply unused.
- No daemon/worker or CLI change and no new environment variable.
- Release notes must state, in English: the center must be updated before desktops use the account
  configuration (the opposite of 2.14.0's "the center needs no update"); and "Agent settings moved
  to your account: after updating, turn your agents on and enter their launch commands once more."
- **Acceptance (`pnpm -C tests test`)** proves the subscribe sequence and codec did not regress; it
  does not exercise the new messages. No new black-box test is added — a broken sync is visible the
  first time the section is used (AGENTS.md test policy); the done criteria and the walkthrough are
  the real gate.
- The breaking check runs against `main` locally; CI runs it against the PR base. If `main` moves
  before merge, re-run it against the merge base.
- **Real-machine walkthrough is pending the user**, and it needs the new center: a local stack
  (`pnpm dev:pg`, `pnpm dev:server`, two desktop previews of this branch against it — see the
  `desktop-preview` skill) before production is deployed. Walk the acceptance in Requirement, plus:
  cold start with the center stopped still shows the flyout; a 2.14.0 value does not reappear.

## Scope

In scope:
- `proto/coflux/v1/client.proto` and the generated trees under `packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `apps/server/src/hub.ts`, `apps/server/src/store.ts`, `apps/server/src/infra/database/schema-migrations.ts` (and a small new server module if cleaner)
- `packages/client/src/**`
- `apps/desktop/src/renderer/**` (settings section, agent settings modules, flyout and launch readers, config key)
- `wiki/plans/**`

Out of scope:
- `crates/worker`, `crates/supervisor`, `packages/cli`, `crates/cli`, `integrations/**` — no daemon or CLI involvement
- iOS / `packages/swift-client` sources other than the generated tree — non-goal
- `components/workbench/agent-tabs.ts` storage — the tab identity record stays local
- The executor settings path — unrelated
- `docs/releases/**` — release notes are written at release time; the required content is recorded above

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint + generate | `cd proto && buf lint && buf generate` | exit 0, generated trees committed |
| Protocol breaking check | `node scripts/check-protocol-breaking.mjs "../.git#ref=main,subdir=proto"` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Rust build | `cargo build --workspace` | exit 0, zero warnings |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` (needs `pnpm dev:pg`) | exit 0 |
| Walkthrough (acceptance) | local stack + two desktop previews, per Merge and deploy | user-verified |

## Done criteria

- [ ] All non-acceptance commands pass; the black-box suite passes.
- [ ] A change on one desktop reaches another online desktop of the same account without a reload, for both the switch and the command.
- [ ] Two different agents edited from two desktops both survive (per-agent writes).
- [ ] Offline (including a cold start with the center unreachable) the flyout still offers the last received agents, and Settings → Agents is disabled with 「配置存在账号上，离线时可以照常使用，但改不了」.
- [ ] Against a center without the capability flag, the flyout offers nothing and the section is read-only with an update-the-server hint.
- [ ] A failed write shows a local notice, the field returns to the account value, and `lastError` is not touched.
- [ ] Typing in the command input never loses characters or moves the caret because of its own echo.
- [ ] Switching account never shows or launches the previous account's agents.
- [ ] Reconnecting to the center does not wipe the offline cache's agent configuration before the first push arrives.
- [ ] The `coflux_agents` `localStorage` key is removed and never read; no other renderer code reads agent settings from `localStorage`.
- [ ] Agent tab identity still uses local storage, unchanged.
- [ ] No out-of-scope files changed; `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. `broadcast` no longer reaches all of an account's subscribed clients, or the offline catalog is no longer cleared on account switch).
- Live sync or offline cold start turns out to need a daemon, worker or CLI change.
- The protocol breaking check fails for an additive change and the fix would need an allowlist entry.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Plan audit (fable, 2026-10-02) found one blocker — the breaking-check baseline must be
  `../.git#ref=…` because the script runs buf from `proto/` (fixed) — and folded in the offline-cache
  persist window, the table shape, debounce flush/drop, the toast mechanism, and renderer wiring
  landmines. All cited facts held at `aa65d982`.

- Adding an agent stays a desktop-only change (catalog entry + logo); the center stores any id within its limits.
- If iOS ever gets an agent menu, it reads the same `AuthOk` flag and update message; nothing on the center changes.
- The tab identity record is deliberately still per-desktop; moving it would mean task-level metadata on the center, a separate decision.
