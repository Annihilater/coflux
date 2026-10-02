# Plan 20261002-headless-self-hosted-cli: Headless devices run without systemd, and both CLIs speak English product copy

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 11bc48bb..HEAD -- crates/launcher crates/ptyd/src/main.rs crates/cli packages/cli tests/src/cofluxd-service.test.mjs tests/src/service-unit.test.mjs tests/src/release-sign.test.mjs tests/src/cli-release-trust.test.mjs integrations/claude-plugin apps/desktop/src/main/desktop-runtime.ts apps/desktop/src/renderer/components/workbench/add-device-view.ts crates/runtime/src/sessions.rs crates/runtime/src/main.rs`

## Status

- Priority: P2
- Effort: L
- Risk: MED
- Depends on: `20261002-runtime-launcher-merge` (PR #99, open, unmerged). This branch is cut from its tip `11bc48bb`; the pull request for this plan targets `dev/20261002-runtime-launcher-merge`, not `main`.
- Category: feature
- Execution: subagent(opus) — departure check
- Stop after: implementation — departure check (plan audit, then implement)
- Plan review: audit — departure check
- Workspace: isolated — the session was on the main worktree; this worktree (`.claude/worktrees/20261002-headless-self-hosted-cli`, branch `dev/20261002-headless-self-hosted-cli`) was cut from the PR #99 tip at the user's direction
- Planned at: `11bc48bb`, 2026-10-02

## Requirement

Two problems, one CLI surface.

**A. `cofluxd` only works where systemd (Linux) or launchd (macOS) manages it.** In a Docker container, a WSL distro without systemd, or an Alpine/OpenRC host, `systemctl` is missing or systemd is not PID 1. Today `cofluxd up` still prints `✓ systemd: …` and `✓ daemon 已启动`, because `run()` in `packages/cli/cofluxd.mjs` never checks exit status, and then hangs in `waitForAuthorization` while nothing is running. The user's first idea was to embed pm2; that was rejected (see Decisions). The outcome:

- **`cofluxd up` picks the service mode by itself.**
  - macOS: launchd, as today.
  - Linux with systemd booted: systemd user units, as today. When a `systemctl --user` call fails there, `up` stops with a clear error and a non-zero exit; it never prints success.
  - Linux without systemd booted: **self-managed mode**. `cofluxd up` starts a small background watchdog that owns the terminal host and the launcher, restarts the launcher with backoff when it exits (terminals survive, as with `cofluxd restart`), and restarts both when the terminal host dies (terminals were already lost). It says plainly that this mode does not start on boot and that containers should use `cofluxd run` as their entry point.
- **New `cofluxd run`**: the same flags as `up` (`--server`, `--name`, `--shell`, `--key`, `--version`, `--bin-dir`); it downloads binaries if missing, then runs the watchdog in the **foreground**. Output goes to stdout/stderr (container logs). An unregistered device prints its authorization link in that output. A launcher crash is restarted internally with terminals kept; the terminal host exiting ends `run` with a non-zero exit code so the outer supervisor (Docker restart policy, s6, supervisord, tmux) restarts it; SIGTERM/SIGINT stops everything cleanly and exits 0 — `docker stop` works.
- **Every other command works in self-managed mode.** `status` shows the service as `running (self-managed, no autostart)`, or a user-level description of what is wrong — for example `stopped`, or `starting` while terminals are still held but the device is not connected. It never names a component. `logs [-f]` reads `daemon.log`; `down` stops everything; `restart` restarts the service and keeps terminals; `restart --ptyd` restarts everything and ends terminals; `uninstall [--purge]` works. Running `up` again while the self-managed service is up behaves like `restart`: it applies the settings and keeps terminals. `run` never exits because a join key was rejected; it prints the rejection and keeps running, so a container restart policy cannot loop on a spent key.
- **Subcommands and flags are frozen.** `up`, `run`, `status`, `doctor`, `update`, `restart`, `restart --ptyd`, `fda`, `logs [-f]`, `down`, `uninstall [--purge]` and every existing flag keep their names. Only the prose around them changes, even where a flag name happens to be internal (`--ptyd`).
- Non-goals: autostart on boot without an init system; generating OpenRC/runit/sysvinit units; root or system-level units; `loginctl enable-linger`; pm2 or any third-party process manager; any macOS behaviour change; Windows.

**B. Both CLIs read like code comments, in Chinese.** Messages explain internals (`launcher / ptyd 无变化——不需要重启…运行组件（runtime）由中心自动推送更新；本次刷新的只是它的内置兜底二进制`), cite plans, and nest parenthetical rationale. They are shown to users. The outcome: `cofluxd`, `coflux` (Node: `packages/cli/coflux.mjs`, `account-client.mjs`; Rust: `crates/cli`), the shared `release-trust.mjs` messages, every `--help`, and the npm package description are **English product copy**:

- Say what happened and what to do next. Never explain the design. No plan numbers.
- Never name internal components — launcher, ptyd, runtime, worker, supervisor, sessiond, gateway internals. User vocabulary only: device, service, terminals, server, account, workspace, project.
- Style (user-approved, gh/fly-like): green `✓` for success; yellow `!` for warnings; red `✗ Error: <what>` on **stderr** followed by one indented line with the next action; progress as `Doing X... done`; `status`/`doctor` as aligned key/value tables; `--help` as standard `Usage:` / `Commands:` / `Flags:` sections. Colour and symbols-in-colour only when the stream is a TTY; honour `NO_COLOR`. Agents call `coflux` without a TTY and must get plain text.
- Machine-consumed output keeps its shape: `--json`, ids and handles, `terminal read` content, `workspace` JSON lines, exit codes, `service-files`.
- Approved reference mock (wording may be refined, structure may not):

```text
$ cofluxd up
Downloading Coflux 2.15.0 (linux-x64)... done
✓ Signature verified
✓ Service started

To add this device to your account, open:

    https://coflux.dev/a/7Kx2Qp

Waiting for authorization... (expires in 10m)
✓ Device "build-box" connected to coflux.dev

$ cofluxd update
✓ Already up to date (2.15.0)

$ cofluxd status
Device      build-box
Server      coflux.dev
Service     running (self-managed, no autostart)
Connection  connected for 3h 12m
Terminals   4 open

$ cofluxd up --key abc
✗ Error: invalid join key
  Copy the full command from Add Device in Coflux.
```

Out of scope for B: error text that originates in the runtime or the server and that the CLI only relays (for example `越界` / `不存在` asserted in `tests/src/contract.test.mjs`), and the daemon's own log lines in `daemon.log` / `cofluxd run` output. These stay as they are; a later slice owns them.

**C. Delete tests that only pin copy.** The user asked to clear out the messy tests in this area. AGENTS.md's rule decides which: keep a test only if a break would stay invisible while using the product.

Observable when done: in a `node:22` container without systemd, `cofluxd up` shows an authorization link and the device comes online; killing the launcher brings the device back within seconds with terminals intact; `status`/`logs`/`down`/`restart` behave as above; `cofluxd run --key …` as a container command brings the device online and `docker stop` exits cleanly; on a systemd host where `systemctl --user` fails, `up` errors out instead of claiming success. Across `cofluxd` and `coflux` common paths (`up`, `update`, `restart`, `status`, `doctor`, `logs`, `down`, `coflux login`, `terminal …`, `workspace …`, `notify`, `ports`, `secret …`, `executor run`, `annotations …`, `device exec`, `project import`, `--help`) there is no Chinese text, no internal component name, and every error carries a next step.

## Decisions & tradeoffs

- **No pm2 and no third-party process manager**: cofluxd and the launcher supervise themselves. Rejected: pm2 — `pm2 startup` only generates systemd/launchd/OpenRC/upstart units, so it removes no init-system dependency; it adds a resident Node daemon on every device; and it is AGPL-3.0 (`npm view pm2 license` → `AGPL-3.0`, version 7.0.4). Rejected: a "lighter" service library (e.g. the Rust `service-manager` crate) — it too only writes units for an existing init system. Surviving reboot belongs to the init system or the outer container runtime; that is a non-goal here.
  Based on: the launcher already supervises the runtime (spawn, probation, rollback) — `crates/launcher/src/main.rs:1-12`; desktop already runs ptyd + launcher with no launchd — `apps/desktop/src/main/desktop-runtime.ts:156-167,360-374`.

- **The watchdog is Rust, a `watch` mode of the existing `coflux-launcher` binary.** Invoked as `coflux-launcher watch` (foreground) — no new binary, no new release artifact. Without `watch`, `coflux-launcher` behaves exactly as it does today, and the launchd, systemd and desktop paths keep starting the launcher directly. The watcher process starts `coflux-ptyd` and a child `coflux-launcher` (normal mode); the launcher itself still never starts ptyd (its contract at `crates/launcher/src/main.rs:7-9` stays true). Rejected: a resident Node watchdog (`cofluxd run` staying alive as the supervisor) — devices must not run resident Node (AGENTS.md: "Rust daemon core, no Node runtime"; the desktop-bundled daemon ships no Node). `cofluxd run` may stay as a thin Node parent that forwards signals and mirrors the exit code — it supervises nothing.
  Based on: `crates/launcher/Cargo.toml` (binary `coflux-launcher`); `packages/cli/cofluxd.mjs` `ensureBinaries` installs `coflux-launcher`, `coflux-runtime`, `coflux-ptyd` into `~/.coflux/bin`.

- **Watcher semantics** (these define the product behaviour; the mechanism is the executor's):
  - Launcher exits for any reason the watcher did not ask for → restart it with backoff; ptyd untouched.
  - ptyd exits → stop the launcher; in background mode restart ptyd then the launcher with backoff; in foreground mode exit non-zero.
  - SIGTERM / SIGINT to the watcher → SIGTERM the launcher (its "leave"), then SIGTERM ptyd (ends the shells), exit 0.
  - A `cofluxd restart` request → SIGTERM the launcher and start it again immediately, with no backoff; ptyd untouched. The watcher must be able to tell a requested restart from a crash, so it needs a control path cofluxd can reach — a socket, a signal with a defined meaning, or similar; the executor chooses. Killing the launcher's pid from outside does not qualify: the watcher would see a crash. `(revised on plan audit)`
  - In foreground mode, SIGHUP gets the same ordered stop as SIGTERM/SIGINT. `(revised on plan audit)`
  - Exactly one instance per `COFLUX_HOME`. The watcher holds an exclusive lock for its lifetime. Holding the lock is not enough on its own, though: ptyd and the launcher run in their own sessions, so when the watcher is SIGKILLed or OOM-killed they live on as orphans after the lock is released. Before starting anything, `watch`, `up` and `run` must also check whether a ptyd or launcher already serves this home — live `ptyd.sock` / `launcher.sock`, or a live pid in `runtime.pid` (written at `crates/runtime/src/main.rs:735`). If one does, adopt it, or refuse with a next step; never start a second one. `(revised on plan audit)`
  Background vs foreground is a flag of `watch` chosen by cofluxd; the flag name is the executor's call.

- **ptyd and the launcher run in their own sessions/process groups, never in the watcher's** (decided while planning). A Ctrl-C in `cofluxd run` delivers SIGINT to the whole foreground process group, and ptyd treats SIGINT as "stop all terminals" (`crates/ptyd/src/main.rs:62-63`); the launcher treats it as leave (`crates/launcher/src/main.rs:155`). Only the watcher may decide whom to signal and in what order. Rejected: inheriting the watcher's process group — Ctrl-C and terminal hangups would race the ordered shutdown.

- **Service mode on Linux is decided by `/run/systemd/system`** — the `sd_booted()` test. Present → systemd user units; absent → self-managed. Rejected: "is `systemctl` on PATH" — many container images ship `systemctl` without systemd running, and that is exactly the failing case. With systemd booted, any failing `systemctl --user` call makes `up`/`restart`/`down` exit non-zero with an error naming the failed step; no silent fallback to self-managed. Every `launchctl`/`systemctl` call checks its exit status — except the deliberate "unload/stop whatever may be loaded" calls whose failure is expected, which must stay tolerant.
  Based on: `packages/cli/cofluxd.mjs` `run = (cmd, args, opts) => spawnSync(...)` with no status check; `installService` / `restartService` / `stopService`.

- **Self-managed mode is recorded on disk, not re-detected.** `status`, `down`, `restart`, `logs`, `uninstall` act on the mode the device is actually running under (a marker plus the watcher's pid/lock in `COFLUX_HOME`; layout is the executor's call). `restart` in self-managed mode signals the running watcher; it does not start a second one.

- **`cofluxd run` refuses to start while another instance owns this `COFLUX_HOME`** — a background watcher, or a launchd/systemd service that is loaded and running — and tells the user to run `cofluxd down` first. Two launchers would fight: the launcher deletes and re-binds `launcher.sock` unconditionally at start (`crates/launcher/src/main.rs:124`).

- **The self-managed watcher gets the same `COFLUX_*` environment the units carry, and only that.**
  - It always gets `COFLUX_HOME`. When this install can host an executor, it also gets `COFLUX_EXECUTOR_NODE` / `COFLUX_EXECUTOR_ENTRY` as absolute paths from `executorRuntime()`. A missing variable is a silent break: the daemon runs, and only `coflux executor run` reports much later that the machine has no executor host.
  - Every other inherited `COFLUX_*` variable is stripped. Non-`COFLUX_*` variables (`PATH`, `HOME`, locale, …) pass through.
  - Exception: an explicit allowlist of operator/test overrides that the harness or release tests rely on. The executor finds and lists these; examples are a release public-key override and `COFLUX_RUNTIME_PROBATION_MS`.
  - Rejected: `{ ...process.env, COFLUX_HOME, … }`, the desktop's pattern (`apps/desktop/src/main/desktop-runtime.ts:163,374`). `cofluxd up` is often run from inside a Coflux terminal, and the PTY environment is a copy of the runtime's own (`crates/runtime/src/sessions.rs:1046`). That terminal carries `COFLUX_LAUNCHER_SOCK`, `COFLUX_LAUNCHER_NONCE`, `COFLUX_TRANSPORT_*`, `COFLUX_LOCAL_GATEWAY_PORT` and `COFLUX_SESSION_ID`, which the launcher and runtime read and would then bind to another daemon's sockets. `(revised on plan audit)`
  Based on: `packages/cli/service-unit.mjs:1-40`; `tests/src/service-unit.test.mjs`.

- **One output helper per language; Node and Rust `coflux` print the same English text.** Node: one module under `packages/cli/` shared by `cofluxd.mjs`, `coflux.mjs`, `account-client.mjs`, `release-trust.mjs`. Rust: one module in `crates/cli`. Each owns the symbols, colour, TTY detection, `NO_COLOR`, and the error-plus-next-step shape. Library choice is the executor's; a small Rust crate or hand-rolled SGR is fine. The helper does its own TTY / `NO_COLOR` gating. `packages/cli/package.json` declares `engines.node >=20`; `util.styleText` only exists from 20.12, and only gates on TTY / `NO_COLOR` by itself from 22.13. `(revised on plan audit)` Rejected: a separate formatting approach per command — the reason the copy reads inconsistent today.

- **Value-bearing output keeps its shape; prose is rewritten.** Anything an agent or script consumes — `--json`, printed ids and handles, the handle format `coflux:<kind>:<first 8 of id>`, `terminal read` content, `workspace` JSON lines, exit codes, the hidden `cofluxd service-files` JSON — keeps its structure. Where `packages/cli/skills/coflux/SKILL.md` documents a prose line or help phrase that changes, the skill is updated in the same change.

- **Test deletion rule** (user request, AGENTS.md "Test harness" criterion). The criterion: an assertion on **prose**, in any language, goes. An assertion on behaviour or on a machine contract stays, even when it lives in a test that also checks prose. `(revised on plan audit)`
  - Delete these whole:
    - `tests/src/cofluxd-service.test.mjs` — asserts Chinese help text and unit-file shape, both visible in use;
    - in `crates/cli`: `terminal_new_and_run_output_matches_node`, `wait_send_and_close_phrases`, `terminal_list_rows_show_busy_and_last_exit_for_live_shells`, `ports_rows_and_empty`, `executor_success_prints_the_reply_the_files_and_the_no_commit_boundary`, `executor_failure_names_the_terminal_state_and_the_reason`, `executor_timeout_message_says_it_cancelled`, `list_renders_everything_an_agent_needs`, `a_multi_element_annotation_describes_every_element`, `a_region_annotation_describes_the_region_its_container_and_what_is_inside`, `empty_list_names_the_workspace`, `code_comments_render_their_location_and_lines`, `resolved_line`, `help_keeps_agent_phrases_used_by_skill_docs`.
  - Keep, and drop only their prose assertions:
    - `errors_match_node_strict_mode` — which inputs are rejected;
    - `a_wrong_kind_filter_names_both_kinds` (`crates/cli/src/handle.rs:167`) — handle and raw id both accepted, a wrong kind is `Err` rather than an empty list;
    - `terminal_list_leads_with_the_handle_even_against_a_daemon_that_sends_none` (`crates/cli/src/commands.rs:861`) — the handle `coflux:terminal:<8>` is derived locally when the daemon sends no ref; this is machine output;
    - `session_block_reminds_about_coflux_secret_with_its_skill_path` (`crates/cli/src/integration.rs:534`) — the `<coflux-session>` wrapper and the absolute skill path, the only way a Codex session finds the skill.
  - Keep untouched: argument parsing, base64url/S256 vectors, secret masking, ANSI stripping, handle parsing, hook body, HTTP parsing, timeouts/defaults, id uniqueness, Codex integration argument handling, `workspace_json_lines_keep_node_field_order_and_omit_missing`, and `tests/src/service-unit.test.mjs`, which is extended so the executor variables are also asserted on the self-managed watcher's environment. Also stripped `COFLUX_*` — cheap to assert, invisible when broken.
  - The trust-chain suites `tests/src/release-sign.test.mjs` and `tests/src/cli-release-trust.test.mjs` are kept whole. They match error text with regexes (`release-sign.test.mjs:78-79,226-247`: 未知 release component, sha256 不匹配, 大小不匹配, 缺少匹配, 元数据非法, release Ed25519 签名无效; `cli-release-trust.test.mjs:264` `floor 已损坏`, `:394` `--version vX.Y.Z`). When this plan rewrites those messages, only the regexes change, to match the new English text one for one: no case is removed, weakened or restructured. Each negative case must still fail for the reason it names. `(revised on plan audit)`
  - `tests/src/secret-input.test.mjs:243` expects the Rust CLI's stderr to contain `not provided`. Keep that phrase in the rewritten copy.

  Write no new tests for copy or for anything a person notices on first use. Other black-box files are out of scope.

## Direction

The watchdog is a supervision shell around two processes that already exist; cofluxd only prepares (binaries, settings, join key) and hands over. Self-managed mode is a third service backend beside launchd and systemd inside `cofluxd.mjs`, selected once at `up` and recorded.

Milestone dependencies:
- M1 (Rust watcher) and M2 (Node output helper + `coflux` Node copy) are independent and may run concurrently.
- M3 (Rust `coflux` copy + test deletion) needs M2, because the Rust text must match the Node text.
- M4 (cofluxd self-managed mode, `run`, exit-status checks, cofluxd copy) needs M1 and M2.
- M5 (docs, skill, plugin) needs M3 and M4.

### Milestone 1: `coflux-launcher watch` supervises ptyd and the launcher

The watcher semantics in Decisions hold: one instance per home, ptyd and launcher in their own process groups, ordered shutdown, launcher restart with backoff, background vs foreground behaviour on ptyd death, a restart request that touches only the launcher. Its own log lines are English and plain. The normal launcher mode is unchanged.
Validation: `cargo build -p coflux-launcher` with zero warnings; `cargo test -p coflux-launcher` → pass.

### Milestone 2: Node output helper and English `coflux` (Node)

The shared helper exists. `coflux.mjs` and `account-client.mjs` print English product copy in the approved style; `--help` uses Usage/Commands/Flags; value-bearing output is unchanged.
Validation: `node --check packages/cli/coflux.mjs packages/cli/account-client.mjs` → exit 0; `bash -o pipefail -c "NO_COLOR=1 node packages/cli/coflux.mjs --help | perl -CS -ne 'exit 1 if /\p{Han}/'"` → exit 0; every hit of `git grep -nP '\p{Han}' -- packages/cli/coflux.mjs packages/cli/account-client.mjs` is a comment, not a string literal.

### Milestone 3: English `coflux` (Rust) and copy-pinning tests removed

`crates/cli` prints the same text as M2 through its own helper; the tests listed in Decisions are gone and the kept ones pass.
Validation: `cargo build -p coflux-cli` with zero warnings; `cargo test -p coflux-cli` → pass; `git grep -nP '\p{Han}' -- crates/cli/src` shows no user-facing string (comments may remain).

### Milestone 4: `cofluxd` self-managed mode, `cofluxd run`, honest service calls, English copy

Everything in Requirement A holds, and every `cofluxd` message follows Requirement B. `tests/src/cofluxd-service.test.mjs` is deleted; `tests/src/service-unit.test.mjs` covers the watcher's environment as well.
Validation: `node --check packages/cli/cofluxd.mjs packages/cli/service-unit.mjs packages/cli/release-trust.mjs` → exit 0; `node --import tsx --test tests/src/service-unit.test.mjs` → pass; `node --import tsx --test tests/src/cli-release-trust.test.mjs` → pass (the trust chain must survive the copy rewrite); `bash -o pipefail -c "NO_COLOR=1 node packages/cli/cofluxd.mjs --help | perl -CS -ne 'exit 1 if /\p{Han}/'"` → exit 0; every hit of `git grep -nP '\p{Han}' -- packages/cli/cofluxd.mjs packages/cli/release-trust.mjs` is a comment; `node --import tsx --test tests/src/release-sign.test.mjs` → pass.

### Milestone 5: Docs, skill, plugin

`packages/cli/README.md` documents self-managed mode and `cofluxd run`, with a Docker example. `packages/cli/skills/coflux/SKILL.md` matches the new help and output wherever it quotes them. `node scripts/sync-claude-plugin.mjs` has been run, and `integrations/claude-plugin/.claude-plugin/plugin.json` is bumped from 0.21.0 to 0.22.0. The npm `description` in `packages/cli/package.json` is English. If `docs/RELEASING.md` or `docs/deployment.md` describe headless install steps, they mention `cofluxd run`.
Validation: `node scripts/sync-claude-plugin.mjs --check` → exit 0 (the CI step, `.github/workflows/ci.yml:157`).

## Landmines

- **`up` skips downloads when binaries exist** (`packages/cli/cofluxd.mjs:286-329`, `skipIfPresent`). A device whose `coflux-launcher` predates `watch` will fail to start self-managed mode after only upgrading the npm package. cofluxd must recognise an unsupported `watch` (unknown-mode exit, or a version check) and tell the user to run `cofluxd update`. It must never report the service as started.
- **The launcher re-binds `launcher.sock` unconditionally** (`crates/launcher/src/main.rs:124`). Any path that can start a second launcher for the same home — a second watcher, `run` while a unit is active, `up` run twice — silently orphans the first one.
- **ptyd's SIGTERM/SIGINT means "end every terminal"** (`crates/ptyd/src/main.rs:62-63`), and its systemd unit uses `KillMode=process` so only ptyd gets the signal (`packages/cli/service-unit.mjs` `ptydSystemdUnit`). The watcher must mirror this: signal ptyd only on full stop, and only ptyd, never its process group.
- **SSH hangup.** Background mode must fully detach from the invoking terminal: new session, stdin from `/dev/null`, stdout/stderr to `daemon.log`. Otherwise logging out of SSH sends SIGHUP and the "self-managed" service dies with the session — the very failure this plan exists to remove.
- **Both CLIs used to be tested for parity.** Once the parity tests are deleted, nothing enforces that Node and Rust `coflux` print the same text. M3 must compare against M2's strings directly.
- **The Bash tool runs zsh.** In `git show "$B:tests/…"` the `:t` is taken as a modifier and corrupts the path. Write `${B}:path`, or use `bash -c`.
- **Running black-box tests from inside a Coflux terminal** leaks `COFLUX_*` variables (e.g. `COFLUX_RUNTIME_ID`) into the harness; clear them first. Black-box ports are hardcoded, so two suites cannot run on one machine at once. Local test Postgres is `127.0.0.1:5432` (`pnpm dev:pg`).
- **Desktop shows the `cofluxd up --key` command** in its Add Device dialog (`apps/desktop/src/renderer/components/workbench/add-device-view.ts`). The command line itself must not change shape. The same file's headless agent prompt (line ~36) tells the agent to confirm that `cofluxd status` shows `(凭证: 已登记)`. That line is the one in-scope exception in `apps/desktop`: rewrite it to whatever the new `status` prints for a registered device. `(revised on plan audit)`
- **Start order: ptyd first.** The watcher waits for `ptyd.sock` to answer before it starts the launcher. The runtime tolerates a missing ptyd for only about 10 s (`crates/runtime/src/main.rs:620`), and ptyd cleans up its own stale socket (`crates/ptyd/src/server.rs:217`). The black-box harness's `spawnDaemon` uses the same order.
- **`apps/desktop/src/main/daemon-files.test.ts:53` compares `plistXml` output byte for byte.** In `packages/cli/service-unit.mjs`, add functions; do not change the text of existing templates.
- **PID 1 in Docker.** When `cofluxd run` is the container's PID 1, Node does not reap orphaned zombies. The README's Docker example uses `docker run --init` (or `init: true` in compose).
- **`util.styleText`** — see the output-helper decision: it does not exist on Node 20.0–20.11, and on Node 20.12–22.12 it colours unconditionally.

## Merge and deploy

- This branch stacks on PR #99. Merge #99 first, then retarget this PR to `main`. Release the two together or this one after #99: the `watch` mode ships inside the `coflux-launcher` artifact.
- No protocol change, no migration, no server change, no new environment variables. Release order: the normal `v*` tag publishes the launcher, the npm `cofluxd`, and the Desktop bundle together.
- Release notes must say: headless Linux hosts without systemd are now supported (`cofluxd up` runs self-managed, and `cofluxd run` is the container entry point); `cofluxd` and `coflux` output is now English; and on systemd hosts `cofluxd up` now fails loudly when `systemctl --user` does not work, where it used to report success.
- Existing devices: `npm i -g cofluxd@latest && cofluxd update && cofluxd restart` picks up the new launcher; launchd/systemd devices see only the copy change.
- Plugin 0.22.0 ships with the release (the plugin is no longer published through `myWsq/plugins`).
- Checks CI does not run: the Docker acceptance under Commands, and a visual pass of `cofluxd up` / `status` / an error in a colour terminal and with `NO_COLOR=1`.

## Scope

In scope:
- `crates/launcher/` (new `watch` mode only)
- `crates/cli/` (copy, output helper, test deletions)
- `packages/cli/` (`cofluxd.mjs`, `coflux.mjs`, `account-client.mjs`, `release-trust.mjs`, `service-unit.mjs`, new output helper, `package.json` description, `README.md`, `skills/`)
- `integrations/claude-plugin/` (sync output + version bump)
- `tests/src/cofluxd-service.test.mjs` (delete), `tests/src/service-unit.test.mjs` (extend)
- `tests/src/release-sign.test.mjs`, `tests/src/cli-release-trust.test.mjs` — error-text regexes only, one for one
- `apps/desktop/src/renderer/components/workbench/add-device-view.ts` — only the agent prompt line that quotes `cofluxd status`
- `Cargo.lock` — if a Rust output crate is added
- `docs/RELEASING.md` / `docs/deployment.md` — only lines describing headless install steps
- `wiki/plans/`

Out of scope:
- `crates/runtime`, `crates/ptyd`, `apps/server` — error text and logs they produce are a later slice; ptyd's signal contract is consumed, not changed
- the rest of `apps/desktop` — the desktop starts ptyd and the launcher itself and does not use `watch`
- systemd/launchd unit content, beyond what honest exit-status handling needs
- other black-box test files

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust build (zero warnings) | `cargo build -p coflux-launcher -p coflux-cli` | exit 0, no warnings |
| Rust tests | `cargo test -p coflux-protocol -p coflux-launcher -p coflux-runtime -p coflux-cli -p coflux-ptyd` | exit 0 |
| Node syntax | `node --check packages/cli/cofluxd.mjs packages/cli/coflux.mjs packages/cli/account-client.mjs packages/cli/release-trust.mjs packages/cli/service-unit.mjs` | exit 0 |
| Unit environment | `node --import tsx --test tests/src/service-unit.test.mjs` | pass |
| Trust chain | `node --import tsx --test tests/src/cli-release-trust.test.mjs` | pass |
| Release signing | `node --import tsx --test tests/src/release-sign.test.mjs` | pass |
| No Chinese in help | `bash -o pipefail -c "NO_COLOR=1 node packages/cli/cofluxd.mjs --help \| perl -CS -ne 'exit 1 if /\p{Han}/'"` (and the same for `coflux.mjs` and `target/debug/coflux --help`) | exit 0 |
| No Chinese string literals | `git grep -nP '\p{Han}' -- packages/cli/*.mjs crates/cli/src` | every hit is a comment |
| Plugin mirror | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Black-box core (acceptance) | `pnpm -C tests test` with inherited `COFLUX_*` cleared | pass (the launcher binary changed) |
| Container acceptance (acceptance) | Linux binaries built in the repo Docker image (`docker build -t coflux-test .`); inside a container with no systemd, run `node packages/cli/cofluxd.mjs up --server ws://host.docker.internal:8787/daemon --bin-dir target/debug` against a local `pnpm dev:server` + `pnpm dev:pg` on the host. Then: kill the launcher → device back online with terminals kept; `status`, `logs`, `restart`, `down`; then `cofluxd run` in the foreground, Ctrl-C / `docker stop` exits cleanly | behaviour as in Requirement A |

## Done criteria

- [ ] All listed commands pass.
- [ ] On a Linux host or container without `/run/systemd/system`, `cofluxd up` starts the self-managed service, says it does not autostart, and the device connects; the launcher is restarted after it is killed, and terminals survive.
- [ ] `cofluxd run` runs in the foreground with logs on stdout/stderr, exits 0 on SIGTERM/SIGINT after stopping everything, exits non-zero when the terminal host dies, and refuses to start while another instance owns the home.
- [ ] With systemd booted and `systemctl --user` failing, `cofluxd up` exits non-zero with an error and never prints success.
- [ ] macOS launchd and Linux systemd behaviour is unchanged apart from copy and exit-status checks.
- [ ] `cofluxd` and `coflux` (both implementations) print English product copy in the approved style on the paths listed in Requirement; no internal component names; every error is `✗ Error:` on stderr plus a next step; no colour without a TTY or with `NO_COLOR`.
- [ ] `--json`, ids/handles, `terminal read` content, `workspace` JSON lines and exit codes are byte-for-byte unchanged in shape.
- [ ] The tests named in Decisions are deleted or trimmed as stated, kept tests pass, `service-unit.test.mjs` covers the watcher environment, and the trust-chain suites pass with every negative case intact.
- [ ] A watcher killed with SIGKILL leaves no path that starts a second launcher for the same home.
- [ ] Running `cofluxd up` from inside a Coflux terminal starts a self-managed service that binds only its own home's sockets.
- [ ] README, SKILL.md and the plugin mirror are updated; the plugin version is 0.22.0.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- PR #99's launcher contract has changed under this branch: the launcher starts ptyd itself, SIGTERM no longer means leave, or `launcher.sock` binding changes.
- Self-managed mode would need a change in `crates/runtime` or `crates/ptyd`.
- An agent-facing output shape documented in SKILL.md cannot keep its structure under the new style.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- `daemon.log` in self-managed mode is append-only, just like launchd's today. Log rotation is not part of this plan; watch long-lived containers.
- After this plan, Chinese text remains only in runtime/ptyd/server messages and logs. The next slice should move those to English under the same principles, and update `tests/src/contract.test.mjs` with them.
- Plan audit (fable): every finding was accepted; none was rejected.
- The deleted parity tests were the only automatic guard that Node and Rust `coflux` say the same thing. Any future copy change must touch both implementations.
