import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { changesSince, takeChangeBaseline, type ChangesDeps, type ChangesGitRunner } from "./changes.js";

const REPO = "/Users/alice/repo";

/** What the fake repository answers; mutated between the baseline and the final scan. */
type FakeRepo = {
  /** `rev-parse --show-prefix` output without the newline; null = not a git repository. */
  prefix: string | null;
  /** `rev-parse --absolute-git-dir` output; null = it fails. */
  gitDir: string | null;
  /** `rev-parse --show-toplevel` output; null = it fails. */
  toplevel: string | null;
  /** `check-ignore -q .` exit status. */
  ignoreStatus: number;
  /** Porcelain entries (`XY path`, top-level relative); null = `git status` fails. */
  dirty: string[] | null;
  /** Every call's full argument list, global options included. */
  calls: string[][];
};

function fakeRepo(init: Partial<FakeRepo> = {}): FakeRepo {
  return { prefix: "", gitDir: `${REPO}/.git`, toplevel: REPO, ignoreStatus: 1, dirty: [], calls: [], ...init };
}

/** The arguments after git's global options (`--git-dir=…`, `--work-tree=…`, `-c <setting>`). */
function subcommand(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    if (args[index] === "-c") index += 2;
    else if (args[index].startsWith("--git-dir=") || args[index].startsWith("--work-tree=")) index += 1;
    else break;
  }
  return args.slice(index);
}

function fakeGit(repo: FakeRepo): ChangesGitRunner {
  const line = (value: string | null) =>
    value === null ? { stdout: "", ok: false, status: 128 } : { stdout: `${value}\n`, ok: true, status: 0 };
  return (args) => {
    repo.calls.push([...args]);
    const command = subcommand(args);
    const key = command.join(" ");
    if (key === "rev-parse --show-prefix") return line(repo.prefix);
    if (key === "rev-parse --absolute-git-dir") return line(repo.gitDir);
    if (key === "rev-parse --show-toplevel") return line(repo.toplevel);
    if (key === "check-ignore -q .") {
      return { stdout: "", ok: repo.ignoreStatus === 0, status: repo.ignoreStatus };
    }
    if (command[0] === "status") {
      if (repo.dirty === null) return { stdout: "", ok: false, status: 128 };
      return { stdout: repo.dirty.map((entry) => `${entry}\0`).join(""), ok: true, status: 0 };
    }
    return { stdout: "", ok: false, status: 128 };
  };
}

/** Git mode against a fake repository and a signature table keyed by absolute path. */
function gitDeps(repo: FakeRepo, signatures: Map<string, string>): Partial<ChangesDeps> {
  return {
    runGit: fakeGit(repo),
    signature: (path) => signatures.get(path) ?? null,
    listDir: () => {
      throw new Error("git mode must not walk the tree");
    },
  };
}

test("git: a dirty file that changed again and a new file are both listed", () => {
  const repo = fakeRepo({ dirty: [" M a.txt"] });
  const signatures = new Map([[`${REPO}/a.txt`, "1"]]);
  const baseline = takeChangeBaseline(REPO, gitDeps(repo, signatures));
  assert.equal(baseline.mode, "git");

  repo.dirty = [" M a.txt", "?? new.txt"];
  signatures.set(`${REPO}/a.txt`, "2");
  signatures.set(`${REPO}/new.txt`, "9");
  assert.deepEqual(changesSince(baseline, 5_000), { files: ["a.txt", "new.txt"], incomplete: null });
});

test("git: a file dirty before the run and untouched by it is not listed", () => {
  const repo = fakeRepo({ dirty: [" M keep.txt"] });
  const signatures = new Map([[`${REPO}/keep.txt`, "1"]]);
  const baseline = takeChangeBaseline(REPO, gitDeps(repo, signatures));
  assert.deepEqual(changesSince(baseline, 5_000), { files: [], incomplete: null });
});

test("git: a dirty file the run reverted is listed", () => {
  const repo = fakeRepo({ dirty: [" M reverted.txt"] });
  const signatures = new Map([[`${REPO}/reverted.txt`, "1"]]);
  const baseline = takeChangeBaseline(REPO, gitDeps(repo, signatures));

  repo.dirty = [];
  signatures.set(`${REPO}/reverted.txt`, "2");
  assert.deepEqual(changesSince(baseline, 5_000), { files: ["reverted.txt"], incomplete: null });
});

test("git: a dirty file that left the dirty set unchanged on disk (committed meanwhile) is not listed", () => {
  const repo = fakeRepo({ dirty: ["M  committed.txt"] });
  const signatures = new Map([[`${REPO}/committed.txt`, "1"]]);
  const baseline = takeChangeBaseline(REPO, gitDeps(repo, signatures));

  repo.dirty = [];
  assert.deepEqual(changesSince(baseline, 5_000), { files: [], incomplete: null });
});

test("git: a root its repository ignores is walked instead", () => {
  const repo = fakeRepo({ ignoreStatus: 0 });
  const baseline = takeChangeBaseline(REPO, { runGit: fakeGit(repo), listDir: () => [] });
  assert.equal(baseline.mode, "walk");
  assert.ok(!repo.calls.some((call) => subcommand(call)[0] === "status"), "git status must not run for an ignored root");
});

test("git: the final status is pinned to the repository recorded before the run, fsmonitor off, submodules ignored", () => {
  const root = `${REPO}/.claude/worktrees/wt`;
  const gitDir = `${REPO}/.git/worktrees/wt`;
  const repo = fakeRepo({ gitDir, toplevel: root });
  const baseline = takeChangeBaseline(root, gitDeps(repo, new Map()));

  // What the run's rewritten `.git` file would now point git at; the final scan must not ask.
  repo.gitDir = "/planted/.git";
  repo.toplevel = "/planted";
  const before = repo.calls.length;
  changesSince(baseline, 5_000);

  const finalCalls = repo.calls.slice(before);
  assert.equal(finalCalls.length, 1);
  const [call] = finalCalls;
  assert.deepEqual(call.slice(0, 5), [`--git-dir=${gitDir}`, `--work-tree=${root}`, "-c", "core.fsmonitor=false", "status"]);
  assert.ok(call.includes("--ignore-submodules=all"));
});

test("git: a subdirectory workspace reports paths relative to itself, not to the repository", () => {
  const root = `${REPO}/sub`;
  const repo = fakeRepo({ prefix: "sub/" });
  const signatures = new Map<string, string>();
  const baseline = takeChangeBaseline(root, gitDeps(repo, signatures));

  repo.dirty = ["?? sub/x.ts"];
  signatures.set(`${root}/x.ts`, "1");
  assert.deepEqual(changesSince(baseline, 5_000), { files: ["x.ts"], incomplete: null });
});

test("git: a failing final git status lists nothing and says the list is incomplete", () => {
  const repo = fakeRepo({ dirty: [" M a.txt"] });
  const signatures = new Map([[`${REPO}/a.txt`, "1"]]);
  const baseline = takeChangeBaseline(REPO, gitDeps(repo, signatures));

  repo.dirty = null;
  const result = changesSince(baseline, 5_000);
  assert.deepEqual(result.files, []);
  assert.ok(result.incomplete);
});

test("walk: a created, a deleted and a rewritten file are listed; a change under .git is not", (t) => {
  const root = mkdtempSync(join(tmpdir(), "coflux-changes-"));
  t.after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "keep.txt"), "same");
  writeFileSync(join(root, "gone.txt"), "bye");
  writeFileSync(join(root, "rewrite.txt"), "a");

  const notARepository = fakeGit(fakeRepo({ prefix: null }));
  const baseline = takeChangeBaseline(root, { runGit: notARepository });
  assert.equal(baseline.mode, "walk");

  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "new.txt"), "hello");
  rmSync(join(root, "gone.txt"));
  writeFileSync(join(root, "rewrite.txt"), "abcdef");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/somewhere-else\n");

  assert.deepEqual(changesSince(baseline, 5_000), {
    files: ["gone.txt", "rewrite.txt", "sub/new.txt"],
    incomplete: null,
  });
});
