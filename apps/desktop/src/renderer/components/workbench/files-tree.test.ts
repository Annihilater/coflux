import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChangedFile, FileIndexEntry } from "@coflux/client";

import { flattenTree, type TreeDir, type TreeNode, type TreeRow } from "./changes-tree";
import { buildFilesTree, filterFilesTree, folderPrefixes, selfAndAncestors, treeHasFile, type FolderListing, type FilesTreeInput } from "./files-tree";

function file(path: string, ignored = false): FileIndexEntry {
  return { path, kind: "file", ignored };
}

function dir(path: string, ignored = false): FileIndexEntry {
  return { path, kind: "directory", ignored };
}

function change(path: string, status: ChangedFile["status"], oldPath?: string): ChangedFile {
  return { path, oldPath, status, additions: 1, deletions: 0, binary: false, size: 10 };
}

function build(partial: Partial<FilesTreeInput>) {
  return buildFilesTree({ index: [], listings: new Map(), changes: [], extra: [], dimIgnored: true, ...partial });
}

/** Every row, every folder open. */
function allRows(nodes: readonly TreeNode[]): TreeRow[] {
  const keys = new Set<string>();
  const walk = (level: readonly TreeNode[]) => {
    for (const node of level) {
      if (node.kind === "dir") {
        keys.add(node.key);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return flattenTree(nodes, { expanded: keys });
}

function outline(nodes: readonly TreeNode[]): string[] {
  return allRows(nodes).map((row) => {
    const indent = "  ".repeat(row.depth);
    if (row.kind === "dir") return `${indent}${row.name}/${row.lazy ? " lazy" : ""}${row.ignored ? " ignored" : ""}${row.dot ? ` •${row.dot}` : ""}`;
    if (row.kind === "note") return `${indent}(${row.text})`;
    return `${indent}${row.name}${row.file ? ` [${row.file.status}]` : ""}${row.ignored ? " ignored" : ""}`;
  });
}

function findDir(nodes: readonly TreeNode[], key: string): TreeDir | undefined {
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    if (node.key === key) return node;
    const found = findDir(node.children, key);
    if (found) return found;
  }
  return undefined;
}

test("the change list is overlaid on the index by path, one row per path", () => {
  const tree = build({
    index: [file("README.md"), file("src/a.ts"), file("src/b.ts"), file("src/gone.ts"), file("src/old-name.ts")],
    changes: [
      change("src/a.ts", "modified"),
      // Deleted but unstaged: still in the index, so it becomes the struck-through row.
      change("src/gone.ts", "deleted"),
      // Deleted and staged: not in the index any more, inserted at its old location.
      change("src/staged-gone.ts", "deleted"),
      // New since the index was fetched.
      change("src/new/fresh.ts", "untracked"),
      // A rename's old path is not a separate entry.
      change("src/new-name.ts", "renamed", "src/old-name.ts"),
    ],
  });
  assert.deepEqual(outline(tree.nodes), [
    "src/ •modified",
    "  new/ •added",
    "    fresh.ts [untracked]",
    "  a.ts [modified]",
    "  b.ts",
    "  gone.ts [deleted]",
    "  new-name.ts [renamed]",
    "  staged-gone.ts [deleted]",
    "README.md",
  ]);
  assert.equal(tree.empty, false);
});

test("a folder's dot keeps one kind of change's tone and reads as modified for a mix", () => {
  const tree = build({
    index: [file("added/x.ts"), file("deleted/y.ts"), file("mixed/p.ts"), file("mixed/q.ts"), file("clean/z.ts")],
    changes: [change("added/x.ts", "added"), change("deleted/y.ts", "deleted"), change("mixed/p.ts", "untracked"), change("mixed/q.ts", "deleted")],
  });
  assert.equal(findDir(tree.nodes, "added")?.dot, "added");
  assert.equal(findDir(tree.nodes, "deleted")?.dot, "deleted");
  assert.equal(findDir(tree.nodes, "mixed")?.dot, "modified");
  assert.equal(findDir(tree.nodes, "clean")?.dot, null);
});

test("ignored folders are lazy and dimmed, and everything listed under them is dimmed too", () => {
  const index = [file("src/a.ts"), dir("node_modules", true), file("debug.log", true), dir("vendor/nested")];
  const pending = build({ index });
  assert.deepEqual(outline(pending.nodes), [
    "node_modules/ lazy ignored",
    "  (加载中…)",
    "src/",
    "  a.ts",
    "vendor/nested/ lazy",
    "  (加载中…)",
    "debug.log ignored",
  ]);

  const listings = new Map<string, FolderListing>([
    ["node_modules", { entries: [{ name: "left-pad", dir: true }, { name: ".package-lock.json", dir: false }] }],
    ["node_modules/left-pad", { error: "权限不足" }],
    ["vendor/nested", { entries: [{ name: "lib.rs", dir: false }, { name: "link", dir: false }] }],
  ]);
  const loaded = build({ index, listings });
  assert.deepEqual(outline(loaded.nodes), [
    "node_modules/ lazy ignored",
    "  left-pad/ lazy ignored",
    "    (权限不足)",
    "  .package-lock.json ignored",
    "src/",
    "  a.ts",
    // A nested repository is not this repository's to judge: nothing under it is dimmed.
    "vendor/nested/ lazy",
    "  lib.rs",
    "  link",
    "debug.log ignored",
  ]);
  // Ignored files are not searchable; files listed under a nested repository are.
  assert.deepEqual(loaded.searchable.map((entry) => entry.path).sort(), ["src/a.ts", "vendor/nested/lib.rs", "vendor/nested/link"]);
});

test("an empty listed folder says so, and compaction never runs through a lazy folder", () => {
  const tree = build({
    index: [dir("a/b"), file("x/y/z.ts")],
    listings: new Map<string, FolderListing>([["a/b", { entries: [{ name: "c", dir: true }] }], ["a/b/c", { entries: [] }]]),
  });
  assert.deepEqual(outline(tree.nodes), ["a/b/ lazy", "  c/ lazy", "    (空文件夹)", "x/y/", "  z.ts"]);
});

test("a directory workspace dims nothing", () => {
  const tree = build({ index: [dir("build", true), file("notes.log", true)], dimIgnored: false });
  assert.deepEqual(outline(tree.nodes), ["build/ lazy", "  (加载中…)", "notes.log"]);
});

test("a truncated index lists the root on demand, dims nothing and still decorates changes", () => {
  const loading = build({ index: null });
  assert.deepEqual(outline(loading.nodes), ["(加载中…)"]);
  assert.equal(loading.empty, false);

  const tree = build({
    index: null,
    listings: new Map<string, FolderListing>([["", { entries: [{ name: "src", dir: true }, { name: "README.md", dir: false }] }]]),
    changes: [change("src/a.ts", "modified")],
  });
  assert.deepEqual(outline(tree.nodes), ["src/ lazy •modified", "  (加载中…)", "  a.ts [modified]", "README.md"]);

  const empty = build({ index: null, listings: new Map<string, FolderListing>([["", { entries: [] }]]) });
  assert.equal(empty.empty, true);
  assert.equal(build({ index: [] }).empty, true);
});

test("a revealed file the index does not know is inserted, also inside a lazy folder", () => {
  const tree = build({ index: [dir("node_modules", true)], extra: ["node_modules/x/y.js"] });
  assert.ok(treeHasFile(tree.nodes, "node_modules/x/y.js"));
  assert.equal(findDir(tree.nodes, "node_modules/x")?.lazy, true, "a folder created under a lazy folder is lazy too");
});

test("the filter covers every non-ignored file, renames by their old path, and is capped", () => {
  const tree = build({
    index: [file("src/view.tsx"), file("src/tree.ts"), file("docs/view.md"), file("out/view.js", true)],
    changes: [change("docs/release.md", "renamed", "docs/RELEASING.md")],
  });
  const view = filterFilesTree(tree.searchable, ["view"], 100);
  assert.deepEqual(outline(view.nodes), ["docs/", "  view.md", "src/", "  view.tsx"]);
  assert.equal(view.matched, 2);
  const renamed = filterFilesTree(tree.searchable, ["releasing"], 100);
  assert.deepEqual(outline(renamed.nodes), ["docs/ •modified", "  release.md [renamed]"]);
  const capped = filterFilesTree(tree.searchable, ["s"], 1);
  assert.equal(capped.shown, 1);
  assert.ok(capped.matched > 1);
});

test("folder paths for revealing a file and for opening a compacted row", () => {
  assert.deepEqual(folderPrefixes("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(folderPrefixes("top.ts"), []);
  assert.deepEqual(selfAndAncestors("apps/desktop/src"), ["apps", "apps/desktop", "apps/desktop/src"]);
});

test("the whole-workspace tree starts folded: only open folders show their rows", () => {
  const tree = build({ index: [file("a/x.ts"), file("b/y.ts")] });
  assert.deepEqual(
    flattenTree(tree.nodes, { expanded: new Set(["b"]) }).map((row) => row.key),
    ["a", "b", "b/y.ts"],
  );
});
