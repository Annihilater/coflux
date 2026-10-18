# Plan 20261018-executor-changed-files: an executor write run reports every file that changed in the workspace, and a refused run says to wait

> Three parts for three readers. The Record says why and stays true after the
> code moves on. The Execution brief is the only part a delegated executor
> receives. Verification is the orchestrator's. At close, `dev:execute-plan`
> appends an Outcome and updates `wiki/plans/README.md`.
>
> Drift check: `git diff --stat a934becb..HEAD -- packages/executor/src packages/executor/README.md crates/cli/src/commands.rs packages/cli/coflux.mjs packages/cli/skills/coflux/SKILL.md integrations/claude-plugin crates/runtime/src/agent_ctl/executor.rs crates/runtime/src/device.rs apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED — the runner's exit paths change, and the abort path runs against the manager's force-kill timer
- Depends on: none
- Category: bug
- Execution: subagent(opus) — departure-check answer
- Stop after: implementation — departure-check answer ("Plan audit, then run")
- Plan review: audit — departure-check answer
- Workspace: isolated — the session was on the main worktree (clean); this plan lives in `.claude/worktrees/20261018-executor-changed-files` on `dev/20261018-executor-changed-files`
- Planned at: `a934becb`, 2026-10-18

## Record

### Requirement

Two problems reported by a user of `coflux executor run`:

1. **The changed-file list misses everything a shell command wrote.** A write run changed three files and the list named two: the ones written through the executor's `write`/`edit` file tools. `shell-written.txt`, created with `echo x >`, was missing. Anything produced by `sed -i`, a formatter or a code generator is equally invisible, and that list is what the delegating agent reviews before committing. The report came from a non-git workspace, where the 2.20.0 release note's workaround ("check `git status`") does not exist; in a git workspace with uncommitted work that workaround also mixes the run's changes with ones that were there before.
2. **A refused concurrent write run gives the wrong next step.** Its output ends with "Adjust the prompt and send a new run." The run was refused because another write run already holds the workspace; the remedy is to wait for that run to finish. The same fixed line is also wrong for a model failure, a stop by the user, and a run whose host vanished.

Product conclusions (a change the consumer perceives; confirmed at the product gate):

- **Consumer and trigger**: the coding agent that ran `coflux executor run [--write]`, at the moment the command returns — it reads the output to review and commit the result, or to decide what to do after a failure.
- **What "Changed files" means**: the net change in the workspace over a write run — every file whose content differs between the start and the end of the run, deletions included, whatever wrote it (file tools, shell redirection, `sed -i`, formatters, code generators).
  - In a git workspace, git-ignored files are left out unless the executor wrote them with its file tools; files that were already modified before the run appear only if the run changed them again.
  - A workspace that is not a git repository is compared file by file.
  - Read-only runs are not scanned: their sandbox cannot write the workspace.
  - The list cannot tell who made a change. Anything else writing to the workspace during the run (the user, another agent) appears in it too; the coflux SKILL says so.
  - When the list cannot be complete (the workspace could not be scanned in full, or the list was too long to print), the output says so in words; a list that silently drops files is the bug being fixed.
- **Next step by how the run ended**, identical in the Rust and Node CLIs:
  - `rejected` — nothing ran. The reason is in English and names the run holding the workspace (or the machine-wide cap); the next step says to send the run again once that is resolved. It never says to adjust the prompt.
  - `model_error` — send again; if the reason points at the provider, key or model, tell the user.
  - `tool_failed` — send again; if it fails the same way, tell the user.
  - `cancelled` — it was stopped (by the user, a timeout or its host); find out why before sending it again.
  - `unknown` — its host vanished mid-run, so the list may be incomplete; check the workspace before sending it again.
  - Where files were left behind, the next step says to review them first.
- **The SKILL** says the command prints the files that changed in the workspace during the run (with the inclusions and exclusions above), and that a refused second writer should wait for the running one and send again.
- **Non-goals**: queueing, asynchronous start/wait/list commands, worktree isolation for runs, translating the executor's other Chinese runtime strings, telling the executor's writes apart from other writers, A/M/D status markers in the list, any wire-protocol change.
- **What the consumer observes when done**: a write run that edits one file with a file tool, creates `shell-written.txt` with `echo x >` and rewrites a third file with `sed -i` lists all three, in a git workspace and in a non-git one; files that were already modified and that the run did not touch are not listed; a file the run deleted is listed; a second concurrent `--write` in the same workspace ends with an English reason naming the running run and a next step that says to wait, not to adjust the prompt.

### Decisions & tradeoffs

- **D1 Detection is a before/after comparison of the workspace taken by the runner, for write runs only, merged with the file-tool paths.** The runner records a baseline before the model gets the prompt and compares against it after every tool process has stopped, on every exit path (normal end, model failure, thrown error, host abort). The reported list is the detected change set ∪ the paths the file tools wrote, normalized to workspace-relative paths, deduplicated and sorted. No wire or protocol change: `changedFiles` already travels runner → manager → job table → report → daemon ledger → `executor.status` → both CLIs, for both hosts. Rejected: watching file events (FSEvents / `fs.watch`) during the run — it reports every touched path (build output, `sed -i`'s temporary files) rather than net change, coalesces and can drop events, and still needs a git pass to drop ignored files. Rejected: tracing each shell child's writes — Seatbelt reports nothing back and nothing else in reach does. Based on: `packages/executor/src/runner.ts:259-264,390-393` (the only source today); the runner is outside the sandbox (`runner.ts` header) and can run git and read the tree; `crates/runtime/src/agent_ctl/executor.rs:819-823` and `crates/runtime/src/device.rs:4971` carry the list unchanged; `apps/desktop/src/renderer/components/workbench/use-executor-bridge.ts:106`; Discussion log 1–2.
- **D2 A git workspace is compared through git's dirty set, never by walking the tree.** Baseline and final state are each `git status --porcelain=v1 -z --untracked-files=all --no-renames` restricted to the workspace root, run with `GIT_OPTIONAL_LOCKS=0` so it never writes `.git/index` (the delegating agent may be using git at the same moment). The baseline also records an `lstat` signature (size and mtime at full precision, or "absent") of every path dirty at the start. A path is listed when it entered the dirty set, or when it was dirty at the start and its signature now differs — whether it is still dirty or has left the set `(revised on plan audit)`. A path that left the dirty set with its signature unchanged is not listed: its content did not change, something else changed git's view of it (the delegating agent committing or staging it). Porcelain paths are relative to the repository top level; they are converted to workspace-relative paths because a workspace can be a subdirectory of its repository. A workspace whose root is itself ignored by the enclosing repository (`git check-ignore -q .` at the root exits 0) is treated as non-git (D3), since git would report nothing under it `(revised on plan audit)`. Consequence accepted: a clean file rewritten with identical content (a no-op `sed -i`) is not listed, because git compares content; a file that was dirty before and is rewritten with identical content but a new mtime is listed; a clean file that becomes dirty without a content change (`git rm --cached` by someone else) is listed. Rejected: walking the tree in git workspaces too — it lists build output and other ignored files, which the product decision excludes. Based on: product conclusions; `packages/executor/src/workspace.ts` (git facts already come from `git rev-parse`); `packages/executor/src/manager.ts` `defaultRunGit` (`execFileSync`, 10 s timeout precedent); the audit's checks against git 2.55.0 (porcelain paths top-level-relative from a subdirectory, `--show-prefix`, `check-ignore -q .` exit codes, `GIT_OPTIONAL_LOCKS=0` leaving `.git/index` untouched).
- **D3 A non-git workspace is compared by walking the tree twice.** Each walk records path → (size, mtime at full precision) for regular files and symlinks, does not follow symlinks, and does not descend into directories named `.git` (their contents are git metadata, not reviewable files) `(decided while planning)`. A path is listed when it appears, disappears, or its signature differs. Each walk is bounded at 200,000 entries `(decided while planning)` and by time: 20 seconds for the baseline walk, which runs before the model gets the prompt and usually on a cold cache, and 5 seconds for the final walk, which runs on the cache the baseline warmed `(revised on plan audit)`. Accepted cost: a file rewritten with identical content is listed (there is no prior content to compare against without hashing the whole tree). Based on: product conclusions; the reported case was a non-git workspace; the audit measured the same `readdirSync` + `lstatSync({ bigint })` shape at 51,988 entries in 2,563 ms cold and 349 ms warm, so a 5-second baseline would fall back on any workspace past roughly 100,000 entries.
- **D4 A list that cannot be complete says so in the text the agent already reads, and falls back to what is known.** When the baseline or the final scan cannot be completed — a walk hits its budget, git fails or times out, or an abort leaves no time — the reported list is the file-tool paths (plus whatever detection did produce, if anything), and one sentence of the form `Changed-file list incomplete: <reason>. Check the workspace yourself.` is appended to the run's `summary` when it succeeded and to its `error` otherwise. The same sentence form reports truncation: the list carries at most 500 paths `(decided while planning)`, and the reason then names how many more changed. No note is added for a read-only run or for a run that ended before its baseline was taken (nothing could have changed through it). Rejected: a new wire field marking the list partial — it would thread through the proto, three generated bindings, both hosts, the daemon ledger and both CLIs for a rare edge, while `summary`/`error` already reach the agent on every path. Rejected: a silent fallback — it is the reported bug. Based on: `crates/cli/src/commands.rs:578-620` (both texts printed); `crates/runtime/src/agent_ctl/executor.rs:815-828` (stored as sent).
- **D5 Scans are synchronous, and any final scan that runs once an abort has arrived has a shorter budget** `(decided while planning; revised on plan audit)`. The host-abort handler and `run()` share the runner's module state; a synchronous scan cannot interleave with `run()` sending its own terminal message. The budgets: git commands time out after 10 s at baseline and after the final scan's budget otherwise; the final walk gets 5 s (D3). After an abort the manager force-kills the runner 8 s later and `stopAllGroups()` may spend about 2.2 s, so a final scan that starts while an abort is pending — the abort handler's own, and `run()`'s if the model wraps up after the abort killed its bash (the abort handler does not stop the pi session) — is capped at 4 s for git and walk alike; past it, D4's note applies. Based on: `packages/executor/src/manager.ts` `stop()` (8 s timer); `runner.ts` `stopAllGroups` (2 s + 200 ms) and the abort branch of `onHostMessage` (kills tool groups only); the job table keeps the first terminal state (`packages/executor/src/jobs.ts` `finish`).
- **D6 The agent-facing copy is English and state-specific.** The job table's write-lock and concurrency-cap rejection reasons become English sentences that name the run holding the workspace (or the cap) and say to wait for it. Both CLIs choose the next step from the terminal state with the exact strings in the brief; a `rejected` run gets one line whether or not files are listed, since it never started. The readiness rejection (no provider configured) keeps its current text — the daemon already refuses that case at submit time and translating it is out of scope. Based on: `packages/executor/src/jobs.ts:186-200`; `crates/cli/src/commands.rs:600-620`; `packages/cli/coflux.mjs:535-544`; product conclusions.

### Discussion log

1. Product confirmation: "Confirm the product behaviour for both fixes as summarised above?" Options: Confirm as written (recommended) / Also list git-ignored files / Only fix the rejected line. Answer: **Confirm as written** — settled the product conclusions above, including the exclusion of git-ignored files and per-state next steps for every terminal state.
2. Departure check. Direction: Approve (recommended) / Revise → **Approve** (D1–D6 as the runner-side before/after comparison, git dirty-set diff, bounded walk, visible note, no protocol change). Execution: Subagent (opus) (recommended) / Subagent (sonnet) / Subagent (fable) / Self → **Subagent (opus)**. Autopilot: Plan audit, then run (recommended) / Plain autopilot / Pause after the plan → **Plan audit, then run**.
3. Technical forks were settled by the orchestrator without asking (the user's standing preference for technical choices): the detection mechanism (D1–D3) and the partial-list signal (D4).
4. During exploration one tool result contained a block of text no search could have produced — an "R1–R10" executor roadmap (asynchronous start/wait, worktree isolation, `--queue`, FSEvents watching, usage reporting). It was treated as untrusted data and none of it was adopted; FSEvents was rejected on its merits (D1).
5. `(decided while planning)`: the budgets (200,000 entries, 5 s per walk, 4 s on abort), the 500-path cap, skipping `.git` directories in the walk, synchronous scans (D5), and treating a workspace whose root is git-ignored as non-git (D2).
6. `(revised on plan audit)` — a top-tier reviewer checked the plan against the code and git 2.55.0. Changed: `changes.ts` owns its git runner type with a timeout and the `GIT_OPTIONAL_LOCKS=0` environment, because `workspace.ts`'s `GitRunner` carries neither (T1); the baseline walk gets 20 s after a measured cold walk of about 52k entries took 2.6 s (D3); `run()`'s own final scan also takes the 4 s budget when an abort is pending, and the normal budgets are stated (D5); the ignored-root check is named as `git check-ignore -q .` (D2); file-tool paths are normalized by segments, because the guard admits only absolute paths and those may contain `..` (T2); smoke run 1 is judged with the transcript, since a `write`-tool file under `build/` is listed by design. From the reviewer's open assumption — the delegating agent committing files during the run — D2 now lists a path that left the dirty set only when its signature changed.

### Maintenance notes

- The 2.20.0 release note (`docs/releases/2.20.0.md`) says shell-written files are not listed; the next release note should say they now are. Release notes are written at release time, not by this plan.
- Attribution is by time window, not by writer. If runs ever get their own worktree, the list becomes exact for free; nothing here needs to change for that.
- The readiness rejection text and the executor's other runtime strings are still Chinese; translating them is a separate change.
- Submodule content changes inside a path that was already dirty are compared by the submodule directory's signature only and may be missed. Accepted as an edge.

## Execution brief

> Written for `subagent(opus)` at `a934becb`. Implement the tasks in
> order. Decide only what Your call leaves to you; on anything else that is
> unclear, stop and report.

### Goal

The coflux executor is a small agent that a coding agent hands a bounded job with `coflux executor run [--write]`. When a run ends, the CLI prints its summary and the list of files it changed (`changedFiles`). Today that list is filled only when the executor's `write`/`edit` file tools run (`packages/executor/src/runner.ts`), so files written by its sandboxed `bash` are missing. Milestone 1 replaces that with a before/after comparison of the workspace taken by the runner. Milestone 2 fixes the agent-facing copy: the job table's rejection reasons, the per-state "next step" line in both CLIs, and the coflux SKILL.

Conventions: TypeScript in `packages/executor` is ESM with `.js` import suffixes, pure modules take their side effects as injected functions (see `workspace.ts` and its `GitRunner`), comments are English and explain why. The Rust CLI and the Node CLI (`packages/cli/coflux.mjs`) must print the same strings. The SKILL is English only and wrapped near 100 columns like the surrounding text. There is no formatter to run for these files beyond keeping the surrounding style.

### Milestone 1: a write run's changed-file list is the workspace's net change

Depends on: none.

#### T1 · A pure-logic module computes the workspace's net change between a baseline and now

- Where: new `packages/executor/src/changes.ts`, beside `packages/executor/src/workspace.ts`.
- Change: add a module that takes a baseline of a workspace root and later computes the change set against it, with git and the file system injected so the logic is testable.
- After:
  - The module defines its own git runner type that takes the arguments, the working directory and a timeout in milliseconds and returns `{ stdout, ok }`, and exports a default implementation built on `execFileSync("git", …)` with `env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }`, `encoding: "utf8"` and that timeout. Every git command the module runs goes through it.
  - Taking a baseline decides the mode (D2, D3): `git rev-parse --show-prefix` at the root fails → walk mode. It succeeds → `git check-ignore -q .` at the root: exit 0 (the root is ignored by its repository) → walk mode; exit 1 → git mode; anything else → the baseline is unavailable and the result will be incomplete. Distinguishing exit 1 from other failures may need the runner type to expose the exit status — extend the type for that rather than guessing.
  - Git mode (D2): baseline and final state each come from `git status --porcelain=v1 -z --untracked-files=all --no-renames -- .` run at the root. Entries are NUL-separated `XY path`; paths are relative to the repository top level and are converted to root-relative by stripping the prefix from `--show-prefix`. The baseline also holds, for each dirty path, an `lstat` signature: size and mtime at full precision (`bigint` stats), or "absent". A path is in the change set when it is dirty now but was not at baseline, or when it was dirty at baseline and its signature now differs (whether it is still dirty or not). A path that left the dirty set with an unchanged signature is not in the change set.
  - Walk mode (D3): baseline and final state are maps of root-relative path → (size, mtime at full precision) for regular files and symlinks, using `lstat` and never following symlinks, skipping any directory named `.git`. A path is in the change set when it was added, removed, or its signature differs. Every walk stops after 200,000 entries; the baseline walk also stops after 20 seconds and the final walk after its time budget. A stopped walk makes the result incomplete.
  - Budgets (D5): baseline git commands time out after 10 seconds. The final computation takes a time budget from its caller — 5 seconds normally, 4 seconds once an abort is pending — which bounds both the final walk and the final git commands' timeout.
  - The result is `{ files, incomplete }`: `files` is the sorted change set; `incomplete` is null or a short English reason (for example "the workspace is not a git repository and has more than 200,000 entries", "git status failed", "scanning took longer than 4 seconds"). A baseline that could not be taken carries its reason forward into the result.
  - Everything is synchronous (D5).
- Tests (new `packages/executor/src/changes.test.ts`, `node:test` like the other `*.test.ts` files, with an injected git runner and a temporary directory or injected file-system functions):
  - git, workspace at the repository root: baseline dirty `{a.txt (sig 1)}`, final dirty `{a.txt (sig 2), new.txt}` → `["a.txt", "new.txt"]`.
  - git: baseline dirty `{keep.txt (sig 1)}`, final dirty `{keep.txt (sig 1)}` → `[]`.
  - git: baseline dirty `{reverted.txt (sig 1)}`, final dirty `{}`, `reverted.txt` now has sig 2 → `["reverted.txt"]`.
  - git: baseline dirty `{committed.txt (sig 1)}`, final dirty `{}`, `committed.txt` still has sig 1 → `[]`.
  - git: `check-ignore -q .` exits 0 → walk mode is used.
  - git, workspace is the subdirectory `sub/` (show-prefix `sub/`): final porcelain lists `sub/x.ts` → `["x.ts"]`.
  - git: the final `git status` fails → `files` empty and `incomplete` non-null.
  - walk: a file created, one deleted, one rewritten with a new size → all three listed; a file under `.git/` changed → not listed.
- Don't: walk the tree in git mode, or list git-ignored paths (D2). Don't run any git command that can write the repository (D2).

#### T2 · The runner reports the net change on every exit path of a write run

- Where: `packages/executor/src/runner.ts` — the `changedFiles` set and `relativeToWorkspace` (around "The files this task changed; the guard extension records them"), `run()` before `await session.prompt(start.prompt);`, the four `send({ type: "done", ...` calls inside `run()`, the `.catch` handler after `run(message)`, and the `message?.type === "abort"` branch of `onHostMessage`.
- Change: take a baseline in write runs just before the prompt; build every terminal `done` message's `changedFiles` (and the note) from one helper that compares against it.
- After:
  - In a write run (`start.write`), the baseline is taken after the session is created and before `session.prompt(...)`; it is held in module state so the abort branch can reach it. Read-only runs take no baseline (D1).
  - Every `done` message — the four in `run()`, the `.catch` one and the abort one — gets `changedFiles` from the same helper, called after `stopAllGroups()` has returned. The helper returns the D1 union: the change set from T1 plus the file-tool paths, deduplicated, sorted, and capped at 500 entries. File-tool paths reach it as absolute paths (the guard refuses relative ones) that may contain `.` or `..` segments; normalize the segments, then make the path relative to the root (`/root/sub/../a.txt` → `a.txt`), so it matches the form T1 produces.
  - When T1's result is incomplete, or the cap dropped entries, the helper also yields one sentence `Changed-file list incomplete: <reason>. Check the workspace yourself.` (for the cap the reason is `<n> more changed files are not listed`). It is appended as its own sentence to `summary` when `outcome` is `succeeded`, and to `error` for every other outcome (D4). No sentence when there is no baseline (read-only run, or the run ended before the baseline was taken).
  - The final scan's budget is 4 seconds whenever an abort has arrived — in the abort branch and in `run()`'s own exit paths when the module's `aborting` flag is already set (the abort branch kills tool groups but not the pi session, so `run()` can still reach its end) — and 5 seconds otherwise (D5).
  - The guard's file-tool recording stays as it is; its set is one input to the union.
- Don't: start the final scan before `stopAllGroups()` returns — a tool process still writing would be missed and the write lock released early (comment above `await stopAllGroups();`). Don't make the scans asynchronous (D5).

#### T3 · The executor README lists the new module

- Where: `packages/executor/README.md`, the `## Layout` table.
- Change: add a row for `changes.ts`.
- After: one row, `changes.ts` — what a write run changed in its workspace: git's dirty set before and after, or a bounded walk outside git. Pure.

### Milestone 2: agent-facing copy says what to do next

Depends on: none. Independent of Milestone 1 (disjoint files).

#### T4 · The job table's rejection reasons are English and say to wait

- Where: `packages/executor/src/jobs.ts`, `rejectionFor` — the write-lock line (starting `return \`该工作区已有一个写模式 executor 任务在跑`) and the cap line (starting `return \`本机同时在跑的 executor 任务已达上限`); `packages/executor/src/jobs.test.ts`, the assertions `/写模式同一工作区只能有一个/` and `/已达上限 2/`.
- Change: replace the two reasons with English text and update the two assertions to match it.
- After:
  - Write lock: `Another write run (${writer.assignment.runId}) is already working in this workspace, and a workspace takes one write run at a time. Wait for it to finish.`
  - Cap: `This machine is already running ${this.limits.maxConcurrent} executor runs, the most it runs at once. Wait for one of them to finish.`
  - The readiness reason and its fallback text are unchanged (D6).
  - The tests assert on a stable fragment of each English sentence (for example `/one write run at a time/` and `/already running 2 executor runs/`); test names may stay as they are.

#### T5 · Both CLIs choose the next step from the terminal state

- Where: `crates/cli/src/commands.rs`, `pub fn render_executor_failure` (the `let (tail, next) = if files.is_empty()` block); `packages/cli/coflux.mjs`, `function renderExecutorFailure` (the `next:` property).
- Change: replace the two fixed next steps with a choice by terminal state and by whether files were left, using exactly these strings in both files.
- After — `terminal` value → next step (left column: no files listed; right column: files listed):

  | terminal | no files | files listed |
  | --- | --- | --- |
  | `rejected` | `Nothing ran. Send this run again once the reason above is resolved.` | same |
  | `model_error` | `Send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead.` | `Review the changes it left, then send the run again. If the reason points at the provider, key or model, tell the user to fix the executor settings instead.` |
  | `tool_failed` | `Send the run again. If it fails the same way, tell the user.` | `Review the changes it left, then send the run again. If it fails the same way, tell the user.` |
  | `cancelled` | `It was stopped before it finished, by the user, a timeout or its host going away. Find out why before sending it again.` | `It was stopped before it finished, by the user, a timeout or its host going away. Review the changes it left and find out why before sending it again.` |
  | `unknown` and any other value | `Its host went away mid-run, so the list of changed files may be incomplete. Check the workspace before sending it again.` | same |

  - The message line (`Executor run ended as …: <reason>. Files already changed (n): …`) is unchanged.
  - The timeout path's next step (`Send it again with a larger --timeout.`) is unchanged.
- Don't: leave `Adjust the prompt and send a new run.` anywhere in either CLI (D6).

#### T6 · The SKILL describes the list and the refused writer correctly, and the plugin mirror follows

- Where: `packages/cli/skills/coflux/SKILL.md`, section `### Hand a bounded sub-task to the executor` — the sentence ending `then prints the executor's final report and the files it changed.` and the bullet starting `- **One writing executor per workspace at a time.**`; then `integrations/claude-plugin/skills/` (generated) and `integrations/claude-plugin/.claude-plugin/plugin.json`.
- Change: rewrite that sentence and that bullet, mirror the skills tree with `node scripts/sync-claude-plugin.mjs`, and bump the plugin version.
- After:
  - The sentence says the command prints the executor's final report and the files that changed in the workspace during the run, whatever changed them, shell commands included. It is followed by: in a git workspace, git-ignored files are left out unless the executor wrote them with its file tools, and files already modified before the run appear only if the run changed them again; the list cannot tell who made a change, so anything else writing to the workspace during the run (the user, another agent) shows up too; when the workspace could not be scanned completely the output says so, and then you check the workspace yourself.
  - The bullet says a second `--write` in the same workspace is refused outright rather than queued and nothing runs: wait for the running one to finish, then send yours again. Read-only runs may still go in parallel up to a small cap.
  - `integrations/claude-plugin/skills/coflux/SKILL.md` is byte-identical to the source (produced by the sync script, not edited by hand).
  - `plugin.json` `"version"` goes from `0.23.0` to `0.24.0`.
- Don't: add any non-English text to the SKILL.

### Your call

- `changes.ts`'s exported names, internal structure, and how file-system access is injected or whether the tests use a real temporary directory for walk mode (never under the repository; create it with `mkdtemp` and remove only that path).
- The exact wording of each `incomplete` reason, within the sentence frame fixed in T2.
- Whether the git porcelain parsing keeps a trailing `/` on directory entries (nested repositories show as one untracked directory).
- How the Rust function returns the strings (all are literals, so `&'static str` still works).
- Whether to add CLI unit tests for the new next steps; the project prefers no test that merely restates a string table.

### Landmines

- `GIT_OPTIONAL_LOCKS=0` must reach every git command the runner runs (D2); without it `git status` may refresh and write `.git/index` from an unsandboxed process while the delegating agent is using git. `workspace.ts`'s `GitRunner` and `manager.ts`'s `defaultRunGit` carry no environment or per-call timeout, which is why T1 defines its own runner.
- The runner overrides `process.env.TMPDIR` and `PI_*` for itself (`runner.ts`, start of `run()`); git child processes inherit that, which is harmless, but do not hand them the provider credential — build their environment from `process.env` plus `GIT_OPTIONAL_LOCKS`, never from the start message.
- Porcelain v1 paths are relative to the repository top level even when git runs in a subdirectory; the workspace root is often a git worktree under another checkout (`.claude/worktrees/*`) or a subdirectory of a repository.

### Scope

In scope:
- `packages/executor/src/changes.ts` (new), `packages/executor/src/changes.test.ts` (new)
- `packages/executor/src/runner.ts`
- `packages/executor/README.md`
- `packages/executor/src/jobs.ts`, `packages/executor/src/jobs.test.ts`
- `crates/cli/src/commands.rs`
- `packages/cli/coflux.mjs`
- `packages/cli/skills/coflux/SKILL.md`
- `integrations/claude-plugin/skills/**` (via the sync script only), `integrations/claude-plugin/.claude-plugin/plugin.json`

Out of scope:
- `proto/`, `crates/protocol`, `packages/protocol`, `packages/swift-client` — no wire change (D4).
- `crates/runtime/**`, `apps/desktop/**` — they already carry `changedFiles` unchanged.
- `packages/executor/src/manager.ts`, `guard.ts`, `sandbox.ts`, `workspace.ts`, `config.ts`, `host*.ts` — unchanged.
- The readiness rejection text in `jobs.ts` and every other Chinese runtime string in `packages/executor` (D6).
- `docs/releases/**` — release notes are written at release time.

### Stop and report if

- A task's anchor is missing, or the code there differs from what the task describes.
- A task needs a file outside the in-scope list.
- Two tasks contradict each other, or a task contradicts the code it changes.
- The runner's exit paths turn out to include a terminal `done` message not listed in T2.
- Making the final scan fit the abort path's 4-second budget would require changing `manager.ts`'s 8-second force-kill.

## Verification

### Milestone validations

- Milestone 1: `node_modules/.bin/tsc -p packages/executor/tsconfig.json --noEmit` → exit 0; `pnpm -C apps/desktop test` → exit 0, with the new `changes.test.ts` cases among the passing tests (the desktop test script includes `../../packages/executor/src/*.test.ts`); in the diff, every `send({ type: "done"` in `runner.ts` takes `changedFiles` from the one helper, and `GIT_OPTIONAL_LOCKS` appears in `changes.ts`.
- Milestone 2: `pnpm -C apps/desktop test` → exit 0 (the updated `jobs.test.ts` assertions pass); `cargo build -p coflux-cli` → exit 0 with zero warnings; `cargo test -p coflux-cli` → exit 0; `node scripts/sync-claude-plugin.mjs --check` → exit 0; `grep -rn "Adjust the prompt" crates/cli/src packages/cli/coflux.mjs` → no output; the five next-step strings in `commands.rs` and `coflux.mjs` are byte-identical (compare by reading the diff).

### Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Executor typecheck (incl. tests) | `node_modules/.bin/tsc -p packages/executor/tsconfig.json --noEmit` | exit 0 |
| Executor + desktop tests | `pnpm -C apps/desktop test` | exit 0 |
| Desktop typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Rust CLI build | `cargo build -p coflux-cli` | exit 0, zero warnings |
| Rust CLI tests | `cargo test -p coflux-cli` | exit 0 |
| Plugin mirror | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Executor build (for the smoke) | `pnpm -C packages/executor build` | exit 0, `packages/executor/dist/runner.js` present |
| Standalone executor smoke (acceptance) | see below | runs 1–5 as described |

**Standalone executor smoke (acceptance), run by the orchestrator on this Mac.** As in plan `20261018-pi-1-3-codemode`: a throwaway script in a `mktemp` directory outside the repository drives the built `ExecutorManager` from `packages/executor/dist` the way `host.ts` does — `spawnRunner` forks `packages/executor/dist/runner.js` with plain Node; provider, model, custom endpoints and credential come from `~/.coflux/executor-settings.json`, read by the script and **never printed**. It does not touch the installed Coflux.app, which is this Mac's executor host. Runs:

1. Git workspace (a temporary repository with one committed file `a.txt` and one uncommitted change to a committed file `dirty.txt`; `.gitignore` lists `build/`): a write run told to edit `a.txt` with the `edit` tool, run `echo x > shell-written.txt`, run `sed -i '' 's/1/2/' b.txt` on a committed `b.txt` containing `1`, and `mkdir -p build && echo y > build/out.txt` → `succeeded`; `changedFiles` is exactly `a.txt`, `b.txt`, `shell-written.txt` (no `dirty.txt`, no `build/out.txt`), no incomplete note in the summary. Read the transcript before calling a difference a defect: if the model created `build/out.txt` with the `write` tool rather than bash, the D1 union lists it by design.
2. The same in a non-git temporary directory (no `.gitignore` semantics) → `changedFiles` contains `a.txt`, `b.txt`, `shell-written.txt` and `build/out.txt`.
3. Git workspace: a write run told to `rm` a committed file → that file is listed.
4. Git workspace: two write runs assigned to the same workspace back to back → the second ends `rejected` with the English write-lock reason naming the first run's id.
5. A write run aborted through the manager while a long `sleep` runs in bash → `cancelled` within the 8-second grace, its `changedFiles` produced (no force-kill line in the manager log).

Then, for the CLI copy, render a `rejected` status through each CLI's function by reading the diff (no live daemon is needed): the next step is the `rejected` line from T5.

### Done criteria

- [ ] All listed commands pass.
- [ ] Every task's `After` state holds.
- [ ] Smoke runs 1–5 behave as described; no credential appears in any output printed during the smoke.
- [ ] Read-only runs take no baseline and never carry the incomplete note (read the diff).
- [ ] The two CLIs' next-step strings are identical to each other and to T5's table.
- [ ] `changes.test.ts` covers the git subdirectory prefix, the dirty-both-times signature case, a path that left the dirty set with and without a signature change, the ignored root, and a failing `git status`.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] The Outcome is appended and `wiki/plans/README.md` status is updated.

### Merge and deploy

- The executor change ships in the desktop app (Coflux.app hosts the executor) and in the npm `cofluxd` package (which vendors `packages/executor` at prepack); the CLI copy ships in the `coflux` binary and the npm CLI. All of them go out together with the next `v*` release; no server, protocol or configuration change.
- The plugin goes to 0.24.0 and is distributed with the release.
- The next release note should replace 2.20.0's "a file created by a shell command is not listed" with the new behaviour.
