import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChangedFile } from "@coflux/client";

import { ancestorKeys, buildChangesTree, filterHighlights, filterTerms, flattenTree, matchesFilter, pickSelection, stepFile, treeFileOrder } from "./changes-tree";

function file(path: string): ChangedFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, size: 10 };
}

const files = [
  file("apps/desktop/src/renderer/components/changes-view.tsx"),
  file("apps/desktop/src/renderer/components/file-tree.tsx"),
  file("apps/desktop/src/old.ts"),
  file("README.md"),
  file("docs/中文 说明.md"),
];

test("single-child folder chains compact into one row, folders before files", () => {
  const rows = flattenTree(buildChangesTree(files), new Set());
  assert.deepEqual(
    rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.name}/` : row.kind === "file" ? row.name : `(${row.text})`}`),
    [
      "apps/desktop/src/",
      "  renderer/components/",
      "    changes-view.tsx",
      "    file-tree.tsx",
      "  old.ts",
      "docs/",
      "  中文 说明.md",
      "README.md",
    ],
  );
  const renderer = rows.find((row) => row.kind === "dir" && row.name === "renderer/components");
  assert.equal(renderer?.key, "apps/desktop/src/renderer/components");
});

test("collapsing a folder hides its rows but not its place in the file order", () => {
  const tree = buildChangesTree(files);
  const rows = flattenTree(tree, new Set(["apps/desktop/src/renderer/components"]));
  assert.equal(rows.some((row) => row.key.endsWith("changes-view.tsx")), false);
  assert.equal(treeFileOrder(tree)[0], "apps/desktop/src/renderer/components/changes-view.tsx");
  assert.deepEqual(ancestorKeys(tree, "apps/desktop/src/renderer/components/file-tree.tsx"), [
    "apps/desktop/src",
    "apps/desktop/src/renderer/components",
  ]);
});

test("selection survives a refresh, or moves to the neighbour that followed it", () => {
  const before = ["a", "b", "c", "d"];
  assert.equal(pickSelection(before, "b", ["a", "b", "d"]), "b");
  assert.equal(pickSelection(before, "b", ["a", "d"]), "d");
  assert.equal(pickSelection(before, "d", ["a", "b"]), "b");
  assert.equal(pickSelection(null, null, ["x", "y"]), "x");
  assert.equal(pickSelection(before, "b", []), null);
});

test("arrow keys step between visible files, skipping folder rows", () => {
  const rows = flattenTree(buildChangesTree(files), new Set());
  const first = "apps/desktop/src/renderer/components/changes-view.tsx";
  assert.equal(stepFile(rows, "apps/desktop/src", 1), first);
  assert.equal(stepFile(rows, first, -1), null);
  assert.equal(stepFile(rows, "apps/desktop/src/old.ts", 1), "docs/中文 说明.md");
  assert.equal(stepFile(rows, null, -1), "README.md");
});

test("the filter matches every term anywhere in the path, and a rename's old path", () => {
  const view = { path: "apps/desktop/src/renderer/changes-view.tsx", status: "modified", additions: 1, deletions: 1, binary: false, size: 1 } as const;
  const moved = { path: "docs/release-process.md", oldPath: "docs/RELEASING.md", status: "renamed", additions: 0, deletions: 0, binary: false, size: 1 } as const;
  assert.deepEqual(filterTerms("  Renderer   VIEW "), ["renderer", "view"]);
  assert.deepEqual(filterTerms("   "), []);
  assert.equal(matchesFilter(view, filterTerms("renderer/ view")), true);
  assert.equal(matchesFilter(view, filterTerms("renderer tree")), false, "every term has to match");
  assert.equal(matchesFilter(moved, filterTerms("releasing")), true);
});

test("highlights cover every occurrence of every term, merged", () => {
  assert.deepEqual(filterHighlights("changes-view.tsx", ["view", "s-v"]), [{ start: 6, end: 12 }]);
  assert.deepEqual(filterHighlights("a-a-a", ["a"]), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 5 },
  ]);
  assert.deepEqual(filterHighlights("README.md", ["zzz"]), []);
});
