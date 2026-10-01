# Plan 20261001-desktop-agents: Launch Claude Code, Codex, Cursor or Grok from the new-tab menu

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 755f4978..HEAD -- apps/desktop/src/renderer packages/client/src/store.ts packages/client/src/device-router.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261001-desktop-agents` on `dev/20261001-desktop-agents`
- Planned at: `755f4978`, 2026-10-01

## Requirement

Coflux runs coding agents in its terminals, but starting one means opening a terminal and typing
the CLI's name. This plan makes "agent" a first-class choice on the desktop: the user enables the
agents they use in Settings, each with its own launch command, and then opens one straight from the
new-tab menu.

Four agents are supported, always in this order: **Claude Code, Codex, Cursor, Grok**. Each has a
display name, a default command used only as a placeholder hint (`claude`, `codex`, `cursor-agent`,
`grok`), and a brand logo.

Product conclusions (confirmed with the user — do not reinterpret):

- **Settings → 「Agents」**: a new section with its own icon, in its own group in the left nav. One card
  with four rows in the fixed order; each row is brand logo + name + a switch on the right.
  - All four are **off by default**.
  - Turning a switch on expands a 「启动命令」 text input under that row. The input starts **empty**;
    its placeholder shows the default command. The user must type the command themselves.
  - An agent is **effective** only when its switch is on **and** its trimmed command is non-empty.
    On + empty shows the inline hint 「填写启动命令后生效」 and the agent is not offered anywhere.
  - Every change saves immediately (no save button), is stored **only on this Mac** (no account
    sync), and works offline. Turning a switch off keeps the typed command for next time.
- **New-tab menu (the tab strip's ＋ and ⌘T)**: when at least one agent is effective, an 「Agent ▸」
  item appears directly below 「终端」. Hovering it, or pressing → on it, opens a flyout to the right
  listing the effective agents in the fixed order, each with its brand logo. When none is effective,
  the 「Agent」 item is not shown at all — the menu looks exactly as it does today.
- **Choosing an agent** opens a new, ordinary interactive terminal in that group — exactly what
  「终端」 opens (cwd = the workspace; for a remote workspace, on the remote device) — and types the
  agent's launch command into it once the shell is ready. The tab's title is the agent's display
  name and its icon is the agent's brand logo. When the agent exits, the user is back at the shell
  and the tab stays.
- **Status glyphs**: Claude keeps today's Clawd state glyph while it is detected; Codex's generic
  `Bot` glyph becomes the Codex logo with the same state tinting; Cursor and Grok show a static logo
  (no state detection).
- **Failure**: a command that is not found, or a CLI missing on a remote device, shows up in the
  terminal itself, like typing it by hand. No extra dialog.
- **Non-goals**: account sync; agents beyond these four or user-defined agents; state detection for
  Cursor or Grok; per-device or per-workspace commands; per-agent keyboard shortcuts.

Observable when done: enable Claude Code and type `claude` → ⌘T shows 「Agent ▸」 → hovering shows
Claude Code with its logo → choosing it opens a tab named after Claude Code that is running `claude`.
Turn every agent off (or clear their commands) → the 「Agent」 item is gone.

## Decisions & tradeoffs

- **Desktop-only change**: no proto, server, daemon or CLI change; ships as a desktop release alone.
  Rejected: adding a `command` to `TaskCreate` — needs a server deploy first and protocol work for
  something the desktop can do itself. Based on: `TaskCreate` carries only `workspace_id` and `title`
  (`proto/coflux/v1/client.proto:113`).
- **Configuration lives in renderer `localStorage`, behind one module that is the only reader and writer**,
  exposing a subscribable state that both the Settings section and the new-tab menu read, so a change
  in Settings is reflected in the menu without a reload. Rejected: account-level storage like the
  executor settings — the user chose "this Mac only"; a main-process file — nothing outside the
  renderer needs it. Reads and writes must tolerate a missing or malformed value (fall back to "all
  off, empty commands") and a throwing `localStorage`. Based on: precedent
  `components/workbench/sidebar-collapse.tsx:39`, `components/workbench/use-pane-width.ts:16`.
- **The agent catalog is fixed data in one place** (id, display name, placeholder command, logo
  component), ordered Claude Code, Codex, Cursor, Grok. Settings rows, the flyout and tab icons all
  derive from it. The placeholder command is never used as a launch command.
- **The desktop types the launch command itself, as the terminal's holder.** Rejected: the server's
  do-script path (`terminal.run`, `createTerminalForAccount` → `typeIntoTerminal` in
  `apps/server/src/hub.ts`) — it reaches the shell through the worker's agent input, which refuses
  whenever a human holder is present (`crates/worker/src/device.rs:1663`), and the newly opened pane
  *is* that holder. Precedent for holder-side typing: `handOffAnnotations` in
  `packages/client/src/store.ts:1643` (holds the session → `deviceRouter.sendInput`). Exposing a
  minimal helper from `@coflux/client` for this (e.g. "does this client hold the session", a local
  error report) is in scope.
- **When to type** (revised in exploration; timeout bound revised on plan audit): only once this
  client holds the new terminal's session, and then on the first of (a) the first authenticated
  OSC 133 prompt-start mark seen live in that terminal, or (b) a short timeout of about 1 s (executor
  may tune, but not above 2 s). The timeout is the common path, not a corner case: whenever the
  prompt was drawn before the attach (usual locally, near-certain remotely, since RUNNING goes round
  the centre) the mark is inside the snapshot, so the timeout is user-perceived latency. The command
  and `\r` go in one write. A better signal, `TerminalCommandState.integrated`
  (`proto/coflux/v1/device.proto:354`), only reaches the client through a snapshot request that no
  client code sends today; using it is out of scope. Rejected: waiting for the mark alone — an attach may begin with an ANSI snapshot
  (`DeviceSessionAttached.ansi_snapshot`, `proto/coflux/v1/device.proto:329`) that carries no
  OSC 133, so the first prompt mark can be lost and the command would never be typed. Rejected:
  the 150 ms text-then-Enter split of `HAND_OFF_ENTER_DELAY_MS` (`packages/client/src/store.ts:136`)
  — that exists for agent TUIs treating a burst as paste; the receiver here is a shell.
- **Exactly once, owned above the pane**: the pending launch command is keyed by task id at the
  workbench level (not inside the terminal pane — moving a tab between groups remounts nothing today,
  but pane lifecycles are not a contract) and is consumed when sent. A reconnect, a re-attach, a
  window reload or a restart must never type it again; persisting the pending command across reloads
  is **not** wanted. (revised on plan audit) The pending command's lifetime is bound to the task, not
  to a wall clock: it is discarded when the task is removed or EXITED, when the pending create is
  dropped (its timeout or a `lastError`, the same place `workbench.tsx` already drops the pending
  create), or on reload — each of which the user already sees. Reaching the holder is not under the
  renderer's control (a task in a hidden group or on an offline device may legitimately wait), so
  there is no "never attached" timeout error. The one real delivery failure — the send itself
  returning false (`deviceRouter.sendInput`, `packages/client/src/device-router.ts:2364`) — is
  reported through the client's global error channel; never drop it silently.
- **Bind the command only to the task that answers this create, checked by title** (decided on plan
  audit): when the created task replaces the pending tab, the launch command (and the agent identity
  record) attach to it only if its `title` equals exactly the title this client sent in `taskCreate`;
  otherwise both are discarded and the mismatch is reported through the global error channel. Reason:
  `findCreatedTask` takes the first task the workspace did not know
  (`components/workbench/terminal-layout.ts:676`) and `TaskCreate` has no request id, so a terminal
  created concurrently elsewhere (e.g. an agent running `coflux terminal new` in the same workspace)
  can take the pending slot — today that only misplaces a tab, with this plan it would type a command
  into someone else's terminal. The title is used as a correlation key for the create, not to infer
  which agent a tab is.
- **Tab identity is a local task id → agent id record** in `localStorage`, written when the created
  task replaces the pending tab, pruned when the task is gone (and against the task list at startup —
  only after the first task snapshot is in, the `snapshotReady` flag in `workbench.tsx`; pruning
  against an empty pre-login or offline list would wipe every record). The task's title is the agent's display name (sent through the existing
  `taskCreate`), so other clients see a sensibly named terminal. Rejected: inferring the agent from the
  title — titles are user-visible text and OSC can replace what the tab shows.
- **Tab icon precedence**: attaching/detached indicators first (unchanged); then, when presence
  detection reports an agent for the session, its state glyph (`AgentGlyph`,
  `components/workbench/workspace-terminal.tsx:56`); otherwise the recorded agent's brand logo;
  otherwise the terminal icon. Detection therefore overlays the brand identity while the process
  runs and the logo comes back when it exits — this layering is intentional. Inside `AgentGlyph`,
  Claude keeps `ClawdGlyph`; the Codex branch (currently the `Bot` fallback) uses the Codex logo with
  the same state tone classes.
- **Menu structure**: Astryx `DropdownMenuSubMenu` as the 「Agent」 row of the existing `NewTabMenu`
  (`components/workbench/workspace-terminal.tsx:204`), placed right below 「终端」. It provides hover
  open and →/←/Esc keyboard handling. Each agent item is disabled while a terminal create is pending
  (`busy`), like 「终端」 — `createTerminalIn` returns early when a create is in flight
  (`components/workbench/workbench.tsx:557`), so an enabled item would silently do nothing.
- **Settings section**: an entry in `SETTINGS_SECTIONS` (`components/settings/settings-nav.ts`) with a
  new `group` value of its own and a nav icon in `SECTION_ICONS`
  (`components/settings/settings-page.tsx`); rows built on the existing `SettingsGroup`
  (`components/settings/settings-group.tsx`) look; Astryx `Switch` and `TextInput`. Placing the
  group (after 「通用」 or after the runtime group) is the executor's call.
- **Logos are inline SVG React components** in the renderer; no new npm dependency and no remote
  image loading. They must read well in light and dark themes.

Left to the executor: SVG sources and colours, the exact timeout, `localStorage` keys and value
format, copy beyond the strings quoted above, module and component boundaries, and the Agents nav
icon.

## Direction

Renderer-only, plus at most a small export from `packages/client`. Three milestones; M2 and M3 both
need M1's catalog/store, and are otherwise independent (M2 is settings files, M3 is the workbench and
tab strip). Fanning out M2 ∥ M3 after M1 is safe; running all three in one package is fine too.

### Milestone 1: Agent catalog and local configuration store

A single module owns the four-agent catalog (with logo components) and the persisted per-agent
`{ enabled, command }` state, exposes the list of effective agents in catalog order, and notifies
subscribers on change. Corrupt or missing storage yields the all-off default without throwing.
Validation: `pnpm -C apps/desktop typecheck` → exit 0. If the effective-agent / parsing logic is a
pure function, a small `node --test` file next to it is appropriate (it guards the "on + empty is not
effective" and "garbage storage" rules, which would not show up as a visible failure); it must be
picked up by the existing `test` script globs in `apps/desktop/package.json`, which cover
`src/renderer/*.test.ts`, `components/settings/` and `components/workbench/` but **not**
`src/renderer/lib/` — a test placed there silently never runs. The node test runner resolves
`apps/desktop/tsconfig.json`, which has no `jsx` setting: keep the parsing/effective logic in a
plain `.ts` module and the logo components in a separate `.tsx`, and test only the former.

### Milestone 2: Settings 「Agents」 section

The section exists, is reachable from the left nav, and implements the settings conclusions above
(fixed order, switches off by default, empty command input with placeholder revealed on enable,
inline hint when on + empty, immediate save, command kept when switched off).
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0 (the existing
`settings-nav.test.ts` invariants must still hold).

### Milestone 3: 「Agent ▸」 in the new-tab menu, launch, and tab identity

The menu shows the flyout only when an agent is effective; choosing one creates a terminal titled with
the agent's name in that group, types the launch command exactly once per the timing decision, records
the tab's agent identity, and renders icons per the precedence decision; failures to deliver reach the
global error channel.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **Focus restore after the menu closes**: `NewTabMenu.changeOpen` re-focuses the active terminal on
  the next frame unless focus moved somewhere on purpose
  (`components/workbench/workspace-terminal.tsx`, `changeOpen`). Choosing an agent from the flyout
  must still leave the caret in the newly opened terminal, and Esc from the flyout must not strand
  focus on nothing.
- **The pending tab is not a task**: `createTerminalIn` creates a layout-only pending tab and the real
  task replaces it later via `findCreatedTask` / `replacePendingTab`
  (`components/workbench/terminal-layout.ts:676`); it is matched as "the first task the workspace did
  not already know". The launch command must be bound to the task that answers *this* pending tab,
  and a pending create that times out (`PENDING_CREATE_TIMEOUT_MS`, `workbench.tsx`) must discard its
  launch command too.
- **OSC titles override the tab title**: the tab shows the session's OSC title when it has one
  (`workspace-terminal.tsx`, `checkpointTitles`), and agent CLIs set one. The agent's display name is
  the task title and the fallback, not a forced label — do not suppress OSC titles.
- **OSC 133 marks are authenticated TOFU inside the pane** (`components/workbench/terminal-command-marks.ts`):
  the secret must never leave that closure. Expose "a prompt-start mark arrived" as an event, not the
  mark payload.
- **`sendInput` buffers before attach**: `deviceRouter.sendInput` retains input and flushes it after
  the attach completes (`packages/client/src/device-router.ts:2364`). Sending early therefore does
  not fail — it lands before the prompt. The timing decision exists to avoid exactly that.
- **A new settings section can render empty without a type error**: `SECTION_ICONS` is a
  `Record<SettingsSectionId, …>` so a missing icon fails typecheck, but the section bodies are a
  `section.id === "…" ? … : null` chain (`components/settings/settings-page.tsx`), so forgetting to
  wire the Agents body only renders its heading.
- **The worktree has no `node_modules`**: every validation command fails until `pnpm install` runs
  in the worktree (lockfile install, no new dependency). Establish the baseline — typecheck and test
  green with zero changes — before editing.
- **No native `title` tooltips** in the renderer; use the `Tooltip` component. Read
  `docs/design-guidelines.md` before touching UI. Clickable elements in the tab strip and top bar
  need the no-drag region style (`components/workbench/drag-region.ts`).

## Merge and deploy

- Desktop release only; no server deploy, no worker release, no migration. Older servers and daemons
  are unaffected.
- No automated gate exercises the menu, the settings rows, or the typed command. A real-machine
  walkthrough by the user is required (`pnpm dev:desktop:prod`, see the `desktop-preview` skill):
  enable each agent, launch it locally and in a remote workspace, check the command is typed once and
  not again after ⌘R, check 「Agent」 disappears with all agents off, and check logos in both themes.
- Release notes should mention the new Settings → Agents section and the 「Agent」 entry in ⌘T.

## Scope

In scope:
- `apps/desktop/src/renderer/**` (settings, workbench tab strip and new-tab menu, new agent modules and logo components)
- `packages/client/src/store.ts` — only to expose a minimal holder/error helper if needed

Out of scope:
- `proto/**`, `crates/**`, `apps/server/**`, `packages/cli/**`, `integrations/**` — the decision is desktop-only
- Agent presence detection for Cursor/Grok (`crates/worker/src/agents.rs`) — non-goal
- `apps/desktop/src/main/**`, `apps/desktop/src/preload/**` — storage is renderer-local

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Client typecheck (only if `packages/client` changed) | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` | user-verified, per Merge and deploy |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Settings → Agents shows the four agents in order, all off by default; enabling reveals an empty
      command input with the default as placeholder; on + empty shows 「填写启动命令后生效」.
- [ ] The new-tab menu has no 「Agent」 item unless an agent is effective, and then lists only the
      effective agents in catalog order with logos.
- [ ] Choosing an agent opens a terminal titled with its display name and types its configured
      command (never the placeholder) exactly once; reload/reconnect never retypes it; a failed send
      produces a visible error.
- [ ] A task that takes the pending slot with a title other than the one sent never receives the
      launch command or the agent identity.
- [ ] The Agents section body is actually rendered (not just its heading).
- [ ] Tab icons follow the precedence decision; Codex detection uses the Codex logo.
- [ ] No proto/server/daemon files changed; no new npm dependency.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. `TaskCreate` gained a command field,
  or the worker no longer refuses agent input under a human holder).
- Typing the command reliably turns out to need a daemon or protocol change.
- Astryx `DropdownMenuSubMenu` cannot be used inside the existing `DropdownMenu` button-anchored menu.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Plan audit (fable) found no blocker; verified the holder refusal, `DropdownMenuSubMenu` inside the
  button-anchored menu (leaf clicks close the root and go through the existing focus restore; Esc in
  the flyout closes only that level), and the icon precedence. Its findings were folded in above.
  Noted, not adopted: `DeviceSessionAttached.snapshot_seq === 0` would tell the pane that the first
  mark will arrive live, but reading it means changing `device-router.ts` — a possible follow-up to
  cut the ~1 s latency.

- Adding an agent means one catalog entry plus a logo; detection for it is a separate worker change.
- If the desktop ever needs agents to follow the account, move the store behind the executor-settings
  path; the catalog stays the same.
