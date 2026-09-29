import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDiffRows, buildSegments, gapId, parseHunkRanges, splitLines } from "./parse-diff";

test("-U0 headers: omitted counts are 1 and empty ranges name the line before them", () => {
  const patch = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -2 +2 @@",
    "-b",
    "+B",
    "@@ -5,0 +6,2 @@ fn context",
    "+x",
    "+y",
    "@@ -9,2 +10,0 @@",
    "-i",
    "-j",
  ].join("\n");
  const hunks = parseHunkRanges(patch);
  assert.deepEqual(hunks, [
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
    { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 },
    { oldStart: 9, oldCount: 2, newStart: 10, newCount: 0 },
  ]);
  // old: 12 lines; new: 12 - 1 + 1 + 2 - 2 = 12 lines.
  assert.deepEqual(buildSegments(12, 12, hunks), [
    { kind: "equal", oldStart: 0, newStart: 0, length: 1 },
    { kind: "change", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    { kind: "equal", oldStart: 2, newStart: 2, length: 3 },
    { kind: "change", oldStart: 5, oldCount: 0, newStart: 5, newCount: 2 },
    { kind: "equal", oldStart: 5, newStart: 7, length: 3 },
    { kind: "change", oldStart: 8, oldCount: 2, newStart: 10, newCount: 0 },
    { kind: "equal", oldStart: 10, newStart: 10, length: 2 },
  ]);
});

test("a missing side is one change covering the other side whole", () => {
  assert.deepEqual(buildSegments(0, 3, []), [{ kind: "change", oldStart: 0, oldCount: 0, newStart: 0, newCount: 3 }]);
  assert.deepEqual(buildSegments(2, 0, []), [{ kind: "change", oldStart: 0, oldCount: 2, newStart: 0, newCount: 0 }]);
  assert.deepEqual(buildSegments(4, 4, []), [{ kind: "equal", oldStart: 0, newStart: 0, length: 4 }]);
});

test("lines follow git's count: no phantom line after a trailing newline, CR dropped", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\n\r\nb\r\n"), ["a", "", "b"]);
});

test("long equal stretches fold between changes and at the file edges, and expand by id", () => {
  // 20 equal, 1 changed, 20 equal.
  const segments = buildSegments(41, 41, [{ oldStart: 21, oldCount: 1, newStart: 21, newCount: 1 }]);
  const rows = buildDiffRows(segments, "inline", new Set());
  const kinds = rows.map((row) => (row.kind === "gap" ? `gap${row.hidden}` : row.kind === "inline" ? row.type : "split"));
  assert.deepEqual(kinds, ["gap17", "context", "context", "context", "del", "add", "context", "context", "context", "gap17"]);

  const leading = segments[0]!;
  const expanded = buildDiffRows(segments, "inline", new Set([gapId(leading)]));
  assert.equal(expanded.filter((row) => row.kind === "gap").length, 1);
  assert.equal(expanded.length, 20 + 2 + 3 + 1);
});

test("side-by-side pairs deletions with additions and leaves the shorter side empty", () => {
  const segments = buildSegments(3, 4, [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }]);
  const rows = buildDiffRows(segments, "split", new Set());
  assert.deepEqual(rows, [
    { kind: "split", left: { line: 0, changed: false }, right: { line: 0, changed: false } },
    { kind: "split", left: { line: 1, changed: true }, right: { line: 1, changed: true } },
    { kind: "split", left: null, right: { line: 2, changed: true } },
    { kind: "split", left: { line: 2, changed: false }, right: { line: 3, changed: false } },
  ]);
});

test("short stretches between changes are never folded", () => {
  // Changes at lines 1 and 8 leave six equal lines between them: 3 + 3 context, nothing hidden.
  const segments = buildSegments(10, 10, [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    { oldStart: 8, oldCount: 1, newStart: 8, newCount: 1 },
  ]);
  const rows = buildDiffRows(segments, "inline", new Set());
  assert.equal(rows.filter((row) => row.kind === "gap").length, 0);
});
