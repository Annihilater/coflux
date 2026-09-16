# Plan 20260916-pty-remote-session: Terminals declare themselves remote, so agent CLIs send the clipboard back to the person watching

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live code. Run milestone validations as you go only if
> you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat ebca9085..HEAD -- crates/supervisor/src/sessions.rs crates/supervisor/src/shell_integration.rs crates/supervisor/Cargo.toml`

## Status

- Priority: P2
- Effort: S
- Risk: MED — it changes the environment of every program in every coflux terminal
- Depends on: `wiki/plans/20260914-terminal-copy-clipboard.md` (the OSC 52 receiver; DONE, in review as PR #64)
- Category: bug
- Execution: subagent opus — from the departure check
- Stop after: implementation — from the departure check's autopilot item
- Plan review: none — from the departure check's autopilot item
- Workspace: isolated — `dev/20260916-pty-remote-session`
- Planned at: `ebca9085`, 2026-09-16

## Requirement

Copying inside an agent CLI does not reach the user. Running grok in a coflux
terminal on one machine while watching from another, its copy command reports
success and puts the text into the clipboard of **the machine the PTY runs
on** — the user, sitting at a different computer, gets nothing and has no
indication anything went wrong.

### Why

Agent CLIs choose a clipboard route by asking whether they can reach the
user's clipboard directly. `grok doctor` in a coflux terminal reports:

```
native    local (pbcopy)
osc 52    off
status    confirmed
```

It found `pbcopy`, concluded the clipboard is right there, and wrote to it.
That conclusion is wrong in coflux and cannot be made right by the CLI: a
terminal here is always potentially watched from somewhere else, and the
watching device can change at any moment.

The signal these tools use to know better is the SSH environment. With it
present, the same `grok doctor` reports `native: remote (pbcopy)` and states
"Grok sends OSC 52". Claude Code decides identically — its SSH check is
literally `!!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT ||
process.env.SSH_TTY)`.

But `crates/supervisor/src/sessions.rs:856-897` injects only `TERM`, `PATH`
and the `COFLUX_*` variables. Nothing tells the program its output is being
rendered on another machine, so every CLI that optimises for a local clipboard
gets it wrong. The OSC 52 receiver that would carry the text back already
exists (plan 20260914) and currently sits idle, because nothing ever emits
OSC 52.

### Observable when done

- In a coflux terminal, `grok doctor` reports `native: remote (pbcopy)` instead
  of `local`, and grok's copy command puts the text into the clipboard of the
  **device being used to view the terminal**, not the PTY host's.
- The same holds for Claude Code's copy.
- `echo $SSH_TTY` inside a coflux terminal prints that session's real PTY
  device path, and that path exists.
- Nothing else about the terminal changes: the shell starts the same way, the
  `COFLUX_*` contract variables are untouched, and a user's own `SSH_*`
  variables — when the daemon itself was started from an SSH session — are not
  silently destroyed (see Decisions).

## Decisions & tradeoffs

- **Only `SSH_TTY` is injected — not `SSH_CONNECTION`, not `SSH_CLIENT`**:
  measured, one variable is enough. Setting `SSH_TTY` alone already flips
  `grok doctor` from `native: local (pbcopy)` to `native: remote (pbcopy)`,
  and Claude Code's check is an `||` across all three, so any one satisfies it.
  Decisive tradeoff: `SSH_TTY`'s value is a **real PTY device path we actually
  have**, while `SSH_CONNECTION` and `SSH_CLIENT` would require inventing an
  IP and port pair — the daemon does not know the viewing client's address, and
  a fabricated one surfaces in tooling that prints "connected from …".
  Rejected: all three (fabricated values, wider blast radius for no measured
  gain); a coflux-specific variable (no CLI reads it); a per-CLI private switch
  — grok's only other lever, `GROK_OSC52_SINK`, leaves `native: local` and so
  does not redirect the route, and it is undocumented.

- **The value must be this session's real PTY device path, never a
  placeholder**: programs may `stat` or open `$SSH_TTY`, and a path that does
  not exist is worse than an absent variable. `SlavePty` (portable-pty 0.8.1)
  exposes only `spawn_command`, but `MasterPty::as_raw_fd()` is available on
  Unix (`portable-pty-0.8.1/src/lib.rs:114`), and the slave's name is
  recoverable from that descriptor. Rejected: a fixed string like
  `/dev/ttys000` — it satisfies a truthiness check but lies, and breaks any
  program that uses the path. If the real path genuinely cannot be obtained,
  that is a STOP, not a licence to invent one — report it and the fallback in
  the next bullet gets promoted instead.

- **Inject in the PTY layer, not in the shell rc**: setting it where `TERM`
  and the `COFLUX_*` variables are set covers every shell, including ones the
  shell-integration planner does not recognise (it deliberately skips unknown
  shells, `sessions.rs:884-897`). Rejected as the primary route:
  `export SSH_TTY=$(tty)` inside the injected rc — it works and the
  infrastructure exists, but it only reaches instrumented shells, leaving the
  behaviour inconsistent across sessions. Keep it in mind only as the fallback
  if the device path proves unobtainable at the PTY layer.

- **Ordering follows the existing override convention**: the injection must
  come *after* the `for (key, value) in std::env::vars()` copy at
  `sessions.rs:855-857`, like `PATH` and the `COFLUX_*` variables, whose
  comments state exactly why. Writing it before the copy means the supervisor's
  own environment silently wins. Note the consequence this ordering has: when
  the daemon itself was launched from an SSH session, the supervisor's
  inherited `SSH_TTY` is copied in and then **replaced** by ours. That is the
  correct outcome — ours describes the session the program is actually
  attached to — but it is a deliberate overwrite, not an accident.

- **No setting, no opt-out**: the statement "this terminal may be watched from
  another machine" is unconditionally true in coflux, so there is nothing for a
  user to configure. Rejected: a toggle — it adds a configuration surface and
  documentation for a fact that does not vary. If a concrete program turns out
  to misbehave, that is a bug report with a specific case, and the remedy is
  chosen then.

## Direction

One change in the supervisor's PTY setup. No protocol, server, worker, or
client changes: the receiving half already shipped in plan 20260914.

Single milestone; nothing to fan out.

### Milestone 1: every coflux PTY carries a truthful `SSH_TTY`

A session's PTY environment contains `SSH_TTY` set to that PTY's own device
path, injected alongside the existing overrides so it wins over anything
inherited. Programs that branch on the SSH environment now take their remote
branch.

The device-path lookup is the only part with real risk (see Landmines); it
deserves a unit test that asserts the value names an existing character device
belonging to this session, not merely that the variable is non-empty. The test
module at `sessions.rs:2063` already spawns real PTYs and is the natural home.

Validation: `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-cli`
with `RUSTFLAGS="-D warnings"` -> exit 0.

## Landmines

- **`sessions.rs:1113` is a test-only PTY** ("测试专用" per its comment) and is
  not part of this change. Only the production path around `:836-903` matters.
- **`ptsname()` is not thread-safe on macOS** — it returns a pointer to a
  static buffer, and there is no `ptsname_r` there. Whatever lookup is used
  must be safe under the supervisor's concurrency (sessions are created from
  more than one place); copy the name out immediately, or use the
  `TIOCPTYGNAME` ioctl, which writes into a caller-supplied buffer.
- **`as_raw_fd()` returns `Option`** and the borrowed descriptor stays owned by
  the master. Do not close it, and do not keep it past the master's lifetime.
- **The environment copy is wholesale**: `for (key, value) in std::env::vars()`
  brings in everything the supervisor inherited, so a user who started the
  daemon from an SSH session already has `SSH_*` in their terminals today.
  After this change one of them is replaced and the other two remain — do not
  "tidy" that by removing the inherited ones; `env_remove` on variables the
  user's own session legitimately set is out of scope.
- **`COFLUX_*` names are a published contract** ("变量名是 agent 面向的契约（写
  进 SKILL.md），只能加不能改", `sessions.rs:871-872`). This change adds a
  non-`COFLUX_` variable and must not touch them.

## Scope

In scope:
- `crates/supervisor/src/sessions.rs`
- `crates/supervisor/Cargo.toml` — only if the device-path lookup needs a
  dependency that is not already present
- tests alongside the existing ones in `sessions.rs`

Out of scope:
- `crates/supervisor/src/shell_integration.rs` — the rc route is the rejected
  fallback; do not implement both.
- Anything under `apps/` — the receiving half is plan 20260914's.
- `SSH_CONNECTION` / `SSH_CLIENT` — rejected above.
- Removing or rewriting `SSH_*` variables the supervisor inherited.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Rust tests | `cargo test -p coflux-protocol -p coflux-supervisor -p coflux-worker -p coflux-cli` (with `RUSTFLAGS="-D warnings"`) | exit 0 |
| Real-machine walkthrough (acceptance) | `grok doctor` inside a coflux terminal | reports `native: remote (pbcopy)` |

## Done criteria

- [ ] The Rust test command passes with warnings denied.
- [ ] `SSH_TTY` in a coflux terminal names a device path that exists and
      belongs to that session — asserted by a test, not by eyeballing.
- [ ] `SSH_CONNECTION` and `SSH_CLIENT` are not injected.
- [ ] The injection sits after the `std::env::vars()` copy.
- [ ] `grok doctor` in a coflux terminal reports `native: remote (pbcopy)`.
- [ ] No out-of-scope files changed.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- The PTY's real device path cannot be obtained at the PTY layer — report it
  rather than substituting a placeholder; the rc fallback is then the decision
  to revisit.
- Making this work would require changing the `COFLUX_*` contract variables or
  removing inherited environment.
- A validation command fails twice after one reasonable fix.

## Maintenance notes

- This is the emitting half of cross-machine copy; the receiving half is plan
  20260914 (OSC 52 in the desktop terminal). Neither is useful alone, and a
  future change that removes one should account for the other.
- Declaring the session remote has effects beyond the clipboard: programs that
  branch on the SSH environment also stop auto-opening browsers and print URLs
  instead. In coflux that is the better behaviour — a browser would open on the
  PTY host, invisible to a user watching from elsewhere — and terminal URLs are
  ⌘-clickable (plan 109). If a specific program regresses, that is a concrete
  bug report, not a reason to withdraw the signal.
- The claim "one variable is enough" rests on two measurements from
  2026-09-16: grok flipping to `native: remote` with only `SSH_TTY` set, and
  Claude Code's `||` check across the three names. If a future CLI reads only
  `SSH_CONNECTION`, that is the moment to revisit — and it needs an answer for
  the fabricated address, which is why it was declined here.
