import { ChangesWhitespace, DeviceChangeStatus, type DeviceChangesFile, type DeviceChangesList } from "@coflux/protocol";

import { DAEMON_OUTDATED_CODE } from "./device-router";

/* Workspace changes (plans 20260929-changes-file-tree, 20261001-changes-review-polish): the shapes
 * the store hands the desktop changes view, and the pure mapping from the device responses. */

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
export type ChangedFile = {
  /** Worktree-relative path in the working tree (the new path of a rename). */
  path: string;
  /** Base-side path; set only for renames. */
  oldPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** The larger of the two sides in bytes. */
  size: number;
};
/**
 * Which whitespace changes a file's patch leaves out, one git flag per level: none, trailing
 * (`--ignore-space-at-eol`), amount (`-b`, which includes trailing) and all (`-w`).
 */
export type WhitespaceMode = "show" | "ignoreAtEol" | "ignoreChange" | "ignoreAll";
/** An option of the changes RPCs that a worker must echo back to prove it honoured it. */
export type ChangesOption = "uncommitted" | "whitespace";
/**
 * `daemonOutdated`: the device's worker is too old. Without `outdatedOption` it predates the
 * changes RPCs altogether; with it, it answered but ignored that option (the default branch scope
 * and plain whitespace still work there).
 */
export type ChangesFailure = { ok: false; error: string; daemonOutdated: boolean; outdatedOption?: ChangesOption };
/** `base` is the commit every per-file request must compare against (empty on an unborn branch). */
export type ChangesListResult = { ok: true; base: string; files: ChangedFile[] } | ChangesFailure;
export type ChangeFileResult =
  | {
      ok: true;
      oldExists: boolean;
      newExists: boolean;
      oldContent: string;
      newContent: string;
      /** `git diff -U0` of the pair (with the whitespace mode's flag); empty when a side is missing or both are equal. */
      patch: string;
      binary: boolean;
    }
  | ChangesFailure;

export const CHANGES_OPTION_OUTDATED_MESSAGE: Record<ChangesOption, string> = {
  uncommitted: "这台设备的 daemon 版本过旧，不支持「未提交」。更新 daemon 后重试。",
  whitespace: "这台设备的 daemon 版本过旧，不支持这个空白处理方式。更新 daemon 后重试。",
};

function changedFileStatus(status: DeviceChangeStatus): ChangedFileStatus {
  switch (status) {
    case DeviceChangeStatus.ADDED:
      return "added";
    case DeviceChangeStatus.DELETED:
      return "deleted";
    case DeviceChangeStatus.RENAMED:
      return "renamed";
    case DeviceChangeStatus.UNTRACKED:
      return "untracked";
    default:
      return "modified";
  }
}

function optionOutdated(option: ChangesOption): ChangesFailure {
  return { ok: false, error: CHANGES_OPTION_OUTDATED_MESSAGE[option], daemonOutdated: true, outdatedOption: option };
}

/** A thrown router error as a failure; `daemon_outdated` is the worker predating the changes RPCs. */
export function changesFailure(error: unknown): ChangesFailure {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    daemonOutdated: code === DAEMON_OUTDATED_CODE,
  };
}

/**
 * A list response as the view sees it. `ok` is checked first; then a request for the uncommitted
 * scope whose response does not echo it came from a worker that silently answered the branch scope.
 */
export function toChangesListResult(result: DeviceChangesList, uncommitted: boolean): ChangesListResult {
  if (!result.ok) return { ok: false, error: result.error || "获取变更失败", daemonOutdated: false };
  if (uncommitted && !result.uncommitted) return optionOutdated("uncommitted");
  return {
    ok: true,
    base: result.base,
    files: result.files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath,
      status: changedFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      size: Number(file.size),
    })),
  };
}

const WHITESPACE_WIRE: Record<WhitespaceMode, ChangesWhitespace> = {
  show: ChangesWhitespace.UNSPECIFIED,
  ignoreAtEol: ChangesWhitespace.IGNORE_AT_EOL,
  ignoreChange: ChangesWhitespace.IGNORE_CHANGE,
  ignoreAll: ChangesWhitespace.IGNORE_ALL,
};

export function whitespaceWire(mode: WhitespaceMode): ChangesWhitespace {
  return WHITESPACE_WIRE[mode];
}

/** A file response as the view sees it; an echo other than the requested mode means the worker
 * did not apply it (it predates the field, or the level). */
export function toChangeFileResult(result: DeviceChangesFile, whitespace: WhitespaceMode): ChangeFileResult {
  if (!result.ok) return { ok: false, error: result.error || "读取文件失败", daemonOutdated: false };
  if (result.whitespace !== WHITESPACE_WIRE[whitespace]) return optionOutdated("whitespace");
  return {
    ok: true,
    oldExists: result.oldExists,
    newExists: result.newExists,
    oldContent: result.oldContent,
    newContent: result.newContent,
    patch: result.patch,
    binary: result.binary,
  };
}
