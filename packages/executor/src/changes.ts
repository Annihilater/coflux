/**
 * What a write run changed in its workspace, measured rather than reported.
 *
 * The executor's file tools are not the only way it writes: its sandboxed bash creates, rewrites and
 * deletes files too, and nothing the runner sees says which ones. So the runner takes a baseline of
 * the workspace just before the prompt and compares the workspace against it once the run is over.
 *
 * Two ways to take that picture, chosen when the baseline is taken:
 *  - **git mode**, when the root is inside a git repository that does not ignore it: git's dirty set
 *    before and after. Cheap on a large tree, and it leaves out what the repository ignores (build
 *    output, node_modules). A path that was already dirty at baseline counts only if its lstat
 *    signature moved, so edits that predate the run are not blamed on it.
 *  - **walk mode** otherwise: a bounded walk of the tree, comparing size and mtime per file.
 *
 * This runs in the runner, outside the sandbox, possibly while the delegating agent is using git in
 * the same repository. Every git command therefore carries `GIT_OPTIONAL_LOCKS=0` (without it
 * `git status` may refresh and rewrite `.git/index`), and none of them writes the repository.
 *
 * Synchronous on purpose: the final scan sits between stopping the run's tool processes and
 * reporting its terminal state, and nothing else may run in between. Budgets keep it short. Git and
 * the file system are injected so the logic is testable without a repository.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";

/**
 * Runs one git command at `cwd`. Unlike workspace.ts's `GitRunner`, it takes a per-call timeout and
 * reports the exit status: `check-ignore` answers with its exit code, and 1 ("not ignored") must not
 * be mistaken for a failure. `status` is null when git never exited on its own (timeout, spawn
 * failure).
 */
export type ChangesGitRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => { stdout: string; ok: boolean; status: number | null };

/** A dirty set of a few hundred thousand paths is several megabytes; the default 1 MiB would turn it
 * into a failure. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const defaultChangesGit: ChangesGitRunner = (args, cwd, timeoutMs) => {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      // Built from this process's environment, never from the start message: the provider
      // credential must not reach a child.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      // git's complaints ("not a git repository") are expected answers here, not runner errors.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { stdout, ok: true, status: 0 };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return { stdout: "", ok: false, status: typeof status === "number" ? status : null };
  }
};

export type DirEntry = { name: string; kind: "dir" | "file" | "other" };

export type ChangesDeps = {
  runGit: ChangesGitRunner;
  /** A path's lstat signature (size and mtime to the nanosecond), or null when it is absent. Never
   * follows a symlink. */
  signature: (path: string) => string | null;
  /** A directory's entries without following symlinks; `file` covers regular files and symlinks.
   * null when the directory cannot be read. */
  listDir: (path: string) => DirEntry[] | null;
  now: () => number;
};

function lstatSignature(path: string): string | null {
  try {
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stats ? `${stats.size}:${stats.mtimeNs}` : null;
  } catch {
    return null;
  }
}

function listDirectory(path: string): DirEntry[] | null {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry): DirEntry => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : entry.isFile() || entry.isSymbolicLink() ? "file" : "other",
    }));
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: ChangesDeps = {
  runGit: defaultChangesGit,
  signature: lstatSignature,
  listDir: listDirectory,
  now: Date.now,
};

/** Past this many entries a walk stops and the list is incomplete. */
export const MAX_WALK_ENTRIES = 200_000;
/** The baseline's git commands, each. */
const BASELINE_GIT_TIMEOUT_MS = 10_000;
/** The baseline's own scanning: the walk, or the lstat pass over git's dirty set. */
const BASELINE_SCAN_MS = 20_000;
/** The final scan's budget in an ordinary ending. */
export const FINAL_SCAN_BUDGET_MS = 5_000;
/** The final scan's budget once an abort has arrived: the host force-kills a runner 8 seconds after
 * asking it to stop, and stopping the tool processes takes up to about 2.2 of them first. */
export const ABORTING_SCAN_BUDGET_MS = 4_000;

/** Run at the root, so the pathspec `.` keeps a subdirectory workspace to itself. Renames off: a
 * rename is two changed paths, and the extra source field would complicate parsing for nothing. */
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."] as const;

type GitBaseline = {
  mode: "git";
  root: string;
  /** The root's path below the repository's top level (`sub/`), or empty at the top level. */
  prefix: string;
  /** Every path dirty at baseline, root-relative, with its signature then (null = absent). */
  dirty: Map<string, string | null>;
};

type WalkBaseline = {
  mode: "walk";
  root: string;
  /** Why the walk was needed, for the reason given when it runs out of entries. */
  why: string;
  files: Map<string, string>;
};

type NoBaseline = { mode: "unavailable"; root: string; reason: string };

export type ChangeBaseline = (GitBaseline | WalkBaseline | NoBaseline) & { deps: ChangesDeps };

/** `files` is the sorted change set, root-relative; `incomplete` is null when it is the whole story,
 * otherwise a short English reason it may not be. */
export type ChangeSet = { files: string[]; incomplete: string | null };

/**
 * The workspace as it stands now. Never throws: anything that keeps a baseline from being taken
 * becomes a baseline whose result is incomplete, carrying the reason forward.
 */
export function takeChangeBaseline(root: string, overrides: Partial<ChangesDeps> = {}): ChangeBaseline {
  const deps: ChangesDeps = { ...DEFAULT_DEPS, ...overrides };
  const unavailable = (reason: string): ChangeBaseline => ({ mode: "unavailable", root, reason, deps });

  const prefix = deps.runGit(["rev-parse", "--show-prefix"], root, BASELINE_GIT_TIMEOUT_MS);
  if (!prefix.ok) return walkBaseline(root, deps, "is not a git repository");

  // A root its repository ignores is invisible to `git status`; only a walk sees what changes in it.
  const ignored = deps.runGit(["check-ignore", "-q", "."], root, BASELINE_GIT_TIMEOUT_MS);
  if (ignored.status === 0) return walkBaseline(root, deps, "is ignored by its git repository");
  if (ignored.status !== 1) return unavailable("git check-ignore failed before the run started");

  const status = deps.runGit(STATUS_ARGS, root, BASELINE_GIT_TIMEOUT_MS);
  if (!status.ok) return unavailable("git status failed before the run started");

  const deadline = deps.now() + BASELINE_SCAN_MS;
  const rootPrefix = prefix.stdout.replace(/\n$/, "");
  const dirty = new Map<string, string | null>();
  for (const path of dirtyPaths(status.stdout, rootPrefix)) {
    if (deps.now() > deadline) {
      return unavailable(`scanning the workspace before the run took longer than ${seconds(BASELINE_SCAN_MS)} seconds`);
    }
    dirty.set(path, deps.signature(absolute(root, path)));
  }
  return { mode: "git", root, prefix: rootPrefix, dirty, deps };
}

function walkBaseline(root: string, deps: ChangesDeps, why: string): ChangeBaseline {
  const walked = walk(root, deps, deps.now() + BASELINE_SCAN_MS);
  if (walked.stopped === "entries") return { mode: "unavailable", root, reason: tooManyEntries(why), deps };
  if (walked.stopped === "time") {
    const reason = `scanning the workspace before the run took longer than ${seconds(BASELINE_SCAN_MS)} seconds`;
    return { mode: "unavailable", root, reason, deps };
  }
  return { mode: "walk", root, why, files: walked.files, deps };
}

/**
 * What changed since `baseline`, within `budgetMs`: the final walk stops at it, and each final git
 * command times out at it. A scan cut short still lists what it had found, all of it real changes,
 * and says it is incomplete.
 */
export function changesSince(baseline: ChangeBaseline, budgetMs: number): ChangeSet {
  if (baseline.mode === "unavailable") return { files: [], incomplete: baseline.reason };
  const { deps, root } = baseline;
  const deadline = deps.now() + budgetMs;
  const late = `scanning the workspace after the run took longer than ${seconds(budgetMs)} seconds`;
  const changed = new Set<string>();

  if (baseline.mode === "git") {
    const status = deps.runGit(STATUS_ARGS, root, budgetMs);
    if (!status.ok) return { files: [], incomplete: "git status failed after the run" };
    for (const path of dirtyPaths(status.stdout, baseline.prefix)) {
      if (!baseline.dirty.has(path)) changed.add(path);
    }
    // A path dirty at baseline counts only if it moved since, whether it is still dirty or not: a
    // file reverted by the run is a change, one committed by someone else meanwhile is not.
    for (const [path, before] of baseline.dirty) {
      if (deps.now() > deadline) return { files: sorted(changed), incomplete: late };
      if (deps.signature(absolute(root, path)) !== before) changed.add(path);
    }
    return { files: sorted(changed), incomplete: null };
  }

  const walked = walk(root, deps, deadline);
  for (const [path, signature] of walked.files) {
    if (baseline.files.get(path) !== signature) changed.add(path);
  }
  // Deletions are only knowable from a complete walk: a stopped one never reached most paths.
  if (walked.stopped) {
    return { files: sorted(changed), incomplete: walked.stopped === "time" ? late : tooManyEntries(baseline.why) };
  }
  for (const path of baseline.files.keys()) {
    if (!walked.files.has(path)) changed.add(path);
  }
  return { files: sorted(changed), incomplete: null };
}

/**
 * Porcelain v1 `-z` entries (`XY path`, NUL-separated) to root-relative paths. Paths come relative
 * to the repository's top level even when git runs in a subdirectory, so the root's own prefix is
 * stripped. A directory entry keeps its trailing `/` (a nested repository shows as one untracked
 * directory), which tells the reader it is not a file.
 */
function dirtyPaths(stdout: string, prefix: string): string[] {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    // `--no-renames` should keep these out; a rename or copy would carry its source as the next field.
    if (code.includes("R") || code.includes("C")) index += 1;
    const path = entry.slice(3);
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (relative) paths.push(relative);
  }
  return paths;
}

type WalkResult = { files: Map<string, string>; stopped: "entries" | "time" | null };

/** Regular files and symlinks below `root`, by root-relative path, never following a symlink and
 * never entering a `.git` directory. Stops at the entry cap or the deadline, whichever comes first. */
function walk(root: string, deps: ChangesDeps, deadline: number): WalkResult {
  const files = new Map<string, string>();
  const pending = [""];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    // An unreadable directory is skipped at both ends alike, so it adds nothing either way.
    const listed = deps.listDir(directory ? `${root}/${directory}` : root);
    if (!listed) continue;
    for (const entry of listed) {
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) return { files, stopped: "entries" };
      if (deps.now() > deadline) return { files, stopped: "time" };
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        if (entry.name !== ".git") pending.push(path);
        continue;
      }
      if (entry.kind !== "file") continue;
      const signature = deps.signature(`${root}/${path}`);
      if (signature !== null) files.set(path, signature);
    }
  }
  return { files, stopped: null };
}

function tooManyEntries(why: string): string {
  return `the workspace ${why} and has more than ${MAX_WALK_ENTRIES.toLocaleString("en-US")} entries`;
}

function absolute(root: string, path: string): string {
  return `${root}/${path.replace(/\/$/, "")}`;
}

function sorted(paths: Set<string>): string[] {
  return [...paths].sort();
}

function seconds(ms: number): number {
  return ms / 1000;
}
