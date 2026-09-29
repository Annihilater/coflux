# Plan 20260930-r2-download-mirror: Latest release binaries download from R2 at dl.coflux.dev; history stays on GitHub

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat dbdfdb0a..HEAD -- scripts/release-sign.mjs scripts/desktop-update-feed.mjs scripts/product-version.test.mjs packages/cli/cofluxd.mjs .github/workflows/release.yml .github/workflows/desktop-release.yml .github/workflows/npm-publish.yml apps/desktop/electron-builder.yml apps/desktop/test/config.test.ts apps/desktop/src/main/updater.ts apps/desktop/src/main/index.ts apps/desktop/README.md apps/desktop/src/renderer/components/workbench/add-device-view.ts apps/desktop/src/renderer/components/workbench/add-device-view.test.ts apps/server/src/auto-update.ts crates/supervisor/src/upgrade.rs tests/src/cli-release-trust.test.mjs tests/src/release-sign.test.mjs README.md docs/RELEASING.md docs/deployment.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: dx
- Execution: subagent(opus) — departure check in `dev:explore`, 2026-09-30
- Stop after: implementation — departure check (plan audit, then execute)
- Plan review: audit — ran 2026-09-30 (fable); findings folded in, marked `(revised on plan audit)`
- Workspace: isolated — planned from the main worktree; branch `dev/20260930-r2-download-mirror` at `.claude/worktrees/20260930-r2-download-mirror`
- Planned at: `dbdfdb0a`, 2026-09-30

## Requirement

Every binary coflux ships is downloaded from GitHub Releases (`github.com/.../releases/download` → `*.githubusercontent.com`). From mainland China this fails most of the time. Measured 2026-09-30 from prod-bj (Beijing):

- GitHub Release downloads: 18–53 KB/s. In 60 s they fetched only 1–3 MB of the 197 MB desktop zip.
- Cloudflare edge: 1.4–2.9 MB/s.

After this plan, the **latest stable release** downloads from a Cloudflare R2 bucket on the custom domain **`dl.coflux.dev`**:

1. **Worker/transport/ptyd hot upgrades** pushed by the server. Stable manifests carry R2 URLs.
2. **`cofluxd up` / `cofluxd update`** (npm) with no `--version`, or with `--version` equal to the latest stable. The latest version is read from R2, and nothing calls `api.github.com`.
3. **Desktop auto-update.** New builds read their feed from R2. Installed apps keep reading the `desktop-updates` branch feed, but its zip URL points at R2.
4. **First install.** The add-device page's DMG button and the README download link point at a version-less R2 DMG alias.

**Storage stays small (user requirement, added after the departure check).** R2 holds **only the latest stable release**, about 0.6 GB: v2.11.0's assets total 617 MB. R2's free tier is 10 GB-month, and egress is free. Every older release, and every prerelease, is fetched from GitHub Releases, which are still published exactly as today and remain the permanent record. `cofluxd` routes an explicitly requested older version or a prerelease to GitHub by itself.

Nothing reaches users until the next `v*` release after this merges. There is no backfill.

## Decisions & tradeoffs

- **Domain and bucket**: bucket `coflux-releases`, served only through the R2 custom domain `dl.coflux.dev` (the zone `coflux.dev` is on Cloudflare).
  - Rejected: the `r2.dev` public URL. It is rate-limited and not for production.
  - Based on: the user's answer at exploration, and `docs/deployment.md:87-99`. That section shows the zone is on Cloudflare, and that an explicit record overrides the proxied `*.coflux.dev` wildcard (`:93`) for that one name.
- **R2 retains exactly one release — the latest stable** (user decision, 2026-09-30):
  - After the pointers move to a new stable tag, the same pointer step deletes every other `releases/<tag>/` prefix.
  - Before deleting, it reads back `releases/latest.json` and confirms it names the new tag. It never deletes the prefix `latest.json` names.
  - Prereleases are **never uploaded** to R2.
  - Rejected: keeping all history, which would exceed the free tier within weeks at the current release cadence.
  - Rejected: keeping latest + previous. The user asked for latest only. The windows it would cover are one-shot and self-healing; see Landmines.
  - Rejected: R2 lifecycle rules. They are age-based and cannot express "all but the current tag".
- **Object layout** (fixed, because installed clients will hard-code parts of it):
  - `releases/<tag>/<asset>` — the latest stable tag's GitHub Release assets under their exact asset names. That covers the signed daemon artifacts, `.release.sig`, `manifest.json`, `SHA256SUMS`, NOTICES/MODULES, and the desktop `.zip` / `.zip.blockmap` / `latest-mac.yml`.
    - The versioned `.dmg` is **not** uploaded here. The alias below is the only DMG on R2. `release-notes.md` is not a GitHub asset and is not uploaded either.
    - The upload set is derived from the same globs as the `release` job's `files:` (`.github/workflows/release.yml:326-331`), minus the `.dmg`, rather than maintained as a second list. `(revised on plan audit)`
  - `releases/latest.json` — `{"version":"<tag>"}`, the latest stable tag.
  - `desktop/latest-mac.yml` — the electron-updater feed for new desktop builds. It is read by `publish.url: https://dl.coflux.dev/desktop`.
  - `desktop/<alias>-arm64.dmg` — the latest stable DMG under a version-less name, uploaded directly from the desktop artifacts. The exact alias name is the executor's call.
- **Publish ordering — two phases**:
  - (a) An upload job puts the versioned objects on R2 **before** the `release` job creates the GitHub Release. The server pushes hot upgrades as soon as the GitHub Release appears (`apps/server/src/auto-update.ts:146-167`), so the R2 URLs in its manifest must already resolve.
  - (b) A pointer job writes `releases/latest.json`, `desktop/latest-mac.yml` and the DMG alias, then prunes. It runs only **after** the `release` job succeeds, and only for non-prerelease tags. This is the same gate as `desktop-updates` (`release.yml:337-340`).
  - Rejected: writing pointers in the upload job. The tag-drift check inside the `release` job (`release.yml:296-317`) can still abort after upload.
  - Rejected: uploading after the GitHub Release. The server would push URLs that 404 and burn `autoUpdateMaxAttempts` (`auto-update.ts:189-200`).
- **Prerelease handling in the job graph** `(decided while planning)`: the upload job must not be skipped at the job level for prereleases. The `release` job needs it, and a job whose dependency was skipped is itself skipped. The upload job therefore always runs and becomes a no-op for prerelease tags, or the executor uses an equivalent construct that provably still runs `release`.
- **Overwrite gate: never overwrite a published tag** `(revised on plan audit)`:
  - Before touching any object, the upload job checks whether the GitHub Release for the tag already exists (`gh release view`; the job has `contents: read`).
  - If the release exists, it refuses to upload unless every object's bytes are identical.
  - If the release does not exist, overwriting is allowed. A full re-run rebuilds and re-notarizes, so the bytes legitimately differ.
  - Rejected: "overwritable until a pointer references it". The server and `cofluxd --version` consume versioned objects without looking at pointers. A "Re-run all jobs" after the release exists would swap the bytes under a manifest whose sha256 the server has already cached. This turns the existing rule "no full re-run after publication" (`docs/RELEASING.md:118-119`) into a hard gate.
- **Pointer logic is a testable Node script, not inline YAML** `(revised on plan audit)`:
  - Deciding what to write and what to prune lives in a script under `scripts/` with its own tests. The workflow only calls it.
  - The script fetches the current R2 `latest.json` and `desktop/latest-mac.yml` and uses them as `previous`.
  - It refuses a lower version.
  - It refuses a same-version `latest-mac.yml` whose content differs (sha512 drift), reusing `scripts/desktop-update-feed.mjs`'s guard (`:28-32`).
  - It treats "the existing pointer could not be read, other than a plain 404" as an error, not as "no previous".
  - The prune selection is a pure function: given the listed prefixes and the confirmed latest tag, it returns the prefixes to delete. It is unit-tested, including "never returns the latest tag" and "returns nothing if read-back disagrees".
- **Manifest URLs**:
  - `scripts/release-sign.mjs` writes `https://dl.coflux.dev/releases/<tag>/<asset>` for every component of a **stable** tag.
  - For a **prerelease** tag it keeps the GitHub URL, since prereleases are never on R2. The script decides from the tag itself.
  - The R2 base is one constant or env override, not five literals.
  - After the next release prunes R2, older manifests' URLs 404. Nothing reads them: the server only reads the latest manifest, and `cofluxd` builds URLs from its base, not from `entry.url`. This is accepted and documented in Maintenance notes.
  - Rejected: the server rewriting URLs at dispatch. That needs a server change and a deployment, for no gain while only the latest is served.
  - The trust chain is unaffected. Release signatures bind version/target/sha256/size and never the URL (`scripts/release-sign.mjs:46,73,99,117,147`). The supervisor only requires http/https (`crates/supervisor/src/upgrade.rs:173`).
- **The server keeps polling GitHub for discovery**. `apps/server/src/auto-update.ts` is unchanged, because prod-jp is in Japan. Old supervisors benefit automatically.
- **`cofluxd` routing by version, not by failure**:
  - The mirror base defaults to `https://dl.coflux.dev/releases`. `COFLUX_RELEASE_DOWNLOAD_BASE` overrides it.
  - The archive base defaults to `https://github.com/myWsq/coflux/releases/download`, with an env override so tests can serve it.
  - Resolution works as follows:
    - Without `--version`, `cofluxd` reads `<mirror>/latest.json` and installs that tag from the mirror. If the pointer cannot be read, it fails with a clear message that names `--version` as the way to install from GitHub.
    - With `--version X`, it reads the pointer. If the pointer names X, it installs from the mirror. If the pointer names another tag, or cannot be read, it installs from the archive.
  - `COFLUX_RELEASE_API_BASE` is removed.
  - There is no "try R2, then GitHub on error" fallback. An R2 outage must stay visible.
  - Every existing verification, floor and anti-rollback behaviour is unchanged.
  - Based on: `packages/cli/cofluxd.mjs:31-33,261-274,351`.
- **`latest` now means latest stable** `(decided while planning)`: today `releases?per_page=1` may return a prerelease (`cofluxd.mjs:261`). That now matches the server (`/releases/latest`) and the desktop feed.
- **Desktop feed**:
  - `apps/desktop/electron-builder.yml` `publish` becomes `{provider: generic, url: https://dl.coflux.dev/desktop, useMultipleRangeRequest: false}`.
  - The `desktop-updates` branch keeps being pushed for installed apps.
  - Both feeds carry the R2 absolute zip URL.
  - `useMultipleRangeRequest: false` `(revised on plan audit)`: the default is `true` for non-S3 hosts (`builder-util-runtime/out/publishOptions.d.ts:175-177`), and `multipleRangeDownloader.js:83` throws unless the response is `multipart/byteranges`. The Cloudflare/R2 edge does not produce that (inferred; confirm with the Range probe in Commands). Without the flag, differential updates would never work.
  - Rejected: stopping the branch feed. It is baked into every installed app's `app-update.yml`.
- **Add-device DMG button → the R2 alias** `(decided while planning)`: `desktopDownloadUrl` (`add-device-view.ts:13-15`) no longer pins the running app's version. Pinned versions are pruned from R2, and a GitHub pin would be the slow path this plan exists to remove. Plan 20260923-add-device-dialog (`wiki/plans/20260923-add-device-dialog.md:62`) chose the pin only because GitHub's `releases/latest` had been hijacked by release ordering and could not deep-link to an asset. The alias fixes both problems, and a newer app on the other Mac is fine because it self-updates anyway. The README's download links use the same alias. The release badge may stay on GitHub.
- **Credentials and job placement**:
  - R2 credentials live in the `release-signing` environment. Only the upload and pointer jobs use them. The `sign` job (`WORKER_SIGNING_KEY`, `contents: read`, `release.yml:233-272`) never does.
  - Neither new job gets `contents: write`.
  - Reuse the names of the retired 2026-09-11 R2 implementation (commit `2379b706`): secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; variables `R2_ENDPOINT` and `R2_BUCKET`.
  - A missing value fails the job explicitly.
- **Infrastructure split** (user decision):
  - The executor creates the bucket, attaches `dl.coflux.dev`, and adds the cache rule below in the Cloudflare dashboard, through the signed-in Chrome.
  - The **user** creates the R2 API token (Object Read & Write on this bucket) and runs `gh secret set` / `gh variable set --env release-signing` themselves.
  - Secret values never enter an agent's context. Non-secret values (account ID, endpoint) may be reported to the user.
- **Caching is explicit, not by extension** `(revised on plan audit)`:
  - Cloudflare decides cacheability by file extension by default. Extension-less daemon binaries, `.sig`, `.json`, `.yml` and `.blockmap` are not cached, while `.dmg` / `.zip` are.
  - M1 therefore adds a Cache Rule for hostname `dl.coflux.dev`: eligible for cache, with edge TTL taken from the origin's `Cache-Control`.
  - Uploads set `Cache-Control`: long and immutable on `releases/<tag>/*`, short (at most a few minutes) on the three pointers.
  - The DMG alias must be uploaded fresh with its own short `Cache-Control`. It must never be a server-side copy of a versioned object: S3 `CopyObject` keeps the source's metadata by default.
  - `desktop/latest-mac.yml` is fetched with a `?noCache=` query (`GenericProvider.js:20`), so its TTL matters less. `latest.json`'s TTL is the one that matters.
  - Exact values are the executor's call.

Left to the executor: the upload tool (the aws CLI against the R2 endpoint is proven by `2379b706`; `AWS_EC2_METADATA_DISABLED=true` and `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` are harmless insurance); job and step layout within the ordering above; the pointer script's name and interface; the alias name; the env var name for the archive base; exact cache values; doc wording.

## Direction

The work falls into three code areas plus one infrastructure step:

- **Release pipeline**: `release-sign.mjs`, an upload job, and a pointer job backed by a tested script.
- **Clients**: `cofluxd.mjs`, the desktop publish config, the feed renderer, and the add-device URL.
- **Documentation**: RELEASING, deployment, the desktop README, and the root README.

### Milestone 1: R2 bucket, domain and cache rule are live

This milestone establishes four things:

- Bucket `coflux-releases` exists with `r2.dev` access off.
- `dl.coflux.dev` is attached and active.
- The hostname Cache Rule is in place.
- A probe object uploaded through the dashboard is served.

Validation (executor), in four checks:

- `curl -sI https://dl.coflux.dev/<probe>` → `200`. Note that a bare 404 proves nothing, because the proxied `*.coflux.dev` wildcard already answers today.
- A second request shows `cf-cache-status: HIT`.
- Requests with a `node` user agent and with no user agent both succeed without a `cf-mitigated` challenge header. The clients are Node `fetch`, Electron net and a Rust downloader, so check for Bot Fight Mode, Browser Integrity Check and WAF interference.
- The multi-range probe `curl -H 'Range: bytes=0-9, 20-29'` is recorded as evidence for the `useMultipleRangeRequest` decision.

Delete the probe afterwards. Then hand the user the token and secret instructions. No code milestone depends on the token.

### Milestone 2: Manifests and desktop feeds point at R2

- `release-sign.mjs` writes R2 URLs for stable tags and GitHub URLs for prereleases.
- `renderDesktopFeed` renders R2 zip URLs and keeps every existing guard.
- `electron-builder.yml` publishes to `https://dl.coflux.dev/desktop` with `useMultipleRangeRequest: false`, and `config.test.ts`'s `Builder.publish` type and assertion lock both.
- Stale comments are updated: `apps/desktop/src/main/updater.ts:34-35`, `apps/desktop/src/main/index.ts:208-209`, and `electron-builder.yml:83-86`.

Validation: `node --test scripts/product-version.test.mjs`, `node --import tsx --test tests/src/release-sign.test.mjs` (asserting both the stable and the prerelease URL forms), and `pnpm -C apps/desktop test` all exit 0.

### Milestone 3: cofluxd routes latest to R2 and history to GitHub

`cofluxd` implements the routing rule in Decisions. `tests/src/cli-release-trust.test.mjs` serves a mirror (with `latest.json`) and an archive from its local HTTP server. Beyond the existing cases, it covers three:

- The latest tag is fetched from the mirror.
- An explicit older `--version` is fetched from the archive, and never from the mirror.
- An unreadable pointer without `--version` fails with the `--version` hint.

`COFLUX_RELEASE_API_BASE` is gone from both files.

Validation: `node --import tsx --test tests/src/cli-release-trust.test.mjs` exits 0.

### Milestone 4: The release workflow uploads, publishes, points and prunes in order

`release.yml` gains two jobs:

- An upload job that `needs` `sign` and `desktop`. The `release` job `needs` it.
- A pointer/prune job that `needs` `release`, is gated on non-prerelease, and runs in `release-signing`.

The `desktop-updates` branch push stays.

`apps/desktop/test/config.test.ts` locks the graph:

- `release.needs ⊇ [upload]` and `upload.needs ⊇ [sign, desktop]`.
- The pointer job's `needs ⊇ [release]`, its `if` contains `prerelease == 'false'`, and its `environment` is `release-signing`.
- Neither new job has `contents: write`.
- The upload job contains the published-tag overwrite gate.
- `desktop-updates` still exists.

Update `config.test.ts:179` (`release.needs` deepEqual). Reword the `:214` assertion message "R2 上传已撤": the assertion stays, because the reusable desktop build must still not upload, but the message must no longer claim R2 is retired. The pointer script's unit tests run in CI. Add them to the `unit_tests` array at `.github/workflows/ci.yml:137`, or wherever the executor places them, as long as CI runs them.

Validation: `pnpm -C apps/desktop test` and the pointer script's tests exit 0, plus `actionlint` if available.

### Milestone 5: First-install links and docs

- The add-device button and the README links point at the R2 alias. Update `add-device-view.test.ts`.
- `docs/RELEASING.md` covers the following. The GitHub-as-update-source paragraph (`:142`) is replaced, and the stale mentions at `:122` and `:186` are fixed.
  - the R2 layout and retention (latest stable only);
  - the two-phase order;
  - the overwrite gate;
  - that a pointer-job failure blocks `npm-publish`, which is triggered by `workflow_run` on `release` success, the same as a `desktop-updates` failure today;
  - secret and variable names, not values;
  - that `desktop-updates` must keep being pushed;
  - the manual fallback: `--version vX.Y.Z` always works, with old versions fetched from GitHub.
- `apps/desktop/README.md:98` is updated.
- `docs/deployment.md`'s domain table gains `dl.coflux.dev` (R2 custom domain, proxied, cache rule).

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` exits 0.

Dependencies:

- M4 consumes M2's feed-renderer signature, and both edit `config.test.ts`, so run M2 → M4 in one package.
- M3 and M5 are independent of each other and of M2/M4.
- M1 is infrastructure and gates no code milestone.

## Landmines

- **Installed desktop apps have the branch feed URL baked in** (`app-update.yml` → `raw.githubusercontent.com/myWsq/coflux/desktop-updates`). Keep pushing it (`release.yml:337-371`).
- **The server pushes as soon as the GitHub Release exists.** Pointers and pruning must wait for the `release` job (`release.yml:296-317`, the drift check lives there). The upload must finish before it starts.
- **A skipped `needs` dependency skips the dependent job.** The upload job cannot carry a job-level `if: prerelease == 'false'` (see Decisions).
- **One-shot windows around pruning (accepted, self-healing):**
  - The server polls every 10 min (`apps/server/src/config.ts:167`). Between a prune and its next poll, it may push the pruned previous version's URL to a daemon still on an even older worker. That produces one 404, charged to the old version's attempt quota. Quotas are keyed by (daemon, version) and reset for the new version.
  - A desktop app mid-download of the previous zip at prune time fails, and retries at the next 4-hour check.
  - A `cofluxd` run that read the old `latest.json` a moment before the prune gets one 404 and succeeds on re-run.
- **Differential desktop updates:** the old blockmap comes from electron-updater's cache dir first (`AppUpdater.js:696`), and only then from a URL built by replacing the version in the new URL (`Provider.js:22-25`). With latest-only retention that URL is always pruned, so differential works only for apps with a cached `current.blockmap`, and otherwise falls back to a full download. This is expected. It works at all only because `useMultipleRangeRequest: false`.
- **`coflux-screen`** (landed 2026-09-29) ships inside the app bundle only (`config.test.ts`, "coflux-screen" test). It is not a daemon release asset. Do not add it to any upload set.
- **Tests that assert the current shape literally:** `scripts/product-version.test.mjs:40-51`, `apps/desktop/test/config.test.ts:64,179,214`, `add-device-view.test.ts:19`, and `tests/src/cli-release-trust.test.mjs:66-69,96-97,119`.
- **A fresh worktree has no `node_modules`.** Run `pnpm install` before any validation. `node --import tsx` needs it.
- **This repo's Bash tool shell is zsh.** `"$VAR:path"` is eaten by modifiers, and `set -e` does not hold across the tool's chained commands. Workflow YAML runs bash, so this concerns local commands only.

## Scope

In scope:
- `scripts/release-sign.mjs`, `scripts/desktop-update-feed.mjs`, `scripts/product-version.test.mjs`, a new pointer script and its test under `scripts/`
- `packages/cli/cofluxd.mjs`
- `.github/workflows/release.yml`, `.github/workflows/ci.yml` (to run the new script test)
- `apps/desktop/electron-builder.yml`, `apps/desktop/src/main/updater.ts` and `apps/desktop/src/main/index.ts` (comments), `apps/desktop/test/config.test.ts`, `apps/desktop/README.md`
- `apps/desktop/src/renderer/components/workbench/add-device-view.ts` and its test
- `tests/src/cli-release-trust.test.mjs`, `tests/src/release-sign.test.mjs`
- `README.md`, `docs/RELEASING.md`, `docs/deployment.md`
- Cloudflare dashboard: bucket `coflux-releases`, custom domain `dl.coflux.dev`, the hostname cache rule

Out of scope:
- `apps/server/src/auto-update.ts` — discovery stays on GitHub.
- `crates/supervisor` — it already accepts any http(s) URL.
- `.github/workflows/desktop-release.yml` — the reusable build must still not upload. Touch it only if an output must be exposed.
- Backfilling any existing release. Changing how the npm registry itself is reached.
- Creating the R2 token or setting GitHub secrets and variables — the user does this.
- Tagging a release, pushing, merging.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Install deps (worktree) | `pnpm install` | exit 0 |
| Feed renderer / version tests | `node --test scripts/product-version.test.mjs` | exit 0 |
| Pointer script tests | `node --test scripts/<pointer script>.test.mjs` | exit 0 |
| Release signing contract | `node --import tsx --test tests/src/release-sign.test.mjs` | exit 0 |
| cofluxd trust chain + routing | `node --import tsx --test tests/src/cli-release-trust.test.mjs` | exit 0 |
| Desktop typecheck + tests | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test` | exit 0 |
| Retained black-box suite | `pnpm -C tests test` | exit 0 (release signing is one of its three areas) |
| R2 live (acceptance) | M1's probe: `200`, then `cf-cache-status: HIT`, no `cf-mitigated` with a `node` UA | as stated |
| Multi-range behaviour (acceptance) | `curl -s -D- -o /dev/null -H 'Range: bytes=0-9, 20-29' https://dl.coflux.dev/<probe>` | recorded: not `multipart/byteranges` confirms the flag is required |
| Real release (acceptance, user-triggered) | next stable `v*` tag | R2 holds only `releases/<tag>/`, `latest.json`, `desktop/latest-mac.yml` and the alias; the `desktop-updates` feed points at R2; a daemon hot-upgrade log shows a `dl.coflux.dev` URL; `cofluxd update --version <older>` downloads from GitHub |

## Done criteria

- [ ] All listed non-acceptance commands pass.
- [ ] `dl.coflux.dev` serves from the bucket with the cache rule, and the user has the exact secret and variable names to set.
- [ ] A stable manifest from `release-sign.mjs` contains only `https://dl.coflux.dev/releases/<tag>/…` URLs, and a prerelease manifest contains only GitHub URLs. Both are asserted.
- [ ] Both desktop feeds render R2 zip URLs. Every existing feed guard still rejects its bad case. `useMultipleRangeRequest: false` is locked by a test.
- [ ] `cofluxd` installs latest from the mirror and older versions from the archive. Tests prove the older-version path never touches the mirror's versioned objects. `COFLUX_RELEASE_API_BASE` is gone.
- [ ] Workflow order is locked by tests: upload before `release`, pointer after `release`, pointer stable-only, overwrite gate present, no `contents: write` on the new jobs, `desktop-updates` still pushed.
- [ ] Prune selection is unit-tested. It never returns the confirmed latest tag, and it returns nothing when the read-back disagrees.
- [ ] Missing R2 secrets or variables fail the jobs explicitly.
- [ ] The add-device button and the README point at the R2 alias.
- [ ] Implementation follows every entry in Decisions & tradeoffs. No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds. For example: release signatures now bind the URL, the supervisor restricts upgrade hosts, or `cofluxd` starts reading `entry.url`.
- Cloudflare refuses the custom domain, or the dashboard needs credentials the signed-in browser lacks.
- Zone security settings challenge non-browser clients on `dl.coflux.dev`, and fixing that would change zone-wide settings. Report instead of changing zone-wide security.
- The outcome requires changing `apps/server/src/auto-update.ts` or `crates/supervisor`.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- `dl.coflux.dev` is now part of the product contract. Installed desktop apps (from the first R2-era release on) and every stable manifest reference it.
- Manifests of superseded stable releases, on GitHub and in any cache, carry R2 URLs that 404 after pruning. Nothing reads them today. If anything ever starts consuming a historical manifest's `entry.url`, rewrite to the archive first.
- The `desktop-updates` branch push can be retired only once essentially every install has passed the first R2-era release.
- If Cloudflare-to-mainland throughput degrades, a mainland mirror can sit behind the same layout and `COFLUX_RELEASE_DOWNLOAD_BASE` without touching signatures.
- Plan audit findings not adopted: none. The audit's unverifiable assumptions (zone bot/WAF settings, `release-signing` reviewers or wait timers, `action-gh-release` re-run asset behaviour) are checked by M1's probe or noted as STOP conditions.
