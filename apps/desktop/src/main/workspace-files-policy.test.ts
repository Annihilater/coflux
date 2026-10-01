import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openRefusal, resolveWorkspaceFile } from "./workspace-files-policy";

/* Plan 20261001-changes-review-polish: the renderer names (workspace root, relative path); main must
 * never let that pair reach a path outside the root or anything but an existing regular file. */

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "coflux-workspace-files-"));
  const root = join(base, "root");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a");
  writeFileSync(join(base, "outside.txt"), "secret");
  symlinkSync(join(base, "outside.txt"), join(root, "escape.txt"));
  symlinkSync(join(root, "src", "a.ts"), join(root, "inside-link.ts"));
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(root, "run.sh"), 0o755);
  writeFileSync(join(root, "launch.command"), "echo hi\n");
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a regular file inside the root resolves to its real path", () => {
  const { root, cleanup } = fixture();
  try {
    const file = resolveWorkspaceFile(root, "src/a.ts");
    assert.ok(file.ok);
    assert.ok(file.path.endsWith(join("root", "src", "a.ts")));
    assert.equal(file.executable, false);
    assert.equal(openRefusal(file), null);
    // A symlink that stays inside the root is followed.
    assert.ok(resolveWorkspaceFile(root, "inside-link.ts").ok);
  } finally {
    cleanup();
  }
});

test("absolute, parent-escaping, symlinked-out, missing and non-file paths are refused", () => {
  const { base, root, cleanup } = fixture();
  try {
    for (const rel of ["/etc/passwd", "../outside.txt", "src/../../outside.txt", "escape.txt", "missing.ts", "src", "", "a\0b"]) {
      assert.equal(resolveWorkspaceFile(root, rel).ok, false, `${JSON.stringify(rel)} must be refused`);
    }
    assert.equal(resolveWorkspaceFile("relative/root", "src/a.ts").ok, false, "the root must be absolute");
    assert.equal(resolveWorkspaceFile(join(base, "outside.txt"), "x").ok, false, "the root must be a directory");
    assert.equal(resolveWorkspaceFile(42, "src/a.ts").ok, false);
  } finally {
    cleanup();
  }
});

test("opening refuses executables and launcher types, revealing them is still resolvable", () => {
  const { root, cleanup } = fixture();
  try {
    const script = resolveWorkspaceFile(root, "run.sh");
    assert.ok(script.ok);
    assert.equal(script.executable, true);
    assert.notEqual(openRefusal(script), null);
    const launcher = resolveWorkspaceFile(root, "launch.command");
    assert.ok(launcher.ok);
    assert.notEqual(openRefusal(launcher), null);
  } finally {
    cleanup();
  }
});
