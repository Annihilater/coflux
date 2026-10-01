import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

/*
 * The changes view's local file actions (plan 20261001-changes-review-polish): 在 Finder 中显示 and
 * 用默认应用打开 for a file of a workspace on this machine. The renderer passes the workspace root and
 * a path relative to it, never a joined path; everything is resolved and checked here, so the bridge
 * cannot be used to reach arbitrary paths.
 *
 * `shell.openPath` launches whatever the file's default handler is, and for some types that is
 * running it. Opening is therefore refused for anything with an execute bit and for types whose
 * default action launches code or another location (bundles are directories and never pass the
 * regular-file check). Revealing in Finder never runs anything and only needs the containment and
 * regular-file checks.
 */

const MAX_PATH_CHARS = 4096;

/** Types whose default action runs something or opens another location, with or without +x. */
const LAUNCHING_EXTENSIONS = new Set([
  ".app",
  ".command",
  ".tool",
  ".terminal",
  ".jar",
  ".pkg",
  ".mpkg",
  ".dmg",
  ".workflow",
  ".action",
  ".scptd",
  ".prefpane",
  ".saver",
  ".fileloc",
  ".webloc",
  ".inetloc",
  ".url",
  ".desktop",
]);

export type ResolvedWorkspaceFile = { ok: true; path: string; executable: boolean } | { ok: false; error: string };

/**
 * The real path of `rel` under `root`, if it is an existing regular file inside the root. Symlinks
 * are followed and the target must still be inside the root's real path.
 */
export function resolveWorkspaceFile(root: unknown, rel: unknown): ResolvedWorkspaceFile {
  if (typeof root !== "string" || typeof rel !== "string") return { ok: false, error: "路径无效" };
  if (!root || !rel || root.length > MAX_PATH_CHARS || rel.length > MAX_PATH_CHARS) return { ok: false, error: "路径无效" };
  if (root.includes("\0") || rel.includes("\0")) return { ok: false, error: "路径无效" };
  if (!isAbsolute(root)) return { ok: false, error: "工作区路径无效" };
  if (isAbsolute(rel) || rel.split(/[\\/]/).some((segment) => segment === "..")) return { ok: false, error: "路径无效" };
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    if (!statSync(realRoot).isDirectory()) return { ok: false, error: "工作区路径无效" };
    realFile = realpathSync(resolve(realRoot, rel));
  } catch {
    return { ok: false, error: "文件不存在" };
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!realFile.startsWith(prefix)) return { ok: false, error: "文件不在工作区内" };
  let mode: number;
  try {
    const stats = statSync(realFile);
    if (!stats.isFile()) return { ok: false, error: "不是普通文件" };
    mode = stats.mode;
  } catch {
    return { ok: false, error: "文件不存在" };
  }
  return { ok: true, path: realFile, executable: (mode & 0o111) !== 0 };
}

/** Why 用默认应用打开 must not open this resolved file, or null when it may. */
export function openRefusal(file: { path: string; executable: boolean }): string | null {
  if (file.executable) return "这是可执行文件，不会直接打开；请在 Finder 中查看";
  if (LAUNCHING_EXTENSIONS.has(extname(file.path).toLowerCase())) return "这类文件打开时会运行程序，不会直接打开；请在 Finder 中查看";
  return null;
}
