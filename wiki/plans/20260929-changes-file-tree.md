# Plan 20260929-changes-file-tree: The changes view becomes a file tree beside a single-file diff

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 90095a31..HEAD -- proto/coflux/v1/device.proto crates/protocol packages/protocol crates/worker/src/device.rs crates/worker/src/git.rs crates/worker/src/ops.rs packages/client/src apps/desktop/src/renderer/components/workbench/changes-view.tsx apps/desktop/src/renderer/components/workbench/parse-diff.ts apps/desktop/src/renderer/components/workbench/diff-highlight.ts apps/desktop/src/renderer/components/workbench/changes-refresh.ts apps/desktop/src/renderer/components/workbench/workbench.tsx`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — planned from the clean main worktree; this plan lives on `dev/20260929-changes-file-tree` in `.claude/worktrees/20260929-changes-file-tree`
- Planned at: `90095a31`, 2026-09-29

## Requirement

The desktop 「变更」 overlay (the top-right dock button that covers the whole main area; Esc or a second press returns to the terminal groups) currently fetches the **full diff of every changed file at once** — one `git diff <base>` plus one `git diff --no-index` per untracked file, eight at a time — and stacks every file as a collapsible card. On a workspace with dozens of changed files this is slow (especially to a remote device, where each untracked file is a round trip) and it is hard to find a particular file. The user wants a VS Code-style review: a file tree on the left, the selected file's diff on the right.

Once this is done, opening 「变更」 shows the tree almost immediately (one round trip for the whole list), and only the file being looked at has its content fetched.

### Product conclusions (confirmed by the user)

- **Replaces** the stacked all-files form entirely; there is no toggle back to it.
- **Comparison base is unchanged**: merge-base of the workspace's default branch and `HEAD`, against the working tree, plus untracked files — the same base the dock button's `+X −Y` is computed from.
- **Entry and exit unchanged**: the dock button opens it; Esc or pressing it again returns to the terminals.
- **Layout**:

  ```
  ┌ 12 个文件  +340 −120            [↻] ┬ src/a.ts   +12 −3   [并排|内联] ┐
  │ ▾ apps/desktop/src                  │  12  old line    │ 12  old line   │
  │   ▾ renderer/components             │  13 -foo()       │ 13 +bar()      │
  │       changes-view.tsx +80 −40  M ◀ │ ── ↕ 展开 42 行 ──────────────── │
  │       file-tree.tsx    +120     U   │  56  ctx         │ 57  ctx        │
  │   old.ts                  −9    D   │                                   │
  └─────────────── ⇔ draggable ────────┴───────────────────────────────────┘
  ```

- **Tree**: compact folders (a chain of single-child directories collapses into one row such as `renderer/components`); all folders expanded by default; each file row shows `+N −M` and a status letter `A` / `M` / `D` / `R` / `U` (untracked), with the file name coloured by status. The tree pane's width is draggable.
- **Right pane**: side-by-side by default, toggled to inline from the pane's toolbar; the choice persists across files (and across restarts). By default only the change hunks with 3 lines of context are shown; the unchanged stretches between (and before/after) hunks collapse into a 「↕ 展开 N 行」 row that reveals those lines when clicked.
- **Selection**: on open, restore that workspace's last-selected file if it is still in the list, otherwise select the first file in tree order. Clicking a file selects it. With focus in the tree, ↑/↓ moves the selection between files (the right pane follows), ←/→ collapses/expands the folder.
- **Refresh**: when the code changes (the existing trigger: the workspace's additions/deletions change while the view is active) or the user presses refresh, the list and the current file are refetched; the right pane keeps its scroll position where it can. If the current file is no longer in the list, the neighbouring file in tree order is selected.
- **States**:
  - First load: centred spinner (as today).
  - No changes: 「这个工作区还没有变更」 with a refresh button (as today).
  - List fetch failed: full-view error with retry (as today).
  - Single file loading or failed: spinner / error + retry **in the right pane only**; the tree stays usable.
  - Binary file: 「二进制文件，不显示内容」.
  - Rename with no content change: 「重命名自 X，内容未变」.
  - Added / deleted file in side-by-side: one side is empty.
  - Large diff: 「变更较大」 with a 「仍然加载」 button instead of fetching/rendering automatically.
  - Device's daemon too old for the new list request: a readable hint that the daemon needs updating (see Decisions).
- **Non-goals**: staging, discarding or committing; opening in an editor; choosing another base; per-commit history; searching or filtering the tree; next/previous-change keyboard shortcuts.
- **Acceptance from the user's side**: on a workspace with dozens of changed files, 「变更」 shows the tree right away and only the selected file loads; the tree makes the target file easy to find; switching files has no noticeable wait for normal-sized files; split/inline toggle, gap expansion, and auto-refresh behave as above.

## Decisions & tradeoffs

- **The file list comes from one new device-channel RPC answered by the worker, not from `exec` calls composed in the renderer.** It is a request/response pair on `DeviceEnvelope` (the same family as `exec_run`/`fs_read`), keyed by `workspaceId` only. The worker resolves the workspace's worktree and default branch itself, computes the base exactly as `git::diff_stat` does (merge-base of default branch and `HEAD`, falling back to `HEAD`), and returns that **base commit id** plus one entry per changed file: path, previous path for renames, status (added / modified / deleted / renamed / untracked), additions, deletions, binary flag, and a size figure the client can use for the large-file guard. Untracked files are included with their line counts, counted by reading the files directly as the existing summary does — never by spawning a process per file. **(revised on plan audit)** Every path `git ls-files --others --exclude-standard` reports must become an entry: the existing summary loop `continue`s past files over 1 MB and files containing NUL, and copying that loop would drop those paths from the tree. The skip applies to counting only — such a file is listed with its binary / size flags and a zero line count. Rejected: renderer-side `git diff --numstat` plus per-untracked-file `diff --no-index --numstat` over `exec` — it keeps one round trip per untracked file, which is the slowness this plan exists to remove. Rejected: showing untracked files without line counts to avoid the RPC — the tree would disagree with the dock's `+X −Y`, which already counts untracked lines.
  Based on: `crates/worker/src/git.rs:90` (`diff_stat`, merge-base + `--shortstat` + `untracked_additions`), `crates/worker/src/git.rs:133` (`count_untracked_lines`), `crates/worker/src/device.rs:3901` (`workspace_root`; the state map holds `(path, default_branch)`), `apps/desktop/src/renderer/components/workbench/changes-view.tsx:70` (the per-file batches this replaces). `git diff -z -M --raw --numstat <base>` was verified to produce parseable status + path + count records in one call.
- **Every per-file content request uses the base commit id the list returned**, never an independently resolved base. The renderer's own `resolveBase` goes away. How the file's content is fetched (e.g. `git show <base>:<path>` plus the working-tree file, or `git diff -U<large> <base> -- <paths>`, over the existing `exec`/`fsRead` RPCs or a second new RPC) is the executor's call; the criterion is that the right pane gets enough to highlight **each side as a whole file** (not concatenated hunks, which is what breaks syntax context today) and to reveal any collapsed gap without another design. Renames must show the old path's content on the left.
  Based on: `apps/desktop/src/renderer/components/workbench/changes-view.tsx:26` (`resolveBase`), `apps/desktop/src/renderer/components/workbench/changes-view.tsx:110` (highlighting concatenated hunks).
- **The large-diff guard considers both changed lines and size**, from the list entry, before fetching content. A file with a two-line change inside a multi-megabyte file is "large" too. Exact thresholds are the executor's call; they must keep the right pane responsive and must sit below transport limits.
  Based on: `crates/worker/src/ops.rs:12` (`fsRead` refuses files over 2 MB), `crates/worker/src/ops.rs:11` (`exec` default 60 s timeout).
- **(decided while planning) An old worker must surface the 「daemon 需要更新」 hint promptly, not after a 20-second timeout and not as a stray global error.** A worker built before this plan cannot decode the new oneof field: prost leaves the payload empty and the worker answers `empty_payload` **without a request id**, so the client cannot correlate it through the normal path and the request would otherwise sit until `DEVICE_REQUEST_TIMEOUT_MS` while the unmatched error goes to `options.onError`. The client must attribute that answer to the in-flight request(s) of the new payload type(s) and fail them with a distinguishable code the view renders as the update hint. No `exec`-based fallback path. **(revised on plan audit)** The attribution must be keyed on the lane the error arrived on, and the existing heartbeat branch must be narrowed the same way: today that branch claims **any** id-less `empty_payload` while a `ping` is pending, regardless of channel, so on a current worker (which answers `ping`) a list error landing inside the one-RTT ping window every 15 s would be recorded as "heartbeat unsupported", permanently stop that route's heartbeat, and still leave the list request to time out. Heartbeats go only on the session lane; RPC requests go only on the elevated lane; `handleDeviceError` already receives the `channel` and already tests `channel.lane === "elevated"`. So: the heartbeat branch only claims an id-less error that arrived on the session lane; an id-less `empty_payload` (not `unsupported_payload`) on the elevated lane fails every in-flight request whose payload case is one this plan adds. A `device-router.test.ts` unit test covers both directions (mirror the heartbeat case near `device-router.test.ts:1176`): the id-less error on the elevated channel rejects the list request with the distinguishable code, leaves `errors` untouched and heartbeat/RTT state unchanged; on the session channel the heartbeat branch behaves as before. Rejected: relying on `unsupported_payload` — that code is only sent for payloads the new worker knows but a client may not originate. Rejected: an `exec` fallback — a second implementation kept alive for a window the worker hot-push closes anyway.
  Based on: `crates/worker/src/device.rs:1882` (empty payload → `empty_payload`, request id `None`), `packages/client/src/device-router.ts:1476` (heartbeat attribution of an id-less `empty_payload`, no channel check), `packages/client/src/device-router.ts:1717` (heartbeat sent on the session lane), `packages/client/src/device-router.ts:1960` (requests flushed to the elevated lane), `packages/client/src/device-router.ts:1536` (existing `channel.lane === "elevated"` test), `packages/client/src/device-router.ts:43` (20 s request timeout). Precedent for the same prost behaviour: `apps/desktop/src/main/loopback-tunnel.ts:91`.
- **Rendering stays in-house**, extending `parse-diff.ts` and `diff-highlight.ts` (shiki, `github-dark-default`, lazily loaded grammars) with line numbers, side-by-side row alignment and gap folding. Rejected: `@pierre/diffs` — it renders into a shadow root with its own adopted stylesheet, so the app's Tailwind tokens, the inlined Maple Mono font and the Tooltip rule cannot reach it. Rejected: Monaco's diff editor — several megabytes, its own theme system, and web-worker plumbing in Electron for a read-only view.
  Based on: `apps/desktop/src/renderer/components/workbench/diff-highlight.ts:1`, `apps/desktop/src/renderer/components/workbench/parse-diff.ts:1`, `docs/design-guidelines.md`.
- **No new black-box test.** A broken changes view is visible the first time it is opened, so it does not meet the bar in `AGENTS.md` ("Test harness"). Pure logic the executor extracts (tree compaction, split alignment, gap computation, list parsing in Rust) may get ordinary unit tests where they catch real edge cases (renames, `-z` paths with spaces or non-ASCII, binary `-\t-` numstat), not tests that restate the implementation.
- **Left to the executor**: tree component structure and compaction algorithm; RPC and field names; where the split/inline preference is persisted (`localStorage`, following `use-sidebar-width.ts`); whether the tree splitter reuses `sidebar-resize-handle.tsx`; large-diff thresholds; whether per-file content is a second RPC or existing `exec`/`fsRead`; virtualisation, if expanded large files need it.

## Direction

The list RPC is the boundary: the worker owns "what changed and against what base", the renderer owns presentation and fetches one file's content at a time against that base. `ChangesView` keeps its public contract with `workbench.tsx` (props, activation through `shouldActivateChangesView`, refresh through `shouldRefreshChanges`) so the overlay wiring does not change.

### Milestone 1: the list RPC exists end to end below the UI

`proto/coflux/v1/device.proto` gains the request/response pair; `buf generate` output is committed for every generated target; the worker answers it (scoped like the other RPCs) with base + entries including untracked files; `@coflux/client` exposes it per workspace (like `execInWorkspace`) and turns an old worker's id-less `empty_payload` into a prompt, distinguishable failure.
Validation: the "Proto lint", "Generated code consistent" and "Protocol breaking" rows of Commands; zero-warning `cargo build`; `cargo test -p coflux-protocol`; `COFLUX_HOME= cargo test -p coflux-worker`; `node --import tsx --test packages/client/src/*.test.ts` including the new router test; `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit`; `pnpm -C apps/desktop typecheck`.

### Milestone 2: the two-pane view replaces the stacked view

`ChangesView` renders the tree and the single-file pane with every behaviour and state listed under Requirement, using the list RPC and per-file content against the returned base.
Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`.

Milestone 2 needs milestone 1's client method; they are sequential — one work package, do not fan out.

## Landmines

- **Scope gate.** A new client-originated payload that is not listed in `required_scope` is rejected with `unsupported_payload` ("不能由 client 发起"). Map it to `DeviceScope::Rpc` alongside `ExecRun`/`FsRead`. `crates/worker/src/device.rs:4091`, `crates/worker/src/device.rs:1915`.
- **Request-id plumbing.** Several matches over the payload must learn the new variants or the request never correlates. Worker: `request_id()` (`crates/worker/src/device.rs:4172`; without it the dispatcher answers `invalid_request_id`), `required_scope` (`:4091`), `clear_request_id` (`:3996`), `set_response_request_id` (`:4023`). Client: `requestIdOf` (`packages/client/src/device-router.ts:2562`; without a case, `request()` rejects synchronously with 「Device request 缺少 requestId」 before anything is sent) and the neighbouring `case` switches at `:2576` / `:2596`. **(revised on plan audit)**
- **Generated code has three targets.** `buf generate` rewrites `packages/protocol/src/gen`, `crates/protocol/src/gen` **and** `packages/swift-client/Sources/CofluxProtocol/Generated`; CI fails if any of them differs from the committed tree. `.github/workflows/ci.yml:115`.
- **`check-protocol-breaking.mjs` needs a baseline argument** and exits with a usage error without one. `scripts/check-protocol-breaking.mjs:28`.
- **Worker tests in a Coflux terminal.** Run them as `COFLUX_HOME= cargo test -p coflux-worker`. If presence/hook- or shell-integration-related cases go red locally, treat it as known local environment contamination first (this machine runs Coflux itself), not as a regression of this plan. **(revised on plan audit)**
- **`ChangesView` is kept mounted per workspace** and only hidden when another workspace is selected or the overlay closes; per-workspace selection can live in component state and must survive close/reopen. Background workspaces must not fetch. `apps/desktop/src/renderer/components/workbench/workbench-state.ts:20`, `apps/desktop/src/renderer/components/workbench/changes-view.tsx:40`.
- **Refresh has no content revision.** `shouldRefreshChanges` refetches on re-activation, workspace/base change, additions/deletions change, or manual refresh; additions/deletions are not a cache key. Keep that trigger. `apps/desktop/src/renderer/components/workbench/changes-refresh.ts:11`.
- **Esc is owned by the workbench** while the overlay is open; its capture listener bails on `event.defaultPrevented` (`apps/desktop/src/renderer/components/workbench/workbench.tsx:1135`), so the tree's key handling must never `preventDefault` Esc. `apps/desktop/src/renderer/components/workbench/workbench.tsx:1116`.
- **Transport limits.** A device response over `MAX_DEVICE_FRAME_BYTES` (30 MB) is answered with `response_too_large` (`crates/worker/src/device.rs:2918`); `exec` stdout is unbounded and lossily decoded (`crates/worker/src/ops.rs`); `fsRead` stops at 2 MB. If content goes through `exec git show`, the large-diff guard is the only line of defence.
- **No other hop inspects device payloads** (verified during audit): the server relays opaque bytes (`apps/server/src/hub.ts:16`), the Tailcat helper and desktop transport treat frames as opaque, and the Swift `DeviceRouter.swift` switches have `default` branches — nothing outside the listed scope is needed to carry the new payload.
- **UI rules**: tooltips use the Tooltip component, never native `title`; see `docs/design-guidelines.md`.
- **Paths**: git output must be read with `-z` (or `core.quotepath=false`) so non-ASCII and spaced paths survive; the current code relies on `core.quotepath=false`. `apps/desktop/src/renderer/components/workbench/changes-view.tsx:55`.

## Scope

In scope:
- `proto/coflux/v1/device.proto` and generated code under `packages/protocol/src/gen`, `crates/protocol/src/gen`, `packages/swift-client/Sources/CofluxProtocol/Generated`
- `crates/protocol/src` (non-generated glue, if any is needed)
- `crates/worker/src/device.rs`, `crates/worker/src/git.rs` (and a new worker module if cleaner)
- `packages/client/src` (device router + store method, `device-router.test.ts`)
- `apps/desktop/src/renderer/components/workbench/changes-view.tsx`, `parse-diff.ts`, `diff-highlight.ts`, new files beside them for the tree / diff pane / pure helpers and their unit tests
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/server` — the new RPC is device-channel only; no server change is expected (typecheck still runs)
- The dock button, overlay wiring and Esc handling in `workbench.tsx` — unchanged behaviour
- iOS / Swift client UI — only its generated protocol code changes
- Release, version bumps, docs/releases — a separate release step
- `tests/` black-box suite — no new test (see Decisions)

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint | `cd proto && buf lint` | exit 0 |
| Generated code consistent | `cd proto && buf generate`, then from the worktree root `git status --porcelain -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` (two separate commands — the worktree Bash guard rejects `git -C ..`) | no output after committing |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=90095a31,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-protocol && COFLUX_HOME= cargo test -p coflux-worker` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0 (wire protocol touched) |
| UI walkthrough (acceptance) | local stack or `pnpm dev:desktop:prod` with this branch's worker — see Maintenance notes | by the user |

## Done criteria

- [ ] All listed automated commands pass.
- [ ] Opening 「变更」 issues one list request to the device and fetches content only for the selected file; no per-untracked-file requests remain.
- [ ] The list's totals agree with the dock's `+X −Y` for the same workspace (same base, untracked counted).
- [ ] Every path `git status --porcelain` reports for the workspace (including untracked files over 1 MB and binary untracked files) appears in the tree.
- [ ] The router unit test proves an id-less `empty_payload` on the elevated lane fails the list request without touching heartbeat state, and one on the session lane still reaches the heartbeat branch.
- [ ] Every state and behaviour under "Product conclusions" is implemented, including restore-last-selection, ↑/↓/←/→, draggable tree width, persisted split/inline choice, gap expansion, large-diff guard, binary and rename-only states.
- [ ] Against a worker without the new RPC, the view shows the update hint within a couple of seconds and no global error toast appears.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (e.g. a server change).
- A validation command fails twice after one reasonable fix.
- The old-worker answer turns out to carry a request id or a different code than `empty_payload` — revisit the attribution decision instead of guessing.

## Maintenance notes

- Plan audit (fable, 2026-09-29) revised: the old-worker attribution (lane-keyed, heartbeat branch narrowed), untracked entries for files the count skips, request-id landmines, validation command forms, the COFLUX_HOME note. No finding was rejected.
- Release order: the worker must ship before (or with) the desktop that calls the new RPC; remote workers pick it up through the normal hot push from the latest release. The release notes should mention that 「变更」 on a device whose daemon is not updated shows an update hint.
- A real walkthrough needs a worker that knows the RPC: the bundled daemon in a dev build of this branch, or a local stack (`pnpm dev:pg`, `dev:server`, this branch's `dev:daemon`, `apps/desktop dev`). `pnpm dev:desktop:prod` alone talks to production workers that do not have it yet and will only show the update hint.
