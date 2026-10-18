# Plan 20261018-worktree-guard-managed-only: the worktree guard denies only worktrees coflux actually manages

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ce733f45..HEAD -- crates/cli/src integrations/claude-plugin crates/runtime/src/agent_ctl.rs crates/runtime/src/workspace_match.rs crates/runtime/src/worktree_locate.rs`

## Status

- Priority: P1
- Effort: M
- Risk: MED — the plugin's messenger hook runs on every tool call, so the guard sits on a hot, user-visible path
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure check (2026-10-18)
- Stop after: implementation — departure check (plan audit chosen)
- Plan review: audit — departure check
- Workspace: isolated — cut from the main worktree into `.claude/worktrees/20261018-worktree-guard-managed-only`, branch `dev/20261018-worktree-guard-managed-only`
- Planned at: `ce733f45`, 2026-10-18

## Record

### Requirement

Inside a Coflux terminal, Claude Code's `PreToolUse` hook denies every Bash command that textually matches
`git [global options] worktree remove|move` as soon as `COFLUX_PROJECT_ID` is set, with the reason "Use coflux
workspace list and coflux workspace remove <workspaceId> to remove a managed worktree and its sidebar record…".
It never checks whether the targeted worktree is one coflux keeps a record for. The guard exists for exactly one
reason: removing a coflux-registered worktree by hand leaves an orphan workspace record in the sidebar. A
worktree coflux has no record of cannot orphan anything, yet it is blocked all the same — and that is most of
them. On the maintainer's machine this repository has 25 git worktrees and only 3 coflux records (the main
checkout, `.claude/worktrees/20261017-screen-display-recovery`, `.claude/worktrees/20261018-pi-1-3-codemode`),
so `git:clean` and `dev:execute-plan`'s worktree cleanup are refused for the other 22, frequently. (A fourth
record appeared when this plan's own worktree was registered on entry.)

Done means: a `git worktree remove|move` whose target resolves to a worktree root that is a registered coflux
workspace on this device is still denied, with a reason naming that workspace; every other such command passes
through untouched; and when the guard cannot tell, it stays silent. One implementation serves both ways the
guard is loaded (the device's integration bundle and the marketplace plugin).

Not perceptible as a product change: the guard's intended contract was always "managed worktrees only"; this
restores it. No product confirmation was needed.

### Decisions & tradeoffs

- **D1 Predicate**: deny only when the targeted worktree's root is *exactly* (after canonicalization) the path
  of a registered workspace on this device, in any project. The gate is being inside a coflux session
  (`COFLUX_SESSION_ID` set) with the `claude` host, a `PreToolUse` event and the `Bash` tool; the
  `COFLUX_PROJECT_ID` requirement is dropped. Rejected: keeping the project gate — it is not a membership
  check, and a session opened in a directory workspace (no project) can orphan a record just the same.
  Rejected: prefix containment — a worktree nested under the main checkout (`.claude/worktrees/*`) would count
  as the main workspace and be denied.
  Based on: `crates/cli/src/integration.rs:317-339` (current gate and regex);
  `crates/runtime/src/worktree_locate.rs` `workspace_at_root` (equality, not prefix, is how the daemon itself
  decides "this root is a workspace").
- **D2 Authority**: ask the daemon through the existing read-only local action `workspace.current`, sending the
  target root as the request's `cwd`; the target is registered iff the response's `path` canonicalizes equal to
  the canonical target root. The daemon resolves `cwd` by longest component-prefix match over the device's whole
  workspace table and falls back to the terminal's owning workspace, so a registered root comes back as itself
  and anything else comes back as some other path. Rejected: `workspace.locate` — it registers unknown worktrees
  and moves terminal ownership (side effects). Rejected: account `coflux workspace list` — a center round trip
  for a question the device answers locally (local-first principle), and it needs an account login headless
  devices may not have. Rejected: a new `workspace.lookup` action — a runtime release and version skew for no
  capability `workspace.current` lacks.
  Based on: `crates/runtime/src/agent_ctl.rs:515` (`WorkspaceCurrent` response: `workspaceId`, `ref`, `path`,
  `owningWorkspaceId`, …), `agent_ctl.rs:882` `resolve_scope`, `crates/runtime/src/workspace_match.rs`
  `workspace_for_cwd`, workspace table filled from the center's `WorkspaceList` at `crates/runtime/src/main.rs:1942`.
- **D3 Target resolution mirrors git**: for each `git … worktree remove|move` occurrence, the worktree argument
  (for `move`, the source) is resolved the way git's `find_worktree` does — first a unique match of the argument
  as a path-component suffix of an entry in `git worktree list --porcelain`, then an exact canonical match of
  the argument resolved against the command's base directory. Only roots that git lists are ever sent to the
  daemon. The base directory is the hook payload's `cwd`, updated by `-C` options in order and by a literal
  `cd <path>` earlier in the same command line. Rejected: plain path resolution only — `git worktree remove
  <name>` relies on suffix matching and would slip through. Rejected: the old whole-text regex — it also fires
  on quoted text (commit messages, `echo`), the backlog noted in plan 099.
  Based on: git `worktree.c` `find_worktree` (suffix first, then realpath); `git:clean` and `dev:execute-plan`
  issue plain `git worktree remove <path>`.
- **D4 Fail open on uncertainty**: anything the guard cannot resolve with certainty yields no opinion — a
  non-literal argument (shell variables, command substitution, globs, `~user`), a relative argument after a
  non-literal `cd`/`pushd`/`popd`, a `git worktree list` failure or timeout, the daemon unreachable, refusing, or
  answering with a missing or empty `path`, an owning workspace the daemon does not know, the guard's own time
  budget running out. Accepted cost: a managed worktree removed in a
  form the guard cannot read leaves an orphan record, exactly as `rm -rf` on it does today.
  Based on: the hook contract in `integrations/claude-plugin/scripts/guard-git-worktree.mjs:11-15` ("every
  anomaly must be no opinion; never block by mistake").
- **D5 One implementation, in the Rust CLI**: the guard is one function in `crates/cli` called from both entry
  points — `coflux agent hook claude` (the integration bundle, `integration::hook`) and `coflux hook claude`
  (the plugin's existing matcher-free `PreToolUse` messenger, `commands::run_hook`). The plugin's
  `scripts/guard-git-worktree.mjs` and its `hooks.json` entry are deleted; the plugin version is bumped.
  Rejected: fixing the JS copy too — two parsers already drifted (the Rust regex lacks the JS
  `(?!worktree\b)` lookahead). Inside a Coflux terminal `coflux` on `PATH` is the native binary (the bundle
  directory first, then `~/.coflux/bin/coflux`, a Mach-O executable), so the plugin path reaches the Rust guard.
  Based on: `which -a coflux` in a Coflux terminal; `crates/cli/src/main.rs:146` (`agent`) and `:170` (`hook`).

### Discussion log

- Departure check — Direction ("deny only when the target resolves exactly to a registered coflux workspace on
  this device, via the daemon's read-only `workspace.current`; allow whenever unsure; one Rust implementation
  for bundle and plugin, JS guard deleted"): **Approve**. Execution: **Subagent (opus)** (recommended).
  Autopilot: **Plan audit** (recommended).
- Literal `cd <path>` earlier in the command updates the base directory rather than forcing "no opinion": it is
  the most common agent form (`cd /repo && git worktree remove …`) `(decided while planning)`.
- Suffix-then-path order copied from git; comparisons are exact (case-sensitive) — a case-only mismatch git
  would still accept on a case-insensitive filesystem falls to "no opinion" `(decided while planning)`.
- When the matched workspace is the terminal's own owning workspace, the reason says so: `coflux workspace
  remove` would close this very terminal `(decided while planning)`.
- The Node `coflux hook` (`packages/cli/coflux.mjs`) gets no guard: in Coflux terminals the native binary wins
  on `PATH` `(decided while planning)`.
- Plan audit (fable) confirmed D2 (resolution over the whole device table; owning workspace unknown → 409 → no
  opinion) and D3 (suffix then realpath, checked against git 2.55), and changed: `-C` is folded into the base and
  never forwarded; an empty `path` means no opinion; the time budget is required (stop at the first registered
  root, ≤ 4 s across daemon calls, bounded `git` child) instead of optional; `cd -…` options and a closing `)`
  make the base unknown; T5's stdout invariant is scoped to `PreToolUse` and `run_hook`'s doc comment is
  rewritten; `Cargo.lock` is in scope; the worktree-isolation Bash guard is a landmine; an ambiguous-suffix
  acceptance case was added `(revised on plan audit)`.
- The audit verified that the case-only mismatch is live on macOS (git matches suffixes case-insensitively
  under `core.ignorecase`); kept as an accepted fail-open `(revised on plan audit)`.

### Maintenance notes

- Heredoc bodies are lexed as ordinary command lines, so a heredoc line that spells out a guarded command naming
  a *registered* worktree is still denied. Real collisions need a registered path in the text; accepted.
- A nested shell (`sh -c '…'`, `bash -c`, `eval`) is one quoted word to the guard and is never inspected.
- A case-only variant of a registered worktree's name is accepted by git on macOS (`core.ignorecase`) but not
  matched by the guard: fail-open, verified on plan audit.
- An unquoted `echo` of a guarded command naming a registered worktree is denied, because `git` counts at any
  word position. Accepted, like the heredoc case.
- The hook payload's `cwd` can lag a directory change the Bash tool persisted; in practice this fails open.
- The guard's verdict depends on the daemon's workspace table, which mirrors the center's records for this
  device; a record the daemon has not yet synced (seconds after registration) is not denied.
- Daemon-side reconciliation — dropping a record when git stops listing its worktree — would remove the need for
  this guard entirely; it is out of scope here and would need a runtime change.
- Plugin 0.23.0 paired with a `coflux` older than this change has no guard at all (the old `coflux hook` never
  had one): fail-open, acceptable.

## Execution brief

> Written for `subagent(opus)` at `ce733f45`. Implement the tasks in order. Decide only what Your call leaves to
> you; on anything else that is unclear, stop and report.

### Goal

A Claude Code `PreToolUse` hook inside Coflux terminals blocks `git worktree remove|move` so agents do not orphan
coflux workspace records. Today it blocks every such command; after this change it blocks only commands whose
target is a worktree root that coflux has registered as a workspace on this device, asks the local daemon to
decide, and says nothing whenever it cannot be sure. The logic moves into one Rust function in `crates/cli`,
shared by the two hook entry points; the plugin's JavaScript copy is deleted.

Conventions: Rust 2021 in `crates/cli`, `serde_json::Value` for JSON, existing helpers in
`crates/cli/src/integration.rs` and `crates/cli/src/gateway.rs`; new comments in English; format touched Rust
files with `cargo fmt -p coflux-cli` only if the crate is already rustfmt-clean (check with `cargo fmt -p
coflux-cli --check` before your edits — if it is not clean, do not reformat unrelated code).

### Milestone 1: one precise guard in the Rust CLI, used by both entry points

Depends on: none

#### T1 · A guard function decides from the hook payload alone

- Where: new module under `crates/cli/src/integration/` (sibling of `workspace.rs`, `codex.rs`), declared in
  `crates/cli/src/integration.rs` next to `mod codex; mod workspace;`.
- Change: implement one entry function taking the hook payload (`&serde_json::Value`) and returning
  `Option<String>` — the complete deny decision JSON, or `None` for no opinion. Inside it:
  1. Gate (D1): return `None` unless `COFLUX_SESSION_ID` is non-empty, `hook_event_name == "PreToolUse"`,
     `tool_name == "Bash"` and `tool_input.command` is a string. Do not read `COFLUX_PROJECT_ID`. The caller
     guarantees the host is `claude`.
  2. Extract candidate targets from the command text with a small hand-written shell lexer (see T2). If there
     is no candidate, return `None` without spawning any process or touching the network — this function runs
     on every tool call.
  3. Resolve each candidate to a listed worktree root (T3), then ask the daemon (T4). Deny as soon as one
     candidate is a registered workspace (do not query the rest); otherwise `None`.
- After: output, when denying, is exactly one JSON object
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`.
  The reason (English) names the verb, the worktree path and the workspace's full `workspaceId` (plus its `ref`
  when the response carries one), and says: use `coflux workspace remove <workspaceId>`, which closes that
  workspace's terminals and then removes the worktree and its sidebar record; moving a coflux worktree is not
  supported — remove it and create a new one; worktrees coflux has no record of are not blocked; Claude Code's
  own worktree cleanup needs nothing. When the response's `owningWorkspaceId` equals the matched `workspaceId`,
  the reason also says this terminal belongs to that workspace, so removing it would close this terminal: leave
  the worktree first (`ExitWorktree`, or `coflux workspace enter <path of another workspace>`).
- Don't: panic on any input — no `unwrap`/`expect`/indexing on data from the payload, git or the daemon. A panic
  in this path exits non-zero before the turn-state event is forwarded (D4).

#### T2 · The lexer finds `git … worktree remove|move` occurrences and their literal targets

- Where: the module from T1.
- Change: split the command into simple commands and words, then scan each simple command.
  - Lexing: single quotes are literal; double quotes allow `\"`, `\\`, `\$`, `` \` `` escapes; backslash escapes
    outside quotes; separators `&&`, `||`, `;`, `|`, `&`, newline, `(`, `)`. A word is *non-literal* if it
    contains an unquoted or double-quoted `$` or backtick, an unquoted `*`, `?` or `[`, or begins with an
    unquoted `~` that is not exactly `~` or `~/…` (expand those two with `HOME`).
  - Occurrence: within one simple command, a word that is exactly `git` or ends in `/git`, at any position (so
    `sudo git`, `env A=1 git`, `do git` count), followed by git global options, then the word `worktree`, then
    `remove` or `move`. Global options: `-C <dir>` (and `-C<dir>`), `-c <k=v>`, `--git-dir[=]…`,
    `--work-tree[=]…`, `--no-pager`, `-P`, `--bare`, `--literal-pathspecs` and any other `--long[=value]`;
    a value-taking option consumes its value word.
  - Subcommand arguments: skip `-f`, `--force` (repeatable) and, for `move`, any other `-…` option; `--` ends
    options. The first remaining word is the target (for `move`, the source). No such word → no candidate.
  - Base directory: starts as the payload `cwd`. A literal `cd <path>` (or `cd -- <path>`) in an earlier simple
    command of the same line moves it (relative to the current base); `cd` with no argument, any other
    `-`-prefixed `cd` argument (`cd -`, `cd -P x`), a non-literal argument, `pushd`, `popd`, or a closing `)`
    makes it unknown for the rest of the line. Each `-C <dir>` of the occurrence applies on top, in order, and is
    consumed there — `-C` is never among the options forwarded to git in T3; a non-literal `-C` makes the base
    unknown.
  - Every occurrence in the line yields its own candidate: `(verb, target word, base or unknown, the repository
    options to forward — at most --git-dir / --work-tree, see Your call)`.
- After: unit tests in the module (input command → candidates), at least:
  - `git worktree remove .claude/worktrees/a` → remove, `.claude/worktrees/a`, base = payload cwd
  - `git -C /r worktree remove -f --force x` → remove, `x`, base `/r`
  - `git worktree move a /tmp/b` → move, `a`
  - `cd /r && git worktree remove a` → base `/r`; `cd "$X" && git worktree remove a` → base unknown
  - `cd -P /r && git worktree remove a` → base unknown; `(cd /r && true); git worktree remove a` → base unknown
  - `git -C /r -C sub worktree remove a` → base `/r/sub`, no `-C` among the forwarded options
  - `git worktree remove -- -odd` → `-odd`
  - `git worktree remove a; git worktree remove b` → two candidates
  - `git commit -m "git worktree remove a"`, `echo 'git worktree move a b'` → none
  - `git worktree remove "$wt"`, `` git worktree remove `pwd` ``, `git worktree remove .claude/worktrees/*` → none
  - `for wt in a b; do git worktree remove $wt; done` → none
  - `git worktree list`, `git worktree add x`, `git worktree prune` → none
  - `sudo /usr/bin/git worktree remove a` → remove, `a`
- Don't: keep or extend the regex in `integration.rs` (D3) — it matches inside quoted text.

#### T3 · A candidate resolves to a worktree root the way git resolves it

- Where: the module from T1; keep the matching itself a pure function over `(target, base, listed roots)` so it
  is unit-testable without git.
- Change: obtain the listed roots by running `git -C <base>` (when the base is unknown and the target is
  absolute, `-C <target>`) with any forwarded repository options, then `worktree list --porcelain`; roots are
  the `worktree <path>` lines. Bound this child with a timeout — std `Command` has none, so spawn it and poll
  `try_wait`, killing it on expiry; a timeout or non-zero exit means no candidate. Then, in git's order:
  1. Suffix: the target string equals the trailing part of exactly one listed root, starting at a `/` boundary
     or at the root's start → that root. Zero or several matches → step 2.
  2. Path: the target joined to the base (or the target itself when absolute), canonicalized, equals exactly one
     canonicalized listed root → that root.
  Otherwise no candidate. Relative target with unknown base → no candidate, without running git.
- After: unit tests (pure matcher), at least, with roots `["/r", "/r/.claude/worktrees/a", "/x/a"]`:
  - `worktrees/a` → `/r/.claude/worktrees/a`
  - `.claude/worktrees/a` with base `/r` → `/r/.claude/worktrees/a` (suffix)
  - `a` → two suffix matches → path step relative to base; base `/x` → `/x/a`, base `/q` → none
  - `/r` → `/r`; `/r/.claude` → none; `b` → none
  Use non-existent example paths only where the matcher does not canonicalize, or temp directories where it does.
- Don't: query the daemon for an unlisted path (D3).

#### T4 · The daemon says whether a root is registered

- Where: the module from T1, calling `local_at` from `crates/cli/src/integration.rs` (private to `integration`,
  reachable from a child module).
- Change: for each distinct resolved root, call `local_at("workspace.current", None, <root>)`. Registered iff
  the call succeeds, `workspaceId` is non-empty, `path` is present and non-empty (the daemon answers `""` when
  the effective workspace is not yet in its table), and `path` canonicalizes (fall back to the literal string if
  canonicalization fails) equal to the canonical root (D2). Any error or empty `path` → that candidate gives no
  opinion (D4). Stop at the first registered root.
- Budget (required): all daemon calls of one guard invocation share at most 4 s in total. `local_at` waits up to
  1.8 s per call, so either call `crate::gateway::local_post` with the remaining budget or stop issuing calls once
  the next one could exceed it; candidates left when the budget runs out give no opinion. With the bounded `git`
  child (T3) this keeps the guard plus the `/hook` forward well under the bundle hook's 8 s timeout
  (`claude_hooks` in `integration.rs`, `"timeout":8`); a hook killed by that timeout loses the turn-state event.
- After: no new action, field or route on the daemon; a daemon that is down or refuses yields `None` for the
  whole call when no other candidate matched.
- Don't: call `workspace.locate` or `workspace.forget`, or any account/center command (D2).

#### T5 · Both hook entry points use it, and nothing else prints

- Where: `crates/cli/src/integration.rs` `fn hook` — the block starting `if event == "PreToolUse"` with
  `&& !env("COFLUX_PROJECT_ID").is_empty()`; `crates/cli/src/commands.rs` `pub fn run_hook`.
- Change: replace the old block in `hook` with a call to the guard (host `claude` only) printing its decision
  when `Some`. In `run_hook`, after the payload is parsed and only when the agent is `claude`, call the same
  guard and print its decision when `Some`, then continue to forward the event to `/hook` exactly as today.
- After: for every `PreToolUse` input, stdout of both commands is either empty or exactly one decision JSON
  object followed by a newline. Other events keep their current output (`hook` still prints `emit_context` on
  SessionStart, UserPromptSubmit and PostToolUse). Debug text stays on stderr behind `COFLUX_HOOK_DEBUG`. The
  `/hook` forwarding, its timeout and every other event branch are unchanged. `run_hook`'s doc comment, which
  says the command never writes stdout, is rewritten in English to state the `PreToolUse` exception. The guard
  is exposed from `integration` as `pub(crate)` (as `pub use workspace::enter as enter_workspace` is) so
  `commands.rs` can call it. Drop `regex` from `crates/cli/Cargo.toml` if nothing else in the crate still uses
  it (today its only use is the old guard); the matching `Cargo.lock` change is in scope.
- Don't: read stdin a second time — both entry points already hold the parsed payload; pass it in.

### Milestone 2: the plugin stops carrying its own guard

Depends on: Milestone 1 (the plugin now relies on `coflux hook claude` for the guard).

#### T6 · The JS guard is gone from the plugin

- Where: `integrations/claude-plugin/scripts/guard-git-worktree.mjs`; `integrations/claude-plugin/hooks/hooks.json`
  (`"PreToolUse"` array, the entry with `"matcher": "Bash"`, and the top-level `"description"` clause
  "inside a coflux project session, steer `git worktree remove|move` to the coflux account CLI workspace
  commands"); `integrations/claude-plugin/README.md` (the `hooks/` bullet starting
  "`PreToolUse` with `matcher: "Bash"` runs `scripts/guard-git-worktree.mjs`", and the messenger bullet
  starting "`UserPromptSubmit`, `PreToolUse`, …"); `integrations/claude-plugin/.claude-plugin/plugin.json`.
- Change: delete the script; delete only the `Bash`-matcher entry from `PreToolUse`, leaving the matcher-free
  `coflux hook claude` entry and every other hook byte-for-byte; rewrite the description clause and the README
  so they say the `coflux hook claude` messenger, on `PreToolUse`, denies `git worktree remove|move` only when
  the target is a worktree coflux has registered as a workspace on this device, points to `coflux workspace
  remove <workspaceId>`, and otherwise stays silent; bump `"version"` from `0.22.0` to `0.23.0`.
- After: `hooks.json` is valid JSON; no file under `integrations/claude-plugin` mentions `guard-git-worktree`;
  all plugin text is English.
- Don't: touch `integrations/claude-plugin/skills/` or `packages/cli/skills/` — they are mirrored and checked
  in CI, and their removal guidance is still correct.

Milestones are sequential and small: run them as one package.

### Your call

- Module and function names, internal types, how the lexer is structured, test layout.
- Whether `--git-dir` / `--work-tree` are forwarded to the listing call or make the candidate uncertain
  (uncertain is the safe default; `-c` does not affect the listing and may be dropped).
- Whether heredoc bodies are skipped by the lexer (welcome, not required).
- Exact wording of the deny reason within T1's required content.
- The `git` child's timeout value and how the 4 s daemon budget is enforced (T3, T4 — both are required).

### Landmines

- **The guard you are replacing is active in your own session.** Any Bash command whose text contains `git`,
  then optional options, then `worktree remove` or `worktree move` is denied before it runs — including a
  `git commit -m` message, an `echo`, or a heredoc that writes test fixtures. Write files with the Write/Edit
  tools, write commit messages to a file and use `git commit -F <file>`, and keep that word sequence out of Bash
  command lines.
- **A second Bash guard is active too**: the worktree-isolation guard refuses compound git commands
  (`a && git …`, loops) and `git -C <path outside this worktree>`. Run git only as single plain commands from
  the worktree directory.
- **Never actually remove or move a worktree** while working on this; the tests are pure, and nothing in this
  task needs a real removal.
- Unit tests must not depend on `COFLUX_*` variables or a running daemon: this terminal exports
  `COFLUX_SESSION_ID` and friends, and a test that reads them behaves differently here than in CI
  (`crates/cli/src/integration.rs` reads env through `fn env`).
- `crates/cli/src/commands.rs` `run_hook` runs for every hook event of the plugin; any added latency or output
  there is felt on every tool call.

### Scope

In scope:
- `crates/cli/src/integration.rs`
- `crates/cli/src/integration/<new guard module>.rs`
- `crates/cli/src/commands.rs`
- `crates/cli/Cargo.toml` (only to drop `regex` if it becomes unused)
- `Cargo.lock` (only the change that follows from dropping `regex`)
- `integrations/claude-plugin/scripts/guard-git-worktree.mjs` (deleted)
- `integrations/claude-plugin/hooks/hooks.json`
- `integrations/claude-plugin/README.md`
- `integrations/claude-plugin/.claude-plugin/plugin.json`
- `wiki/plans/` (Outcome and index, at close)

Out of scope:
- `crates/runtime/**` — the daemon is not changed (D2).
- `packages/cli/coflux.mjs` — the Node `coflux hook` gets no guard.
- `packages/cli/skills/**`, `integrations/claude-plugin/skills/**` — mirrored skills, unchanged.
- `integrations/claude-plugin/scripts/worktree-follow.mjs`, `session-moved.mjs`, `session-context.sh` — the
  follow/forget hooks are unrelated and must not change.
- `tests/**` — no black-box tests for this (AGENTS.md test policy).

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- `workspace.current` does not accept the request body's `cwd` as the path it resolves, or its response has no
  `path` field.
- The only way to keep `run_hook`'s stdout clean would change how other events are handled.

## Verification

### Milestone validations

- Milestone 1: `RUSTFLAGS="-D warnings" cargo build -p coflux-cli` → exit 0;
  `RUSTFLAGS="-D warnings" cargo test -p coflux-cli` → exit 0, the new lexer and matcher tables pass.
- Milestone 2: `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'`
  → exit 0; `git grep -n guard-git-worktree -- integrations` → no output;
  `node scripts/sync-claude-plugin.mjs --check` → exit 0.

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Zero-warning build | `RUSTFLAGS="-D warnings" cargo build -p coflux-cli` | exit 0 |
| CLI unit tests | `RUSTFLAGS="-D warnings" cargo test -p coflux-cli` | exit 0 |
| hooks.json valid | `node -e 'JSON.parse(require("fs").readFileSync("integrations/claude-plugin/hooks/hooks.json","utf8"))'` | exit 0 |
| Skills mirror | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Guard against the live daemon (acceptance) | In this Coflux terminal, write PreToolUse payload files with the Write tool (`hook_event_name` `PreToolUse`, `tool_name` `Bash`, `cwd` `/Users/wsq/Workspace/coflux`, the command in `tool_input.command`), then run `target/debug/coflux agent hook claude < <file>` and `target/debug/coflux hook claude < <file>` | see below |

Acceptance expectations (never run the commands themselves, only feed them as payloads):

- `… worktree remove .claude/worktrees/20260908-codex-agent-tab` (no coflux record) → empty stdout from both.
- `… worktree remove .claude/worktrees/20261018-pi-1-3-codemode` (registered, `fb02a297…`) → one deny JSON
  naming that workspace id.
- `… worktree remove 20261018-pi-1-3-codemode` (suffix form) → deny.
- `… worktree remove coflux` (ambiguous suffix: several listed roots end in `/coflux`) → empty stdout; a
  prefix- or first-match implementation would deny here.
- `… worktree remove /Users/wsq/Workspace/coflux/.claude/worktrees/20261018-worktree-guard-managed-only`
  (this plan's own worktree, registered as `1bfb1389…` and owning this terminal) → deny, with the
  "this terminal belongs to it" sentence.
- `git commit -m "<the managed remove command above>"` → empty stdout.
- A Read tool payload (`tool_name` `Read`) → empty stdout.

Each payload is also forwarded to `/hook` and marks this terminal's agent as active — harmless.

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] The acceptance payloads behave as listed, through both `coflux agent hook claude` and `coflux hook claude`.
- [ ] Lexer and matcher unit tables exist and would fail on the old regex behaviour (quoted text, unregistered
      targets) and on prefix instead of exact matching.
- [ ] The guard bounds its `git` child, keeps its daemon calls within 4 s in total, and stops at the first
      registered root.
- [ ] No `COFLUX_PROJECT_ID` check remains in the guard path; no `workspace.locate`/`forget` or center call is
      made by it.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; `crates/runtime` untouched.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- Nothing reaches the user until a `v*` release: the fixed guard ships in the native `coflux` CLI (Desktop
  bundle, npm `cofluxd`) and the integration bundle is content-addressed by that binary, so running sessions
  keep the old guard until Coflux updates and the agent restarts. The plugin is delivered with `v*` releases
  only (no `plugins-builder` commit). Release notes should say that `git worktree remove|move` is now blocked
  only for coflux-registered worktrees.
- No runtime, server, migration or protocol change; release order does not matter.
- Rollback: revert the commit; the old guard returns with the next release.

## Outcome

- Status: APPROVE — 2026-10-18
- Mode: subagent(opus), one package, no revision round
- Commits: `a9bf07b6..d4e13121` (`94d60bd3` CLI guard, `d4e13121` plugin)
- Evidence: zero-warning `cargo build -p coflux-cli`; `cargo test -p coflux-cli` 56/56 (8 new guard tests);
  hooks.json parses; no `guard-git-worktree` left under `integrations`; skills mirror check passes. Both entry
  points of `target/debug/coflux` were fed live payloads against the running daemon, 9/9 as expected. Silent:
  an unmanaged worktree, the ambiguous suffix `coflux`, the command inside a commit message, a Read tool
  payload, the main worktree. Denied with the right workspace id: the registered path, its suffix form with
  `--force`, a `cd`-prefixed `move`, and this plan's own worktree (with the "this terminal belongs to it"
  sentence). A blocked case completes in 39 ms.
- Deviations (accepted at review):
  - `local_at` delegates to a new `local_within(…, timeout)`, so the guard keeps its response checks under
    its own budget.
  - Every dash word after `remove`/`move` is skipped as an option, because git accepts bundled and
    abbreviated forms.
  - A target that resolves to the main worktree (listed first) gives no opinion: git refuses that command
    itself.
  - More forms give no opinion: brace expansion, a `GIT_*=` assignment in front of `git`, global options
    that print and exit, `cd` in a pipeline, in the background or outside command position, and unterminated
    quoting. Heredoc bodies are skipped.
  - `--git-dir`, `--work-tree` and `--bare` make a candidate uncertain.
  - The hook section comment in `commands.rs` was rewritten in English.
  - The plugin README says only the Rust `coflux` guards.
- Follow-ups:
  - A `v*` release is needed before agents see this; the plugin 0.23.0 ships with it.
  - The Node `coflux hook` (npm) has no guard, so a plugin session whose `coflux` resolves to it has no
    worktree guard at all now (out of scope by decision).
  - The case-only mismatch fails open on macOS.
  - Daemon-side reconciliation of orphaned records remains a separate idea.
