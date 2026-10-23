# Workspaces and worktrees

Read this when your cwd leaves the workspace the terminal was opened in, before moving the task into
another worktree (`coflux workspace enter`, Claude's `EnterWorktree`), or when a local command
answers "not in this workspace or does not exist" or "predates the daemon upgrade".

## Contents

- Two workspaces to keep apart: owning and effective
- Explicitly enter a workspace (`coflux workspace enter`, the way for Codex)
- Claude: coflux follows you into a git worktree (`EnterWorktree` / `ExitWorktree`)

## Two workspaces to keep apart: owning and effective

- **Owning workspace** = the workspace this terminal **belongs to**: what the user's sidebar shows it
  under, what its turn state, branch and diff stats are attributed to. It starts out as
  `COFLUX_WORKSPACE_ID` and moves with you when you enter or leave a git worktree (below).
- **Effective workspace** = the workspace **your current working directory is inside**. This is what
  every local command acts on.

They are the same until your cwd wanders off. A coflux child workspace is a normal registered Git
worktree. Running a command with cwd B (or `cd <path>` inside that command) changes that command's
effective workspace, but does not move the terminal or change later tools' default cwd. In B:

- `coflux terminal new` opens the terminal **in B**, under B in the user's sidebar, running in B's
  directory, counting against B's terminal cap;
- `coflux terminal list` lists B's terminals, and A's terminals answer `read` / `wait` / `send`
  with "not in this workspace or does not exist" (`cd` back to A to reach them again);
- Account CLI calls need **B's** id as `workspaceId`;
- the terminal itself stays under A, and `progress`, `notify` and `ports` still belong to it,
  whatever your cwd is; `COFLUX_TASK_ID` and `COFLUX_SESSION_ID` never change.

If your cwd is outside every coflux workspace (say `/tmp`), local commands fall back to the owning
workspace.

A terminal opened before the daemon was upgraded is the one case with no owning workspace at all:
its local commands are refused with "predates the daemon upgrade" whatever your cwd is, because the
daemon never guesses ownership from a directory. Open a new terminal.

`coflux workspace` (see the skill's "Ask where you are") always tells you both ids and whether they
differ (`moved`). With the plugin installed you also get a `<coflux-session-moved>` block at the
start of every prompt while the two differ — but that block only arrives with the **next** user
prompt, so ask `coflux workspace` yourself right after a `cd`.

## Explicitly enter a workspace

Use this workflow when the task should move into another worktree, particularly in Codex, which
does not provide Claude's `EnterWorktree` tool:

1. Select an existing worktree from `coflux workspace list --device <deviceId>`, or create one with
   `coflux workspace new --project <projectId> --branch <branch>`. Use the returned workspace path.
2. Run `coflux workspace enter <path>`. This uses the existing workspace-locate operation: the
   daemon verifies the same Git repository, registers an unknown worktree, and moves the current
   terminal's owning workspace. The terminal, PTY and conversation continue without restarting.
3. Use the returned absolute `path` explicitly as `workdir`/`cwd` for subsequent task commands,
   including local `coflux` commands. Use absolute file paths for tools with no working-directory
   argument. Read the target directory's applicable `AGENTS.md` before editing. Run `coflux workspace`
   **in that directory** and use its workspace ID for account operations.

`hostCwdChanged: false` is intentional: neither this command nor a one-off shell `cd` can change
Codex's default directory or sandbox permissions. A successful terminal move is not proof that
later tools operate there. Keep the selected path in task context and verify it before editing.
Use the same enter command with the original path to return; returning does not delete a worktree.
Temporary reads, checks or commands elsewhere do not change the explicit selection.

For a device-managed Codex session, `resumeSupported: true` means the selection is saved by native
conversation ID. Hooks inject the selected path after the switch and restore it after compaction
or resume, including resume in another Coflux terminal of the same project and device. A new
conversation does not inherit the selection. If the saved path is missing or cannot be verified,
the hook reports it; do not silently resume edits in the original directory. Select a valid
workspace explicitly, or retry after connectivity returns. Plain terminals and Claude receive
`resumeSupported: false`; Claude's native directory tools provide its session directory behavior.

The enter command requires the current native CLI. The npm CLI delegates it to the pinned native
integration, or the installed device CLI outside a managed agent. If unavailable, update the
device; do not claim that a shell `cd` supplied the missing persistence behavior.

## Claude: coflux follows you into a git worktree

`EnterWorktree` switches this live session into a git worktree (its own, or an existing one you point
it at), `ExitWorktree` switches back, and resuming a session that had entered one puts you straight
back in it. **coflux comes along**: the terminal's *owning* workspace moves to the workspace that
worktree is, and if coflux has never seen that worktree it registers it as a child workspace of this
project first — a new card appears in the user's sidebar, with its branch and diff stats. Nothing is
interrupted: same terminal, same PTY, same conversation, and the user keeps watching it where it now
lives. When Claude Code cleans up its own worktree on exit, that workspace's terminals move back to
the project's main workspace and the record disappears by itself.

So, after entering or leaving a worktree, owning **and** effective are both the new workspace: pass
its id to account CLI commands and everything local already acts on it. The plugin drops the new id
next to the tool result, and `coflux workspace` always tells you. Two things stay behind on purpose:

- `COFLUX_WORKSPACE_ID` (and the workspace id and handle in the `<coflux-session>` block from
  earlier in this session) still names where the terminal was *opened*; it is frozen when the PTY
  starts and cannot be rewritten. Never reuse either form after a move.
- The shell inside this terminal keeps its own directory. That is only about the shell; it does not
  affect where your work is attributed.

Nothing happens when coflux cannot follow, and nothing is blocked either: another repository, a
directory that is not a git repository, a terminal opened in a directory workspace (no project), or
a daemon that is down or too old — the session just carries on with the ownership it had.
