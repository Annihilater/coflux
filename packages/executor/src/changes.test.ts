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
  /** `check-ignore -q .` exit status. */
  ignoreStatus: number;
  /** Porcelain entries (`XY path`, top-level relative); null = `git status` fails. */
  dirty: string[] | null;
  calls: string[];
};

function fakeRepo(init: Partial<FakeRepo> = {}): FakeRepo {
  return { prefix: "", ignoreStatus: 1, dirty: [], calls: [], ...init };
}

function fakeGit(repo: FakeRepo): ChangesGitRunner {
  return (args) => {
    const key = args.join(" ");
    repo.calls.push(key);
    if (key === "rev-parse --show-prefix") {
      return repo.prefix === null ? { stdout: "", ok: false, status: 128 } : { stdout: `${repo.prefix}\n`, ok: true, status: 0 };
    }
    if (key === "check-ignore -q .") {
      return { stdout: "", ok: repo.ignoreStatus === 0, status: repo.ignoreStatus };
    }
    if (args[0] === "status") {
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
  assert.ok(!repo.calls.some((call) => call.startsWith("status")), "git status must not run for an ignored root");
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
