# Plan 20261002-secret-skill: Agents reach for `coflux secret` whenever a value must stay out of the transcript

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat c53845fc..HEAD -- packages/cli/skills integrations/claude-plugin crates/cli/src/integration.rs crates/cli/src/integration scripts/sync-claude-plugin.mjs .github/workflows/ci.yml apps/desktop/src/renderer/components/workbench/secret-request-card.tsx apps/desktop/src/renderer/components/workbench/secret-request.ts apps/ios/Coflux/Views/SecretRequestCard.swift crates/worker/src/secret.rs crates/worker/src/secret/dotenv.rs`

## Status

- Priority: P2
- Effort: M
- Risk: LOW — documentation and two client input fields; no protocol, worker or server change
- Depends on: none
- Category: feature
- Execution: subagent(opus) — departure check (dev:explore, 2026-10-02)
- Stop after: implementation — departure check (plan audit, then continue)
- Plan review: audit — departure check
- Workspace: isolated — the session started in the main worktree; this plan lives on `dev/20261002-secret-skill` in `.claude/worktrees/20261002-secret-skill`
- Planned at: `c53845fc`, 2026-10-02

## Requirement

`coflux secret` (plan `20260926-agent-secret-input`) lets an agent obtain a value from the user without the value entering its context: a masked card appears over the terminal on the user's desktop and iOS app, and the agent only ever learns `provided` / `declined` / `cancelled`. In practice agents rarely use it: they ask the user to paste the API key into the chat instead. The capability is one section of the 713-line `coflux` skill (`packages/cli/skills/coflux/SKILL.md:477-518`). The skill's description lists it as one clause among a dozen features, so an agent that is about to ask for a key has nothing pointing it there.

Once this is done, an agent running in a Coflux terminal uses `coflux secret` whenever it needs a value from the user that should not enter the conversation. That includes values that cannot be pasted today because they span several lines.

Product conclusions (confirmed by the user in exploration):

1. **Consumer and trigger.** The consumer is a Claude Code or Codex agent in a Coflux terminal. It uses the capability in three situations:
   - It needs a value from the user that must not enter the transcript.
   - It is about to dig such a value out of shell history, the keychain or the user's config files on its own.
   - The user offers to paste a secret into the chat. The agent intercepts that and asks through the card instead.
2. **Coverage.** Anything the user would not want in the transcript, in the model provider's logs or on screen counts: API keys, tokens, passwords, database connection strings, private keys, certificates, cookies, recovery codes, and personal data such as ID or card numbers. Interactive prompts are excluded (an `ssh`/`sudo` password prompt, an OTP typed into a login flow). For those the user takes over the terminal, as today.
3. **Form.** A new standalone skill named `coflux-secret`, which Claude shows as `coflux:coflux-secret`.
   - Its description is written around those trigger situations, not as a feature list.
   - The secret section of the `coflux` skill moves into it wholesale. The `coflux` skill keeps a single pointer to it, and the secret clause is removed from the `coflux` skill's description.
   - The new skill states that it works only inside a Coflux terminal.
4. **Always-on reminder.** Every `<coflux-session>` block carries one sentence: when you need a sensitive value from the user, use `coflux secret`; never ask them to paste it into the chat.
5. **Multi-line values on desktop.** Pasting text with an inner line break into the desktop card turns the field into a masked multi-line area that keeps the line breaks.
   - In multi-line mode Enter inserts a line break and ⌘Enter submits.
   - Single-line behaviour is unchanged.
   - There is no manual toggle.
6. **Multi-line values on iOS.** The iOS card accepts multi-line values too, masked, byte-identical to what was pasted.
7. **Landing multi-line values.** The skill documents how such values reach their destination:
   - into an environment variable through `exec`;
   - into a dotenv file through `inject`;
   - into a standalone owner-only file (for example `key.pem`) through `coflux secret exec NAME -- sh -c '(umask 077; printf %s "$NAME" > <path>)'`.

   It also states the limit that comes with them: output redaction (`***` in `exec` output and in `coflux terminal read`) matches only the complete value. A multi-line value, or one line of it, printed to a terminal is **not** redacted. The only protection is never printing it. (revised on plan audit)
8. **Non-goals.** An `ask --multiline` flag (it would need a protocol field), a new file-injection command, and any change to the worker, the server or the wire protocol.
9. **Observable when done:**
   - A fresh Claude or Codex session in a Coflux terminal that needs an API key asks through the card instead of asking the user to paste it.
   - `coflux:coflux-secret` is listed among Claude's skills.
   - A PEM pasted into the desktop or iOS card reaches `coflux secret exec` with every line break intact.

## Decisions & tradeoffs

- **A separate skill, not a better paragraph in `coflux`**: the secret content lives in `packages/cli/skills/coflux-secret/SKILL.md` (frontmatter `name: coflux-secret`) and nowhere else. The `coflux` skill keeps only a pointer: one line in its body naming the skill and its relative path `../coflux-secret/SKILL.md`. That path is needed because agents that read the skill as a file, rather than through `/skills`, cannot follow a bare name. The `secret` entry in the local-commands table and in the limits list is reduced to a reference or removed. (pointer path revised on plan audit) Rejected: copying the section so that both skills carry it — two copies drift. Rejected: only rewording the `coflux` description — skill selection is driven by the description, and a long feature list cannot carry the trigger situations. Based on: `packages/cli/skills/coflux/SKILL.md:3,17,477-518,704-705`.
- **The new skill's description lists trigger situations and the coverage list from product conclusions 1–2**, phrased as "use this when…". It is not a feature summary. Plugin and skill text is English only. Based on: AGENTS.md language policy; user memory `coflux-plugin-hooks-source` (plugin directory and SKILL must be English).
- **`packages/cli/skills/` is the only source, and every delivery channel ships the whole directory**:
  - npm already ships `skills/` (`packages/cli/package.json` `files`).
  - The managed integration must write the new skill next to `skills/coflux/SKILL.md` among the assets it embeds and validates (`crates/cli/src/integration.rs:17,70-75`). Claude loads that root through `--plugin-dir` (`integration.rs:385`). Codex loads it as an extra skills root (`crates/cli/src/integration/codex.rs:495-520`), so both pick up a second skill directory.
  - Codex discovery must also confirm the second skill: today `crates/cli/src/integration/codex.rs:513` checks only `coflux/SKILL.md`, and it must require both. (revised on plan audit)
  - The Claude plugin delivery directory `integrations/claude-plugin/skills/` must mirror the whole source tree. Today `scripts/sync-claude-plugin.mjs:9-10` hardcodes one file pair. After this change, sync copies every file under `packages/cli/skills/`. `--check` fails when the plugin's `skills/` tree has a file missing, an extra file the source does not have, or a file that differs. The source tree is authoritative. The script's Chinese comments and messages become English while it is rewritten (AGENTS.md language policy). (revised on plan audit)
  - The desktop bundle carries a fourth copy: `apps/desktop/scripts/stage-daemon.mjs:97` copies the whole `integrations/claude-plugin` directory into the app. When there is no managed launcher, `crates/supervisor/src/shell/claude.sh:30-33` loads it with `--plugin-dir`. Copying the whole directory picks up the new skill without a change.

  Rejected: adding a second hardcoded file pair to the script — the next skill would silently miss the plugin. Rejected: symlinks — the marketplace contract forbids them (`scripts/sync-claude-plugin.mjs:2-4`).
- **Bump the plugin version**: `integrations/claude-plugin/.claude-plugin/plugin.json` goes from `0.20.0` to `0.21.0`, because the delivery directory changes. Based on: AGENTS.md (`integrations/claude-plugin` paragraph).
- **The reminder goes into both `<coflux-session>` emitters**: the Rust `emit_context` (`crates/cli/src/integration.rs:234-270`) and the plugin's `integrations/claude-plugin/scripts/session-context.sh:96-104`. The two blocks already differ in wording. Only their handle lines must match line for line (`integration.rs:206-212`), so the sentence does not need identical wording in both, but both must carry it. The Rust emitter's sentence also carries the absolute path `root.join("skills/coflux-secret/SKILL.md")`, the same way the block already points at the `coflux` skill. The reason is that a Codex session launched with `-p/--profile` keeps its native runtime, registers no extra skill roots and reaches skills only through that file path (`crates/cli/src/integration/codex.rs:318`). (revised on plan audit) Rejected: putting the reminder in the skill only — skills are loaded on demand, and this block is in context from the first turn. Based on: `integration.rs:308-331` (the block is emitted at SessionStart and whenever the workspace changes).
- **The worker and the protocol do not change**: the worker already accepts any non-empty UTF-8 value without NUL up to 64 KiB (`crates/worker/src/secret.rs:44,357-363`). `exec` hands the value through an environment variable unchanged, and `inject` double-quotes and escapes line breaks (`crates/worker/src/secret/dotenv.rs:141-166`). Desktop and iOS pass the value through untouched (`proto/coflux/v1/device.proto:952` `string`, `packages/client/src/device-router.ts:2554` with no trim). Multi-line input is therefore purely a client concern. Rejected: an `ask --multiline` hint — it needs a proto field, a center fan-out and a worker release, all for something paste detection gives for free.
- **Multi-line values are accepted without redaction support, as a documented limitation** (revised on plan audit): redaction is a literal match on the complete value. In the worker it is `crates/worker/src/secret.rs:509-560`, applied at `crates/worker/src/device.rs:3851,3900`; in the CLI it is the `Masker` at `crates/cli/src/secret.rs:396-423`. A PTY rewrites `\n` as `\r\n`, and a program may print one line on its own, so a multi-line value printed to a terminal is not redacted. The skill must limit its "`***` in `terminal read` / `exec` output" promise to single-line values and say that multi-line values rely on never being printed. Rejected: per-line or CRLF-aware redaction in the worker — the approved direction excludes worker changes; it is a candidate follow-up.
- **Desktop multi-line detection reads the paste event, not `onChange`**: the card's field is `TextInput type="password"` (`apps/desktop/src/renderer/components/workbench/secret-request-card.tsx:103-113`, and `onEnter` submits). A password input drops line breaks before `onChange` sees the text, so the clipboard text must be read in the paste handler. That the line breaks are lost is inferred from the HTML value sanitization, not tested on a machine, but either way the paste event is the only place the original text exists. Astryx `TextInput` has no `onPaste` prop, while `TextArea` has one. Catch the paste on a wrapping element (React's synthetic paste event bubbles) or through a ref. In multi-line mode the value is never rendered in clear text at any moment. The masking mechanism and the visual are the executor's choice; `-webkit-text-security` on a textarea is available in Electron's Chromium. Follow `docs/design-guidelines.md` (Tooltip component, never a native `title`).
- **Only an inner line break switches to multi-line** (decided while planning): text copied from a terminal or a file often ends with a newline. Such text, with line breaks only at its start or end, must behave exactly as today: it stays single-line, with the line breaks dropped. Multi-line mode starts only when a line break remains between content after the surrounding line breaks are ignored. Here a line break means LF, CRLF or a lone CR. Once in multi-line mode, the submitted value is the pasted text with every CRLF and lone CR normalized to LF and nothing else changed. That includes any trailing newline, because OpenSSH private keys need theirs. Normalizing to LF matches what a `<textarea>` value does by specification anyway, so a value pasted and then edited stays consistent. The skill states that multi-line values arrive with LF line endings. Rejected: switching on any line break — a pasted API key with a trailing newline would silently become a multi-line value with a newline in it. Rejected: keeping CRLF byte for byte — the textarea would rewrite it on the first edit. iOS follows the same rule. (line-break definition and normalization revised on plan audit)
- **iOS keeps the same invariants, and the executor chooses the control**: `SecureField` (`apps/ios/Coflux/Views/SecretRequestCard.swift:162-175`) is single-line. The iOS card must accept a multi-line value with three invariants:
  - the value is the pasted text under the inner-line-break and normalization rule above;
  - it is never shown in clear text;
  - `.privacySensitive()` is kept.

  How the user gets it in (for example a paste action that reads `UIPasteboard` and shows a masked summary) is the executor's call. New copy stays in Chinese like the rest of the card.
- **Release is not part of this run**: the skill reaches users with the next `v*` release (CLI and desktop bundle the `coflux` binary, which embeds the skill) and through the plugin marketplace once the builder receives the new SHA. iOS ships through TestFlight separately.

## Direction

The three milestones are **independent**: their file sets are disjoint (skills and integration, desktop renderer, iOS app), and none needs another's outcome to validate. They are safe to fan out as separate work packages.

### Milestone 1: The skill is standalone, delivered everywhere, and reminded in every session

- `packages/cli/skills/coflux-secret/SKILL.md` exists and carries:
  - the trigger-situation description;
  - the full content of the former section, extended with: the coverage list; the "user offers to paste" interception; the boundary for interactive prompts; the three ways to land a multi-line value; the LF line-ending note; the single-line-only redaction limit; and the Coflux-terminal-only note.
- The `coflux` skill points to it by name and relative path.
- The managed integration writes and validates the new skill alongside `skills/coflux/SKILL.md`, and the Codex discovery check requires both skills.
- The plugin directory mirrors `packages/cli/skills/` in full through the generalized sync script.
- The plugin README describes both skills and the generalized source rule, and the plugin version is 0.21.0.
- Both `<coflux-session>` emitters carry the reminder sentence; the Rust one also carries the absolute path of the new skill.
- A Rust unit test in `crates/cli` pins that the context block contains the reminder and the `coflux-secret` path. Nothing pins the block text today: `integration.rs:463-500` tests only `handle_lines`.

Validation:
- `node scripts/sync-claude-plugin.mjs --check` → exit 0.
- After deleting a file from the plugin copy, the same command exits 1. Restore the file afterwards.
- `sh -n integrations/claude-plugin/scripts/session-context.sh` → exit 0.
- The hook script output row in Commands shows the sentence intact.
- `cargo build -p coflux-cli` → zero warnings.
- `cargo test -p coflux-cli` → exit 0.
- The Han-character check in Commands → no output.

### Milestone 2: The desktop card takes multi-line values

The desktop card behaves as follows:
- A paste with an inner line break switches the field to a masked multi-line area holding exactly the pasted text.
- In that mode Enter inserts a line break and ⌘Enter submits.
- A paste without an inner line break, typing, and Enter-to-submit behave as before.

The inner-line-break and normalization rule lives in a pure function with a **required** `*.test.ts` unit test, because the desktop test glob skips `.tsx`. The test covers at least these cases:
- a trailing `\n`;
- a leading `\n`;
- a trailing `\r\n`;
- an inner `\n` with a trailing `\n` kept;
- an inner `\r\n` and a lone `\r`, both normalized to LF;
- text with no line break.

This is the one place a user's value can be altered silently. (revised on plan audit)

Validation: `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` → exit 0.

### Milestone 3: The iOS card takes multi-line values

The iOS card accepts a multi-line value under the invariants in Decisions. Single-line entry and the return-to-submit behaviour are unchanged.

Validation: `node scripts/build-ios-transport.mjs`, then the `xcodebuild` row under Commands → `** BUILD SUCCEEDED **`.

## Landmines

- **The managed integration validates its assets on every launch** (`crates/cli/src/integration.rs:76-87`): it compares every embedded asset with what is on disk. A new asset must be written and validated in the same list; otherwise every launch reports "integration files are damaged". The root directory is keyed by the binary's hash, so a new binary gets a fresh directory and old directories are untouched.
- **`session-context.sh` prints through `printf '%s\n'` with single-quoted arguments** (`:96-104`): a backtick or an apostrophe inside the new sentence must survive single quoting. Check the printed block, not just `sh -n`.
- **The Rust `<coflux-session>` text is a single `format!` string** (`integration.rs:260`): adding a sentence must not shift the positional arguments.
- **Chromium strips line breaks from `<input type=password>`**: any detection placed in `onChange` sees the already-flattened text and never fires.
- **`Enter` submits through `TextInput`'s `onEnter`** (`secret-request-card.tsx:111`): in multi-line mode that must no longer submit, or the first line break the user types sends a truncated value.
- **iOS build prerequisites**:
  - `xcodebuild` needs `node scripts/build-ios-transport.mjs` first, because the bridging header imports `libcofluxtailcat.h` and the framework is gitignored.
  - Package resolution can rewrite the two tracked `Package.resolved` files; check `git status` after building and restore them if only a re-resolve changed them.
  - Signing may stall the build; append `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`.
  - CI never builds iOS.
- **Local Rust tests can be polluted by the surrounding Coflux session**: if `cargo test` fails on environment-dependent cases, rerun with `COFLUX_HOME=` cleared before treating it as a regression (user memory `agent-presence-tests-unrunnable-locally`).
- **The plugin's SessionStart hook runs under a tight budget**: a 3 s locate watchdog (`session-context.sh:40-41`) inside the hook timeout declared in `integrations/claude-plugin/hooks/hooks.json`. The reminder is static text and must not add any command.
- **Codex with `-p/--profile` sees skills only through file paths** (`crates/cli/src/integration/codex.rs:318`): a reminder without the absolute path leaves `coflux-secret` unreachable in those sessions.
- **No CI gate keeps the plugin directory English**: the Han-character grep in Commands is the only check.

## Merge and deploy

- **After merging, the plugin release**: send the merge commit SHA to the `myWsq/plugins-builder` session so the marketplace picks up plugin 0.21.0. CI does not do this.
- **Managed integration and the desktop bundle's plugin copy** (`apps/desktop/scripts/stage-daemon.mjs:97`): both take effect when the user runs a CLI or desktop build from a `v*` release containing this change and relaunches the agent. Nothing changes on the server or the worker, and there is no ordering constraint.
- **iOS**: ships through TestFlight (`apps/ios/release.sh`) independently of the desktop release.
- **Release notes**:
  - Agents now ask for secrets through the card more readily.
  - Multi-line values (private keys, JSON credentials) can be pasted into the secret card on desktop and iOS.
  - Known limitation: multi-line values are not redacted to `***` in terminal output.
- **Rollback**: revert the commit. Nothing is persisted, and no protocol changes.

## Scope

In scope:
- `packages/cli/skills/coflux/SKILL.md`, `packages/cli/skills/coflux-secret/SKILL.md` (new)
- `integrations/claude-plugin/skills/**`, `integrations/claude-plugin/.claude-plugin/plugin.json`, `integrations/claude-plugin/scripts/session-context.sh`, `integrations/claude-plugin/README.md` (`:57`, `:89` name only the one skill)
- `crates/cli/src/integration.rs`, `crates/cli/src/integration/codex.rs` (discovery check)
- `AGENTS.md:21`, `docs/agent-integration.md:31,47` — only the wording that says the skill is single
- `scripts/sync-claude-plugin.mjs`, `.github/workflows/ci.yml` (the step's name or comment only, if it names a single file)
- `apps/desktop/src/renderer/components/workbench/secret-request-card.tsx`, `secret-request.ts` and a new `*.test.ts` beside them
- `apps/ios/Coflux/Views/SecretRequestCard.swift` (and a new iOS view file if the executor needs one)
- `wiki/plans/20261002-secret-skill.md`, `wiki/plans/README.md`

Out of scope:
- `crates/worker/**`, `crates/protocol/**`, `packages/protocol/**`, `proto/**`, `apps/server/**` — no wire or worker change (product conclusion 8)
- The stale "web/mobile app" wording in `session-context.sh:98` — unrelated
- Releasing, tagging, TestFlight, or sending the SHA to the builder

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Plugin mirror | `node scripts/sync-claude-plugin.mjs --check` | exit 0 |
| Hook script syntax | `sh -n integrations/claude-plugin/scripts/session-context.sh` | exit 0 |
| Hook script output | `COFLUX_WORKSPACE_ID=w COFLUX_DEVICE_ID=d PATH=/usr/bin:/bin sh integrations/claude-plugin/scripts/session-context.sh` | block printed with the reminder sentence intact |
| Plugin and skills stay English | `git grep -nP '\p{Han}' -- integrations/claude-plugin packages/cli/skills` | no output |
| CLI build | `cargo build -p coflux-cli` | exit 0, zero warnings |
| CLI tests | `cargo test -p coflux-cli` | exit 0 |
| Desktop gates | `pnpm -C apps/desktop typecheck && pnpm -C apps/desktop test && pnpm -C apps/desktop build` | exit 0 |
| iOS transport framework | `node scripts/build-ios-transport.mjs` | exit 0 |
| iOS compile | `xcodebuild build -project apps/ios/Coflux.xcodeproj -scheme Coflux -destination 'generic/platform=iOS' -allowProvisioningUpdates` | `** BUILD SUCCEEDED **` |
| Managed integration files (acceptance) | run the built `target/debug/coflux` agent launch path, or inspect a fresh `~/.coflux/agent-integrations/<id>/skills/` | both `coflux/` and `coflux-secret/` present |
| Skill discovery (acceptance) | fresh Claude Code (`/skills` or the skill list) and Codex (`/skills`) session in a Coflux terminal | `coflux:coflux-secret` / `coflux-secret` listed |
| Agent trigger walkthrough (acceptance) | fresh Claude Code and Codex session in a Coflux terminal, ask for something needing an API key | agent uses `coflux secret ask`; performed by the user |
| Desktop/iOS paste walkthrough (acceptance) | paste a PEM and a key with a trailing newline into the card, then `coflux secret exec NAME -- sh -c 'printf %s "$NAME" \| wc -l'` | PEM keeps its line count; the key stays single-line; performed by the user |

## Done criteria

- [ ] All non-acceptance commands pass.
- [ ] `packages/cli/skills/coflux-secret/SKILL.md` exists, its description leads with the trigger situations, and the `coflux` skill no longer carries the secret section or the secret clause in its description.
- [ ] The new skill limits the `***` redaction promise to single-line values, states the LF line-ending note, and uses the `umask 077` recipe for standalone files.
- [ ] The plugin directory mirrors every file under `packages/cli/skills/`, and `--check` fails on a missing, extra or differing file.
- [ ] The managed integration writes `skills/coflux-secret/SKILL.md` and validates it; Codex discovery requires both skills.
- [ ] Both `<coflux-session>` emitters print the reminder sentence; the Rust one includes the new skill's absolute path, and a unit test pins it.
- [ ] The desktop and iOS cards keep an inner-line-break paste masked and identical to the pasted text, except that CRLF and lone CR become LF. A paste with line breaks only at its start or end stays single-line. The desktop rule is covered by a `*.test.ts`.
- [ ] Plugin version is 0.21.0.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds — in particular, the worker rejecting a value with a line break.
- Supporting multi-line requires touching the worker, the protocol or the server.
- The outcome requires out-of-scope files.
- A validation command fails twice after one reasonable fix.
- A named assumption is false.

## Maintenance notes

- The `coflux-secret` description is the trigger surface. If agents still under-use the capability, tune the description and the `<coflux-session>` sentence before adding anything else.
- A future skill added under `packages/cli/skills/` reaches every channel automatically through the generalized sync and the managed-integration asset list. Keep the asset list in step with the directory.
- The inner-line-break rule is the one place a user's value could be altered silently. Any change to it needs the trailing-newline case re-checked.
- Follow-up candidate: CRLF-aware or per-line redaction in the worker and the CLI `Masker`, so multi-line values get the same `***` protection as single-line ones.
- Plan audit (fable, 2026-10-02): every finding was applied — the single-line-only redaction limit, the `umask 077` recipe, the Codex profile path and the discovery check, sync wording and the README in scope, the desktop bundle channel, the reminder unit test, the required desktop test, CRLF normalization, the Han check and the `onPaste` note. None was rejected.
