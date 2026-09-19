# Plan 20260919-terminal-paper-overlay: The agent conversation as a page you can copy from

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 94e590c5..HEAD -- proto/ crates/worker/src/hook.rs crates/worker/src/main.rs crates/worker/src/observed.rs crates/worker/src/ops.rs crates/cli/src/commands.rs packages/client/src/store.ts packages/protocol/ apps/server/src/hub.ts apps/server/src/config.ts apps/desktop/src/renderer/components/workbench/`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — reviewed 2026-09-19; findings folded in (see Maintenance notes)
- Workspace: isolated — cut `dev/20260919-terminal-paper-overlay` at `.claude/worktrees/20260919-terminal-paper-overlay` from the main worktree
- Planned at: `94e590c5`, 2026-09-19

## Requirement

Copying an agent's prose out of a coflux terminal yields text broken by hard
newlines. Claude Code and Codex render through Ink, which wraps text to the
terminal width **itself** and emits a real newline plus an indent prefix on
every visual line. Pasting that anywhere means re-flowing it by hand.

This is not a terminal bug and there is no terminal-side fix. xterm's selection
already handles soft wrapping correctly — `get selectionText` walks the lines
and appends a wrapped line to the previous one without inserting `\n` (verified
in the installed `@xterm/xterm@6.1.0-beta.304` bundle). Every newline that
survives a copy is one the application really emitted, which is why iTerm2,
Terminal.app and Ghostty behave identically. The only source of unwrapped prose
is the agent's own transcript.

**What this builds.** A small button in the terminal's top-right corner. Clicking
it expands a "paper" overlay from the button's centre (clip-path circle) until it
covers the terminal. The paper carries the whole conversation of the agent
session running in *that* terminal — the user's prompts and the agent's prose —
in chronological order, as one document. Any part of it can be selected and
copied; scrolling up is how you reach older material. Clicking the button again
or pressing Esc collapses it the same way. The terminal keeps running underneath
the whole time; the overlay only covers it.

**Product conclusions settled with the user — do not reopen:**

- **Motion.** Expand in 200–260ms, ease-out (fast start, slow settle). Collapse
  in roughly 160ms — one notch faster. Rationale: this animation is seen dozens
  of times a day; past ~300ms it reads as waiting rather than as delight.
- **Paper surface.** Background is a theme-following paper colour — a notch
  lighter than the terminal under the dark theme, **never pure white** (pure
  white flares at night and the desktop ships both light and dark themes). The
  typeface switches from Maple Mono CN to the system UI stack; **no new font
  files** — the desktop already inlines its only bundled family. The measure
  narrows to a single readable column. These three together carry "this is paper,
  not a terminal"; the effect must not rely on a harsh white.
- **Content.** Markdown **source**, shown verbatim and **not rendered**. This is
  what makes a selection paste back as the author's original text, and it keeps
  the dependency count at zero (the repository currently has no markdown, marked
  or remark dependency). The user's own prompts carry a light marker so they work
  as anchors while scrolling. Tool calls collapse to a single dim line (e.g.
  `⏺ Bash(git status)`) — kept purely as landmarks, never expanded.
- **Freshness.** Opening takes one snapshot and lands scrolled to the bottom
  (newest). No live following.
- **Reach.** Claude and Codex; local and remote devices alike.
- **Not in this build.** Search, per-entry copy buttons, Markdown rendering, tool
  call details, live following.

**Observable when done.** In a terminal running Claude, click the top-right
button; the paper expands; select a paragraph and paste it elsewhere — it arrives
as continuous prose with no hard newlines and no indent prefix; Esc collapses it
and the terminal is still live underneath — in particular the agent's turn is
**not** interrupted by that Esc.

## Decisions & tradeoffs

- **Source of truth is the agent's transcript file, not the terminal scrollback.**
  Rejected: un-wrapping the scrollback heuristically. Measurement killed the
  obvious rule — in a 129-column terminal the continuation lines of a wrapped
  paragraph measured 88, 85 and 65 columns wide, nowhere near the right edge,
  because Ink breaks on word boundaries and a long unbreakable token (a
  `node_modules/.pnpm/...` path) forces an early break. A sounder rule does exist
  ("would the next line's first word have fit?" — it classified every sampled
  line correctly and leaves short code lines alone), but it is still a heuristic,
  it cannot recover Markdown structure, and it silently corrupts box-drawing
  content. The transcript has the author's original text with no inference at all.

- **No new protocol request; the body travels over the existing exec channel.**
  The desktop reads the transcript with `client.execInWorkspace(workspaceId,
  command, args)`, which already routes to whichever device owns the workspace —
  local and remote are the same path, with no branch in our code.
  Based on: `packages/client/src/store.ts:1102` (the method, which delegates to
  `deviceRouter.exec`) and `apps/desktop/src/renderer/components/workbench/changes-view.tsx:29`
  (the changes view runs `git` this way today).

- **One new proto field, but four hand-written touch points on its path.** The
  field is `agent_session_id` on `SessionAgentRef`, **tag 7** — the message
  already has six fields, ending at `progress = 6`. The wire addition is one line;
  what makes this a real milestone is that nothing on the path is generic. All
  four must be updated or the field is silently dropped, with no type error to
  warn you:
  1. `apps/server/src/hub.ts:1763` — the server rebuilds each entry field by field
     (`valid.push({ sessionId, taskId, agent, state, message, progress })`).
  2. `apps/server/src/hub.ts:1767-1777` — the `unchanged` short-circuit compares
     the same six fields one by one. Miss it and a change that alters *only* the
     id (Claude `/clear` starts a new session while the state stays put) never
     re-broadcasts.
  3. `packages/client/src/store.ts:899-906` — the client maps the entry field by
     field again into `SessionAgentState`.
  4. `packages/client/src/store.ts:158-230` — `sessionAgents` is persisted into
     the catalog, so entries restored on a cold start predate the new field. The
     TS type will claim `string` while the value is `undefined`; treat a missing
     id as "no id" everywhere rather than trusting the type.
  Rejected: having the hook report an absolute transcript path — the file is
  *named* after the session id, so shipping a path would weld the agent's private
  directory layout into our wire protocol for no gain.
  Based on: `proto/coflux/v1/common.proto:105-121` (the six existing fields;
  `task_id` is the terminal), `proto/coflux/v1/client.proto:247-251`
  (`SessionAgentsUpdated` broadcasts the device's full set, re-sent per device on
  subscribe), `crates/cli/src/commands.rs:752-759` (the CLI already sends
  `agentSessionId` — Claude's `session_id`, Codex's `thread-id`),
  `crates/worker/src/hook.rs:52-64` (`HookRequest` has no such field, so the
  worker silently drops it today), and
  `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:115,419`
  (the desktop already reads `state.sessionAgents`, keyed by `task.sessionId`).
  *(revised on advisor review — the original entry claimed the field would arrive
  with no other work, and cited tag 6.)*

- **The session id never enters a command string; it is passed as an argument.**
  The daemon's exec runs `Command::new(command).args(args)` with **no shell**
  (`crates/worker/src/ops.rs:34-35`), so nothing is interpreted on that side. The
  desktop will nevertheless need a shell, because locating the transcript requires
  `~`/`$HOME` expansion and globbing that the daemon does not provide (`fs.read`
  is anchored to the workspace root by `safe_resolve`, `crates/worker/src/ops.rs:96-115`,
  and cannot reach `~/.claude`). The rule is therefore positional, not lexical:
  the script text is a **fixed literal** that references `"$1"`, and the id is
  passed as a separate argv entry — `sh -c '<fixed script using "$1">' sh <id>`.
  String interpolation of the id into script text is forbidden outright, in every
  call site, whatever validation ran earlier. A conservative character-set and
  length check is the **second** line of defence, applied at the worker before the
  id is broadcast and again in the desktop before use; it is not the first, and a
  future call site that forgets it must still be safe.
  Rejected: relying on validation or quoting alone — one forgetful call site
  reopens the hole, and the id crosses three processes before it gets there.
  *(revised on advisor review — the original entry assumed the daemon side ran a
  shell and made the character-set check the primary defence.)*

- **Rejecting a malformed id must not reject the hook event.** The CLI forwards
  the agent's raw JSON value (`crates/cli/src/commands.rs:758`, `session.clone()`),
  which is not guaranteed to be a string. If the worker's hook body types the new
  field such that a non-string makes the whole body fail to deserialize, the
  request 400s and **the presence event is lost** — the agent's activity state
  stops updating, a far worse outcome than a missing button. Parse the field
  leniently and independently: anything that is not a well-formed id yields "no
  id" while the event itself is processed normally.
  Based on: `crates/worker/src/hook.rs:104-117` (the hook body shape).
  *(revised on advisor review)*

- **The id lives like `progress`, not like `message`.** `apply_hook_state` clears
  `hook_messages` on every event (`crates/worker/src/observed.rs:93-97`), while
  `hook_progress` deliberately survives across events and is pruned with its entry
  (`crates/worker/src/observed.rs:262-293`). The session id belongs to the second
  group: it identifies the session, so it must not evaporate when the agent
  changes turn state.
  *(decided while planning, confirmed on advisor review)*

- **Recording the id must not depend on the event being state-bearing.**
  `consume_hook_events` returns early for events that carry no turn state — such
  as `SessionStart` — before the pid lookup (`crates/worker/src/main.rs:466-473`).
  If the id is only captured after that point, the button cannot appear until the
  first `UserPromptSubmit`, even though the transcript exists from `SessionStart`
  onward. Capture the id for any event that carries one, without letting such an
  event alter the presence state.
  *(decided while planning)*

- **JSONL parsing lives in the renderer, not in the daemon.** The daemon returns
  file bytes and nothing else; the record structure is interpreted by desktop TS.
  Rejected: parsing on the daemon and returning a structured result — these are
  private formats belonging to other vendors and they change; teaching the daemon
  about them welds a volatile format into our protocol and forces a daemon
  release whenever a vendor shifts a field. In the renderer, a format change is
  one patch in one place.
  Based on: `crates/worker/src/ops.rs:62` (exec already does nothing but
  `String::from_utf8_lossy` over stdout — it never interprets content).

- **Read a bounded tail of the file, never the whole file.** Transcripts grow
  without bound — one on the planning machine already measured 978KB — and
  nothing on the path truncates: the daemon converts all of stdout, and the
  server's frame ceiling is a hard 30MB wall. Reading the tail keeps a long
  session from walking into that wall, off the wire, and out of the parser.
  Take roughly 512KB (a measured 400KB tail still yielded dozens of messages) and
  state the loss on the page: the paper's top carries a line saying earlier
  content was truncated. The exact byte count is the executor's call; the bound
  and the visible notice are not.
  Rejected: reading the whole file and trusting the 30MB ceiling — it converts a
  gradual degradation into a cliff that only the heaviest users hit.
  Based on: `apps/server/src/config.ts:109` (`maxPayload` defaults to 30MB) and
  `crates/worker/src/ops.rs:62` (no truncation on the daemon side).
  *Correction carried from exploration: an earlier claim that
  `apps/desktop/src/main/ipc-sanitize.ts` gates this path was wrong — that gate is
  on main↔renderer IPC, while `execInWorkspace` goes over the WebSocket. The
  decision stands; only its justification changed.*

- **The overlay is a renderer component layered over the terminal, never inside
  xterm — and it must take the keyboard while open.** The in-terminal floating
  layer pattern already exists and should be followed. But Esc is not a ⌘
  combination, so the terminal's key handler claims it and writes it to the PTY
  (`apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:269`,
  `decideTerminalKeyOwner` → `return true`). An Esc that reaches Claude Code
  interrupts its turn. The overlay must hold focus while open and intercept Esc
  during the capture phase, so closing the paper never touches the agent.
  Based on: `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:269`
  (the handler) and `:891` (the ⌘F floating layer to follow).
  *(revised on advisor review — the Esc/PTY conflict was missing entirely.)*

- **The button appears only for terminals that actually have an agent.** It
  renders when the terminal has a `sessionAgents` entry naming an agent **and** a
  usable id, and is absent otherwise — a dim, permanently disabled control in the
  corner of every plain shell is noise. The empty state belongs one level in: the
  button is present but the transcript cannot be read or parses to nothing, and
  the paper says so instead of opening blank. That empty state must distinguish
  "no file found" from "read failed" — the daemon runs as a launchd service whose
  environment differs from an interactive shell, so a miss is not self-explanatory.
  Based on: `proto/coflux/v1/common.proto:108-109` (sessions with no agent never
  appear in the roster at all). *(decided while planning)*

- **Codex support degrades rather than blocks.** Whether Codex's hook payload
  actually carries `thread-id` is a **named assumption** — the CLI reads that key
  (`crates/cli/src/commands.rs:756`) and the integration registers Codex hooks
  under Claude's event names (`crates/cli/src/integration.rs:130-143`), but no one
  has confirmed the field against a live Codex run. If it turns out absent, Codex
  terminals simply get no button; finish and report the Claude side rather than
  treating it as a blocker.
  *(decided while planning)*

## Direction

The chain is short and already mostly built: the hook messenger reports an agent
session id that the worker throws away; restore it, carry it along the presence
message that already reaches the desktop, and let the desktop fetch and parse the
file over the exec channel that already crosses devices. What is *not* short is
the number of hand-written field lists on that path — see the four touch points
under Decisions.

**Milestones are strictly sequential — do not fan out.** Each one needs the
previous one's output: M2 cannot fetch without the id from M1, and M3 renders the
shape M2 produces.

### Milestone 1: the agent session id reaches the desktop store

`SessionAgentRef` carries the agent's own session id as tag 7, constrained at the
worker as decided above, and it arrives in the desktop's `sessionAgents` state
alongside the existing `state` and `message`. All four hand-written touch points
are updated. Malformed ids are dropped without dropping their hook event. The
generated artifacts for all three protocol targets are regenerated and committed
in step. The CLI is not touched — it already sends the field.

Validation: `cargo build` -> exit 0 with zero warnings;
`COFLUX_HOME= cargo test -p coflux-worker` -> exit 0;
`node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` -> exit 0;
`pnpm -C apps/desktop typecheck` -> exit 0;
`cd proto && buf generate` followed by `git status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` -> empty output.

### Milestone 2: transcript bytes become a conversation

Given an agent name, a validated agent session id and a workspace, the desktop
locates the transcript on the owning device, reads a bounded tail, and parses it
into an ordered conversation of user prompts, agent prose and collapsed tool-call
landmarks, with a flag for whether the head was truncated. Both Claude's
`~/.claude/projects/*/<session-id>.jsonl` and Codex's date-partitioned
`~/.codex/sessions/<y>/<m>/<d>/rollout-*-<thread-id>.jsonl` are handled. The
parser is a pure function over file text, unit-tested against fixtures of both
formats that include the misclassification traps listed under Landmines.

Validation: `pnpm -C apps/desktop test` -> exit 0, with new tests covering both
formats and the tool_result / isMeta / sidechain / injected-block / unknown-record
traps; `pnpm -C apps/desktop typecheck` -> exit 0.

### Milestone 3: the paper

The button, the expand/collapse motion, the paper surface and the document
itself, per the product conclusions in Requirement. Esc and a second click both
collapse, and Esc never reaches the PTY. The terminal keeps running underneath.
The empty, truncated and read-failed states are visible and distinct.

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` -> exit 0.

## Landmines

- **Three generated protocol targets, not two.** `proto/buf.gen.yaml` runs TS,
  Rust **and** Swift plugins, and CI re-runs `buf generate` then fails if any of
  the three output directories differs from the repository
  (`.github/workflows/ci.yml:115-124`). The Swift generated directory is therefore
  in scope even though no Swift source is being written.
- **`contract.test.mjs` does not cover this.** `grep sessionAgents tests/src/*.mjs`
  returns nothing — the black-box suite covers the exec/fs contract only. The real
  gate for this change is the `buf generate` consistency check above. (An earlier
  draft of this plan claimed otherwise.)
- **`check-protocol-breaking` must be given its baseline argument** or it does not
  check what you think it checks.
- **clippy is not a gate in this repository** — CI does not run it and the
  baseline already carries 23 errors. Do not spend effort making it quiet.
- **Esc reaches the PTY unless the overlay stops it** — see the Decisions entry;
  a leaked Esc interrupts the agent's turn, which is worse than the overlay
  failing to close.
- **Claude's `user` records are mostly not the user.** In a sampled tail, 19 of 21
  `user` records were `tool_result` payloads. In another, 85 of 93 were
  `tool_result`, 5 carried `isMeta: true`, and 2 were `<command-name>` slash-command
  records. None of those are prompts.
- **Exclude `isSidechain: true` records** — those belong to subagents and would
  interleave a different conversation into the page.
- **`type` is not limited to `assistant` and `user`.** A real file also carries
  `last-prompt`, `ai-title`, `mode`, `permission-mode`, `atis-latch`, `attachment`,
  `system`, `cost-state`, `continued-in` and `file-history-snapshot`. Parse by
  allow-list and ignore the rest.
- **Codex `role: "user"` messages carry injected blocks.** Observed payloads begin
  with `<recommended_plugins>`, `<user_instructions>` or `<environment_context>`
  — system injection, not the person typing. Filter by that leading-tag shape.
- **Codex rollout shape varies by originator** (`Codex Desktop`, `codex_cli_rs`,
  `codex_exec` all present on the planning machine). There is no `user_message`
  in `event_msg`; user prompts live only in
  `response_item.payload{type:"message",role:"user"}`. `phase: "final_answer"`
  appears in roughly half the local rollout files, so it is a useful marker but
  not a guaranteed one. Fixtures must include at least the TUI shape.
- **Codex rollouts are date-partitioned**, so finding one by thread id means
  searching `~/.codex/sessions/<year>/<month>/<day>/`, not globbing one directory.
- **A tail read starts mid-line.** The first line of the window is almost always a
  truncated JSON fragment — discard it rather than letting a parse error abort the
  whole page.
- **Claude's project directory contains a same-named subdirectory**
  `<session-id>/subagents/`. A single-level glob is safe; a recursive `find -name`
  will match inside it.
- **`tail -c N` over more than one file prints `==> file <==` headers.** The same
  id can exist under two project directories; count the matches and handle the
  ambiguity rather than parsing a header as JSON.
- **`CLAUDE_CONFIG_DIR` and `CODEX_HOME` can relocate both directories** (unset on
  the planning machine), and the daemon runs as a launchd service whose environment
  is not an interactive shell's. Honour those variables and keep "not found"
  distinguishable from "read failed".
- **Desktop tests only match `*.test.ts`** (`apps/desktop/package.json:13`), so a
  parser test file must not be `.tsx`.
- **Presence-related Rust tests go red on this machine for environmental reasons.**
  When coflux itself is running, the agent-activity presence/hook tests fail and
  can hang the whole run. Clearing the variable fixes it: run Rust tests as
  `COFLUX_HOME= cargo test -p <crate>`. This plan touches exactly that code, so
  the trap is live here — do not read those failures as a regression.
- **The black-box suite hard-codes its ports**, so two runs on one machine collide
  and fail as timeouts that look like code bugs. Check that no other session is
  running it, and that local Postgres is up (`pnpm dev:pg`).
- **Desktop UI conventions**: read `docs/design-guidelines.md` first. Hover hints
  use the `Tooltip` component — native `title` is prohibited.
- **The ⌘F search box already occupies `absolute right-4 top-2`** in the terminal
  pane. The new button shares that corner and must not collide with it when a
  search is open.
- **Terminals on a device running an older worker never get a button**, because
  the field is not sent. That is correct behaviour, but it looks like a bug during
  a walkthrough — see Commands for what a walkthrough actually requires.

## Scope

In scope:
- `proto/coflux/v1/common.proto`
- `crates/protocol/src/gen/`, `packages/protocol/src/gen/`, and
  `packages/swift-client/Sources/CofluxProtocol/Generated/` — all three are
  regenerated by `buf generate` and checked by CI
- `crates/worker/src/hook.rs`, and the presence path it feeds
  (`crates/worker/src/main.rs`, `crates/worker/src/observed.rs`)
- `apps/server/src/hub.ts` (the entry projection and the `unchanged` comparison)
- `packages/client/src/store.ts` (the entry mapping and the catalog restore)
- `apps/desktop/src/renderer/components/workbench/` (new overlay and parser
  modules, plus `terminal-pane.tsx`)

Out of scope:
- `crates/cli/` — it already sends `agentSessionId`; nothing to change
- Hand-written Swift sources under `packages/swift-client/` — only the generated
  directory is touched, and no iOS feature work belongs to this plan
- `lastOutput()` in `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:445-453`
  — a real, adjacent bug (it joins lines with `"\n"` without consulting
  `isWrapped`, so "copy the last command's output" hard-splits soft-wrapped long
  lines), but independent of this requirement
- Markdown rendering, search, per-entry copy buttons, live following

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Protocol artifacts | `cd proto && buf generate`, then `git status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | empty output |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Wire contract (acceptance) | `pnpm -C tests test` | exit 0 — needs local Postgres (`pnpm dev:pg`) and exclusive ports |
| Desktop walkthrough (acceptance) | Local stack only: `pnpm dev:pg`, `pnpm dev:server`, `pnpm dev:daemon` (this branch's `cargo build` output), `pnpm -C apps/desktop dev` | by hand, by the user |

**The walkthrough cannot use `pnpm dev:desktop:prod`.** That points at the
production server and the installed daemon, neither of which carries the new
field, so the button would never appear and the feature would look broken. Both
halves of the chain must be this branch's build. Remote-device behaviour is not
walkable at all until the worker ships and each device runs `cofluxd update`;
that part is verified by code review, not by hand.

## Done criteria

- [ ] All listed commands pass, including the `buf generate` consistency check over all three generated directories.
- [ ] In a terminal running an agent, the top-right button expands a paper overlay covering the terminal, and Esc or a second click collapses it.
- [ ] Pressing Esc to close the paper does not reach the PTY — the agent's turn continues uninterrupted.
- [ ] Text selected on the paper and pasted elsewhere arrives as continuous prose — no hard newlines, no indent prefixes.
- [ ] The paper shows the user's prompts and the agent's prose in order, with tool calls as single dim landmark lines, and lands scrolled to the newest.
- [ ] Run against a real transcript tail from this machine, the parser emits **no** entry that is neither a human prompt nor agent prose — specifically none derived from `tool_result`, `isMeta`, `<command-name>`, `isSidechain`, or a Codex `<recommended_plugins>`-style injected block. A parser that only allow-lists `type` does not satisfy this.
- [ ] A truncated head is stated on the page; "no transcript found" and "read failed" are distinguishable states, and neither renders a blank page.
- [ ] Terminals with no agent, and entries restored from an older catalog without the new field, show no button and raise no error.
- [ ] A malformed or missing agent session id is rejected **without** dropping the hook event that carried it: presence state still updates.
- [ ] The session id is never interpolated into command text anywhere — every call site passes it as a separate argv entry.
- [ ] The fetch path calls `execInWorkspace` with no local/remote branching and no `daemonId` inspection.
- [ ] Required tests exist and assert meaningful behavior.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false — except the Codex `thread-id` assumption, whose
  documented fallback is to ship the Claude side and report.
- The argv-only rule for the session id cannot be satisfied and interpolation
  looks necessary — the injection surface is not negotiable; stop and report.

## Maintenance notes

- **Reversed after the walkthrough (2026-09-19): Markdown is now rendered.** The
  decision above to show Markdown *source* verbatim — taken so that a copy gave
  back the author's exact text — was overturned by the user once they saw the
  page. Rendered headings, lists and code blocks read far better, and the
  original pain point (Ink's hard newlines and indent prefixes) is solved either
  way; what is lost is the `**`/`#` markers when pasting back into a Markdown
  document. The same pass laid the page out as a conversation (the user's prompts
  in bubbles, agent prose plain) and rewrote every user-facing string: the
  original ones leaked this plan's own metaphor ("纸面", "把这段对话摊成一页")
  and implementation detail (`CLAUDE_CONFIG_DIR`, "daemon 以后台服务运行") into
  the product. **Lesson for future plans: prose written to explain a design to an
  implementer is not product copy, and an executor will ship it as if it were.**
  Name the UI strings explicitly, or say that they are yet to be written.
- **Advisor review (2026-09-19) changed three things**, all folded in above: the
  walkthrough command was wrong (`pnpm dev:desktop:prod` cannot show this feature);
  "one new field, no other work" understated the four hand-written field lists on
  the path and cited the wrong tag; and the injection argument rested on the
  daemon running a shell, which it does not — the rule is now argv-positional
  rather than validation-first. It also supplied most of the Codex and Claude
  record-shape landmines. One advisor observation was deliberately left out: that
  the terminal pane's top-right corner is probably not inside a window drag region
  (the existing ⌘F box needs no `no-drag`). It was labelled as inference, and if
  it turns out wrong the design guidelines already cover the fix.
- **Known cosmetic inconsistency, left as built.** The session-id character check
  is slightly stricter downstream than upstream: the worker
  (`crates/worker/src/hook.rs`, `sanitize_agent_session_id`) accepts an id whose
  first byte is `-` or `_`, while the server (`apps/server/src/hub.ts`,
  `validAgentSessionId`) and the desktop (`terminal-transcript.ts`,
  `isUsableAgentSessionId`) both require the first character to be alphanumeric.
  The comment on the server helper claims parity with the worker; it is in fact
  narrower. This is safe — the stricter side is downstream, so nothing the worker
  rejects can slip through, and the effect of the gap is only that such an id
  silently yields no button. It is also unreachable in practice (Claude ships a
  UUID, Codex a ULID-ish string). Tighten the worker's first-byte rule, or fix the
  comment, whenever that file is next touched.
- The transcript formats belong to Claude Code and Codex and will change without
  notice. The parser is deliberately renderer-side and allow-list driven so that a
  vendor change is a single front-end patch; resist any later proposal to move
  parsing into the daemon or the protocol.
- The `lastOutput()` `isWrapped` bug noted under Out of scope is still open and
  worth its own small plan.
- If someone later wants unwrapping for plain (non-agent) shell output, the
  measured finding is that line width alone does not work; the viable rule is
  "would the next line's first word have fit in the remaining columns?", with a
  companion rule for whether to reinsert the space the wrap consumed (reinsert
  when the previous line stopped short of the right edge, which means the break
  fell on a space; do not when it ran to the edge, which means a CJK hard break).
