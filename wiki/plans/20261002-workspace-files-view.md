# Plan 20261002-workspace-files-view: the 「变更」 overlay becomes a whole-workspace 「文件」 view, and ⌘+click lands in it

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 09b86ee8..HEAD -- proto/coflux/v1 crates/protocol crates/worker/src packages/protocol packages/client/src apps/desktop/src/renderer tests/src/contract.test.mjs`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; branch `dev/20261002-workspace-files-view` at `.claude/worktrees/20261002-workspace-files-view`
- Planned at: `09b86ee8`, 2026-10-02

## Requirement

Today the top-right 「变更」 button covers the main area with a tree of **changed files only** and one file's diff (`apps/desktop/src/renderer/components/workbench/changes-view.tsx`). With no changes it shows only 「这个工作区还没有变更」, and there is no way to browse the rest of the workspace. ⌘+clicking a path in a terminal opens a separate read-only file tab (plan `20261001-terminal-file-tab`). The user wants one place to look at the workspace's files: the overlay lists the whole workspace, changes show as decorations on that tree (VS Code explorer + SCM), and ⌘+click takes you there.

Product conclusions (confirmed by the user; not to be reopened):

1. **Entry.** The top-right button is renamed 「文件」. Its icon changes from `FileDiff` to a file-tree icon (lucide `FolderTree` or equivalent). It still shows `+N −M` when there are changes. The tooltip reads 「文件」 when closed and 「返回终端 Esc」 when open. Both git workspaces and directory workspaces (no `projectId`, `isDirWorkspace`) get the button.
2. **Tree.**
   - The default lists the whole workspace with folders expanded level by level.
   - Changed files are decorated as today: name tinted by status, `+/−` counts, status letter. A folder that contains changes carries a small dot in the status tone.
   - Deleted files appear at their old location, struck through, and open to their diff.
   - Files ignored by `.gitignore` are listed but dimmed.
   - On the first open, the folders on the way to changed files are expanded. After that the user's fold state is kept.
   - A 「仅变更」 toggle at the top of the tree switches to today's changed-only review tree. Its state is remembered on this machine.
   - The comparison scope (分支全部改动 / 未提交) stays in both modes and decides which files count as changed.
3. **Filter (⌘F).** In all-files mode it searches paths across the whole workspace, tracked and untracked but not ignored. Results show as a filtered tree, like today.
4. **Right pane.**
   - An unchanged file shows its read-only content, exactly like the file tab: line numbers, highlighting, copyable, follows the disk.
   - A changed file shows its diff by default, with comments, F7, split/inline and whitespace all kept. A 「差异 / 文件」 switch in the header shows the full current content instead. A deleted file has only the diff.
   - F7 / ⇧F7 step only through changed files in both modes.
5. **⌘+click on a terminal path** opens the 「文件」 overlay, then reveals and selects the file in the tree.
   - An unchanged file lands on the line and highlights it.
   - A changed file lands on that line of the diff's new side, expanding a folded unchanged stretch if the line is inside one. Without a line it lands on the first change.
6. **File tabs stay, as the secondary route.** The terminal link's right-click menu and the tree's file menu both carry 「在标签页中打开」, for keeping a file beside a terminal. Existing file tabs restore as before.
7. **Directory workspaces** get the same tree, without change decorations, without 「仅变更」 or the scope menu, and without dimming.
8. **Empty states.** All-files mode is empty only when the workspace is: copy 「这个工作区是空的」. 「仅变更」 keeps today's copy (「这个工作区还没有变更」 / 「没有未提交的变更」).
9. **Not doing:** editing, create/rename/delete, content search (grep), ⌘P quick open, git staging or commits, drag and drop, multi-select.

Done, as the user sees it: with or without changes, pressing 「文件」 browses the whole workspace. Changes stand out on the tree, open to their diff, and can be switched to the full file. ⌘+clicking a path in a terminal jumps straight into this tree at that file and line. On a device whose worker predates this plan, the overlay still works as today's changed-only view, with a daemon-outdated hint.

## Decisions & tradeoffs

- **One new device RPC returns the workspace's file index in one response, and the tree is built from it.**
  - Git workspace contents:
    - every tracked file, plus every untracked file that is not ignored — the set `git ls-files --cached --others --exclude-standard` gives;
    - every ignored entry at its top-most ignored level, with fully ignored directories collapsed to one directory entry — the set `git ls-files --others --ignored --exclude-standard --directory` gives.
  - Each entry carries its kind (file / directory) and whether it is ignored.
  - Directory workspace contents: a walk of the root with the same entry shape and no ignored entries.
  - **The worker chooses git mode or walk mode by asking git whether the root is the top level of a git worktree.** It does not use the workspace's `default_branch`: that is empty for directory workspaces, but also for git repositories without a detectable default branch (`crates/worker/src/main.rs:1786`). The desktop decides which git parts to show from `isDirWorkspace` (product conclusion 7). In a directory workspace that happens to be a repository top level, git mode is used, but nothing is dimmed and ignored directories are plain lazy folders. **(revised on plan audit)**
  - The filter runs on the client over the non-ignored file entries of this index.
  - Rejected: building the tree level by level with `fsList` plus a separate search index. That is two sources of truth for one tree, a round trip per expanded folder on a remote lane, and `fsList` has no ignored flag.
  - Rejected: an `fsList` extension that flags ignored entries. It still needs the separate index for the filter.
  - Based on: `crates/worker/src/changes.rs:321` (the worker already shells out to `git ls-files --others --exclude-standard -z`), `crates/worker/src/ops.rs:239` (`list_dir` has no ignore semantics), `crates/protocol/src/lib.rs:71` (`MAX_DEVICE_FRAME_BYTES` = 30 MiB).
- **Directories the index does not descend into are lazy nodes, loaded with the existing `fsList` when expanded.**
  - This covers ignored directory entries, untracked nested repositories (`git ls-files --others` reports them as `dir/`), and submodule gitlinks. A gitlink comes from `--cached` **without** a trailing slash; only its mode `160000` (`ls-files --stage`) tells it apart from a file. **(revised on plan audit)**
  - A symlink returned by a lazy `fsList` is a leaf, never an expandable folder.
  - Everything under an ignored directory is shown dimmed, with no further ignore check, because git does not descend into an ignored directory.
  - Everything under a nested repository or submodule is shown undimmed.
  - Rejected: asking git about each lazily listed entry. The answer is already known for ignored directories, and nested repositories are not this repository's to judge.
  - Based on: `crates/worker/src/device.rs:3316` (the worker already answers a workspace-scoped `fsList`), `packages/client/src/store.ts:1828`. The store today exposes only the home-browsing `listDeviceDirectory` (`browseHome = true`); a workspace-scoped listing function is **new** in `@coflux/client`, calling `deviceRouter.fsList(daemonId, workspaceId, path, false)`. **(revised on plan audit)**
- **The index is bounded and says when it is truncated. A truncated index switches the tree to lazy listing.**
  - The worker stops at a fixed entry cap (order of 100k entries) or response-size budget (order of 8 MiB, well under the 30 MiB frame), whichever comes first. It also stops at a wall-clock budget (order of 3 s) for a walk. Any of these returns `truncated`.
  - With a truncated index the client does not build the tree from the partial index. It lists the root and every expanded folder lazily with `fsList`. In that mode:
    - nothing is dimmed;
    - change decorations still apply;
    - the filter matches only entries already listed, and the tree says so: 「文件太多，筛选只覆盖已展开的目录」.
  - Directory workspaces walk under the same caps. A device page's directory workspace is typically the home folder, which will usually truncate. That is expected, and is why the lazy mode exists.
  - The exact caps are the executor's call within these orders of magnitude.
  - Rejected: an unbounded walk or listing. The home folder as a directory workspace makes that a multi-second, multi-megabyte answer over a remote lane.
  - Rejected: building the tree from a partial index. Folders would look complete but miss files. **(decided while planning)**
  - Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:507-512` (a device page renders its canonical directory workspace).
- **The index and the change list refresh on different rhythms.**
  - The change list refreshes as today (`changes-refresh.ts`: open, `+/−` change, scope, manual).
  - The index is fetched when the overlay opens and on the manual refresh button only.
  - Files created or deleted between index fetches still show up, because the change list's status is overlaid onto the index **by path**:
    - a changed path the index already has takes the change status (a deleted-but-unstaged tracked file is still in `--cached`, so it becomes the struck-through row instead of gaining a second row);
    - a changed path the index lacks — new since the fetch, or deleted from the index — is inserted;
    - a renamed file's old path is not shown as a separate entry.
    - One row per path, always. **(revised on plan audit)**
  - Rejected: refetching the index on every `+/−` change. With an agent writing files, that re-sends megabytes per tick to a remote device.
  - Based on: `crates/worker/src/git.rs:95` (untracked lines are counted into `additions`, so a new file changes `+/−` and triggers the change-list refresh), `apps/desktop/src/renderer/components/workbench/changes-view.tsx:260-269`.
- **A worker that predates the index RPC degrades to today's product, not an error page.**
  - The overlay shows today's changed-only tree, with the 「仅变更」 toggle forced on and disabled.
  - It also shows a hint that the device's daemon must be updated to browse all files.
  - In a directory workspace, which has no change list, the hint is the whole body.
  - Old-worker attribution follows the existing fsStat / annotations pattern in `device-router.ts`: lane- and generation-keyed, with stray counting, and a short-circuit on the same generation. An old worker answers an unknown payload with an id-less `empty_payload` on the elevated lane.
  - **The index attribution runs first, before `attributeFsStatUnsupported` and before the changes branch.** The rule is "the newest payload is attributed first": a worker that lacks fsStat or changes also lacks the index. The workers actually in the field (2.10–2.15) know changes and fsStat but not the index. Opening the overlay sends the index request together with `changesListRequest`, and often with fsStat requests from terminal links. If the index branch came later, the one stray error would mark changes as outdated on a worker that supports them. It could also mark fsStat unsupported for the generation, which turns off every terminal link on that device. **(revised on plan audit)**
  - Rejected: an `fsList`-based fallback that builds the full tree on old workers. It is a second implementation kept alive for the window the worker hot-push closes anyway; same posture as plans `20260929-changes-file-tree` and `20261001-terminal-file-tab`.
  - Based on: `packages/client/src/device-router.ts:1603-1618` (branch order: fsStat attribution, then changes), `:1718-1745`, `:2544` (fsStat short-circuit), `:3036`.
- **Reveal contract: the workbench asks the view to reveal `(path, line?)`, and the view owns how.**
  - ⌘+click and the link menu's 「打开文件」 call a new workbench entry that opens the overlay for that workspace and hands the view a reveal request carrying a sequence number, so a repeat reveal of the same file jumps again.
  - The view then does all of the following:
    - leaves 「仅变更」 if the file is unchanged;
    - clears the filter if the filter hides the file;
    - expands the ancestors — loading lazy folders level by level when the path sits under one (for example `node_modules/x/y.js`, or anything in truncated mode);
    - inserts the path if the index does not know it (the terminal link was already confirmed to exist by `fsStat`);
    - selects the file and lands on the line as in product conclusion 5.
  - `openFileTab` stays as it is and is what 「在标签页中打开」 calls.
  - Rejected: ⌘+click keeps opening a tab and the tree is a menu item. The user chose the tree as the primary route.
  - Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:780` (`openFileTab`), `apps/desktop/src/renderer/components/workbench/terminal-pane.tsx:488` (⌘+click) and `:1087-1094` (link menu), `apps/desktop/src/renderer/components/workbench/changes-tree.ts` (`ancestorKeys` already handles compacted folders).
- **One read-only file body, shared by the file tab and the overlay.**
  - The body is taken out of `FileView` and driven by `(workspaceId, path, line, reveal)` rather than a tab id.
  - In the overlay it is "on screen" when the overlay is open and that file is selected in 「文件」 mode. It writes no file-tab record.
  - Its polling, highlighting, windowing and outdated handling are the same code, not a copy.
  - Rejected: a second viewer for the overlay. Two copies of the 400k-char / 5000-line rules and the conditional polling would drift.
  - Based on: `apps/desktop/src/renderer/components/workbench/file-view.tsx:44-50` (props bound to `FileRuntime` and `tabId`), `apps/desktop/src/renderer/components/workbench/workbench.tsx:209-215` (`screenOf` returns nothing while the overlay is open, so it cannot be the overlay's on-screen signal).
- **Landing on a line inside a diff reuses the diff pane's gap expansion.** The diff pane already expands folded equal stretches on demand and keeps them expanded for comments. A reveal of a new-side line expands the gap that holds it, then scrolls to and highlights that row. Based on: `apps/desktop/src/renderer/components/workbench/changes-diff-pane.tsx:482` and `:537-553`.
- **「仅变更」 is a machine-wide preference next to the existing ones.** It is stored in `changes-preferences.ts` and shared by every workspace, like `mode`/`scope`/`whitespace`. The fold state and selection stay per workspace in the mounted view, as today. Based on: `apps/desktop/src/renderer/components/workbench/changes-preferences.ts:17-23`, `changes-view.tsx:137-140`.
- **Directory workspaces send no change-list request.** They show no scope menu, no 「仅变更」, no `+/−`, and no F7 or comments. They already get fsStat-gated terminal links today: the worker's `workspace_root` does not filter by branch. So only the overlay must open up for them, and it has **two** gates. **(revised on plan audit)** Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:2069` (dock button gate), `apps/desktop/src/renderer/components/workbench/workspace-terminal.tsx:1413` (the overlay is not mounted for directory workspaces; `:1419-1420` hard-code the `FileDiff` icon and 「变更」), `crates/worker/src/device.rs:4523` (`workspace_root`), `crates/worker/src/changes.rs` (git-only).

Left to the executor: names of the RPC, messages, components and files (renaming `changes-view.tsx` to a files view is fine); the exact caps; tree virtualisation or a result cap for large filter results (`changes-file-tree.tsx` renders every row today); the exact icon; how lazy folders show loading and errors; how the change list and index are merged into one tree model.

## Direction

The new RPC lives at the same layers as `fsStat` did in `20261001-terminal-file-tab`: `proto/coflux/v1/device.proto` (next free envelope fields after 145), generated output for every target, the worker handler scoped by `workspace_root` (which resolves only the path; git or walk mode is the worker's own repository check, per Decisions), and `@coflux/client` exposing it per workspace with old-worker attribution. The desktop overlay keeps its single-component-per-workspace lifecycle (mounted while hidden) and its contract with the workbench grows only the reveal request.

Milestones are strictly serial — each consumes the previous one's output, so this plan runs as one work package.

### Milestone 1: the device answers a workspace file index

- The worker answers the new request for git and directory workspaces with the entry set, kinds, ignored flags and `truncated` defined above.
- An unknown workspace is refused like the other workspace RPCs.
- Worker unit tests cover, on a temp repo:
  - tracked plus untracked-not-ignored files listed;
  - an ignored directory collapsed to one ignored directory entry;
  - an ignored file listed as ignored;
  - a tracked file matched by `.gitignore` listed as not ignored;
  - a nested untracked repository listed as a directory;
  - a submodule gitlink listed as a directory;
  - truncation at the cap;
  - a directory workspace walk.
- The worker has no `[dev-dependencies]` and no `tempfile`. Either build the temp directories with `std::env::temp_dir()` and a unique name, or add a dev-dependency; `crates/worker/Cargo.toml` and `Cargo.lock` are in scope for that. **(revised on plan audit)**
- `tests/src/contract.test.mjs` gains one wire-contract case for the new request, mirroring the fsStat case.

Validation: `cd proto && buf lint && buf generate` with no diff in the generated dirs; the breaking check against `09b86ee8`; zero-warning `cargo build`; `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker` → exit 0.

### Milestone 2: the client exposes it, and an old worker is a typed "outdated" answer

- `@coflux/client` returns the index for a workspace, or a typed failure that distinguishes a daemon too old for it.
- `device-router.test.ts` proves the following:
  - several in-flight index requests on an old worker each fail as outdated;
  - the stray id-less errors reach `onError` zero times;
  - heartbeat state is untouched;
  - a later request on the same generation fails without being sent;
  - with an index request and a `changesListRequest` in flight, one stray error fails only the index request, and the change list still resolves when its answer arrives;
  - with an index request and several fsStat requests in flight, on a worker that knows fsStat, `fsStatUnsupported` stays unset. **(revised on plan audit)**
- A workspace-scoped directory listing is added to the store for lazy folders.

Validation: `node --import tsx --test packages/client/src/*.test.ts` → exit 0; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` → exit 0.

### Milestone 3: the 「文件」 overlay

- Product conclusions 1–4 and 7–8 hold, including truncated lazy mode and the old-worker degrade.
- Pure logic gets unit tests next to the existing `changes-tree.test.ts`: merging index and change list into one tree, folder change dots, lazy and ignored nodes, and the filter over the index.

Validation: `pnpm -C apps/desktop lint && pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0.

### Milestone 4: ⌘+click reveals in the tree; file tabs become the secondary route

- Product conclusions 5–6 hold.
- Reveal works in all of these cases:
  - into an ignored or lazy subtree;
  - in truncated mode;
  - while 「仅变更」 is on;
  - while a filter is active;
  - on a changed file at a line inside a folded stretch.
- 「在标签页中打开」 exists in both menus and opens the existing file tab.

Validation: `pnpm -C apps/desktop lint && pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

## Landmines

- **An old worker's answer to the new payload carries no request id.** If attribution only extends the changes branch, the 2nd..Nth stray errors each raise a global error toast. Mirror the fsStat pattern: generation, stray count, short-circuit (`packages/client/src/device-router.ts:1718-1745`). Never claim id-less errors on the session lane — the heartbeat owns those.
- **Six hand-maintained payload tables must each learn the new request/response pair** — missing one fails silently or at send time:
  - worker: `crates/worker/src/device.rs:4655` (clear the request id), `:4677` (set it), `:4786` (scope table), `:4906` (get it);
  - router: `requestIdOf` (`packages/client/src/device-router.ts:3004`) and `responseRequestId` (`:3040`).
  - Without `requestIdOf`, the request is rejected at `:2263` with 「Device request 缺少 requestId」 and never sent. **(revised on plan audit)**
- **`git ls-files` output is NUL-separated with `-z`.** Without `-z`, non-ASCII paths come back quoted.
  - The ignored-directory set and untracked nested repositories end in `/`; do not mistake them for files.
  - A submodule gitlink comes from `--cached` **without** `/`; read the mode (`--stage`, `160000`), or it becomes a file whose read answers NOT_FILE.
  - A deleted-but-unstaged tracked file is still in `--cached`. **(revised on plan audit)**
- **An empty untracked directory is invisible to `ls-files`.** A git workspace holding only empty directories reads as 「这个工作区是空的」. That is acceptable; it is not a bug to chase.
- **A tracked file matched by `.gitignore` is not ignored** — git semantics. It comes from `--cached` and must not be dimmed.
- **The diff pane only computes and expands gaps once content is loaded.** A reveal must wait for the content of the newly selected file, as the F7 landing already does (`changes-view.tsx:379-390`, `pending`), before it expands and scrolls.
- **The overlay must not steal ⌘F / F7 / Esc from things that own them.** The existing listeners skip menus, dialogs, typing targets and `data-owns-escape` (`changes-view.tsx:397-432`, `workbench.tsx:1500-1531`). The new 「差异 / 文件」 switch and file body must keep working under those rules. ⌘F in 「文件」 mode focuses the tree filter, not a find-in-file.
- **`FileView` remembers snapshots per tab id** (`file-runtime.ts`). The overlay's use of the shared body must not create, prune or persist file-tab records. Otherwise cold-start restore (`file-tabs.ts:128`) will see orphans.
- **`check-protocol-breaking.mjs` refuses to run without a baseline argument.** `"../.git#ref=09b86ee8,subdir=proto"` works from this linked worktree; buf follows the gitdir file.
- **Desktop tests are a flat glob** (`src/renderer/components/workbench/*.test.ts`). A test in a subdirectory never runs.
- **Local worker tests are polluted by a real `COFLUX_HOME`**: run them as `COFLUX_HOME= cargo test …`.

## Merge and deploy

- Release the worker before the desktop. A desktop on this version against an old worker shows the changed-only view with the outdated hint, which is acceptable. The UI walkthrough needs this branch's worker.
- No server change, no migration, no environment variables.
- Release notes must say two things:
  - the 「变更」 button is now 「文件」 and lists the whole workspace;
  - ⌘+clicking a path in a terminal now opens it in the 「文件」 view, and the file tab moved to the right-click 「在标签页中打开」.

## Scope

In scope:
- `proto/coflux/v1/device.proto` and the generated output for **every** `buf.gen.yaml` target (`clean: true`), including `packages/swift-client/Sources/CofluxProtocol/Generated` — regenerated Swift code is expected; do not revert it
- `crates/protocol/src`, `crates/worker/src` (new handler, index logic and its tests); `crates/worker/Cargo.toml` and `Cargo.lock` only if a test dev-dependency is added
- `packages/protocol`, `packages/client/src` (API, router attribution, tests)
- `apps/desktop/src/renderer/components/workbench/**` (overlay, tree model, file body extraction, reveal, menus, dock button)
- `tests/src/contract.test.mjs` (one new case)
- `wiki/plans/README.md`

Out of scope:
- `apps/server` — device RPCs do not pass through server logic.
- iOS / Swift sources other than the generated protocol code, and the CLI — no consumer for this view.
- Editing, file operations, content search, ⌘P quick open, git operations — product non-goals.
- Removing file tabs — they remain the secondary route.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Protocol lint + generate | `cd proto && buf lint && buf generate`, then `git status --porcelain` on the generated dirs | exit 0, no diff after commit |
| Protocol breaking | from `proto/`: `node ../scripts/check-protocol-breaking.mjs "../.git#ref=09b86ee8,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop lint && pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Wire contract (acceptance) | `pnpm -C tests test` (needs local Postgres via `pnpm dev:pg`) | exit 0 |
| UI walkthrough (acceptance) | desktop dev preview against a local stack running this branch's worker (desktop-preview skill); done by the user | the "done, as the user sees it" list holds |

## Done criteria

- [ ] All listed non-acceptance commands pass; `pnpm -C tests test` passes.
- [ ] With and without changes, 「文件」 lists the whole workspace. Changed files and their folders are decorated, ignored entries are dimmed, and deleted files are struck through.
- [ ] 「仅变更」 reproduces today's review tree, and its state survives a restart.
- [ ] A changed file opens to its diff and switches to 「文件」. An unchanged file shows its content and follows the disk.
- [ ] ⌘+click lands on the right file and line in every reveal case listed in Milestone 4.
- [ ] 「在标签页中打开」 exists in the terminal link menu and the tree file menu.
- [ ] Directory workspaces have the button and a tree without git parts. A home-folder workspace opens in truncated lazy mode without stalling.
- [ ] Against a 2.14/2.15 worker, which knows changes and fsStat but not the index:
  - the overlay shows the changed-only view with the outdated hint;
  - the change list itself loads;
  - terminal file links keep working;
  - no stray error toasts appear.
- [ ] Required tests exist and assert meaningful behavior: worker index cases, router attribution, tree merge and filter.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular, an old worker answers an unknown payload with a request id or with a code other than `empty_payload`.
- `git ls-files --others --ignored --exclude-standard --directory` does not collapse ignored directories on the installed git.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Plan audit (fable, 2026-10-02) revised the following, and no finding was rejected:
  - old-worker attribution order: the index first;
  - gitlinks have no trailing slash;
  - change status is overlaid by path, one row per path;
  - the six payload tables;
  - the second directory-workspace gate and the git-mode signal;
  - generated Swift code is in scope;
  - the worker temp-dir test setup;
  - the new workspace-scoped listing in the store;
  - breaking-check and flat test-glob notes.

- The index is a snapshot taken when the overlay opens. The change list keeps the tree honest for changed paths in between. An ignored file created after opening appears only after 刷新 or reopening — by design.
- Truncated lazy mode is the fallback for huge repositories and home-folder workspaces. If it turns out to be common in git repositories, raise the caps or add ignored flags to `fsList` rather than building the tree from a partial index.
