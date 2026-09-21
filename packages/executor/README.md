# @coflux/executor

The coflux executor: the **single** implementation of the bounded sub-task runner that a coding
agent delegates one well-scoped piece of work to.

It is a package rather than a part of Coflux.app so that any machine with a JS runtime can host it.
Two hosts start the very same code:

- `cofluxd` (installed from npm) starts `@coflux/executor/host` with its own `node`, and the Rust
  worker talks to it over inherited stdio carrying JSONL;
- Coflux.app imports this package in its Electron main process and forks `@coflux/executor/runner`
  per task through `utilityProcess` (a `utilityProcess` cannot fork another one, and the
  `runAsNode` fuse rules out `child_process.fork`, so the desktop's host logic runs in the main
  process while the task processes stay isolated).

On a machine where both could host, the **daemon wins** and Coflux.app must not register a host of
its own. That election is the daemon's decision, made when a host registers — never a race.

## Platform

The executor is **macOS-only** today. Every tool command is wrapped in `/usr/bin/sandbox-exec`, and
there is no Linux equivalent yet; the daemon therefore does not register a host on Linux. The
sandbox tier is "against mistakes, not adversaries" — see `src/sandbox.ts`.

## Layout

| file | what it owns |
| --- | --- |
| `jobs.ts` | the job table: concurrency, the per-workspace write lock, terminal states, reconciliation. Pure. |
| `manager.ts` | the side effects the job table asks for: spawning runners, killing process groups, writing sandbox profiles. |
| `runner.ts` | one task, one process: pi, the guard extension, the sandboxed bash backend. |
| `sandbox.ts` / `workspace.ts` | the Seatbelt profile text and the git facts it needs. Pure. |
| `guard.ts` | the path guard for pi's structured file tools. Pure. |
| `config.ts` / `settings-cache.ts` | the account-held configuration as the local daemon last wrote it. |
| `catalog.ts` / `runtime.ts` | the model catalogue and the long-lived `ModelRuntime` the settings page browses. |
| `host-core.ts` | hostId, epoch and the register/report framing both hosts share. |
| `host.ts` | the standalone stdio entry the daemon starts. |
