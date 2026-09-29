import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChangedFile } from "@coflux/client";

import { ancestorKeys, buildChangesTree, flattenTree, pickSelection, stepFile, treeFileOrder } from "./changes-tree";

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
    rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.name}/` : row.name}`),
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
  const renderer = rows.find((row) => row.name === "renderer/components");
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
