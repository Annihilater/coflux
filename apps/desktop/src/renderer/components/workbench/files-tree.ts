import type { ChangedFile, ChangedFileStatus, FileIndexEntry } from "@coflux/client";

import { compareNames, matchesFilter, type TreeDir, type TreeNode } from "@/components/workbench/changes-tree";

/**
 * The whole-workspace tree of the files view (plan 20261002-workspace-files-view), built from three
 * sources:
 *
 * - the device's file index, a snapshot taken when the view opens (null when the device said it was
 *   truncated: the root is then listed on demand like any lazy folder);
 * - the folders listed on demand: directories the index does not descend into (ignored folders,
 *   nested repositories, submodules), and every folder in truncated mode;
 * - the change list, refreshed on its own rhythm, overlaid by path — one row per path: a changed path
 *   the tree already has takes the change, one it lacks is inserted, a rename's old path is dropped.
 *
 * Everything under an ignored folder is ignored, with no further check; folders are never compacted
 * through a lazy folder, so a folder's row keeps its key when its listing arrives.
 */

/** One entry of a folder listed on demand. A symlink is a leaf (`dir` false), never expanded. */
export type ListedEntry = { name: string; dir: boolean };

/** A lazy folder's listing: its entries (possibly from a previous load while a new one runs), its error, or still loading. */
export type FolderListing = { entries: readonly ListedEntry[] } | { error: string } | { loading: true };

export type FilesTreeInput = {
  /** The complete index, or null when it was truncated. */
  index: readonly FileIndexEntry[] | null;
  /** Lazy folders by path ("" is the root in truncated mode); absent means not listed yet. */
  listings: ReadonlyMap<string, FolderListing>;
  changes: readonly ChangedFile[];
  /** Files to show even when no source has them yet (a file revealed from a terminal). */
  extra: readonly string[];
  /** Dim ignored entries: git workspaces only, and only when the index is complete. */
  dimIgnored: boolean;
};

/** A file the filter can match: every file of the tree that is not ignored. */
export type SearchableFile = { path: string; change?: ChangedFile };

export type FilesTree = {
  nodes: TreeNode[];
  /** Every non-ignored file in the tree, in no particular order. */
  searchable: SearchableFile[];
  /** No entry at all: the workspace is empty (or its root listing has not arrived). */
  empty: boolean;
};

type MFile = { ignored: boolean; change?: ChangedFile };
type MDir = { dirs: Map<string, MDir>; files: Map<string, MFile>; lazy: boolean; ignored: boolean };

function newDir(lazy: boolean, ignored: boolean): MDir {
  return { dirs: new Map(), files: new Map(), lazy, ignored };
}

function splitPath(path: string): { parents: string[]; name: string } {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  return { parents: parts, name };
}

/** The folder at `segments`, creating missing ones: under a lazy folder a new one is lazy too (its
 * full contents are unknown), elsewhere it is plain. A file in the way is replaced. */
function ensureDir(root: MDir, segments: readonly string[], ignored: boolean): MDir {
  let dir = root;
  for (const segment of segments) {
    let child = dir.dirs.get(segment);
    if (!child) {
      dir.files.delete(segment);
      child = newDir(dir.lazy, ignored);
      dir.dirs.set(segment, child);
    }
    dir = child;
  }
  return dir;
}

function findDir(root: MDir, path: string): MDir | null {
  let dir: MDir | undefined = root;
  for (const segment of path.split("/").filter(Boolean)) {
    dir = dir.dirs.get(segment);
    if (!dir) return null;
  }
  return dir;
}

/** The dot's status for a set of changes: one kind keeps its tone, a mix reads as modified. */
function dotOf(statuses: ReadonlySet<ChangedFileStatus>): ChangedFileStatus | null {
  if (statuses.size === 0) return null;
  const kinds = new Set([...statuses].map((status) => (status === "untracked" ? "added" : status === "renamed" ? "modified" : status)));
  return kinds.size === 1 ? ([...kinds][0] as ChangedFileStatus) : "modified";
}

function noteKey(dirKey: string): string {
  return `${dirKey}/\0note`;
}

/**
 * Converts the mutable tree. A chain of plain folders that each hold exactly one folder and no file
 * becomes one row; a lazy folder ends the chain. Returns the statuses of the changes below, for the
 * parent's dot.
 */
function toNodes(dir: MDir, prefix: string, listings: ReadonlyMap<string, FolderListing>, out: TreeNode[]): Set<ChangedFileStatus> {
  const statuses = new Set<ChangedFileStatus>();
  const dirs = [...dir.dirs.entries()].sort(([left], [right]) => compareNames(left, right));
  for (const [name, child] of dirs) {
    let label = name;
    let key = `${prefix}${name}`;
    let current = child;
    while (!current.lazy && current.files.size === 0 && current.dirs.size === 1) {
      const [nextName, next] = current.dirs.entries().next().value as [string, MDir];
      label = `${label}/${nextName}`;
      key = `${key}/${nextName}`;
      current = next;
    }
    const children: TreeNode[] = [];
    if (current.lazy) {
      const listing = listings.get(key);
      if (!listing || "loading" in listing) children.push({ kind: "note", key: noteKey(key), text: "加载中…" });
      else if ("error" in listing) children.push({ kind: "note", key: noteKey(key), text: listing.error, error: true });
    }
    const below = toNodes(current, `${key}/`, listings, children);
    if (current.lazy && children.length === 0) children.push({ kind: "note", key: noteKey(key), text: "空文件夹" });
    for (const status of below) statuses.add(status);
    const node: TreeDir = { kind: "dir", key, name: label, children, dot: dotOf(below) };
    if (current.lazy) node.lazy = true;
    if (current.ignored) node.ignored = true;
    out.push(node);
  }
  const files = [...dir.files.entries()].sort(([left], [right]) => compareNames(left, right));
  for (const [name, file] of files) {
    out.push({ kind: "file", key: `${prefix}${name}`, name, file: file.change, ignored: file.ignored || undefined });
    if (file.change) statuses.add(file.change.status);
  }
  return statuses;
}

function collectSearchable(dir: MDir, prefix: string, out: SearchableFile[]) {
  for (const [name, child] of dir.dirs) {
    if (!child.ignored) collectSearchable(child, `${prefix}${name}/`, out);
  }
  for (const [name, file] of dir.files) {
    if (!file.ignored) out.push(file.change ? { path: `${prefix}${name}`, change: file.change } : { path: `${prefix}${name}` });
  }
}

export function buildFilesTree(input: FilesTreeInput): FilesTree {
  const { index, listings, changes, extra } = input;
  // Truncated: nothing is dimmed, the root is listed on demand.
  const dim = input.dimIgnored && index !== null;
  const root = newDir(index === null, false);

  for (const entry of index ?? []) {
    const { parents, name } = splitPath(entry.path);
    if (!name) continue;
    const ignored = dim && entry.ignored;
    const parent = ensureDir(root, parents, false);
    if (entry.kind === "directory") {
      if (!parent.dirs.has(name)) {
        parent.files.delete(name);
        parent.dirs.set(name, newDir(true, ignored));
      }
    } else if (!parent.dirs.has(name) && !parent.files.has(name)) {
      parent.files.set(name, { ignored });
    }
  }

  // Parents before children: a listing applies only where its folder is already in the tree.
  const listed = [...listings.entries()].sort(([left], [right]) => left.split("/").length - right.split("/").length || compareNames(left, right));
  for (const [path, listing] of listed) {
    if (!("entries" in listing)) continue;
    const dir = path === "" ? root : findDir(root, path);
    if (!dir || !dir.lazy) continue;
    for (const entry of listing.entries) {
      if (!entry.name || entry.name.includes("/")) continue;
      if (entry.dir) {
        if (!dir.dirs.has(entry.name) && !dir.files.has(entry.name)) dir.dirs.set(entry.name, newDir(true, dir.ignored));
      } else if (!dir.dirs.has(entry.name) && !dir.files.has(entry.name)) {
        dir.files.set(entry.name, { ignored: dir.ignored });
      }
    }
  }

  // One row per path: a rename's old path is never a separate entry.
  for (const change of changes) {
    if (!change.oldPath || change.oldPath === change.path) continue;
    const { parents, name } = splitPath(change.oldPath);
    const parent = findDir(root, parents.join("/"));
    const existing = parent?.files.get(name);
    if (parent && existing && !existing.change) parent.files.delete(name);
  }
  for (const change of changes) {
    const { parents, name } = splitPath(change.path);
    if (!name) continue;
    const parent = ensureDir(root, parents, false);
    // A changed submodule is a folder of the tree; it keeps its folder row.
    if (parent.dirs.has(name)) continue;
    const existing = parent.files.get(name);
    parent.files.set(name, { ignored: false, change: existing?.change ?? change });
  }
  for (const path of extra) {
    const { parents, name } = splitPath(path);
    if (!name) continue;
    const parent = ensureDir(root, parents, false);
    if (!parent.dirs.has(name) && !parent.files.has(name)) parent.files.set(name, { ignored: false });
  }

  const nodes: TreeNode[] = [];
  if (root.lazy) {
    const listing = listings.get("");
    if (!listing || "loading" in listing) nodes.push({ kind: "note", key: noteKey(""), text: "加载中…" });
    else if ("error" in listing) nodes.push({ kind: "note", key: noteKey(""), text: listing.error, error: true });
  }
  toNodes(root, "", listings, nodes);
  const searchable: SearchableFile[] = [];
  collectSearchable(root, "", searchable);
  const empty = root.dirs.size === 0 && root.files.size === 0 && !nodes.some((node) => node.kind === "note");
  return { nodes, searchable, empty };
}

/** The filtered tree: every searchable file whose path matches every term, fully known (no lazy
 * folders, no notes). At most `cap` files are kept, in path order. */
export function filterFilesTree(
  searchable: readonly SearchableFile[],
  terms: readonly string[],
  cap: number,
): { nodes: TreeNode[]; matched: number; shown: number } {
  const matched = searchable.filter((file) => matchesFilter(file.change ?? file, terms));
  matched.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const shown = matched.slice(0, cap);
  const root = newDir(false, false);
  for (const file of shown) {
    const { parents, name } = splitPath(file.path);
    const parent = ensureDir(root, parents, false);
    parent.files.set(name, { ignored: false, change: file.change });
  }
  const nodes: TreeNode[] = [];
  toNodes(root, "", new Map(), nodes);
  return { nodes, matched: matched.length, shown: shown.length };
}

/** Every folder on the way to `path` (a file's path), each as a full path: what has to be open for
 * its row to show, whatever the compaction. */
export function folderPrefixes(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const prefixes: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) prefixes.push(parts.slice(0, index).join("/"));
  return prefixes;
}

/** A folder row's key and every folder above it: expanding a compacted row opens the whole chain. */
export function selfAndAncestors(key: string): string[] {
  return folderPrefixes(`${key}/x`);
}

/** Whether `path` names a file the tree shows as a file. */
export function treeHasFile(nodes: readonly TreeNode[], path: string): boolean {
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.key === path) return true;
    } else if (node.kind === "dir" && path.startsWith(`${node.key}/`)) {
      return treeHasFile(node.children, path);
    }
  }
  return false;
}
