# Plan 20260929-browser-scope-partitions: Built-in browser state is shared per project, and per device on the device view

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat debb5738..HEAD -- apps/desktop/src/shared/browser-partitions.ts apps/desktop/src/shared/desktop-bridge.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/browser-policy.ts apps/desktop/src/main/browser-host.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/components/workbench/browser-runtime.ts apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/workbench.tsx packages/client/src/store.ts`

## Status

- Priority: P2
- Effort: M
- Risk: MED
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; work lives on `dev/20260929-browser-scope-partitions` in `.claude/worktrees/20260929-browser-scope-partitions`
- Planned at: `debb5738`, 2026-09-29

## Requirement

The desktop app's built-in browser (plan 20260924-desktop-browser-tab) gives every **workspace** its own persistent Electron session partition (`apps/desktop/src/shared/browser-partitions.ts:8-11`). Logging into a site in one worktree of a project therefore does nothing for the project's other worktrees: the user logs in again in every worktree. The user wants the login state to follow the **project** instead.

Product conclusions (confirmed by the user in exploration):

1. **Scope of sharing.** Browser state — cookies, localStorage/IndexedDB and other storage, HTTP cache, trusted certificates, site permissions — is owned by a *browser scope*:
   - a workspace that belongs to a project → the **project**: every worktree of that project shares one state;
   - a directory workspace (no `projectId`; the carrier of the device detail view, `packages/client/src/store.ts:443-445`) → the **device**: one state per device, *not* shared with any project on that device.
   Different projects stay isolated from each other; different devices stay isolated from each other; a project and its device's device view stay isolated.
2. **Only state is shared.** Tabs remain per workspace: each workspace shows only the tabs opened in it. History is already global on this Mac (`apps/desktop/src/renderer/components/workbench/browser-library.ts:4`) and does not change. Annotations stay per workspace.
3. **Remote projects are unchanged.** A remote project's `localhost` still reaches the project's device through the tunnel; a local one is still this Mac.
4. **Clear actions follow the scope.** ⋯ → 清除 Cookies / 清除缓存 / 清除已信任的证书 act on the current tab's scope (project or device), which affects the tabs of every worktree in that project. The menu copy does not change.
5. **localhost cookie collision is accepted.** Cookies ignore ports, so two worktrees of one project running dev servers on `localhost:3000` and `:3001` overwrite each other's same-named localhost cookies. This is accepted; no per-host carve-out.
6. **No migration.** Existing per-workspace browser data is deleted, not merged: after the upgrade every project and device starts empty and the user logs in once per project. The release notes must say so.

Observable when done: log into a site in worktree 1 of project A → open the same site in worktree 2 of project A: already logged in. Open it in project B, or in the device detail view: not logged in. Clearing cookies from a tab in worktree 2 logs worktree 1's tabs out of that site too.

## Decisions & tradeoffs

- **The partition identity is the browser scope, not the workspace**: a scope is either a project (by `projectId`) or a device (by `daemonId`), and exactly one persistent partition exists per scope. Every piece of browser state main or the renderer currently keys by workspace id for partition purposes moves to the scope: the `browserPrepare` / `browserClearData` IPC payloads and their parsers, main's per-partition entry and the `mode` event it emits, the certificate records (already keyed by partition name), and the renderer runtime's `prepared` / `modes` caches. Rejected: keeping `workspaceId` in the IPC and letting main map it to a project — main has no client store and cannot know a workspace's project. Based on: `apps/desktop/src/main/browser-host.ts:420-427` (entry built from `workspaceId`), `:255` (`mode` event carries `workspaceId`), `:752-753` (clear by workspace), `apps/desktop/src/main/browser-policy.ts:27-35` (partition ⇄ workspace id), `:320-323` and `:380-383` (IPC payload parsers), `apps/desktop/src/renderer/components/workbench/browser-runtime.ts:167-182` (caches keyed by workspace).
- **The renderer derives the scope from the workspace; the rule is fixed**: `isDirWorkspace(workspace)` (i.e. `!workspace.projectId`) → device scope keyed by the workspace's `daemonId`; otherwise → project scope keyed by `projectId`. `projectId` is a proto3 `string`, so a directory workspace carries `""`, not `undefined`: a presence test such as `projectId !== undefined` is wrong and must not be used. The scope is derived where the workbench builds each browser view's entry (it already iterates `Workspace` objects that carry `projectId` and `daemonId`, `apps/desktop/src/renderer/components/workbench/workbench.tsx:989-1004`), and it is **never written into the persisted tab record** (`BrowserTabRecord`, `browser-runtime.ts:79-84`). Rejected: storing a scope on the tab — a workspace never changes project, so a stored copy can only go stale. (revised on plan audit) Based on: `packages/protocol/src/gen/coflux/v1/common_pb.ts:123-141` (`projectId: string`), `packages/client/src/store.ts:443-445`, `apps/desktop/src/renderer/components/workbench/browser-view.tsx:578-590` (prepare call site).
- **A scope's `mode` event reaches every workspace in that scope**: a tab looks up its mode by its scope, so when main reports a mode change for a project partition, the tabs of all that project's worktrees update. The runtime has no client store and today matches mode events to tabs through the persisted `workspaceId` (`browser-runtime.ts:127-131`); it learns each tab's scope transiently — the view hands its scope to the runtime when it registers (living and dying with the handlers), or the workbench injects a `scopeOf` resolver — never through the persisted record. Rejected: fanning the event out per workspace in main — main does not know the workspaces. (revised on plan audit)
- **Invariant: a scope maps to exactly one daemon.** A project lives on one device; a device scope is its own device. main records the `daemonId` with the scope's entry on first prepare and **rejects** a later prepare of the same scope with a different `daemonId` (an error to the caller, no reconfiguration). The existing re-pointing path — the comment at `browser-host.ts:273` ("a workspace prepared again may have moved") and the `entry.daemonId = daemonId` reassignment near `:430` — is removed, not kept alongside the check. Local/remote mode, the loopback proxy and the tunnel are therefore decided per scope exactly as they are per workspace today. Rejected: silently re-pointing the partition to the new daemon — it would route one project's `localhost` to two devices over time. Based on (verified on plan audit): `projects.daemon_id` and `workspaces.project_id` are never updated (`apps/server/src/store.ts:799-865`); workspaces are created on `project.daemonId` (`apps/server/src/hub.ts:3197,4479`); a daemon's worktree report must match `project.daemonId` (`hub.ts:1640-1643`); removing a device deletes its projects, and re-enrolment mints new UUIDs (`store.ts:989-993`); pending workspaces never produce browser entries (`workbench.tsx:955`). (revised on plan audit)
- **Device-scope ids pass the partition charset check in policy.** `sanitizePrepare` today only length/control-checks `daemonId` (`browser-policy.ts:322-326`); once `daemonId` becomes a partition id it must pass `isPartitionSafeId` in the policy layer like any other scope id. (decided while planning, revised on plan audit)
- **New partition names in two disjoint namespaces**: project partitions and device partitions each get their own prefix, both distinct from the old `persist:coflux-browser-` prefix, so that no project id can ever produce a device partition name (or vice versa) and every old partition is recognisable by prefix alone. Suggested shape: `persist:coflux-web-project-<projectId>` and `persist:coflux-web-device-<daemonId>`; exact spelling is the executor's call provided the three prefixes are pairwise non-overlapping (neither is a prefix of the other) and ids still pass the conservative charset check (`browser-policy.ts:22-25`). The DevTools host partition (`BROWSER_DEVTOOLS_PARTITION`) must remain unproducible from any id, as today. Rejected: reusing the old prefix with a new suffix shape — old and new directories would be indistinguishable to the cleanup, and old certificate records would keep parsing as valid.
- **Old per-workspace data is deleted, not migrated**: at startup, before any browser session is created, main removes the on-disk data of every partition under the old `coflux-browser-` prefix **except** the DevTools host's name — `BROWSER_DEVTOOLS_PARTITION` is `"coflux-browser-devtools"`, which itself starts with the old prefix (`browser-partitions.ts:11,18`); it is in-memory and never on disk, but the selection rule must exclude it explicitly. (revised on plan audit) Old records in the trusted-certificates file are dropped because the parser only keeps partitions it recognises (`browser-policy.ts:264-275`); after the prefix change it must recognise the new names and not the old ones. Rejected: copying the main worktree's partition into the new project partition — extra one-off logic for a feature shipped five days ago, and it would still lose every other worktree's state. The release notes carry one line saying built-in browser logins must be redone once.
- **Tabs, annotations and history are untouched**: a tab still belongs to a workspace (`browser-runtime.ts` `createTab(id, workspaceId, url)`), annotations stay per workspace in the worker, and the annotator does not depend on a partition-derived workspace (`browser-host.ts:699-701`, `annotator.adopt(contents)`). Popups opened by a page open as a tab in the same workspace as today and therefore land in the same scope.
- **Clear actions keep their copy and act on the scope** (product conclusion 4). No confirmation dialog is added.

Left to the executor: the scope's encoding in TypeScript and on the wire, IPC field names, where exactly in main's startup the cleanup runs (it must precede the first `session.fromPartition` for a browser partition), and how far unit tests go beyond the pure policy functions.

## Direction

The change is desktop-only (`apps/desktop`): no protocol, server, worker or CLI change. The pure rules live in `main/browser-policy.ts` (unit-tested under plain Node) and `shared/browser-partitions.ts`; `browser-host.ts` applies them to Electron; the renderer only passes scopes and uses the partition names main hands back.

### Milestone 1: Scope-keyed partitions in main and the bridge

main prepares, gates, clears and reports mode per scope; partition names use the new disjoint prefixes; a scope refuses a second daemon; the certificate store recognises only new names. The bridge types and preload pass a scope instead of a workspace id. Validation: `pnpm -C apps/desktop test` and `pnpm -C apps/desktop typecheck` exit 0, with `browser-policy.test.ts` covering: project vs device name derivation and non-collision, rejection of unsafe ids, round-trip partition → scope, old-prefix names rejected by the attach gate and dropped by the certificate parser, and the IPC payload parsers accepting a valid scope and rejecting malformed ones.

### Milestone 2: The renderer derives and uses scopes

Tabs derive their scope from their workspace per the fixed rule, the runtime caches prepare results and modes per scope, a scope's mode event updates tabs in every workspace of that scope, and clear actions pass the tab's scope. Depends on milestone 1's bridge types. Validation: `pnpm -C apps/desktop typecheck` and `pnpm -C apps/desktop test` exit 0.

### Milestone 3: Old per-workspace data is removed at startup

Before any browser partition session is created, main deletes the on-disk directories of old-prefix partitions under `<sessionData>/Partitions/`. The first `prepare` cannot race the deletion: either the host holds the cleanup promise and `prepare` awaits it, or the cleanup runs synchronously before the browser IPC is registered — executor's choice. Independent of milestone 2; depends on milestone 1 only for the prefix constants. Validation: `pnpm -C apps/desktop test` exit 0 — a pure helper that selects which **directory names** to delete, with fixtures written as on-disk names (no `persist:`, lowercased, e.g. `coflux-browser-<uuid>`), never as partition strings; cases: old workspace names selected; new project/device names, `coflux-browser-devtools` and unrelated names (e.g. another app's) not selected — and `pnpm -C apps/desktop build` exit 0. (revised on plan audit)

The milestones share `browser-policy.ts` / `browser-partitions.ts` / bridge types and are small: run them as one sequential package, do not fan out.

## Landmines

- **On-disk partition directory naming (verified on plan audit against Electron v44.3.0 source).** `Session::FromPartition` strips `persist:`; the directory is `<DIR_SESSION_DATA>/Partitions/` + `base::EscapePath(base::ToLowerASCII(name))` (`shell/browser/api/electron_api_session.cc`, `shell/browser/electron_browser_context.cc`). So an old partition `persist:coflux-browser-<uuid>` lives in `Partitions/coflux-browser-<uuid>`. All ids are server-minted `randomUUID()` values (lowercase hex and hyphens), so lowercasing causes no collisions. The deletion match compares against the constants with `persist:` stripped and lowercased. Deletion is restricted to direct entries of `Partitions/` whose names match — never a broader glob, never anything outside `Partitions/` — and skips symlinked entries (`lstat`).
- **The directory root is `sessionData`, not `userData`.** `Partitions/` hangs off `DIR_SESSION_DATA`; `app.setPath("userData", …)` (`main/index.ts:46-51`, dev `-dev` suffix and `COFLUX_DESKTOP_USER_DATA`) does not explicitly move it — it only follows `userData` by Chromium's default. Resolve the root through `app.getPath("sessionData")` at cleanup time, after those overrides ran. Observed on dev builds (`Coflux-dev/` holds `Cookies`/`IndexedDB` directly); not directly observed on a packaged build.
- **Ordering.** Deleting a partition directory while a session for it is open is undefined. `session.fromPartition` is called only in `main/browser-host.ts` (DevTools host near `:412`, `prepare` near `:425`, `clearData` near `:756`); `browser-login.ts` and `index.ts` never open a browser partition. Windows are created after `createBrowserHost` (`index.ts:466-523`), but the renderer's first `browserPrepare` can still arrive while an asynchronous delete is in flight — see milestone 3 for the required ordering. (revised on plan audit)
- **This machine has no old data.** No `Coflux*` userData here contains `Partitions/` or `browser-certificates.json`, so milestone 3's effect cannot be observed on this machine without first opening a page in an old build.
- **The attach gate reads the partition twice.** `decideWebviewAttach` (`browser-policy.ts:53-70`) compares the partition from `webPreferences` and from `params` and returns a `workspaceId` for a page guest; its result shape changes with the scope. Keep both-sources agreement and the "must be prepared for this renderer" check intact.
- **`mode` handling in the view has two sources.** `browser-view.tsx:581-586` takes the prepare result's mode and then `runtime.modeOf(...)`; both must be looked up by scope, or a worktree opened after the mode changed shows a stale mode.

## Scope

In scope:
- `apps/desktop/src/shared/browser-partitions.ts`
- `apps/desktop/src/shared/desktop-bridge.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/main/browser-policy.ts`, `apps/desktop/src/main/browser-policy.test.ts`
- `apps/desktop/src/main/browser-host.ts`
- `apps/desktop/src/main/index.ts` (only to hook the startup cleanup, if that is where it belongs)
- `apps/desktop/src/renderer/components/workbench/browser-runtime.ts`
- `apps/desktop/src/renderer/components/workbench/browser-view.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` (only if the tab's workspace/project must be threaded to the view)
- Existing unit tests next to the files above
- `wiki/plans/README.md`, this plan

Out of scope:
- `packages/protocol`, `crates/*`, `apps/server`, CLIs — nothing about browser state crosses the wire.
- Browser tabs' layout persistence, history (`browser-library.ts`), annotations, the tunnel/proxy mechanics themselves.
- Release notes — written at release time; this plan only records that they must mention the one-time re-login.
- A shared/global partition for external sites, per-host carve-outs for localhost — rejected in exploration.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Walkthrough (acceptance) | `pnpm dev:desktop:prod` from this worktree, by the user | the observable behaviour under Requirement |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] Two workspaces of the same project resolve to the same partition; a directory workspace (`projectId: ""`) resolves to its device's partition; two projects, two devices, and a project vs its device view resolve to different partitions (asserted by unit tests on the pure derivation, including the `projectId: ""` case).
- [ ] The persisted browser tab record gains no scope field.
- [ ] A prepare of an existing scope with a different daemon id is rejected (unit-tested at the policy level, or in `browser-host` if the check lives there — then covered by review).
- [ ] Old-prefix partitions are refused by the attach gate, dropped from the certificate store, and their directories selected for deletion by the startup cleanup (fixtures are on-disk directory names); new-prefix names and `coflux-browser-devtools` are never selected.
- [ ] The first `prepare` after launch cannot run while the cleanup is still deleting.
- [ ] Clear cookies / cache / certificates operate on the tab's scope.
- [ ] No `workspaceId` remains in browser partition, prepare, clear or mode plumbing (tab ownership and annotations still use it).
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The installed Electron's partition directory naming differs from the rule under Landmines — stop rather than delete by guess.
- The outcome requires out-of-scope files (e.g. a protocol change to learn a workspace's project).
- A validation command fails twice after one reasonable fix.
- Some code path opens a browser partition session before the startup cleanup can run and cannot be reordered.

## Maintenance notes

- A workspace's project never changes, so the scope is derived, not stored. If projects ever become movable between devices, the "one scope, one daemon" invariant breaks and the scope must include the device.
- The one-time re-login must appear in the release notes of the version that ships this.
- Old records in `browser-certificates.json` stay on disk until the next trusted-certificate write rewrites the file; they are harmless because the parser ignores them.
- localhost cookie collision across worktrees is a known, accepted consequence (product conclusion 5); a report of "switching worktrees logs me out of my dev server" is this, not a bug.
