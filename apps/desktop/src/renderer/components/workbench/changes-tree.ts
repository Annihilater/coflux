import type { ChangedFile } from "@coflux/client";

/**
 * The changes view's file tree (plan 20260929-changes-file-tree): folders first, then files, each
 * level sorted by name; a chain of single-child folders collapses into one row
 * (`renderer/components`), the way VS Code's compact folders do.
 */

export type TreeDir = { kind: "dir"; key: string; name: string; children: TreeNode[] };
export type TreeFile = { kind: "file"; key: string; name: string; file: ChangedFile };
export type TreeNode = TreeDir | TreeFile;

export type TreeRow =
  | { kind: "dir"; key: string; name: string; depth: number; expanded: boolean; parentKey: string | null }
  | { kind: "file"; key: string; name: string; depth: number; file: ChangedFile; parentKey: string | null };

type MutableDir = { dirs: Map<string, MutableDir>; files: TreeFile[] };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNames(left: string, right: string): number {
  return collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

export function buildChangesTree(files: readonly ChangedFile[]): TreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let dir = root;
    for (const part of parts) {
      let child = dir.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        dir.dirs.set(part, child);
      }
      dir = child;
    }
    dir.files.push({ kind: "file", key: file.path, name, file });
  }
  return toNodes(root, "");
}

function toNodes(dir: MutableDir, prefix: string): TreeNode[] {
  const dirs: TreeDir[] = [...dir.dirs.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, child]) => {
      // Compact: follow the chain while a folder holds exactly one folder and no files.
      let label = name;
      let key = `${prefix}${name}`;
      let current = child;
      while (current.files.length === 0 && current.dirs.size === 1) {
        const [nextName, next] = current.dirs.entries().next().value as [string, MutableDir];
        label = `${label}/${nextName}`;
        key = `${key}/${nextName}`;
        current = next;
      }
      return { kind: "dir", key, name: label, children: toNodes(current, `${key}/`) };
    });
  const files = [...dir.files].sort((left, right) => compareNames(left.name, right.name));
  return [...dirs, ...files];
}

/** Rows currently on screen: children of a collapsed folder are skipped. */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (level: readonly TreeNode[], depth: number, parentKey: string | null) => {
    for (const node of level) {
      if (node.kind === "dir") {
        const expanded = !collapsed.has(node.key);
        rows.push({ kind: "dir", key: node.key, name: node.name, depth, expanded, parentKey });
        if (expanded) walk(node.children, depth + 1, node.key);
      } else {
        rows.push({ kind: "file", key: node.key, name: node.name, depth, file: node.file, parentKey });
      }
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/** Every file path in tree order, whether or not its folder is collapsed. */
export function treeFileOrder(nodes: readonly TreeNode[]): string[] {
  return flattenTree(nodes, new Set())
    .filter((row) => row.kind === "file")
    .map((row) => row.key);
}

/**
 * The file to select after the list changed: the same file if it is still there; otherwise the
 * nearest file that followed it in the previous tree order (then the nearest before it); otherwise
 * the first file.
 */
export function pickSelection(
  previousOrder: readonly string[] | null,
  selected: string | null,
  nextOrder: readonly string[],
): string | null {
  if (nextOrder.length === 0) return null;
  const present = new Set(nextOrder);
  if (selected && present.has(selected)) return selected;
  if (selected && previousOrder) {
    const at = previousOrder.indexOf(selected);
    if (at >= 0) {
      for (let index = at + 1; index < previousOrder.length; index += 1) {
        if (present.has(previousOrder[index]!)) return previousOrder[index]!;
      }
      for (let index = at - 1; index >= 0; index -= 1) {
        if (present.has(previousOrder[index]!)) return previousOrder[index]!;
      }
    }
  }
  return nextOrder[0] ?? null;
}

/** The visible file row `delta` files away from the focused row (a folder row counts as a position). */
export function stepFile(rows: readonly TreeRow[], focusedKey: string | null, delta: 1 | -1): string | null {
  const files = rows.filter((row) => row.kind === "file");
  if (files.length === 0) return null;
  const at = focusedKey === null ? -1 : rows.findIndex((row) => row.key === focusedKey);
  if (at < 0) return (delta === 1 ? files[0] : files[files.length - 1])!.key;
  if (delta === 1) {
    for (let index = at + 1; index < rows.length; index += 1) if (rows[index]!.kind === "file") return rows[index]!.key;
  } else {
    for (let index = at - 1; index >= 0; index -= 1) if (rows[index]!.kind === "file") return rows[index]!.key;
  }
  return null;
}

/** Every folder that contains `path`, so a selected file can be revealed. */
export function ancestorKeys(nodes: readonly TreeNode[], path: string): string[] {
  const keys: string[] = [];
  const walk = (level: readonly TreeNode[]): boolean => {
    for (const node of level) {
      if (node.kind === "file") {
        if (node.key === path) return true;
      } else if (path.startsWith(`${node.key}/`)) {
        keys.push(node.key);
        if (walk(node.children)) return true;
        keys.pop();
      }
    }
    return false;
  };
  walk(nodes);
  return keys;
}

/* ----- Filter ----- */

/** The filter box's terms: whitespace-separated, lowercased; empty means no filter. */
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term is in the file's path (or a rename's old path), so `renderer/` narrows to a folder. */
export function matchesFilter(file: ChangedFile, terms: readonly string[]): boolean {
  const path = file.path.toLowerCase();
  const oldPath = file.oldPath?.toLowerCase();
  return terms.every((term) => path.includes(term) || Boolean(oldPath?.includes(term)));
}

/** Where the terms occur in a row's label, merged and in order, for highlighting. */
export function filterHighlights(label: string, terms: readonly string[]): { start: number; end: number }[] {
  const lower = label.toLowerCase();
  const ranges: { start: number; end: number }[] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      ranges.push({ start: at, end: at + term.length });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
