# Plan 20261001-changes-review-polish: The changes view reads like VS Code and can switch what it compares

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 755f4978..HEAD -- proto/coflux/v1/device.proto crates/worker/src/changes.rs crates/worker/src/device.rs packages/client/src/store.ts packages/client/src/device-router.ts apps/desktop/src/renderer/components/workbench/changes-view.tsx apps/desktop/src/renderer/components/workbench/changes-diff-pane.tsx apps/desktop/src/renderer/components/workbench/changes-file-tree.tsx apps/desktop/src/renderer/components/workbench/changes-tree.ts apps/desktop/src/renderer/components/workbench/changes-refresh.ts apps/desktop/src/renderer/components/workbench/parse-diff.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/preload apps/desktop/src/main/index.ts docs/design-guidelines.md`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — planned from the clean main worktree; lives on `dev/20261001-changes-review` in `.claude/worktrees/20261001-changes-review`. Plan `20261001-changes-review-comments` follows on the same branch.
- Planned at: `755f4978`, 2026-10-01

## Requirement

The desktop 「变更」 overlay (dock button; Esc or a second press returns to the terminals) is a file tree beside a single-file split/inline diff since plan `20260929-changes-file-tree`. It works but reads thin: tree rows are a chevron and a coloured name with no file or folder icons, the only diff control is an astryx `SegmentedControl` 「并排 | 内联」 that looks heavy in the header, the comparison is fixed to "the whole branch", whitespace-only edits (an agent re-indenting a block) drown the real change, and there is no way to step through changes or act on a file. The user wants it to read like VS Code's SCM view and to offer what Codex/Cursor/Claude Code's review panes offer, starting with choosing what the diff compares.

Once this is done the user reviews an agent's work by: picking the comparison scope, scanning a VS Code-like tree with file-type icons, stepping change by change with F7, seeing exactly which words changed in a changed line, hiding whitespace-only noise, and copying or revealing a file from a menu.

### Product conclusions (confirmed by the user)

```
┌ [分支全部改动 ▾]  12 个文件 +340 −120   [↻] ┬ [ts] changes-view.tsx  apps/desktop/…/workbench  +80 −40   [↑][↓] [⇆] [␣] [⋯] ┐
│ ▾ [📂] apps/desktop/src                       │  12  old line       │ 12  old line                                     │
│   ┊ ▾ [📂] renderer/components                │  13 -foo(a, b)      │ 13 +foo(a, c)    ← only b→c is emphasised        │
│   ┊   ┊ [ts] changes-view.tsx     +80 −40  M  │ ── ↕ 展开 42 行 ─────────────────────────────────────────────── │
│   ┊   ┊ [ts] file-tree.tsx        +120     U  │                                                                  │
│   [rs] old.rs                       −9     D  │                                                                  │
└────────────── ⇔ draggable ───────────────────┴──────────────────────────────────────────────────────────────────┘
```

(`[ts]`, `[rs]`, `[📂]` stand for file-type and folder icons. Plan `20261001-changes-review-comments` later adds a comment-count badge to tree rows and a 「交给 agent」 control to the header; leave room, do not build them here.)

- **Tree, VS Code style**: every file row has a file-type icon and every folder row a folder icon with distinct open/closed glyphs (folder-specific icons where the set has them: `src`, `apps`, `packages`, `docs`, `tests`, `.github`…). Thin indent guides per level like VS Code's tree. Compact folders, status-coloured names, `+N −M` and the status letter stay as they are.
- **Icon set**: Catppuccin VS Code Icons, soft colour — its palette pulled into our dark theme at low saturation, so a glance tells ts/rs/json apart while the status colour of the name stays the dominant signal.
- **Scope selector ("diff strategy")** at the top-left of the tree pane header, two options:
  - 「分支全部改动」 (default, today's behaviour): the default branch's merge-base against the working tree, plus untracked files.
  - 「未提交」: `HEAD` against the working tree, plus untracked files.
  The choice is remembered globally (across workspaces and restarts); switching refetches the list. The dock button's `+X −Y` keeps meaning the branch scope regardless of the selector.
- **Diff header**: file icon, file name, the directory path dimmed, `+N −M`; previous/next change buttons; a split/inline icon toggle replacing the `SegmentedControl`; an 「忽略空白」 icon toggle (remembered globally); a `⋯` menu. Every icon button has a `Tooltip`.
- **Previous/next change**: F7 / ⇧F7 and the two buttons move to the next/previous change block of the current file; past the last block, F7 selects the next file in tree order and lands on its first change (⇧F7 symmetric: previous file, its last change). Works whether focus is in the tree or the diff, not while typing in an input. **(revised on plan audit)** Files with nothing to step through — binary, rename-only, over the hard size limit — are skipped. A large file waiting for 「仍然加载」 is selected and F7 stops there (the next F7 moves past it). A file whose content is still loading is selected and the jump to its first change happens when the content arrives; a file that failed to load is selected and the next F7 moves past it.
- **Word-level highlighting**: inside a changed line pair, the changed words get a stronger tint than the line background; always on, no toggle.
- **Ignore whitespace**: changes that are whitespace-only stop showing as changes, like GitHub's `?w=1`. A file whose every change is whitespace-only shows 「仅空白变化」 instead of a diff. Tree counts are unaffected.
- **File menu** (tree row right-click, and the header `⋯`): 复制路径 (absolute), 复制相对路径, and — only when the workspace lives on this machine's own device — 在 Finder 中显示 and 用默认应用打开. For a deleted file the two local actions are disabled.
- **States**: everything plan `20260929-changes-file-tree` defined stays (first load, empty, list error, per-file loading/error, binary, rename-only, large diff, daemon outdated). Added: a daemon too old for 「未提交」 or 「忽略空白」 shows a daemon-outdated hint instead of silently showing the wrong comparison. **(revised on plan audit)** Its copy says that this option needs a newer daemon — not the existing 「不支持查看变更」 text, since the default scope still works.
- **Non-goals**: stage/unstage, revert, mark as viewed, per-commit or arbitrary-branch comparison, wrap toggle, expand-all-context, tree search/filter, flat-list toggle, editing in the diff. Line comments are plan `20261001-changes-review-comments`.
- **Acceptance from the user's side**: icons and indent guides in the tree; switching to 「未提交」 lists only uncommitted files and back; 忽略空白 removes a pure re-indent; a one-argument edit highlights only that argument; F7 walks every change across files; the menu copies and reveals.

## Decisions & tradeoffs

- **Scope and whitespace are computed by the worker, carried as new `bool` fields on the existing changes RPCs, and echoed back.** `DeviceChangesListRequest` gains `bool` "uncommitted" (false = branch, today's meaning, so an old client's request is unchanged); `DeviceChangesFileRequest` gains `bool` "ignore whitespace", applied as git's `-w` when the worker produces `patch`. Because these are new fields on messages an old worker already decodes, an old worker silently ignores them and answers as if they were absent — no `empty_payload`. **(revised on plan audit)** The echo therefore means "this worker decoded the field", not "this file needed it": `DeviceChangesList` and `DeviceChangesFile` each echo the request's value **unconditionally on every response of that type** — including `ok: false`, an unborn `HEAD`, and added/deleted/binary/equal-sides files where no `git diff` runs. The client checks `ok` first, then treats "asked true, echo false" as `daemonOutdated`. Rejected: an enum for the scope — buf STANDARD lint requires a `_UNSPECIFIED` zero value, and a bool's zero value already means branch. Rejected: echoing "whether `-w` was actually applied" — added/deleted/binary files never run git, so a new worker would be flagged as outdated on every such file. Rejected: computing whitespace-insensitive alignment in the renderer from the two whole sides — it would replace git as the single source of line alignment with a second diff algorithm. Rejected: inferring support from the worker version — the echo is exact and needs no version table.
  Based on: `proto/coflux/v1/device.proto:996` (`DeviceChangesListRequest`), `proto/coflux/v1/device.proto:1015` (`DeviceChangesFileRequest`), `crates/worker/src/changes.rs:253` (`list_changes`, base = merge-base or `HEAD`), `crates/worker/src/changes.rs:463` (the `-U0` patch), `packages/client/src/store.ts:1505`.
- **「未提交」 needs no new content path.** Its base is the `HEAD` commit id returned in the list's `base`; the per-file request already takes an explicit base and reads that commit's blob against the working tree, so only the list computation changes. Untracked files are listed in both scopes.
  Based on: `crates/worker/src/changes.rs:426` (`read_change_file` uses the request's `base`).
- **Tree counts and the dock never use `-w`.** `+N −M` per file and in the header stay git's plain numstat so they agree with the dock's `+X −Y`. Rejected: `-w` numstat in the list — two numbers for the same file would disagree between tree and dock.
- **With whitespace ignored, an empty patch between differing sides means "only whitespace changed"**, shown as 「仅空白变化」. The existing fallback that turns "sides differ but git reported no hunk" into a whole-file replacement must not fire in that case; it stays for the non-`-w` race it was written for.
  Based on: `apps/desktop/src/renderer/components/workbench/changes-diff-pane.tsx:158`.
- **「未提交」 does not auto-refresh on a commit.** Auto-refresh is driven by the workspace's branch-scope `additions/deletions`, which a commit does not change. Accepted: reopening the overlay, the refresh button and switching scope all refetch. The scope itself becomes part of the refresh observation so a switch refetches. Rejected: a new change-revision signal from the worker — out of proportion for this plan.
  Based on: `apps/desktop/src/renderer/components/workbench/changes-refresh.ts:15`.
- **Word-level highlighting is computed in the renderer**, on line pairs inside one change segment (the split view's left/right cells; in inline mode the n-th deleted with the n-th added line of a segment), with a word-level tokenisation (identifier runs, whitespace runs, single punctuation). It overlays the existing shiki tokens rather than replacing them. A pair that is too long or too dissimilar gets no word emphasis (line tint only), so a rewritten line does not turn into confetti. **(revised on plan audit)** With 忽略空白 on, whitespace tokens never count as changed words, so a re-indented line with one real edit emphasises only that edit. Algorithm, thresholds and whether to use a small dependency are the executor's call. Rejected: asking git for `--word-diff` — it changes the patch format the gap/segment model is built on.
  Based on: `apps/desktop/src/renderer/components/workbench/parse-diff.ts` (segments and rows), `apps/desktop/src/renderer/components/workbench/changes-diff-pane.tsx:203` (token rendering).
- **File icons are vendored into the repository from a pinned Catppuccin VS Code Icons release**, by a committed script, never fetched at runtime or installed as a package: the release VSIX's `unflavored` SVGs (colours are `var(--vscode-ctp-*)` CSS variables) plus the mapping tables from its generated theme JSON (`fileNames`, `fileExtensions`, `folderNames`, `folderNamesExpanded`, and the default file/folder/folder-open icons), with the project's MIT `LICENSE` kept next to them. The `--vscode-ctp-*` variables are defined in the renderer stylesheet against our dark palette at low saturation. Resolution follows VS Code: lower-cased full file name first, then the longest compound extension down to the shortest (`d.ts` before `ts`), then the default; folders by lower-cased name with separate open/closed tables. A small local override table may fill gaps (`agents.md`, `claude.md`). Rejected: `@iconify-json/catppuccin` — hard-coded hex colours, no file-name mapping, older version. Rejected: Material Icon Theme — filled, saturated, clashes with lucide. Rejected: Pierre's icons — too few types (no Cargo/lockfile/tsconfig, no folder kinds). UI icons stay lucide; the file-type set is used only for files and folders.
  Based on: research on 2026-10-01 (Catppuccin `catppuccin/vscode-icons` v1.26.0 is the latest release, MIT, ~656 unflavored SVGs ≈ 84 KB gzip); `docs/design-guidelines.md` ("Icons: lucide-react").
- **The local-only file actions go through two new preload bridge methods** (reveal in Finder, open with the default app) implemented with Electron `shell` in the main process. They are offered only when the workspace's `daemonId` equals the desktop's own daemon (`daemonState.daemonId`). **(revised on plan audit)** The renderer passes `(workspace root, relative path)`, never a pre-joined absolute path; the main process resolves them and refuses a relative path that is absolute or contains `..`, a result outside the root, and anything that is not an existing regular file — so the bridge cannot be used to open arbitrary paths. Rejected: running `open` through the device `exec` RPC — works remotely too, but "open on the remote machine" is not what the user sees, and it routes a desktop action through the daemon.
  Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:302` (`daemonState`), `apps/desktop/src/main/index.ts:132` (existing `shell.showItemInFolder` use), `apps/desktop/src/renderer/components/workbench/sidebar.tsx:313` (`workspace.path`).
- **(decided while planning) A design-guidelines entry records the icon split**: file and folder icons come from the vendored Catppuccin set; every other icon stays lucide.
- **No new black-box test.** The changes view is visible the first time it is opened. Pure helpers (icon resolution, word tokenisation/pairing, next-change stepping across files, scope echo handling in the client) may get unit tests where they catch real edge cases; the Rust list/patch changes get tests for the scope and `-w` paths.
- **Left to the executor**: field names; component structure; indent-guide rendering; exact icon colour mapping values; icon loading (eager glob or lazy) as long as switching files never flashes missing icons; split/inline and whitespace button glyphs; the persistence keys (follow the existing `coflux_changes_*` `localStorage` pattern); where the F7 handler lives.

## Direction

The worker stays the authority on "what changed against what"; the renderer owns presentation. `ChangesView` keeps its contract with `workbench.tsx` (props, activation, Esc ownership). **(revised on plan audit)** `ChangesView` gets no new props: what it newly needs — the workspace's `daemonId` and `path` (`client.store`'s `workspaces`), the desktop's own `daemonId` (`useDesktopDaemonState(desktop)` with `desktop` from `@/config`, as `browser-view.tsx` does) — it reads itself, so its mount point in `workspace-terminal.tsx:1252` stays untouched.

### Milestone 1: scope and whitespace exist end to end below the UI

The proto fields and echoes exist with generated code committed for all three targets; the worker lists by scope and produces `-w` patches; `@coflux/client` exposes scope/whitespace on `listWorkspaceChanges` / `readWorkspaceChangeFile` and maps a missing echo to `daemonOutdated`.
Validation: Proto lint, Generated code consistent, Protocol breaking, Rust build, Rust tests, Client tests, Server typecheck, Desktop typecheck rows of Commands.

### Milestone 2: the view gains icons, scope, whitespace, word emphasis, navigation and the file menu

Every product conclusion above is implemented, including the vendor script and its committed output, the stylesheet variables, the bridge methods, and the design-guidelines entry.
Validation: Desktop row of Commands.

Milestone 2 needs milestone 1's client API for scope and whitespace; the icon and tree work does not, but both milestones edit the same view files — run as one sequential package, do not fan out.

## Landmines

- **Old workers ignore new fields silently.** That is why the echo exists; a test should prove the client flags the missing echo. `empty_payload` attribution from plan `20260929-changes-file-tree` still covers workers older than the changes RPCs.
- **Generated code has three targets** (`packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`); CI fails on any drift. `.github/workflows/ci.yml:114`.
- **`check-protocol-breaking.mjs` needs a baseline argument.** `scripts/check-protocol-breaking.mjs:29`.
- **The whole-file fallback** at `apps/desktop/src/renderer/components/workbench/changes-diff-pane.tsx:158` would render a whitespace-only file as a full rewrite once `-w` empties the patch.
- **The content key must include the whitespace flag**, or toggling it keeps showing the cached content. `apps/desktop/src/renderer/components/workbench/changes-view.tsx:76` (`contentKey`).
- **Esc belongs to the workbench**: its listener is a window capture listener (`apps/desktop/src/renderer/components/workbench/workbench.tsx:1356`) that skips only when focus is inside a menu/listbox/dialog. The scope dropdown and context menu are astryx menus (`role="menu"`), so Esc closes them first — keep it that way.
- **Dropdown trigger tooltips**: never `button.tooltip` on a `DropdownMenu` trigger; use the sibling-`Tooltip` pattern. `docs/design-guidelines.md` ("Tooltips on a `DropdownMenu` trigger").
- **Type scale**: 13/12/11 px only; status letters and counts are badges (11 px), code stays 12 px. `docs/design-guidelines.md` ("Type scale").
- **`shell.openPath` launches executables** (an `.app`, a `.command` or a script opens and runs). The main process must open only an existing regular file under an absolute path and refuse anything else; decide whether to also refuse executable bits or bundles, and record the choice. `shell.showItemInFolder` is harmless.
- **F7 must not fire while the user types** (rename dialogs, palette, settings inputs) and must not reach the terminal — the overlay covers the terminals but a covered xterm textarea can still hold focus (see `isVisibleTypingTarget` in `apps/desktop/src/renderer/components/workbench/changes-file-tree.tsx:38`). **(revised on plan audit)** `ChangesView` cannot see the workbench's `overlayEscapeBlocked` (`workbench.tsx:1335`); mirror the Esc listener's own skip — ignore F7 while focus is inside `[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog` — so a confirm dialog or the palette does not flip the diff underneath.
- **On a Mac keyboard F7 is a media key** unless Fn is held or "use F1, F2… as standard function keys" is on; the buttons are the always-available path. Mention it in the release notes; it is not a reason to pick another key.
- **The worktree has no dependencies installed** (no `node_modules`, no `target`); `pnpm install` comes first, otherwise `node_modules/.bin/tsc` in Commands does not exist.
- **Desktop unit tests are collected only from `*.test.ts`** (`apps/desktop/package.json:13`); a `.test.tsx` file silently never runs.
- **Catppuccin VSIX layout** (verified against v1.26.0 on 2026-10-01): `extension/dist/unflavored/*.svg` (656, all colours via 16 `var(--vscode-ctp-*)` names); the mapping is `extension/dist/mocha/theme.json` with `file`/`folder`/`folderExpanded` defaults, lower-cased `fileNames` (1084), `fileExtensions` (729, includes compound keys like `d.ts`), `folderNames`/`folderNamesExpanded` (421 each); `iconDefinitions` paths are flavour-relative (`./icons/<name>.svg`) and must be mapped by icon name onto `unflavored/<name>.svg`; the license is `extension/LICENSE.txt`. `agents.md`, `claude.md` and `wiki` have no mapping.
- **Worker tests in a Coflux terminal**: run as `COFLUX_HOME= cargo test -p coflux-worker`; presence/hook or shell-integration reds are local contamination first.
- **Vendor script needs network** (`gh release download -R catppuccin/vscode-icons <tag>`); pin the tag in the script and commit its output so builds and CI never fetch.

## Merge and deploy

- Release order: worker before (or with) the desktop that sends the new fields; an old worker shows the daemon-outdated hint for 「未提交」 and 「忽略空白」 only — the default scope keeps working.
- Release notes must mention F7 / ⇧F7 (with the Fn note for Mac keyboards) and the scope selector.
- Real walkthrough needs a worker built from this branch (local stack, or a dev build with the bundled daemon); `pnpm dev:desktop:prod` alone will show the hint for the two new options.
- The vendored icon set carries Catppuccin's MIT license; nothing else to configure.

## Scope

In scope:
- `proto/coflux/v1/device.proto` and generated code in its three targets
- `crates/worker/src/changes.rs`, `crates/worker/src/device.rs`
- `packages/client/src` (store, device router, their tests)
- `apps/desktop/src/renderer/components/workbench/changes-*.ts(x)`, `parse-diff.ts`, `diff-highlight.ts`, new files beside them
- `apps/desktop/src/renderer` stylesheet(s) for the icon colour variables; a new vendored icon directory and generated mapping module under `apps/desktop/src/renderer`
- `apps/desktop/src/shared/desktop-bridge.ts`, `apps/desktop/src/preload`, `apps/desktop/src/main` (the two shell methods)
- `pnpm-lock.yaml` / `apps/desktop/package.json` only if the executor chooses a small word-diff dependency
- `scripts/vendor-file-icons.mjs` (new)
- `docs/design-guidelines.md`
- `wiki/plans/README.md`, this plan

Out of scope:
- Code comments, annotation protocol, CLI, skill — plan `20261001-changes-review-comments`
- `apps/server` — device-channel only
- `workbench.tsx` and `workspace-terminal.tsx` — `ChangesView` reads what it needs itself; F7 lives inside the view
- iOS UI, release/version bumps, `tests/` black-box suite

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint | `cd proto && buf lint` | exit 0 |
| Generated code consistent | `cd proto && buf generate`, then from the worktree root `git status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | no output after committing |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=755f4978,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-protocol && COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0 (wire protocol touched) |
| UI walkthrough (acceptance) | local stack or a dev build with this branch's daemon | by the user |

## Done criteria

- [ ] All listed automated commands pass.
- [ ] Switching to 「未提交」 lists the paths of `git diff HEAD` (staged and unstaged) plus untracked files, and back to 「分支全部改动」 restores today's list; the choice survives a restart.
- [ ] Against a worker without the new fields, choosing 「未提交」 or 「忽略空白」 shows the option-specific daemon-outdated hint; the default scope still works.
- [ ] Against a worker with the new fields, 忽略空白 on an added, deleted, binary or rename-only file never shows the daemon-outdated hint (a Rust test covers the echo on those paths and on `ok: false`).
- [ ] With 忽略空白 on, a pure re-indent shows 「仅空白变化」 and a mixed change shows only the non-whitespace hunks; tree counts are unchanged.
- [ ] A one-token edit inside a long line emphasises only that token, in split and inline modes.
- [ ] F7 / ⇧F7 and the buttons walk every change in tree order across files, skip binary/rename-only/oversized files, stop on a large file awaiting 「仍然加载」 and move past it on the next press, and do nothing while typing in an input or while a dialog, menu or the palette has focus.
- [ ] Tree rows show Catppuccin file/folder icons (open/closed folders), indent guides; `Cargo.toml`, `package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `Dockerfile`, `.gitignore` resolve to specific icons.
- [ ] The file menu copies both paths; 在 Finder 中显示 / 用默认应用打开 appear only for this machine's workspaces and the main process refuses non-regular files.
- [ ] The `SegmentedControl` is gone from the diff header; every icon button has a `Tooltip`.
- [ ] The vendor script is committed and re-running it reproduces the committed icon output.
- [ ] Implementation follows every entry in Decisions & tradeoffs; no out-of-scope files changed; `wiki/plans/README.md` updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. the Catppuccin release no longer ships `unflavored` SVGs or a mapping JSON).
- The outcome requires out-of-scope files (e.g. a server change).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Catppuccin VS Code Icons had no release for about a year at planning time; the vendored copy is pinned and does not depend on upstream activity. Re-run the script to upgrade.
- Plan `20261001-changes-review-comments` builds on this view (tree badges, header control, line gutter); keep the header and row layouts open to one more control each.
- Plan audit (fable, 2026-10-01) revised: bool fields instead of an enum (buf STANDARD zero-value rule) with an unconditional echo on every response; no new `ChangesView` props (self-sourced from the store and `@/config`); F7 behaviour on files with nothing to step through and its focus skip; whitespace-aware word emphasis; option-specific outdated copy; root-contained `shell` bridge; dependency, test-glob and VSIX-layout landmines; `--untracked-files=all`; the `git diff HEAD` wording of the scope criterion. No finding was rejected.
- **Superseded after merge (2026-10-01, before release):** the whitespace `bool` became a mode menu at the user's request after walking the view through. `DeviceChangesFileRequest.whitespace` / `DeviceChangesFile.whitespace` (fields 7/11) carry a `ChangesWhitespace` enum — unspecified (show every change), `IGNORE_AT_EOL` (`--ignore-space-at-eol`), `IGNORE_CHANGE` (`-b`), `IGNORE_ALL` (`-w`); the zero value keeps meaning "plain", which is what made the enum acceptable here. The bool fields 6/10 never shipped and are reserved (two `FIELD_NO_DELETE` entries in `proto/breaking-allowlist.json`). The echo is still unconditional and now carries the level the worker applied (an unknown level is applied and echoed as unspecified), so the client compares it with the requested mode. Word emphasis follows the same levels; the header's Space button opens the menu and reads as pressed while any whitespace is ignored. The scope stays a bool.
