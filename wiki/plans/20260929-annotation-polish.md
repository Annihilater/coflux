# Plan 20260929-annotation-polish: browser annotations feel as precise and quiet as Cursor's Design Mode

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat bcb91b3b..HEAD -- proto crates/protocol crates/worker/src/annotations.rs crates/worker/src/device.rs crates/worker/src/hook.rs crates/cli/src/annotations.rs packages/protocol packages/client/src apps/desktop/src/main apps/desktop/src/shared apps/desktop/src/preload apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/browser-annotations*.ts* apps/desktop/src/renderer/desktop-bridge.ts packages/cli/skills integrations/claude-plugin scripts/check-protocol-breaking.mjs`

## Status

- Priority: P2
- Effort: L
- Risk: MED — a deliberate, non-additive change to the annotation wire messages and on-disk store, plus new gestures inside guest pages
- Depends on: none (parallel group with `20260929-type-scale`; see `wiki/plans/README.md`)
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; the group's plans live on `dev/20260929-annotation-polish` (`.claude/worktrees/20260929-annotation-polish`); as a parallel-group member, `dev:execute-plan` runs this plan in its own worktree cut from that branch and merges it back there
- Planned at: `bcb91b3b`, 2026-09-29

## Requirement

Browser annotations shipped in 2.10.0 (plan `20260929-browser-annotations`) work, but feel rough next to Cursor's Design Mode (cursor.com/docs/agent/design-mode): the card is heavy and saves on ⌘↩, only the innermost element under the pointer can be picked, entering the mode opens a 288 px panel that reflows the page under the pointer, colours are hard-coded, pins cover content, clicking a pin only jumps to the panel, the resolved list is noisy, deletion has no undo, and much text is 10 px. This plan polishes the whole interaction. The hand-off rhythm does **not** change: annotations still accumulate and are handed to an agent from the panel (「交给 agent ▾」) or picked up by `coflux annotations list|watch`. Compatibility with older workers, desktops, CLIs or stored annotations is explicitly **not** a goal (user instruction): choose the cleanest design.

### Product conclusions (confirmed with the user)

1. **Who and when**: unchanged — someone looking at a workspace's page in a built-in browser tab who wants to mark precise changes for that workspace's agent, in batches.
2. **Entering and leaving**: the toolbar control becomes a two-part button `[⬚↖ | n]`: the icon (a dashed-square-with-pointer glyph from lucide) toggles annotate mode; the count toggles the side panel. ⌘⇧D toggles annotate mode from anywhere in the browser tab (the page, the address bar, the tab chrome), matching Cursor. Entering annotate mode **no longer opens the panel**. The 「显示/隐藏批注列表」 item leaves the ⋯ menu. A hint pill at the top of the page reads 「点击选择 · ⇧点击多选 · ⇧拖动框选 · ↑↓ 层级 · Esc 退出」.
3. **Picking**:
   - Click picks the hovered element. While hovering, ↑ selects the parent, ↓ returns one level down the path ↑ climbed. The hover label reads `tag.class · W×H`.
   - ⇧click adds an element to (or removes it from) the current selection without opening the card; releasing ⇧ opens one card for all of them. One annotation then has several elements. Its single pin sits on the first element; when the annotation is selected or its card is open the other elements show dashed outlines. The screenshot covers the union of the elements.
   - ⇧drag draws a region on the **live** page (not a frozen frame). The region is anchored to the innermost element that fully contains it, so it follows scrolling and reflow. The agent receives that container's context, the component names of the top-level elements inside the region, and a screenshot of the region. The pin sits on the region's top-left corner; when selected the region shows a dashed outline. Accepted limit: when only `<body>` contains the region it is a fixed document position and drifts on reflow.
4. **The card** (new annotation, edit):
   - Title: the component chain (`Button ‹ Header ‹ App`), falling back to `tag.class` when there is no source identity; multi-select: 「3 个元素 · Button、Card、Nav」; region: 「区域 · Header」.
   - The input grows with its content up to 8 lines. Enter saves, ⇧Enter inserts a newline, nothing fires while an IME is composing.
   - Screenshot and reference images are 32 px thumbnails in the footer's left, beside a paper-clip button; paste still attaches.
   - No 「取消」 button and no long footer hint: Esc, the ✕, or clicking elsewhere closes it. Clicking elsewhere while the comment has text does not discard it: the card shakes instead.
   - It is positioned from its real measured height and never leaves the page area.
5. **On the page**: hover box, pins, anchor and outlines use the app theme's accent colour (following light/dark); resolved pins use the success colour with ✓. Pins sit on the element's top-right outer edge, not over its content. Clicking a pin — in annotate mode or not — opens a **detail card in place**: comment, images, the agent's note; a pending one offers edit and delete, a resolved one confirm and reopen. It no longer jumps to the panel. If a card with text is being written, a pin click shakes that card; an empty one is replaced.
6. **The side panel**: header 「批注 · n 条待处理」 with only 「交给 agent ▾」 and ⋯ (复制为 markdown, 清除全部已完成) and ✕. Rows group by page. Each row: a number badge in the pin's colour, the comment (≤ 3 lines), and a meta line with the component or 「n 个元素」/「区域」. Hovering a row outlines its element(s) or region on the page. 「已完成 · 等你确认 (n)」 is a collapsible section whose rows lead with the agent's note; confirm (✓) and reopen (↺) are icon buttons shown on row hover, not two permanent buttons per row. Empty state: 「按 ⌘⇧D 进入批注模式，点击页面元素写下要怎么改」.
7. **Undo**: deleting, confirming and 「清除全部已完成」 take effect at once everywhere (every desktop, the agent's `list`), then show a toast with 「撤销」 for a few seconds; undo restores the annotation(s) exactly, images and number included. Quitting the app or closing the tab during that window does not bring the deleted annotation back.
8. **Agent side**: `coflux annotations list` (markdown and `--json`) describes every element of a multi-select annotation with its component chain and context, and for a region annotation the region, its container and the components inside it. The coflux skill says so. 「复制为 markdown」 renders the same information.
9. **Typography** in every surface this plan owns (card, detail card, panel, toolbar button, hint pill, and the labels/pins the page script draws): body text — comments, inputs, agent notes — 13 px; secondary text — component names, page group headings, hint pill, hover label — 12 px; 11 px only for badges such as pin and row numbers; nothing at 10 px or below.
10. **States**: all states of the original plan stay (offline read-only, device unreachable, save failure keeps input and offers retry, element not found 「元素未找到」, screenshot/source failure silently omitted). No version-gated states are added.
11. **Non-goals**: freehand drawing on a frozen frame, voice input, send-on-save to an agent, the design-tweak panel, Variants, compatibility with older workers/desktops/CLIs/stored annotations.
12. **Observable when done**: ⌘⇧D enters and leaves the mode with the page width unchanged; ↑ while hovering selects the container; ⇧click three elements makes one annotation and the agent's `list` shows three component chains; a ⇧drag region's pin sits on the region corner and follows scrolling; clicking a pin opens the detail card in place; delete then 「撤销」 restores it; no text in these surfaces is smaller than 11 px.

## Decisions & tradeoffs

- **No compatibility layer anywhere** *(user instruction)*: no capability flags, no version-gated UI, no migration of stored annotations, no dual wire shapes. Rejected: keeping `Annotation.element`/`source` as a "primary target" for old readers, a worker feature bitmask in `DeviceAnnotationsListed` — both were designed only for mixed-version peers. Based on: the user's instruction after the departure check.

- **One annotation targets 1..n elements, optionally narrowed to a region**: `Annotation` replaces its single `element` + `source` with a repeated target (each target = element context + its own source identity) and an optional region. Target 0 is the anchor: the clicked element, the first ⇧clicked element, or the region's containing element. For a region annotation, targets 1..n are the outermost elements inside the region (a small cap is the executor's call), and the region is stored relative to target 0's box so it follows that element. Numbers `7` and `8` and names `element` and `source` are **reserved** in `Annotation`; nothing may reuse them. Rejected: a separate `extra_elements` list beside a kept `element` — two shapes for one concept; storing the region in viewport or page coordinates — does not follow reflow or scrolling containers. Based on: `proto/coflux/v1/device.proto:1026-1044` (`Annotation`), `:977-1006` (`AnnotationElement`, `AnnotationSource`).

- **The protocol breaking gate stays strict except for these exact deletions**: `WIRE_JSON` must still pass (hence reserving both numbers and names); the `FILE`-level `FIELD_NO_DELETE` diagnostics for exactly the removed annotation fields are added to the checked-in exception list, the same mechanism the Tailcat retirement used. Generalise the list's name/wording if it helps, but it must remain an exact per-diagnostic allowlist. Rejected: loosening the rule set or skipping the check. Based on: `scripts/check-protocol-breaking.mjs:8`, `:24-37`, `proto/tailcat-retirement-allowlist.json`, `.github/workflows/ci.yml:105-107`. *(revised on plan audit)* Verified in a scratch copy with buf 1.71.0: replacing the two fields with `reserved 7, 8; reserved "element", "source";`, adding a repeated target field, a restore variant in the mutate oneof and a removed-ids field on `DeviceAnnotationsMutated` passes `buf lint`, the WIRE_JSON pass exits 0, and the FILE pass reports exactly these two diagnostics, which are the entries to add verbatim:
  - `{"path":"coflux/v1/device.proto","type":"FIELD_NO_DELETE","message":"Previously present field \"7\" with name \"element\" on message \"Annotation\" was deleted."}`
  - `{"path":"coflux/v1/device.proto","type":"FIELD_NO_DELETE","message":"Previously present field \"8\" with name \"source\" on message \"Annotation\" was deleted."}`
  `scripts/check-protocol-breaking.test.mjs:8` asserts the list has 26 entries; it becomes 28. Update the `AnnotationPut` comment (`device.proto:1053-1054`), which still names element/source.

- **Worker store format v2; v1 stores are discarded**: bump `INDEX_VERSION`; an index whose version is not the current one is treated as empty and its workspace directory (index and image files) is removed, logged once. Rejected: converting v1 records — compatibility is not a goal and v1 annotations are short-lived work items. Based on: `crates/worker/src/annotations.rs:43` (`INDEX_VERSION = 1`), `:341-353` (`read_index` accepts any version today), `:71-92` (`StoredAnnotation` with `element`/`source`).

- **Undo is a grace window in the worker, not a delayed request in the renderer**: a delete (single, multiple, confirm, clear-resolved) removes the annotations from `list`, the summary counts, `watch` and agent output immediately and persists that; the records and image files are kept restorable for a bounded window (≥ 30 s; the exact value is the executor's call, comfortably longer than the toast) and purged afterwards — lazily on store access and on worker start is enough. A new mutate action restores a set of ids within the window; the mutate response of a delete or clear-resolved names the ids it removed so one 「撤销」 restores exactly that set. Restored annotations keep id, number, status, images and follow-ups. *(revised on plan audit)* Shape of the store change: deleted records move to a **separate list in the workspace index** (not a flag on the record), so `resolve` (`annotations.rs:660-670`), `reopen`, `put` edits, `read_image`, `counts()`, `list` and `agent_json` keep reading only live annotations; image-file removal moves from `delete` (today right after commit, `:593-613`) to the purge; `clear_resolved` (`:616-628`, today two lock acquisitions: collect ids, then `delete`) becomes one operation under one lock so the ids it reports are exactly the ids it removed; purge runs lazily when an index is loaded (`index()`) and in `scan()` — there is no worker-start hook in `AnnotationStore::new`, the unconditional scan is `publish()` after auth (`crates/worker/src/main.rs:1533`); restore re-checks the per-workspace annotation cap; `next_number` never reuses numbers, so a restored number cannot collide. Restore is a new variant **inside** the `DeviceAnnotationsMutate` oneof, not a new envelope payload: the worker's dispatch tables (`crates/worker/src/device.rs:4200` `worker_operation_id`, `:4224`, `:4250`, `:4350`, `:4400`, `:4447`) and the client's `requestIdOf`/`responseRequestId`/`normalizePayload` need no new entries; the client changes are the mutate result and change union in `packages/client/src/store.ts:99-107`. Rejected: the renderer delaying the delete request for the toast's lifetime — an app quit inside the window would resurrect the annotation, and other desktops/agents would still see it. Based on: `crates/worker/src/annotations.rs:593-640` (`delete` removes files at once, `clear_resolved`), `crates/worker/src/device.rs:2109-2130` (`annotations_mutate` dispatch), `proto/coflux/v1/device.proto:1061-1109` (`AnnotationDelete`, `DeviceAnnotationsMutate`/`Mutated`). The toast's action slot exists: astryx `ToastSurface` `endContent` (`@astryxdesign/core/dist/Toast/Toast.d.ts:7`).

- **Gestures live in the page script; framing stays in main; UI stays in the renderer**: the isolated-world script recognises hover, ↑/↓ level changes, click, ⇧click accumulation (finalised on ⇧ release — and on window blur, so a missed keyup cannot leave it pending), and ⇧drag (distinguished from ⇧click by a movement threshold), and reports one pick carrying 1..n elements and an optional region. Main keeps doing the screenshot (existing capture + crop, now of the union rect or the region, clipped to the viewport) and the main-world source-identity read per element, bounded in time. The renderer draws the card, the detail card, the panel and the hint pill. The guest keeps **no preload** and `gateWebview` stays as it is. Rejected: moving gestures into a renderer overlay over the `<webview>` — it would block the page's own hover states and scrolling. Based on: `apps/desktop/src/main/browser-annotator-page.ts:253-310` (hover/click/pick), `:292-310` (pick hides overlays for the capture frame), `apps/desktop/src/main/browser-annotator.ts:323-343` (event relay), `apps/desktop/src/shared/desktop-bridge.ts:191-216` (state and pick types).

- **While a card is open the page stays captured** *(decided while planning)*: today annotate mode switches off when a draft opens (`mode: annotating && draft === null`), so a click on the page reaches the page (navigating, submitting) instead of closing the card. With a card open the page must swallow pointer input and report "clicked outside" to the renderer, which closes an empty card or shakes a non-empty one. Based on: `apps/desktop/src/renderer/components/workbench/browser-view.tsx:323-327`.

- **Colours come from the theme, passed in the annotator state**: the renderer resolves the theme's accent, success and on-accent colours and sends them with the state it already pushes to main; the page script contains no palette of its own (today it hard-codes `#3b82f6`, `#f59e0b`, `#16a34a`). Based on: `apps/desktop/src/main/browser-annotator-page.ts:218-229`, `apps/desktop/src/renderer/components/workbench/browser-view.tsx:563-568` (state push).

- **Pin detail and row-hover outlines reuse the existing anchor/state channel**: the pin click already reports the annotation id; the detail card anchors to the pin's element through the existing `{kind:"pin"}` anchor and its `anchor` rect events; the hovered panel row is one more field of the annotator state. Based on: `apps/desktop/src/main/browser-annotator-page.ts:376-394` (anchor rect reporting), `apps/desktop/src/renderer/components/workbench/browser-view.tsx:316-321`, `:735-738`.

- **⌘⇧D goes through the existing browser-key routing**: inside the page it is classified in main like ⌘L/⌥⌘I and forwarded; in the tab's own chrome the renderer's key handler takes it. It is not a global app menu accelerator (it means nothing outside a browser tab). Based on: `apps/desktop/src/main/browser-policy.ts:166` (`classifyGuestKey`), `apps/desktop/src/main/browser-host.ts:628`, `apps/desktop/src/renderer/components/workbench/browser-view.tsx:952-967`.

- **Toolbar count segment** *(decided while planning)*: the count segment shows the pending count; when nothing is pending but resolved annotations exist it shows a ✓ with the resolved count; it is absent only when the workspace has no annotations at all (the panel is then reachable from ⌘⇧D's empty state — the panel is not needed). Based on: the removal of the ⋯ menu entry (Requirement 2).

- **Type scale**: the same scale as plan `20260929-type-scale` — 13 px body, 12 px secondary, 11 px badges only, nothing ≤ 10 px, via the app's tokens (`text-base`/`text-sm`/`text-xs` → 13/12/11 px), never `text-2xs` or arbitrary `text-[Npx]`. The page script's own labels follow the same numbers. Based on: `apps/desktop/src/renderer/index.css:82-88`; plan `20260929-type-scale` removes the `2xs` rung.

- **No new black-box test**: every break is visible on first use. Rust unit tests for the store (v2 discard, targets/region round trip, delete → restore within the window → purge after it, clear-resolved restore as a set) and TS unit tests for pure helpers that gain real logic (markdown for multi/region, card placement, pin placement) are expected; do not add tests that restate rendering. Based on: `AGENTS.md` "Test harness".

- **New renderer files are named `browser-annotations-*`** *(decided on plan audit)*: the parallel plan's small-text gate excludes exactly `browser-view.tsx` and `browser-annotations*`, so a file named otherwise would fall between both plans' gates.

- **Left to the executor**: exact field and message names; the region's stored representation (relative px + anchor size, or fractions); the cap on multi-select and region-inner elements; the undo window length (≥ 30 s) and toast duration; shake animation; exact icon; how ↓ behaves after the pointer moves (reset the level stack on a new hover target is fine); card and detail-card component structure.

## Direction

```text
page script (isolated world): hover · ↑↓ level · click · ⇧click set · ⇧drag region · outside-click while a card is open · pins/outlines in theme colours
   │ binding: pick{elements[1..n], region?, rects} · pin-click · outside-click · anchor rects
   ▼
desktop main: union/region screenshot (existing capture+crop) · per-element source identity · ⌘⇧D classification
   │ IPC
   ▼
renderer: [⬚↖|n] · hint pill · card · detail card · panel · undo toast ──device channel──▶ worker
worker: store v2 (targets + region, grace deletion + restore) · agent list/watch/resolve ◀── coflux CLI
```

Follow the conventions of the original plan (`wiki/plans/20260929-browser-annotations.md`): SESSION_CONTROL device payloads, never listed in `worker_operation_id`; images never via fs payloads; the device frame budget for uploads; `docs/design-guidelines.md` (Tooltip, never native `title`; never `display:none`/move/re-key a `<webview>`); English code comments; the coflux skill in English.

### Milestone 1: wire, store and agent output

`Annotation` carries targets and an optional region with the old fields reserved; the mutate protocol has the restore action and reports removed ids; generated code is regenerated for Rust, TS and Swift; the breaking check passes with the exact new exceptions. The worker stores v2 (discarding v1), keeps deleted annotations restorable for the window, and serves restore; agent JSON and the CLI's markdown describe every target and the region. Validation: `cd proto && buf lint && buf generate` leaves the generated dirs clean after commit; `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=bcb91b3b,subdir=proto"` exits 0; `node --test scripts/check-protocol-breaking.test.mjs` passes; `cargo build --release -p coflux-worker -p coflux-cli` has zero warnings; `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker -p coflux-cli` passes.

### Milestone 2: page instrumentation and main process

The page script and main implement Requirement 3 and 5's page half: level traversal, ⇧click sets, ⇧drag regions, one pick event with 1..n elements and an optional region, the union/region screenshot, per-element source identity, capture-while-card-open with outside-click reporting, theme colours from state, pins on the top-right outer edge, outlines for the selected annotation and the hovered row, ⌘⇧D classification in guests. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test`.

### Milestone 3: renderer UI and client wiring

The toolbar two-part button, hint pill, card, detail card, panel, undo toasts, empty state and ⌘⇧D in the tab chrome, per Requirement 2–9; the client/store expose restore and removed ids; 「复制为 markdown」 renders targets and regions. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build`; `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` shows no errors beyond the 12 baseline errors in `src/connection.test.ts`.

### Milestone 4: skill

`packages/cli/skills/coflux/SKILL.md` explains multi-element and region annotations as the agent sees them (without repeating CLI help); the plugin copy is synced and `integrations/claude-plugin/.claude-plugin/plugin.json` is bumped. Validation: `node scripts/sync-claude-plugin.mjs && git diff --exit-code -- integrations/claude-plugin/skills`.

Dependencies: M1 and M2 are independent (M2's pick shape is desktop-internal, `apps/desktop/src/shared/desktop-bridge.ts`). M3 needs M1 (generated types, restore) and M2 (pick/outside-click/palette events). M4 needs M1's output shape. Safe to fan out M1 ∥ M2, then M3, with M4 alongside M3.

## Landmines

- **Focus decides who receives ↑/↓ and ⇧**: after clicking the toolbar button focus sits in the renderer, so the page never sees the keys. Entering the mode must focus the page (`focusPage` exists in `browser-view.tsx`). Page keydown listeners must stop ↑/↓ from scrolling the page only while in annotate mode with a hover target.
- **⇧ release can be missed** (focus leaves the window mid-gesture); finalise a pending ⇧click set on blur too, and never leave the page's input swallowed after the mode ends.
- **Picks hide overlays for the capture frame** (`browser-annotator-page.ts:292-310`, 4 s safety timeout); multi/region picks must keep that contract or the screenshot shows the highlight boxes.
- **The in-page script is a `String.raw` template**: no template-literal syntax inside it (`browser-annotator-page.ts:13-14`), and it must act only in the top-level frame.
- **Relocation keys off target 0 only**; a region's pin and outline derive from target 0's current box. A multi-select annotation whose other elements are gone still shows its pin; mark 「元素未找到」 only when target 0 is missing.
- **The debugger must not be touched before the guest's first navigation, every `sendCommand` stays time-bounded**, and main-world reads for n elements must share one bounded budget — see the original plan's landmines (`wiki/plans/20260929-browser-annotations.md`, "Landmines").
- **`worker_operation_id` leaks to the center** (`crates/worker/src/device.rs:4200`): restore travels inside `DeviceAnnotationsMutate`, which is not listed there — keep it that way; do not invent a new envelope payload for restore.
- **The screenshot silently disappears for rects outside the viewport**: `captureElement` (`apps/desktop/src/main/browser-annotator.ts:361`) calls `elementCropFraction(pick.rect, pick.viewport)`, which returns null for a rect not inside the viewport — clip the union/region rect to the viewport before asking for the crop.
- **`apply()` drops picked elements whenever the anchor is not a pick** (`browser-annotator-page.ts:451-453`, `picked.clear()`): during ⇧click accumulation the state must keep a pick anchor, or `pickedElement(token)` and the rects are lost. `readSource` resolves one element per token with `SOURCE_TIMEOUT_MS = 1500` each — parameterise it per element and share one overall budget.
- **`annotatorStateNeedsPage()` decides whether the debugger is attached at all** (`apps/desktop/src/main/browser-annotator-policy.ts`): new state fields (palette, hovered row) must not make it true for tabs without annotate mode, pins or an anchor, or every browser tab gets a debugger.
- **Upload budget**: one save is one device frame (`MAX_ANNOTATION_UPLOAD_BYTES`); a union screenshot of distant elements can be large — crop to the viewport and keep the existing compression path.
- **`<webview>` hygiene**: the card, detail card and outlines are renderer layers over the webview; never hide, move or re-key it (`docs/design-guidelines.md`, "Browser tabs").
- **Plan `20260929-type-scale` unregisters `text-2xs`** in parallel: after merge no `.text-2xs` rule exists. Use only `text-base`/`text-sm`/`text-xs`.
- **Do not edit `wiki/plans/README.md` from the member worktree**: both members' rows sit next to each other and would conflict at merge; the orchestrator updates statuses after merging.
- **Local Rust tests are polluted by running inside coflux**: run them as `COFLUX_HOME= cargo test …`; cargo fail-fast skips later crates, and a pipe hides the exit code.
- **`packages/client` typecheck is red at baseline** (12 errors in `src/connection.test.ts`); judge only new errors.
- **Bash here is zsh**: write `${VAR}:path`, not `"$VAR:path"`.

## Scope

In scope:
- `proto/coflux/v1/device.proto`, the protocol breaking exception list and its script/test (`scripts/check-protocol-breaking*.mjs`), generated `crates/protocol/src/gen`, `packages/protocol/src/gen`, `packages/swift-client/**/Generated`
- `crates/worker/src/annotations.rs`, `crates/worker/src/device.rs`, `crates/worker/src/hook.rs` (annotation actions only)
- `crates/cli/src/annotations.rs`
- `packages/client/src/**` (annotation request/store paths)
- `apps/desktop/src/main/browser-annotator*.ts`, `apps/desktop/src/main/browser-policy.ts`, `apps/desktop/src/main/browser-host.ts` (annotator and key routing only), `apps/desktop/src/shared/desktop-bridge.ts`, `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/desktop-bridge.ts`
- `apps/desktop/src/renderer/components/workbench/browser-view.tsx` (this plan owns the whole file, including its non-annotation small text)
- `apps/desktop/src/renderer/components/workbench/browser-annotations*.ts(x)` and new files beside them
- `packages/cli/skills/coflux/SKILL.md`, `integrations/claude-plugin/**`
- This plan (`wiki/plans/README.md` is updated by the orchestrator after merge, not by the member)

Out of scope:
- Every other renderer file, `apps/desktop/src/renderer/index.css`, `apps/desktop/src/renderer/main.tsx`, `docs/design-guidelines.md` — owned by `20260929-type-scale`
- `apps/server/**` — the summary message does not change
- `tests/**` — no new black-box test
- Freehand drawing, voice, send-on-save, design-tweak panel, Variants

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Dependencies (first) | `pnpm install --frozen-lockfile` | exit 0 |
| Proto lint / generate | `cd proto && buf lint && buf generate && git diff --exit-code -- ../crates/protocol/src/gen ../packages/protocol/src/gen ../packages/swift-client` (after committing generated code) | exit 0 |
| Proto breaking | `cd proto && node ../scripts/check-protocol-breaking.mjs "../.git#ref=bcb91b3b,subdir=proto"` | exit 0 |
| Breaking script test | `node --test scripts/check-protocol-breaking.test.mjs` | exit 0 |
| Rust build | `cargo build --release -p coflux-worker -p coflux-cli` | exit 0, zero warnings |
| Rust tests | `COFLUX_HOME= cargo test -p coflux-protocol -p coflux-worker -p coflux-cli` | exit 0 |
| Server typecheck | `node_modules/.bin/tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| Client typecheck | `node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` | only the 12 baseline errors in `src/connection.test.ts` |
| Desktop | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| Skill sync | `node scripts/sync-claude-plugin.mjs && git diff --exit-code -- integrations/claude-plugin/skills` | exit 0 |
| Small text in owned files | `grep -n -e text-2xs -e 'text-\[[89]px\]' -e 'text-\[1[01]px\]' apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/browser-annotations*` (no `\|` alternation: in this shell `grep -E` treats `\|` literally and the gate would always be empty) | no output |
| Group exit gate (after both group members are merged) | `grep -rn -e text-2xs -e 'text-\[[89]px\]' -e 'text-\[1[01]px\]' -e coflux-text-2xs apps/desktop/src/renderer` | no output |
| Black-box core | `pnpm -C tests test` (wire protocol touched; no annotation case exists, this guards the rest of the wire) | exit 0 |
| Walkthrough (acceptance) | the workspace's device must run a worker built from this branch; follow `docs/desktop-acceptance.md` and the desktop-preview skill (`pnpm dev:desktop:prod` against an installed runtime running this branch's worker, or the local stack) — never stage a daemon into a dev build | the user walks Requirement 12 |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] Every product conclusion in Requirement is implemented; nothing from its non-goals is.
- [ ] `Annotation` has no `element`/`source` fields; their numbers and names are reserved; the breaking exception list gained exactly those deletions.
- [ ] A v1 annotation store is discarded on first access; a v2 store round-trips targets and region.
- [ ] Delete, confirm and clear-resolved disappear from `list`, summary counts and other desktops at once, restore within the window intact, and are purged (images included) after it; an app quit inside the window does not resurrect them.
- [ ] `coflux annotations list` shows every target's component chain and, for a region, the region and its container.
- [ ] Entering annotate mode never changes the page's width; ⌘⇧D works with focus in the page and in the tab chrome.
- [ ] The page script contains no hard-coded palette; pins sit outside the element's top-right corner.
- [ ] No text in this plan's surfaces (renderer and page script) is below 11 px, and 11 px is used only for badges.
- [ ] The guest still has no preload; no annotation payload is in `worker_operation_id`; images never travel as fs payloads.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files (in particular `index.css`, `main.tsx` or another renderer component — those belong to `20260929-type-scale`).
- `buf breaking` reports diagnostics other than the intended annotation field deletions.
- A validation command fails twice after one reasonable fix.
- ⇧click/⇧drag cannot be recognised inside the page without breaking the page's own input when annotate mode is off.

## Maintenance notes

- Releases must ship worker and desktop together: an older worker cannot store the new shape, an older desktop cannot read it. Release notes must say existing annotations are cleared by the upgrade and that ⌘⇧D now toggles annotate mode.
- The region is anchored to target 0; if pages with heavy virtualisation make regions drift, consider anchoring to the region's top-level elements instead.
- Freehand drawing on a frozen frame (Cursor's "draw on the page") would reuse the existing region-capture overlay in `browser-view.tsx`; it was deliberately left out.
