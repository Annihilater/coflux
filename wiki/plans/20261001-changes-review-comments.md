# Plan 20261001-changes-review-comments: Comment on diff lines and hand the comments to the workspace's agent

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 755f4978..HEAD -- proto/coflux/v1/device.proto crates/worker/src/annotations.rs crates/worker/src/agent_ctl.rs crates/worker/src/device.rs crates/cli/src/annotations.rs packages/cli/skills/coflux/SKILL.md integrations/claude-plugin packages/client/src apps/desktop/src/renderer/components/workbench/browser-annotations.ts apps/desktop/src/renderer/components/workbench/browser-annotations-model.ts apps/desktop/src/renderer/components/workbench/browser-annotations-ui.tsx apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx` — run it against the tip left by plan `20261001-changes-review-polish` as well; that plan changes the changes-view files this one builds on.

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: wiki/plans/20261001-changes-review-polish.md
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — lives on `dev/20261001-changes-review` in `.claude/worktrees/20261001-changes-review`, after plan `20261001-changes-review-polish`
- Planned at: `755f4978`, 2026-10-01

## Requirement

Reviewing an agent's diff in the desktop 「变更」 overlay ends today with the user switching to a terminal and typing what they want changed, quoting file names and lines by hand. Codex, Claude Code and Warp let the reviewer comment on diff lines and send the comments to the agent. Coflux already has the delivery path for this: browser annotations are stored per workspace by the device's worker, an agent reads them with `coflux annotations list` / `watch` and answers with `resolve --note`, and the desktop can type a hand-off instruction into an agent's terminal. This plan makes a comment on a diff line one more kind of annotation on that same path.

Once this is done the user writes comments on lines of the diff, hands them to an agent in one click, and later sees each comment marked handled with the agent's note, right where it was written.

### Product conclusions (confirmed by the user)

- **Writing**: hovering a line's gutter shows a `[+]`; clicking it opens a composer right under that line; dragging along the gutter selects a line range first. Works on either side in split mode and on any row in inline mode. ⌘Enter saves, Esc cancels the composer only (it does not close the overlay). Text only — no images.
- **Storage and numbering**: a code comment is a workspace annotation, numbered together with browser annotations (#1, #2…), stored by the worker like them.
- **Showing**: saved comments render as cards under their line(s) with number, comment and status. A pending one can be edited or deleted; a handled (resolved) one shows the agent's note and offers 「确认」 (removes it, undoable as today) and 「重新打开」 with a follow-up comment — same behaviour as browser annotations. Tree rows show a badge with the file's pending-comment count.
- **Re-anchoring**: after the code changes, a comment follows its original lines' text; if they cannot be found it is shown at the top of its file marked 「原位置已变化」. Comments on files that are not in the current list (e.g. after switching scope, or a reverted file) appear in a 「其他批注」 section at the bottom of the tree, where they can be read, confirmed or deleted.
- **Handing off**: a 「交给 agent ▾」 control in the diff header lists the workspace's agent terminals (same list and behaviour as the browser panel's) and types the hand-off instruction into the chosen one.
- **Agent side**: `coflux annotations list` / `watch` print code comments with file, line range, side and the commented lines; `resolve` works unchanged.
- **Separation**: the browser panel shows only page annotations, the changes view only code comments; numbering is shared.
- **States**: a worker without code-comment support hides the `[+]` and shows the daemon-outdated hint where the composer would be offered. **(revised on plan audit)** When the device is offline or the changes list fails, there is no tree and no diff; the 「其他批注」 section still renders, holding every code comment read-only from the annotations model's last load (as the browser panel does offline).
- **Non-goals**: images in code comments, comments on commits or arbitrary refs, threaded replies beyond the existing reopen follow-up, GitHub sync, suggested-change blocks.
- **Acceptance from the user's side**: a comment written on a diff line appears in `coflux annotations list` with its location and text; after the agent resolves it, the card shows the note; confirming removes it; browser annotations are unaffected.

## Decisions & tradeoffs

- **A code comment is an `Annotation` with a code anchor instead of page targets.** `Annotation` gains an optional code anchor message: worktree-relative path; side (base or working tree); first and last line, 1-based inclusive, on that side; the commented lines' text (capped); and, for a base-side anchor, the base commit id it was read from. An annotation has either ≥1 page target or a code anchor, never neither. The worker's create validation (today "needs at least one element") accepts either. **(revised on plan audit)** An edit that sends no code anchor keeps the stored one, mirroring how an edit without targets keeps targets and region (`crates/worker/src/annotations.rs:737`) — otherwise editing a comment's text drops its location. Rejected: a separate code-comment store and RPC family — duplicates storage, numbering, undo, summary, hand-off and the agent CLI for no product difference. Rejected: encoding the location into the comment text — the agent and the re-anchoring need structured fields.
  Based on: `proto/coflux/v1/device.proto` (`message Annotation`, `targets = 15`, `region = 16`), `crates/worker/src/annotations.rs:640` (create requires targets).
- **Support is an explicit capability on the list response, not an inferred error.** `DeviceAnnotationsListed` gains a flag a new worker sets **unconditionally on every such response, including `ok: false`** (it means "this worker decodes code anchors", not "the store is healthy") **(revised on plan audit)**; the client checks `ok` first. Without the flag the changes view hides `[+]` and shows the hint. Rejected: relying on an old worker rejecting a target-less create — the error is a free-text string, and the user would lose a typed comment before learning it cannot be saved. Rejected: an `empty_payload` probe — the annotation payloads already exist on old workers.
  Based on: `proto/coflux/v1/device.proto` (`message DeviceAnnotationsListed`).
- **The store keeps index format version 2**; the code anchor is an additive optional field. Annotations stored by this worker version stay readable by it; no migration.
  Based on: `crates/worker/src/annotations.rs:53` (`INDEX_VERSION`), `crates/worker/src/annotations.rs:27`.
- **Each surface filters by kind; the shared operations must not cross kinds.** The browser panel lists, pins and counts only page annotations; the changes view only code ones. The browser tab's count badge currently uses the center summary's mixed counts (`annotationCount`), so once the list is loaded the badge counts the loaded page annotations, and the summary counts are only a pre-load fallback (a brief overcount before the first load is accepted). 「清除已处理」 in the browser panel today clears every resolved annotation of the workspace, which would silently remove resolved code comments: the clear must remove only the visible kind (e.g. by deleting explicit ids). Rejected: per-kind counts in the summary — the summary travels through the center (`AnnotationsSummary` → `AnnotationsSummaryUpdated`), widening the change to the server for a cosmetic count.
  Based on: `apps/desktop/src/renderer/components/workbench/browser-annotations.ts:151` (`annotationCount`), `apps/desktop/src/renderer/components/workbench/browser-view.tsx:556` (`clear-resolved`), `proto/coflux/v1/device.proto` (`message AnnotationClearResolved`).
- **The hand-off reuses `handOffAnnotations` and one shared instruction for both surfaces.** `HAND_OFF_INSTRUCTION` stops saying 「浏览器批注」 and covers both kinds; `coflux annotations list` returns both kinds, so one hand-off handles everything pending.
  Based on: `apps/desktop/src/renderer/components/workbench/browser-annotations.ts:14`, `apps/desktop/src/renderer/components/workbench/browser-view.tsx:572`, `packages/client/src/device-router.ts:2615`.
- **The agent sees code comments through the existing worker JSON and Rust renderer.** The worker's agent JSON includes the code anchor; `crates/cli/src/annotations.rs` renders a code comment as its location (`path:start-end`, side, base commit for a base-side anchor) plus the commented lines in a fenced block, instead of page/targets. The npm `coflux.mjs` forwards `annotations` to the native CLI, so there is no JS renderer to change. The skill's annotation section (English) describes both kinds; it is synced into the plugin and the plugin version bumped.
  Based on: `crates/worker/src/annotations.rs:980` (`agent_json`), `crates/cli/src/annotations.rs:244` (`render_annotation`), `packages/cli/coflux.mjs:17`, `packages/cli/skills/coflux/SKILL.md:520`.
- **Re-anchoring is a renderer concern over the stored text.** The stored line range is a hint; the renderer looks for the stored lines' text on the anchor's side of the current content, nearest to the hint, and falls back to 「原位置已变化」. The worker never rewrites anchors. Matching tolerance is the executor's call.
- **The composer owns Esc through an explicit opt-out in the workbench's Esc listener.** That listener is a window capture listener, so it runs before any handler inside the overlay and a `preventDefault` there is too late; it currently skips only when focus is inside a menu, listbox or dialog. It gains one more skip condition the composer satisfies (a marker attribute or role on the composer's container — executor's call), and the composer cancels itself on Esc. Rejected: making the composer a `role="dialog"` just to borrow the existing skip — misleading semantics for assistive tech.
  Based on: `apps/desktop/src/renderer/components/workbench/workbench.tsx:1346`–`1356`.
- **No new black-box test.** A broken comment flow is visible on first use. Worker store/validation and the CLI renderer get Rust unit tests for the code-anchor cases; renderer re-anchoring and kind filtering may get unit tests where they catch real edge cases.
- **Left to the executor**: proto field and message names (append new field numbers; never reuse the reserved 7/8); composer and card components (reuse the browser annotation card pieces where they fit); badge style; the 「其他批注」 section layout; gutter drag mechanics; excerpt cap size.

## Direction

The worker remains the only store; the desktop renders and edits through the existing annotations model; the agent reads through the existing CLI. **(revised on plan audit)** `ChangesView` still gets no new props: the annotations model (`annotationsModelFor(client)`), the workspace's tasks and `sessionAgents` for the agent-terminal list (`client.store`, as `browser-view.tsx:290` does) it reads itself, so `workspace-terminal.tsx` stays untouched.

### Milestone 1: code annotations exist end to end below the UI

Proto (anchor + capability) with generated code for all three targets; worker validation, storage, agent JSON; Rust CLI rendering; skill text and plugin sync; client types pass the anchor through.
Validation: Proto lint, Generated code consistent, Protocol breaking, Rust build, Rust tests, Client tests, Server typecheck, Skill sync, Desktop typecheck rows of Commands.

### Milestone 2: the changes view writes, shows and hands off comments; the browser panel ignores them

Every product conclusion above, including kind filtering of the browser badge and 「清除已处理」, the shared hand-off instruction, and the Esc opt-out.
Validation: Desktop row of Commands.

Milestone 2 needs milestone 1's client types; sequential, one package — do not fan out.

## Landmines

- **Esc ordering** (see Decisions): the workbench capture listener at `apps/desktop/src/renderer/components/workbench/workbench.tsx:1346` runs first; without the opt-out, Esc in the composer closes the whole overlay and loses the draft.
- **IME**: ⌘Enter / Esc handling in the composer must ignore `isComposing`, as the browser composer does (`apps/desktop/src/renderer/components/workbench/browser-annotations-ui.tsx:401`).
- **Mixed counts**: `annotationCount` reads the center summary first (`browser-annotations.ts:151`); forgetting this leaves the browser badge counting code comments.
- **Clear-resolved crosses kinds** on the worker (`AnnotationClearResolved` deletes every resolved one).
- **Undo window**: confirm/delete is restorable for 60 s (`crates/worker/src/annotations.rs:77`, `UNDO_WINDOW_MS`); the changes view should offer the same undo toast the browser panel does, or a confirmed comment is gone for good from the user's point of view.
- **Session-control scope**: annotation payloads require `DEVICE_SCOPE_SESSION_CONTROL`, not RPC (`proto/coflux/v1/device.proto:1049`); keep code annotations on the same requests.
- **Plugin delivery**: the skill's single source is `packages/cli/skills/coflux/SKILL.md`; sync with `node scripts/sync-claude-plugin.mjs` and bump `integrations/claude-plugin/.claude-plugin/plugin.json`; CI checks the copies match. Plugin text must be English.
- **Generated code has three targets; `check-protocol-breaking.mjs` needs a baseline argument** (same as plan `20261001-changes-review-polish`).
- **Worker tests in a Coflux terminal**: `COFLUX_HOME= cargo test -p coflux-worker`.
- **Desktop unit tests are collected only from `*.test.ts`** (`apps/desktop/package.json:13`); a `.test.tsx` file silently never runs.
- **An old desktop against a new worker** shows code comments in its browser panel as target-less annotation cards (it does not crash: pins already filter `targets.length > 0`). Accepted; the release notes say to update the desktop.

## Merge and deploy

- Release order: worker/cofluxd before (or with) the desktop. An old worker hides `[+]` with the hint; browser annotations keep working either way.
- Claude plugin: bump the version and hand the new SHA to `myWsq/plugins-builder` after merge.
- Release notes: code comments in 「变更」 and that `coflux annotations list` now includes them.

## Scope

In scope:
- `proto/coflux/v1/device.proto` and generated code in its three targets
- `crates/worker/src/annotations.rs`, `crates/worker/src/agent_ctl.rs`, `crates/worker/src/device.rs` (`DeviceAnnotationsListed` is built there, `device.rs:2155`)
- `crates/cli/src/annotations.rs`
- `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin` (synced copy, version bump)
- `packages/client/src` (annotation types/model plumbing, tests)
- `apps/desktop/src/renderer/components/workbench/changes-*.ts(x)` and new files beside them; `browser-annotations*.ts(x)`, `browser-view.tsx` (kind filtering, shared instruction); `workbench.tsx` (the Esc opt-out only)
- `wiki/plans/README.md`, this plan

Out of scope:
- `apps/server` — the summary stays as is
- iOS UI
- Release, version bumps other than the plugin's, `tests/` black-box suite

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Proto lint | `cd proto && buf lint` | exit 0 |
| Generated code consistent | `cd proto && buf generate`, then from the worktree root `git status --porcelain --untracked-files=all -- packages/protocol/src/gen crates/protocol/src/gen packages/swift-client/Sources/CofluxProtocol/Generated` | no output after committing |
| Protocol breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=755f4978,subdir=proto"` | exit 0 |
| Rust build | `cargo build` | exit 0, zero warnings |
| Rust tests | `cargo test -p coflux-protocol && COFLUX_HOME= cargo test -p coflux-worker && cargo test -p coflux-cli` | exit 0 |
| Client tests | `node --import tsx --test packages/client/src/*.test.ts` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Skill sync | `node scripts/sync-claude-plugin.mjs --check` (after syncing with `node scripts/sync-claude-plugin.mjs`) | exit 0 |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Black-box (acceptance) | `pnpm -C tests test` | exit 0 (wire protocol touched) |
| UI + agent walkthrough (acceptance) | local stack or a dev build with this branch's daemon; write a comment, hand it to an agent terminal, resolve, confirm | by the user |

## Done criteria

- [ ] All listed automated commands pass.
- [ ] A comment saved on a working-tree line range and one on a base-side line appear in `coflux annotations list` (markdown and `--json`) with path, side, line range, commented lines, and base commit for the base-side one.
- [ ] The worker rejects an annotation with neither targets nor a code anchor, and accepts either alone.
- [ ] Against a worker without the capability, the changes view shows no `[+]` and shows the hint; browser annotations still work.
- [ ] After editing the file so the commented lines move, the card follows them; after deleting them, it shows 「原位置已变化」 at the top of the file; a comment on a file outside the current list appears under 「其他批注」.
- [ ] Esc in the composer cancels it and leaves the overlay open; Esc elsewhere still closes the overlay.
- [ ] The browser panel, its pins and its count badge ignore code comments, and its 「清除已处理」 leaves resolved code comments in place.
- [ ] 「交给 agent」 in the diff header types the shared instruction into the chosen agent terminal.
- [ ] The skill describes code comments, the plugin copy is synced and its version bumped.
- [ ] Implementation follows every entry in Decisions & tradeoffs; no out-of-scope files changed; `wiki/plans/README.md` updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (in particular, plan `20261001-changes-review-polish` changed the diff pane in a way that leaves no line gutter to attach to).
- The outcome requires out-of-scope files (e.g. the server).
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- Code and page annotations share one store and numbering on purpose; a future kind (e.g. terminal output) should follow the same anchor-instead-of-targets pattern.
- Plan audit (fable, 2026-10-01) revised: the capability flag is set on every list response including `ok: false`; an edit without an anchor keeps it; `ChangesView` self-sources the model, tasks and agents (no new props); the offline/list-failure state renders 「其他批注」 read-only; `device.rs` is a definite scope item; test-glob and old-desktop landmines; `--untracked-files=all` and `sync-claude-plugin.mjs --check`. Verified by the audit and kept: the center does not parse device payloads, `StoredAnnotation`'s `#[serde(flatten)] extra` preserves the anchor across a worker rollback. No finding was rejected.
