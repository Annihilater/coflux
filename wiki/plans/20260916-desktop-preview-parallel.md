# Plan 20260916-desktop-preview-parallel: Run one desktop dev preview per worktree, side by side

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- apps/desktop/package.json apps/desktop/electron.vite.config.ts apps/desktop/src/main/index.ts apps/desktop/src/main/window.ts apps/desktop/src/main/window-state.ts apps/desktop/src/main/token-store.ts apps/desktop/src/renderer/components/workbench/workbench.tsx docs/desktop-acceptance.md apps/desktop/README.md AGENTS.md`

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: dx
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (autopilot with advisor review)
- Plan review: advisor — departure check; the review ran and its findings are folded in
- Workspace: isolated — planning moved the session to `.claude/worktrees/20260916-desktop-preview-parallel` on `dev/20260916-desktop-preview-parallel`
- Planned at: `ebca9085`, 2026-09-16

## Requirement

Two hard blockers stop the desktop dev client from running in more than one
worktree at a time *as the commands are written*:

1. The renderer's HMR port is a literal with `strictPort: true`
   (`apps/desktop/electron.vite.config.ts:91-95`), so a second `dev` fails on a
   port conflict.
2. Every unpackaged instance resolves `userData` to the single `Coflux-dev`
   directory (`apps/desktop/src/main/index.ts:44`), and the single-instance
   lock lives inside it (`apps/desktop/src/main/index.ts:119`), so even with
   different ports the second Electron calls `app.quit()` immediately.

Neither blocker is absolute: passing `--user-data-dir` by hand and editing the
port out of the Vite config gets a second instance up, and at the time of
planning one was running that way from another worktree
(`.claude/worktrees/20260916-terminal-cursor-parity`, user data dir
`~/.coflux-desktop-dev-cursor-parity`, Vite on 5284, while that worktree's
`electron.vite.config.ts` on disk still reads `5274`). That hand-work, repeated
per worktree and per start, *is* the problem: the outcome here is that the
documented commands do it by themselves.

The owner works across many worktrees at once and wants to keep several branch
previews open side by side for UI comparison and acceptance. The knowledge
needed to do it by hand is also scattered across `docs/desktop-acceptance.md`,
`apps/desktop/README.md`, and `AGENTS.md`.

### Product conclusions (settled in exploration — do not reopen)

- **Consumers**: the owner, plus the agents working inside individual
  worktrees. The scenario is several branch previews open at the same time.
- **Form**: zero-argument commands. `pnpm dev:desktop` and
  `pnpm dev:desktop:prod` (`package.json:10-11`) keep their names and become
  parallel-capable in place. No new command to remember, no per-start human
  decision. Plus one project skill, in English, as the single source of truth
  for how to run, identify, and stop these previews.
- **Flow**: run the command in any worktree → the instance is derived from that
  worktree's path (profile directory, HMR port, instance label), the same
  derivation every time so sign-in state, window position, and the profile's
  IndexedDB identity accumulate across runs → on the profile's *first* start,
  sign-in credentials and executor configuration are copied from the baseline
  profile, so the window opens already signed in → Ctrl-C stops that instance
  and cleans up after it, without touching the others.
- **Output and identification**: the launcher prints an instance summary at
  startup (instance label, profile path, HMR port, server URL, branch). The
  window title carries the branch/instance, and the Dock icon carries a short
  badge. The renderer is not modified; a reviewer comparing UI across branches
  must see the product UI, not preview scaffolding.
- **Scope**: only the dev client against production is made parallel. The local
  stack — server, Postgres, daemon — stays single-instance and unchanged.
- **Acceptance (manual, by the owner)**: three worktrees, one command each →
  three signed-in windows coexist and are individually identifiable; closing
  any one leaves the others working; the installed `Coflux.app` and its runtime
  are untouched throughout.

## Decisions & tradeoffs

- **Derivation key is the worktree path**: the instance slug, the `userData`
  profile directory (`Coflux-dev-<slug>`, a sibling of the baseline), the HMR
  port, and the instance label are all derived from the absolute path of the
  worktree root. The same worktree therefore produces the same instance on
  every run, which is what lets sign-in state, window bounds, and the profile's
  device identity persist. Rejected: deriving from the branch name — a branch
  can be checked out in a different worktree and renamed, and two worktrees can
  sit on the same commit; the path is the thing that is actually one preview.
  Rejected: allocating a free port at random per run — the port would move
  between runs, and diagnostics could not name a stable expected value.
  Based on: `apps/desktop/electron.vite.config.ts:91-95`,
  `apps/desktop/src/main/index.ts:43-44`.

- **The main worktree keeps the baseline profile**: when the launcher runs from
  the repository's main worktree, it uses `Coflux-dev` exactly as today, with
  no derived suffix. The owner's existing sign-in and window position stay
  untouched, and this profile is the source the derived instances copy
  credentials from. Linked worktrees always derive. Detect which case applies
  from git itself, never from directory naming conventions such as
  `.claude/worktrees/`: compare `git rev-parse --show-toplevel` with the main
  worktree, which is the first `worktree ` line of `git worktree list
  --porcelain` and is always absolute (verified: `worktree
  /Users/wsq/Workspace/coflux`). Do **not** use `git rev-parse --git-common-dir`
  for this — it is absolute from a linked worktree but relative to the current
  directory from the main one (`.git` at the root, `../../.git` from
  `apps/desktop`), so the comparison misclassifies the main worktree as linked
  and the owner silently loses the baseline profile
  *(revised on advisor review)*. Rejected: treating
  all worktrees alike with `Coflux-dev` demoted to a credential source — more
  uniform, but it throws away the main worktree's existing window state and
  device identity for no gain. Based on: `apps/desktop/src/main/index.ts:44`,
  `docs/desktop-acceptance.md` ("Development data lives under `Coflux-dev`").

- **All derivation and orchestration live in a dev-only launcher**: a new
  `apps/desktop/scripts/dev.mjs` becomes the `dev` script
  (`apps/desktop/package.json:10`). It computes the instance, prepares the
  profile, sets environment variables, and spawns `electron-vite dev`. Product
  code accepts *labelled inputs only* and performs no discovery: the renderer
  port is read from an environment variable by the Vite config, the profile
  path continues to come from the existing `COFLUX_DESKTOP_USER_DATA`
  (`apps/desktop/src/main/index.ts:42-43`), and the server URL from the
  existing `COFLUX_SERVER_URL` (`apps/desktop/src/main/settings.ts:5-9`).
  Neither the main process nor the Vite config may compute a slug, inspect git,
  scan for sibling instances, or probe ports. Rejected: computing the instance
  inside the main process — it would ship multi-instance orchestration in the
  packaged app, where it can never run and can only rot or misfire.
  Based on: `apps/desktop/package.json:10`, `apps/desktop/src/main/index.ts:42-44`.

- **Environment variable names are fixed by this plan**:
  `COFLUX_DESKTOP_RENDERER_PORT` (read by `electron.vite.config.ts` for
  `server.port`, defaulting to the current `5274` when absent) and
  `COFLUX_DESKTOP_INSTANCE_LABEL` (read by the main process for the window
  title and Dock badge, no labelling at all when absent). They are named here
  because two files must agree on each spelling and a typo degrades silently
  into today's behaviour. Based on: `apps/desktop/electron.vite.config.ts:91-95`.

- **The derived port comes from a reserved range, and the diagnostic is ordered**
  *(revised on advisor review)*: derive the port by hash into a contiguous range
  that avoids every port this repository already claims — 5274 (the baseline
  renderer), 8787 (server, `packages/protocol/src/index.ts:41`), 8788 (local
  gateway, `crates/protocol/src/lib.rs:64`), 5432 (dev Postgres,
  `compose.yaml`), and the black-box suites' fixed ports (`grep -h "PORT = "
  tests/src/*.test.mjs`). The owner also starts instances by hand on ad-hoc
  ports, so a taken port does **not** imply "this worktree is already running".
  On conflict the launcher reports in this order: first this instance's own
  `SingletonLock` — a live holder means the instance is already running, and
  that is the message; only if there is no live holder does it report the port
  as occupied by something else, naming the actual listener
  (`lsof -nP -iTCP:<port> -sTCP:LISTEN`).

- **`strictPort` stays `true`**: a derived port that is already taken fails the
  start rather than silently moving. Rejected: letting Vite fall through to the next free port —
  the most common cause of a taken port is that this worktree's own instance is
  already up, and falling through would start a dev server whose Electron then
  dies on the single-instance lock, leaving a page that loads but no window.
  Based on: `apps/desktop/electron.vite.config.ts:94`,
  `apps/desktop/src/main/index.ts:119`.

- **Sign-in state is copied once, at first start**: when the derived profile
  directory does not yet exist, the launcher copies `session-token.bin`,
  `executor.json`, and `executor-key.bin` from the baseline profile into it.
  Afterwards the profiles evolve independently — signing out of one instance
  does not touch the others. If the baseline is not signed in, nothing is
  copied and the instance starts at the sign-in screen, which is the correct
  degradation. The copy is safe because the token file carries no path binding
  and every dev instance shares one Keychain entry, decided by the app name.
  Rejected: sharing one token file between profiles through a symlink — sign-out
  in any instance would silently sign out all of them. Based on:
  `apps/desktop/src/main/token-store.ts:1-12` (safeStorage only, no path
  binding; ad-hoc-signed dev builds and the installed app share the Keychain
  entry), `apps/desktop/src/main/index.ts:73-78`.

- **The Dock badge is shared with the product's attention count, and the label
  composes with it** *(revised on advisor review)*: the badge is not free real
  estate. The renderer already drives it — it computes waiting-workspace plus
  unread-inbox counts and pushes them through the bridge
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:121`, and `0`
  on unmount at `:137`) to `setDockBadge`, which writes
  `app.dock?.setBadge(count > 0 ? String(count) : "")`
  (`apps/desktop/src/main/notifications.ts:18-20`, wired at
  `apps/desktop/src/main/index.ts:326`). A label written once at startup is
  therefore erased by the first count change. The composition rule is fixed
  here: no label → today's behaviour byte-for-byte; label and count 0 → the
  label alone; label and count > 0 → the label followed by the count. Every
  path that writes the badge must go through that rule, so the count can never
  erase the label and the label can never hide the count. The label is length-
  capped so the badge stays legible. Rejected: having the main process call
  `setBadge` with the label independently of the count — that is exactly the
  implementation that passes typecheck, tests, build, and a short walkthrough,
  and then loses the label the moment a workspace wants attention.

- **Identification uses the window title and the Dock badge only**: with
  `COFLUX_DESKTOP_INSTANCE_LABEL` set, the main process applies the label to
  the window title and, per the composition rule above, to the Dock badge
  (`setBadge` exists in Electron 44: `electron.d.ts:8143`; `app.dock` is
  `Dock | undefined`, `:1966`). The renderer is not
  touched. Note that the renderer continuously overwrites `document.title`
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:363`), so the
  main process must survive that — intercept `page-title-updated` and re-apply,
  rather than setting the title once at creation. Rejected: rendering a branch
  badge in the top bar — the top bar is itself frequently the thing under
  review, and preview scaffolding inside the product UI corrupts the comparison
  the previews exist for. Accepted limitation: `titleBarStyle: "hidden"`
  (`apps/desktop/src/main/window.ts:49`) means the title is visible in Mission
  Control and the Dock's window menu, not on the window frame.

- **The launcher carries a dry-run entry point, because nothing else can check
  it** *(revised on advisor review)*: `COFLUX_DESKTOP_DEV_DRY_RUN=1` makes the
  launcher resolve the instance, print the summary, and exit 0 — spawning
  nothing, and creating or seeding no profile. This exists because the launcher
  is invisible to every other gate: `apps/desktop/tsconfig.json`'s `include` is
  `src/main`, `src/preload`, `src/shared`, `test`, `electron.vite.config.ts` —
  `scripts/` is absent — and the `test` script's globs
  (`apps/desktop/package.json:13`) do not reach `scripts/` either. Without the
  dry run, a launcher with a syntax error passes typecheck, tests, and build.
  Rejected: unit-testing the derivation helpers instead — per `AGENTS.md` a test
  belongs here only if a break would stay invisible in use, and derivation
  breakage is loud; what is actually needed is one command that executes the
  file.

- **Window cascade is seeded by the launcher, not the main process**
  *(decided while planning)*: when creating a new derived profile, the launcher
  writes a `window-state.json` with an offset position, so parallel windows do
  not land exactly on top of each other. The file format is the plain
  `{x, y, width, height}` the main process already reads, the size must respect
  `MIN_WINDOW_SIZE` (1024×640), and an offset that lands off-screen is already
  handled — `resolveWindowBounds` falls back to centred. This keeps the main
  process free of cascade logic. Based on:
  `apps/desktop/src/main/window-state.ts:11-48`,
  `apps/desktop/src/main/window.ts:35-45`.

- **The launcher owns the instance lifecycle**: it starts the child detached, in
  its own process group, and tears the **whole group** down on Ctrl-C, terminal
  close, and its own exit, so no Electron helper survives holding the profile
  lock. Teardown is bounded and escalates *(revised on advisor review)*:
  `SIGTERM` to the group, a bounded wait, then `SIGKILL` to the group. The wait
  is not optional — `before-quit` calls `preventDefault()` and can put a
  confirmation dialog in front of the user when local terminals are running
  (`apps/desktop/src/main/index.ts:125-145`, dialog at `:237-244`), so a
  teardown that only sends `SIGTERM` can hang on a modal. Before starting, a
  `SingletonLock` left by a dead process is reclaimed automatically; a lock held
  by a live PID is a running instance and must be reported, never reclaimed.
  Rejected: documenting the manual cleanup in the skill instead — this is the
  exact trap already recorded in `docs/desktop-acceptance.md`, and multiplying
  it by the number of parallel instances is how the feature becomes unusable.
  Based on: `docs/desktop-acceptance.md` ("Killing the dev Electron's main
  process leaves its helpers behind, and they keep the single-instance lock").

- **The skill becomes the single source of truth**: a new English
  `.agents/skills/desktop-preview/SKILL.md`, with `.claude/skills/desktop-preview`
  symlinked to it, following the existing convention (`.claude/skills/raven-use`
  → `../../.agents/skills/raven-use`). It covers starting, parallelism,
  identification, stopping, cleanup, and what must never be touched.
  `skills-lock.json` tracks externally sourced skills only (it records
  `source`/`sourceType` for `raven-use`); a locally authored skill is not
  registered there. `docs/desktop-acceptance.md` shrinks to the acceptance
  handover itself — click path, pass criterion, what the setup cannot reach —
  and points at the skill; the corresponding lines in `AGENTS.md` and
  `apps/desktop/README.md` become pointers. Rejected: a skill that covers only
  the parallel part — two documents would both explain how to start a preview
  and would drift. Based on: `skills-lock.json`, `.claude/skills/raven-use`
  (symlink), `AGENTS.md` ("Local development pitfalls"),
  `docs/desktop-acceptance.md`.

- **Only the prod-connected dev client becomes parallel**: `pnpm dev:server`,
  `pnpm dev:daemon`, and `pnpm dev:pg` keep today's behaviour and today's fixed
  ports. `pnpm dev:desktop` (local server) benefits from the same launcher, but
  running several instances against one local stack is not a supported outcome
  and is not validated here. Rejected: deriving server and Postgres instances
  too — the daemon's local gateway port is a fixed contract shared with the
  installed app, so a parallel local stack is a different, much larger change.
  Based on: `package.json:6-13`, `crates/protocol/src/lib.rs:64`
  (`LOCAL_GATEWAY_PORT = 8788`).

## Direction

One work package. The milestones are **sequential** — milestone 2 labels the
instances milestone 1 creates, and milestone 3 documents the behaviour both
produce — so this plan must not be fanned out into concurrent packages.

The shape to aim for: a dev-only launcher that turns "where am I" into a set of
environment variables and a prepared profile directory, plus the minimum
labelled inputs in product code to consume them. Everything the packaged app
does stays bit-for-bit identical when the new variables are absent.

Working note for the executor: this session runs inside a linked worktree, where
the Bash guard rejects compound commands and heredocs containing `git -C`,
`git worktree`, and similar wording. Both `apps/desktop/scripts/dev.mjs` and the
skill necessarily contain `git rev-parse` / `git worktree` literals — write those
files with the Write/Edit tools, not with a shell heredoc. Creating the symlink
(`ln -s ../../.agents/skills/desktop-preview .claude/skills/desktop-preview`) is
fine through Bash.

### Milestone 1: A second worktree can start its own preview

`apps/desktop/scripts/dev.mjs` exists and is the package's `dev` script. It
derives the instance from the worktree root, prepares the profile directory
(creating it and seeding credentials, executor config, and cascade window state
on first use), prints the instance summary, spawns `electron-vite dev` in its
own process group, and tears that group down on exit. `electron.vite.config.ts`
reads `COFLUX_DESKTOP_RENDERER_PORT` with `5274` as the fallback and keeps
`strictPort: true`. A port conflict or a live `SingletonLock` produces a
diagnostic that names the cause and the PID; a stale lock is reclaimed.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop build` -> exit 0;
`node --check apps/desktop/scripts/dev.mjs` -> exit 0;
`COFLUX_DESKTOP_DEV_DRY_RUN=1 node apps/desktop/scripts/dev.mjs`, run once from
the repository root and once from `apps/desktop` -> exit 0 both times, printing
the *same* instance summary both times (this is what proves the git-root
resolution rather than a cwd-relative guess). Executed from this linked
worktree, that summary must name a derived `Coflux-dev-<slug>` profile, never
the baseline; the main-worktree branch of that rule is covered by the owner's
acceptance.

### Milestone 2: Parallel windows are individually identifiable

With `COFLUX_DESKTOP_INSTANCE_LABEL` set, the window title carries the label
and survives the renderer's repeated `document.title` writes, and the Dock badge
carries the label composed with the product's attention count per the
composition rule — the count never erases the label, the label never hides the
count. With the variable absent — every packaged run — titles and Dock behave
exactly as before. The renderer is unchanged.

Validation: `pnpm -C apps/desktop typecheck` -> exit 0;
`pnpm -C apps/desktop test` -> exit 0.

### Milestone 3: The knowledge lives in one place

`.agents/skills/desktop-preview/SKILL.md` exists in English and covers: how to
start a preview, how parallelism works and what is derived from what, how
instances are identified, how to stop one and what cleanup is automatic, the
things that must never be done (staging a daemon into a dev build, renaming the
app, taking port 8788), the fact that profiles and their grants accumulate, and
how to read the logs: `~/Library/Logs/Coflux/main.log` is shared by the
installed app and every dev instance (`apps/desktop/src/main/log.ts` uses
electron-log's default path), so lines interleave and only the startup line
identifies an instance, through its `userData` field
(`apps/desktop/src/main/index.ts:157`).
`.claude/skills/desktop-preview` symlinks to it.
`docs/desktop-acceptance.md` keeps the acceptance handover and points at the
skill; `AGENTS.md` and `apps/desktop/README.md` carry pointers rather than
duplicated instructions.

Validation: `test -f .agents/skills/desktop-preview/SKILL.md && test -L .claude/skills/desktop-preview` -> exit 0.

## Landmines

- **`SingletonLock` is a symlink, not a file.** Verified on this machine:
  `~/Library/Application Support/Coflux/SingletonLock -> wsqdeMacBook-Pro.local-13894`,
  and the link target does not exist as a path. Reading it with `readFileSync`
  throws `ENOENT`, which a naive implementation reads as "no lock" — the exact
  inversion that would reclaim a *live* instance's lock. Use `readlinkSync`,
  take the PID after the last `-`, and check the hostname prefix too.
- **A dev instance killed by the single-instance lock exits 0.** The lock path
  calls `app.quit()` (`apps/desktop/src/main/index.ts:119-120`), and
  electron-vite forwards the child's exit code verbatim
  (`ps.on('close', process.exit)` in `electron-vite/dist/chunks/lib-*.js`), so
  the launcher cannot distinguish "started fine" from "was locked out" by exit
  code. The pre-start lock check is the only signal; do not invent one from the
  exit status.
- **The `dev` script does not run from the worktree root.** `pnpm --filter
  @coflux/desktop dev` (`package.json:10-11`) executes with the working
  directory at `apps/desktop`. The launcher must resolve the worktree root
  through git, not from `process.cwd()` or a relative `../..` guess.
- **`COFLUX_DESKTOP_USER_DATA` is `resolve()`d by the main process**
  (`apps/desktop/src/main/index.ts:43`), so a relative value resolves against
  the Electron process's working directory. Always pass an absolute path.
- **Never stage a daemon into a dev build to make parallel previews "more
  complete".** `docs/desktop-acceptance.md` records that a populated
  `build/daemon` makes the dev client start its own runtime against production
  and register this Mac as a second device on the real account — with parallel
  instances that multiplies per instance. The dev client's local-runtime panel
  reporting an incomplete installation is expected.
- **`app.setName` must not be touched.** Electron's safeStorage Keychain entry
  is named after the app name, so renaming an instance would make every copied
  `session-token.bin` undecryptable — the opposite of the goal
  (`apps/desktop/src/main/token-store.ts:1-12`).
- **Port 8788 belongs to the installed app's runtime**
  (`crates/protocol/src/lib.rs:64`). Nothing in this plan may bind it, and the
  existing `pnpm dev:daemon` conflict documented in `docs/desktop-acceptance.md`
  stays as-is — the skill describes it, the code does not change it.
- **Each new profile adds a local browser grant on the production account** for
  this machine's daemon. The ceilings are generous but finite: 1024 in the
  worker (`crates/worker/src/local_auth.rs:37`) and 256 per daemon on the server
  (`apps/server/src/local-control.ts:59`). The skill should say not to
  accumulate profiles indefinitely.
- **`5274` appears in main-process unit tests** as a literal
  (`apps/desktop/src/main/ipc-trust.test.ts:15-16`,
  `apps/desktop/src/main/origin.test.ts:54-56`). Those are pure-function tests
  over a supplied dev renderer URL, not assertions that the port is fixed;
  trusted-URL checks already flow from `ELECTRON_RENDERER_URL`
  (`apps/desktop/src/main/index.ts:35-36`), which electron-vite sets to the
  actual port. Do not hardcode the port anywhere in the main process, and do not
  rewrite those tests to chase the new variable.
- **The renderer overwrites `document.title` on every selection change**
  (`apps/desktop/src/renderer/components/workbench/workbench.tsx:363`). A title
  set once at window creation will be gone within a second of use.

## Scope

In scope:
- `apps/desktop/scripts/dev.mjs` (new)
- `apps/desktop/package.json` (the `dev` script)
- `apps/desktop/electron.vite.config.ts` (renderer port from the environment)
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/window.ts`,
  `apps/desktop/src/main/notifications.ts` (apply the instance label to the
  window title, and compose it with the attention count on the Dock badge;
  nothing else)
- `.agents/skills/desktop-preview/SKILL.md` (new), `.claude/skills/desktop-preview` (new symlink)
- `docs/desktop-acceptance.md`, `apps/desktop/README.md`, `AGENTS.md` (shrink to pointers)
- `wiki/plans/20260916-desktop-preview-parallel.md`, `wiki/plans/README.md`

Out of scope:
- `package.json`'s `dev:server`, `dev:daemon`, `dev:pg` and anything under
  `apps/server/**` or `crates/**` — a parallel local stack is a different change
- `apps/desktop/src/renderer/**` — identification must not touch product UI
- `apps/desktop/electron-builder.yml`, `apps/desktop/scripts/stage-daemon.mjs`,
  `apps/desktop/test/config.test.ts` — packaging is unaffected
- `skills-lock.json` — it tracks externally sourced skills only
- The installed `Coflux.app`, its runtime, and port 8788

## Commands

This worktree starts without `node_modules`; `pnpm install` at the repository
root is a prerequisite for every `pnpm` row below (`dev:execute-plan` installs
at preflight).

| Purpose | Command | Expected result |
| --- | --- | --- |
| Typecheck | `pnpm -C apps/desktop typecheck` | exit 0 |
| Unit tests | `pnpm -C apps/desktop test` | exit 0 |
| Build | `pnpm -C apps/desktop build` | exit 0 |
| Launcher parses | `node --check apps/desktop/scripts/dev.mjs` | exit 0 |
| Launcher resolves | `COFLUX_DESKTOP_DEV_DRY_RUN=1 node apps/desktop/scripts/dev.mjs`, from the repository root and from `apps/desktop` | exit 0 both times, identical summary, derived profile named |
| Skill wiring | `test -f .agents/skills/desktop-preview/SKILL.md && test -L .claude/skills/desktop-preview` | exit 0 |
| Parallel preview (acceptance) | three worktrees, `pnpm dev:desktop:prod` in each | three signed-in, individually identifiable windows coexist; closing one leaves the others working; the installed app is untouched |

## Done criteria

- [ ] All listed commands pass (the acceptance row is the owner's, run last).
- [ ] Running the command in a second worktree starts a second preview instead
      of failing on a port conflict or exiting on the single-instance lock.
- [ ] The same worktree yields the same profile, port, and label on every run.
- [ ] A derived instance's first start opens already signed in when the baseline
      profile is signed in, and at the sign-in screen when it is not.
- [ ] The main worktree still uses `Coflux-dev` with its existing sign-in and
      window position.
- [ ] Ctrl-C leaves no Electron helper holding a profile lock; a stale lock from
      a dead PID is reclaimed automatically on the next start, and a lock held by
      a live PID is reported rather than reclaimed.
- [ ] The Dock badge shows the instance label and the product's attention count
      together: a workspace demanding attention does not erase the label, and the
      label does not hide the count.
- [ ] Every port this repository already claims is outside the derivation range.
- [ ] With the new environment variables absent, behaviour is identical to
      `ebca9085` — packaged runs included.
- [ ] The skill exists, is symlinked, and the three documents point at it
      instead of duplicating it.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- Copied credentials do not decrypt in a derived profile — that invalidates the
  first-start copy decision; report rather than fall back to plaintext or to
  sharing one file.
- Making the window title survive the renderer's `document.title` writes would
  require changing the renderer.

## Maintenance notes

- The launcher is macOS-only in practice: the baseline profile path is
  `~/Library/Application Support/Coflux-dev`, derived from Electron's `userData`
  plus the `-dev` suffix in `apps/desktop/src/main/index.ts:44`. If that suffix
  or the product name ever changes, the launcher's baseline path must change
  with it.
- Lock reclaim is a convenience, not the protection. Chromium's POSIX
  single-instance logic already reclaims a lock whose PID is gone; the failure
  actually recorded in `docs/desktop-acceptance.md` is a *live* helper holding
  the lock after its main process died, which no PID-liveness check can clear.
  Group teardown is what prevents it — do not let the reclaim path lull anyone
  into thinking the lifecycle is handled.
- Profiles are never garbage-collected. A deleted worktree leaves its
  `Coflux-dev-<slug>` directory and its account-side grant behind; both are
  cheap, both are finite. Revisit if the grant ceilings are ever approached.
- A parallel *local stack* remains unsolved, deliberately. If it is ever wanted,
  the pieces exist — `COFLUX_PORT`, `COFLUX_HOME`, `COFLUX_LOCAL_GATEWAY_PORT`
  (`crates/worker/src/main.rs:537`), and a per-stack database — but the fixed
  8788 contract with the installed app is the real obstacle.
