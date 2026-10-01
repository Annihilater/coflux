import assert from "node:assert/strict";
import { test } from "node:test";

import { stepChange, type ChangeNavKind } from "./changes-navigation";

const order = ["a.ts", "image.png", "renamed.ts", "big.json", "b.ts", "c.ts"];
const kinds: Record<string, ChangeNavKind> = {
  "a.ts": "content",
  "image.png": "skip",
  "renamed.ts": "skip",
  "big.json": "stop",
  "b.ts": "content",
  "c.ts": "content",
};
const kindOf = (path: string) => kinds[path] ?? "content";

test("F7 walks the changes of the file, then lands on the next file's first change", () => {
  assert.deepEqual(stepChange(order, "a.ts", null, 3, 1, kindOf), { kind: "change", index: 0 });
  assert.deepEqual(stepChange(order, "a.ts", 1, 3, 1, kindOf), { kind: "change", index: 2 });
  // Past the last change: binary and rename-only files are skipped; a large file stops the walk.
  assert.deepEqual(stepChange(order, "a.ts", 2, 3, 1, kindOf), { kind: "file", path: "big.json", land: null });
  // The large file has no change on screen: the next press moves past it.
  assert.deepEqual(stepChange(order, "big.json", null, null, 1, kindOf), { kind: "file", path: "b.ts", land: "first" });
});

test("⇧F7 is symmetric and lands on the previous file's last change", () => {
  assert.deepEqual(stepChange(order, "b.ts", 1, 2, -1, kindOf), { kind: "change", index: 0 });
  assert.deepEqual(stepChange(order, "b.ts", 0, 2, -1, kindOf), { kind: "file", path: "big.json", land: null });
  assert.deepEqual(stepChange(order, "big.json", null, null, -1, kindOf), { kind: "file", path: "a.ts", land: "last" });
  // With no current change yet, ⇧F7 leaves for the previous file.
  assert.deepEqual(stepChange(order, "c.ts", null, 4, -1, kindOf), { kind: "file", path: "b.ts", land: "last" });
});

test("a file whose content is loading or failed, or has no change, is moved past", () => {
  assert.deepEqual(stepChange(order, "b.ts", null, null, 1, kindOf), { kind: "file", path: "c.ts", land: "first" });
  assert.deepEqual(stepChange(order, "b.ts", null, 0, 1, kindOf), { kind: "file", path: "c.ts", land: "first" });
});

test("the ends of the tree stop the walk, and a stale index is clamped", () => {
  assert.deepEqual(stepChange(order, "c.ts", 1, 2, 1, kindOf), { kind: "none" });
  assert.deepEqual(stepChange(order, "a.ts", 0, 3, -1, kindOf), { kind: "none" });
  assert.deepEqual(stepChange(order, "c.ts", 9, 2, -1, kindOf), { kind: "change", index: 0 });
  assert.deepEqual(stepChange(order, null, null, null, 1, kindOf), { kind: "file", path: "a.ts", land: "first" });
});
