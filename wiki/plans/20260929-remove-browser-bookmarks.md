# Plan 20260929-remove-browser-bookmarks: The built-in browser has no bookmarks

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 90095a31..HEAD -- apps/desktop/src/renderer/components/workbench/browser-library.ts apps/desktop/src/renderer/components/workbench/browser-library.test.ts apps/desktop/src/renderer/components/workbench/browser-view.tsx apps/desktop/src/renderer/components/workbench/browser-runtime.ts apps/desktop/src/renderer/components/workbench/browser-address.ts apps/desktop/src/renderer/components/workbench/workbench.tsx apps/desktop/src/renderer/config.ts`

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: refactor
- Execution: subagent(opus) — departure check in `dev:explore`
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree; work lives on `dev/20260929-remove-browser-bookmarks` in `.claude/worktrees/20260929-remove-browser-bookmarks`
- Planned at: `90095a31`, 2026-09-29

## Requirement

The desktop app's built-in browser tab (plan 20260924-desktop-browser-tab) shipped bookmarks alongside history. The user judges bookmarks entirely unnecessary: the browser exists to look at a workspace's dev servers next to its terminals, not to curate sites. Remove the feature and everything that exists only for it.

Product conclusions (confirmed by the user):

- **Gone from the UI**: the ☆ button inside the address bar (加入书签 / 移除书签); the ⋯ menu's 显示书签栏 checkbox; the bookmarks bar under the toolbar, including its empty-state copy (点地址栏里的 ☆ 把当前页面加入书签) and each bookmark's context menu (在新标签页中打开 / 复制网址 / 删除书签); bookmark entries (star icon) in the address-bar suggestion list.
- **Unchanged**: browsing history and everything built on it — address-bar suggestions (now history only, every row with the history icon), the new tab page's recent visits, and ⋯ → 清除浏览历史. All other toolbar and ⋯ menu items stay as they are.
- **Existing bookmarks** on users' machines are dropped silently: no prompt, no export, no migration UI. Their history survives.
- The removal is mentioned in the next release notes, written at release time — not part of this change.

Observable when done: an http(s) page's address bar has no ☆ and its text uses the full width; the ⋯ menu has no bookmark item; no bar ever appears between the toolbar and the page; typing in the address bar suggests only visited pages; history suggestions, recent visits on a blank tab and 清除浏览历史 behave as before, including history recorded before the upgrade.

## Decisions & tradeoffs

- **Storage format stays at version 1 under the same key**: `STORAGE_VERSION` remains `1` and the key remains `coflux_browser_library`; `bookmarks` and `bookmarksBarVisible` are removed from the `BrowserLibrary` type, parsing ignores them if present, and serialisation no longer writes them. Rejected: bumping the version or renaming the key — `parseLibrary` returns an empty library for any other version, which would wipe every user's history to delete a field. Rejected: a migration step that actively rewrites storage on startup — the next ordinary write drops the fields anyway, and a stale unused field in localStorage is harmless. Based on: `browser-library.ts:36` (`STORAGE_VERSION = 1`), `:70` (version mismatch → `EMPTY_LIBRARY`), `config.ts:37` (key), `browser-runtime.ts:97-106` (library is written only after a change).
- **Suggestions are history only**: `rankSuggestions` ranks history entries; the bookmark candidate merge and the bookmark score bonus are gone; `BrowserSuggestion` has no `source` field (it would only ever be `"history"`); the suggestion row always shows the history icon. The existing match tiers (typed-URL prefix, host label, title word, substring) and the frequency/recency bonuses are unchanged. Rejected: keeping `source` as a single-value union for "future sources" — speculative. Based on: `browser-library.ts:170-236`, `browser-view.tsx:776`.
- **Everything that exists only for bookmarks goes**: the `Bookmark` type, `BOOKMARK_CAP`, `isBookmarked`, `toggleBookmark`, `removeBookmark`, `setBookmarksBarVisible`, and the `onOpenTab` prop chain — `workbench.tsx:1368` passes it to `BrowserViews` (`browser-view.tsx:108,152,165`), which passes it to `BrowserView` (`:208,214`), whose only caller is the bookmark context menu's 在新标签页中打开 (`:885`). Kept: `openBrowserTab` and `normalizeIncomingUrl` in `workbench.tsx`, which other entry points use (`workbench.tsx:540,574-577`). Rejected: leaving `onOpenTab` wired "for later" — an unused prop is dead code.
- **Address bar padding**: the input's right padding reserved for ☆ (`pr-7`, `browser-view.tsx:724`) no longer needs reserving; the exact value is the executor's call (the left padding is `pl-2.5`).
- **The ⋯ menu keeps one divider where the checkbox was (revised on plan audit)**: 显示书签栏 sits between two `DropdownMenuDivider`s (`browser-view.tsx:851` and `:857`); removing it removes one of those dividers too, so the zoom row and 清除浏览历史 are separated by a single divider. "Other ⋯ items stay as they are" does not mean both dividers stay.
- **Comments and docs**: code comments that describe bookmarks as current behaviour are corrected (`browser-library.ts` header, `config.ts:34`, `workbench.tsx:156`, `browser-runtime.ts:15`, `browser-address.ts:151`). Historical records stay untouched: `docs/releases/2.6.0.md` and `wiki/plans/20260924-*.md` describe what shipped then. Wording is the executor's call.
- **Tests (decided while planning)**: `browser-library.test.ts` keeps covering history, parsing and ranking without bookmarks; the corrupt-storage fixture keeps a stale `bookmarks` / `bookmarksBarVisible` pair so the test asserts that pre-upgrade data still parses (history intact) and that re-serialising it no longer carries those fields — that is the silent-drop guarantee, the one behaviour of this change a user could not easily notice breaking.

## Direction

One milestone; the data layer and the UI change together because the UI consumes the removed exports.

### Milestone 1: bookmarks removed end to end

`browser-library.ts` exports no bookmark type, constant or function; `BrowserLibrary` holds history only; `BrowserView`/`BrowserViews` render no ☆, no bookmarks-bar menu item and no bar, and take no `onOpenTab`; suggestions render history only; comments are updated; `browser-library.test.ts` is rewritten per the Tests decision. Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` → exit 0; `git grep -niE -e bookmark -e 书签 -- apps/desktop/src` → no output.

## Landmines

- **Unused imports are not caught**: `tsconfig.base.json:13-14` sets `noUnusedLocals`/`noUnusedParameters` to `false`, so a leftover `Star`, `ContextMenu`, `DropdownMenuCheckboxItem` (its only use in `apps/desktop/src` is `browser-view.tsx:852`, inside the multi-name import at `:30` that otherwise stays) or other import in `browser-view.tsx` passes typecheck (revised on plan audit). Remove each import whose last use disappears by hand (check with `grep` before deleting — `History`, `desktop.writeClipboard`, `hostLabel` are still used elsewhere in the file).
- **Ranking test relied on a bookmark**: the current ranking test (`browser-library.test.ts:124-155`) asserts that a bookmark ranks first and that a bookmarked URL is suggested with `source: "bookmark"`. Rewriting it must still pin the tier order (prefix > host label > title word > substring) and frequency/recency ordering using history entries only, not merely delete assertions.
- **Version guard**: any change to `STORAGE_VERSION` or the version check wipes history for every existing user (`browser-library.ts:70`).

## Scope

In scope:
- `apps/desktop/src/renderer/components/workbench/browser-library.ts`
- `apps/desktop/src/renderer/components/workbench/browser-library.test.ts`
- `apps/desktop/src/renderer/components/workbench/browser-view.tsx`
- `apps/desktop/src/renderer/components/workbench/workbench.tsx` (the `onOpenTab` prop and the comment at :156 only)
- `apps/desktop/src/renderer/components/workbench/browser-runtime.ts` (comment only)
- `apps/desktop/src/renderer/components/workbench/browser-address.ts` (comment only)
- `apps/desktop/src/renderer/config.ts` (comment only)
- `wiki/plans/README.md` (status)

Out of scope:
- History behaviour, the new tab page, the ⋯ menu's other items — unchanged by decision.
- `docs/releases/*`, `wiki/plans/20260924-*` — historical records.
- Release notes for the next version — written at release time.
- Main process, preload bridge, server, protocol — bookmarks never reached them.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install (fresh worktree) | `pnpm install` | exit 0 |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| No leftovers | `git grep -niE -e bookmark -e 书签 -- apps/desktop/src` | no output (exit 1) |
| No unused locals in touched files | `pnpm -C apps/desktop exec tsc -p tsconfig.renderer.json --noEmit --noUnusedLocals --noUnusedParameters 2>&1 \| grep -E "browser-(view\|library)"` | no output (other files' pre-existing findings are filtered out) |
| Visual check (acceptance) | `pnpm dev:desktop:prod`, open a browser tab | done by the user by hand, not by an agent |

## Done criteria

- [ ] All listed commands pass (the acceptance row is left to the user).
- [ ] `STORAGE_VERSION` is still `1` and the storage key is unchanged.
- [ ] A library string in the old version-1 format (history + `bookmarks: [{ url, title, addedAt }]` + `bookmarksBarVisible: true`) parses with its history intact, and serialising the result contains neither `bookmarks` nor `bookmarksBarVisible` — asserted in `browser-library.test.ts`.
- [ ] The ranking test still asserts tier order and frequency/recency ordering with history only.
- [ ] `BrowserSuggestion` has no `source`; no `onOpenTab` remains in `apps/desktop/src`.
- [ ] No import in the touched files is left without a use (the unused-locals command above is clean).
- [ ] The ⋯ menu has a single divider between the zoom row and 清除浏览历史.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (for example the library gained another consumer of bookmarks, or `onOpenTab` gained another caller).
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- Users upgrading keep a stale `bookmarks` array in `localStorage["coflux_browser_library"]` until their next history change rewrites the entry; parsing ignores it. Do not reuse the field names `bookmarks` / `bookmarksBarVisible` for something else under version 1, or that stale data would be read back.
- The next release notes must mention that bookmarks were removed.
- Plan audit: all four findings (a false-passing grep in the Commands table, the double divider, the `DropdownMenuCheckboxItem` import, no mechanical unused-import check) were accepted; cited line drift fixed.
