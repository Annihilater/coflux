# Hand a bounded sub-task to the executor

Read this before running `coflux executor run`: what the executor can and cannot do, how to write
its prompt, and what comes back.

```sh
coflux executor run --title="Fix clippy in worker" --prompt="Fix every clippy warning in crates/worker" --write
coflux executor run --title="Why does the relay test flake" --prompt="Find why the relay reconnect test flakes and report back"
```

The executor is a small agent built into coflux. Give it one self-contained job and it works in
**the workspace your cwd is in** while you keep your own context for the main thread. The command
blocks until the job ends, then prints the executor's final report and the files that changed in
the workspace during the run, whatever changed them, shell commands included. In a git workspace,
git-ignored files are left out unless the executor wrote them with its file tools, and files already
modified before the run appear only if the run changed them again. The list cannot tell who made a
change, so anything else writing to the workspace during the run (the user, another agent) shows up
too. When the workspace could not be scanned completely the output says so, and then you check the
workspace yourself.

**Always pass `--title`**: a few words naming the job. While the run is going, the user sees a
small card on this terminal (on every desktop of the account) with that title, the run's live
progress and a stop button; they can expand it to read everything the executor did. Without a
title the card shows the prompt's first line, which is rarely a good name. The card is read-only
and disappears when the run ends — the result comes back to you, not to the user.

Reach for it when a job is mechanical, bounded and verbose — chasing a failing test suite, a
repetitive refactor across many files, a search that would cost you many tool calls. Keep the work
yourself when it needs the conversation's context, the user's judgment, or decisions the prompt
cannot carry.

**One-shot: there is no session and no follow-up.** Each run starts clean and ends when it ends;
to change something, send a new run with a new prompt. So **write the prompt as a brief, not a
hint**: the executor gets that one string and nothing else — no conversation history, no way to ask
you what you meant. Say what done looks like and how to check it.

**Where it exists: macOS only.** Its boundaries are enforced by the macOS kernel sandbox, and there
is no equivalent on Linux yet, so a Linux machine has no executor and the command says so. On macOS
it is hosted either by the daemon the user installed from npm or by the desktop app, whichever that
machine has — you do not choose, and nothing about the command changes either way.

Its boundaries, enforced by that kernel sandbox — count on them, and tell it what it needs up front:

- **Only the originating workspace is writable.** Writes anywhere outside it are refused by the
  kernel. Reads are not restricted, so it can still see system files, toolchains and the rest of the
  machine — the sandbox stops it from changing things, not from looking. Without `--write` even that
  workspace is read-only, which is the right mode for investigations.
- **Git metadata is read-only, so it never commits.** It leaves changes in the working tree;
  reviewing and committing them is yours. `git status` and `git diff` work fine for it.
- **Its tool processes have no network.** `npm install`, `cargo fetch` and friends fail. Install
  what the job needs before handing it over.
- **One writing executor per workspace at a time.** A second `--write` in the same workspace is
  refused outright rather than queued, and nothing runs: wait for the running one to finish, then
  send yours again. Read-only runs may still go in parallel up to a small cap.
- **It cannot use `coflux secret`** (it is not a terminal process).

A run ends if the host it is on goes away — the user quits the desktop app, signs out, or stops the
machine's terminals — and you get a definite failure, never a hang. The user can also stop it from
the card, which comes back to you as `cancelled`. `--timeout <seconds>` caps how long you wait; the
default is 30 minutes and a timeout cancels the run before failing. The model comes from the user's
account-wide executor settings; if they have not configured one, the command says so in one line —
relay that to the user instead of retrying.

**Images and other files are not an input.** The prompt is a task description with a size cap, not a
file channel: point at paths inside the workspace instead of trying to hand anything over.
