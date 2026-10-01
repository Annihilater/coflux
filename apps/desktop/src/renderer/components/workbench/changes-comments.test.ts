import assert from "node:assert/strict";
import { test } from "node:test";
import { AnnotationCodeSide, AnnotationSchema, AnnotationStatus, create, type AnnotationCodeAnchor } from "@coflux/protocol";
import type { ChangedFile } from "@coflux/client";

import {
  buildExcerpt,
  commentLocation,
  EXCERPT_MAX_CHARS,
  groupCommentsByFile,
  locateAnchor,
  pendingCommentCounts,
} from "./changes-comments";

function anchor(init: Partial<AnnotationCodeAnchor>): AnnotationCodeAnchor {
  return { $typeName: "coflux.v1.AnnotationCodeAnchor", path: "a.ts", side: AnnotationCodeSide.WORKING_TREE, startLine: 1, endLine: 1, excerpt: "", baseCommit: "", ...init };
}

function comment(id: string, number: number, code: Partial<AnnotationCodeAnchor>, status = AnnotationStatus.PENDING) {
  return create(AnnotationSchema, { annotationId: id, number, status, comment: "c", code: anchor(code) } as never);
}

function file(path: string, init: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", additions: 1, deletions: 1, binary: false, size: 10, ...init };
}

const LINES = ["import x;", "", "function total() {", "  return a + b;", "}", "", "function other() {", "  return a + b;", "}"];

test("a comment stays on its lines while they are where it was written", () => {
  assert.deepEqual(locateAnchor(LINES, anchor({ startLine: 3, endLine: 5, excerpt: "function total() {\n  return a + b;\n}" })), { start: 2, end: 4 });
});

test("a comment follows its lines when they move, and tolerates re-indentation", () => {
  const moved = ["// header", "// more", ...LINES];
  assert.deepEqual(locateAnchor(moved, anchor({ startLine: 3, endLine: 5, excerpt: "function total() {\n  return a + b;\n}" })), { start: 4, end: 6 });
  const reindented = LINES.map((line) => `    ${line}`);
  assert.deepEqual(locateAnchor(reindented, anchor({ startLine: 4, endLine: 4, excerpt: "  return a + b;" })), { start: 3, end: 3 });
});

test("of several occurrences the nearest to the stored range wins", () => {
  // `  return a + b;` is on lines 4 and 8; stored at 7 (moved by one), the one on line 8 is nearer.
  assert.deepEqual(locateAnchor(LINES, anchor({ startLine: 7, endLine: 7, excerpt: "  return a + b;" })), { start: 7, end: 7 });
  assert.deepEqual(locateAnchor(LINES, anchor({ startLine: 2, endLine: 2, excerpt: "  return a + b;" })), { start: 3, end: 3 });
});

test("deleted lines cannot be found", () => {
  assert.equal(locateAnchor(LINES, anchor({ startLine: 3, endLine: 3, excerpt: "function gone() {" })), null);
  assert.equal(locateAnchor([], anchor({ startLine: 1, endLine: 1, excerpt: "x" })), null);
  // Without an excerpt the stored range is kept only while it fits.
  assert.deepEqual(locateAnchor(LINES, anchor({ startLine: 2, endLine: 2 })), { start: 1, end: 1 });
  assert.equal(locateAnchor(LINES, anchor({ startLine: 20, endLine: 21 })), null);
});

test("a truncated excerpt still locates the full stored span", () => {
  // The excerpt kept only the first two of five lines; the span is still five.
  assert.deepEqual(locateAnchor(LINES, anchor({ startLine: 3, endLine: 7, excerpt: "function total() {\n  return a + b;" })), { start: 2, end: 6 });
});

test("excerpts are whole lines within the caps", () => {
  assert.equal(buildExcerpt(LINES, { start: 2, end: 4 }), "function total() {\n  return a + b;\n}");
  const long = ["a".repeat(EXCERPT_MAX_CHARS - 2), "bbbb", "c"];
  assert.equal(buildExcerpt(long, { start: 0, end: 2 }), long[0]);
  const huge = ["x".repeat(EXCERPT_MAX_CHARS + 50), "y"];
  assert.equal(buildExcerpt(huge, { start: 0, end: 1 }).length, EXCERPT_MAX_CHARS);
});

test("comments group by file and side; the rest are 「其他批注」", () => {
  const files = [file("src/a.ts"), file("src/new-name.ts", { status: "renamed", oldPath: "src/old-name.ts" })];
  const onA = comment("1", 1, { path: "src/a.ts" });
  const onRenameBase = comment("2", 2, { path: "src/old-name.ts", side: AnnotationCodeSide.BASE, baseCommit: "abc" });
  const onRenameWorking = comment("3", 3, { path: "src/new-name.ts" }, AnnotationStatus.RESOLVED);
  // The base side of a rename is under its old path: a working-tree comment there is elsewhere.
  const stale = comment("4", 4, { path: "src/old-name.ts" });
  const gone = comment("5", 5, { path: "src/reverted.ts" });
  const { byPath, others } = groupCommentsByFile([gone, stale, onRenameWorking, onRenameBase, onA], files);
  assert.deepEqual(byPath.get("src/a.ts")?.map((item) => item.annotationId), ["1"]);
  assert.deepEqual(byPath.get("src/new-name.ts")?.map((item) => item.annotationId), ["2", "3"]);
  assert.deepEqual(others.map((item) => item.annotationId), ["4", "5"]);
  // Badges count pending comments only.
  assert.deepEqual([...pendingCommentCounts(byPath)], [["src/a.ts", 1], ["src/new-name.ts", 1]]);
});

test("locations name the side", () => {
  assert.equal(commentLocation(comment("1", 1, { path: "src/a.ts", startLine: 3, endLine: 5 })), "src/a.ts:3-5");
  assert.equal(commentLocation(comment("2", 2, { path: "src/a.ts", side: AnnotationCodeSide.BASE, startLine: 4, endLine: 4 })), "src/a.ts:4（基准）");
});
