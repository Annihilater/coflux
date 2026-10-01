import assert from "node:assert/strict";
import { test } from "node:test";

import { overlayEmphasis, wordEmphasis, type WordRange } from "./changes-word-diff";

const slices = (line: string, ranges: WordRange[]) => ranges.map((range) => line.slice(range.start, range.end));

test("a one-argument edit inside a long line emphasises only that argument", () => {
  const before = "  const result = await client.readWorkspaceChangeFile(workspaceId, list.base, file.path, file.oldPath);";
  const after = "  const result = await client.readWorkspaceChangeFile(workspaceId, list.base, file.path, undefined);";
  const emphasis = wordEmphasis(before, after, "show");
  assert.ok(emphasis);
  assert.deepEqual(slices(before, emphasis.old), ["file.oldPath"]);
  assert.deepEqual(slices(after, emphasis.new), ["undefined"]);
});

test("a rewritten line gets no word emphasis", () => {
  assert.equal(wordEmphasis("return items.map((item) => item.id);", "throw new Error(message);", "show"), null);
});

test("ignoring whitespace never emphasises a re-indent, only the real edit", () => {
  const before = "foo(a, b);";
  const after = "    foo(a, c);";
  const ignored = wordEmphasis(before, after, "ignoreAll");
  assert.ok(ignored);
  assert.deepEqual(slices(before, ignored.old), ["b"]);
  assert.deepEqual(slices(after, ignored.new), ["c"]);

  // Showing whitespace, the new indentation is part of the change.
  const plain = wordEmphasis(before, after, "show");
  assert.ok(plain);
  assert.deepEqual(slices(after, plain.new), ["    ", "c"]);
});

test("each whitespace mode stops emphasising exactly the whitespace git's flag ignores", () => {
  const before = "if (a)  {";
  const after = "if (a) {   ";
  const ranges = (mode: Parameters<typeof wordEmphasis>[2]) => {
    const emphasis = wordEmphasis(before, after, mode);
    assert.ok(emphasis, mode);
    return { old: slices(before, emphasis.old), new: slices(after, emphasis.new) };
  };
  // The run before "{" changed width and trailing whitespace was added.
  assert.deepEqual(ranges("show"), { old: ["  "], new: [" ", "   "] });
  assert.deepEqual(ranges("ignoreAtEol"), { old: ["  "], new: [" "] });
  assert.deepEqual(ranges("ignoreChange"), { old: [], new: [] });

  // Whitespace inserted where there was none is ignored only by `ignoreAll`.
  const inserted = wordEmphasis("foo(a,b);", "foo(a, b);", "ignoreChange");
  assert.ok(inserted);
  assert.deepEqual(slices("foo(a, b);", inserted.new), [" "]);
  assert.deepEqual(wordEmphasis("foo(a,b);", "foo(a, b);", "ignoreAll")?.new, []);
});

test("pure insertions and deletions emphasise only the added or removed words", () => {
  const emphasis = wordEmphasis("call(a)", "call(a, b)", "show");
  assert.ok(emphasis);
  assert.deepEqual(emphasis.old, []);
  assert.deepEqual(slices("call(a, b)", emphasis.new), [", b"]);
});

test("emphasis splits highlighted tokens at range boundaries and keeps their colours", () => {
  const tokens = [
    { content: "foo", color: "#1" },
    { content: "(a, ", color: "#2" },
    { content: "bar", color: "#3" },
    { content: ")" },
  ];
  // "foo(a, bar)": emphasise "a" (4..5) and "ba" (7..9).
  const pieces = overlayEmphasis(tokens, [
    { start: 4, end: 5 },
    { start: 7, end: 9 },
  ]);
  assert.equal(pieces.map((piece) => piece.content).join(""), "foo(a, bar)");
  assert.deepEqual(
    pieces.filter((piece) => piece.emphasis).map((piece) => [piece.content, piece.color]),
    [
      ["a", "#2"],
      ["ba", "#3"],
    ],
  );
});
