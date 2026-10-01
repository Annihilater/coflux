import { FsReadStatus, type DeviceFsStatResult, type FsReadResult } from "@coflux/protocol";

import { DAEMON_OUTDATED_CODE } from "./device-router";

/* Workspace files (plan 20261001-terminal-file-tab): the shapes the store hands the desktop's
 * terminal links and file tab, and the pure mapping from the device responses. Every state is
 * decided from the typed status, never from the worker's free-form error text. Online/offline is
 * not a result kind: views read the daemon's `online` flag. */

export type FileStat = {
  /** The path as requested, byte for byte. */
  path: string;
  /** Resolves (links followed) to something inside the workspace. */
  exists: boolean;
  /** The resolved target is a regular file. */
  isFile: boolean;
  /** The file's revision; empty unless `isFile`. */
  revision: string;
  /** Canonical workspace-relative path (the file's identity); empty unless `exists`. */
  relativePath: string;
};

export type FileStatResult =
  | { kind: "ok"; entries: FileStat[] }
  /** The device's worker predates `fsStat`. */
  | { kind: "daemonOutdated"; error: string }
  | { kind: "failed"; error: string };

export type FileReadResult =
  | { kind: "ok"; content: string; revision: string }
  /** The known revision is still current; nothing to repaint. */
  | { kind: "notModified"; revision: string }
  | { kind: "tooLarge"; error: string }
  | { kind: "missing"; error: string }
  | { kind: "notFile"; error: string }
  /** The device's worker predates the typed read (it answered without a status or revision). */
  | { kind: "daemonOutdated"; error: string }
  | { kind: "failed"; error: string };

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toFileStatResult(result: DeviceFsStatResult): FileStatResult {
  if (!result.ok) return { kind: "failed", error: result.error || "查询文件失败" };
  return {
    kind: "ok",
    entries: result.entries.map((entry) => ({
      path: entry.path,
      exists: entry.exists,
      isFile: entry.isFile,
      revision: entry.revision,
      relativePath: entry.relativePath,
    })),
  };
}

/** A thrown router error; `daemon_outdated` is the worker predating `fsStat`. */
export function fileStatFailure(error: unknown): FileStatResult {
  return errorCode(error) === DAEMON_OUTDATED_CODE
    ? { kind: "daemonOutdated", error: errorText(error) }
    : { kind: "failed", error: errorText(error) };
}

const OUTDATED_READ = "设备上的 daemon 版本过旧，更新后才能查看文件";

/**
 * A read response as the view sees it. A worker that predates the typed read leaves `status`
 * UNSPECIFIED and `revision` empty; "ok with an empty revision" is that worker too. Its content is
 * not shown, so the file tab and the terminal links agree about the device.
 */
export function toFileReadResult(result: FsReadResult): FileReadResult {
  const error = result.error || "读取文件失败";
  switch (result.status) {
    case FsReadStatus.OK:
      return result.revision ? { kind: "ok", content: result.content, revision: result.revision } : { kind: "daemonOutdated", error: OUTDATED_READ };
    case FsReadStatus.NOT_MODIFIED:
      return result.revision ? { kind: "notModified", revision: result.revision } : { kind: "daemonOutdated", error: OUTDATED_READ };
    case FsReadStatus.NOT_FOUND:
      return { kind: "missing", error };
    case FsReadStatus.NOT_FILE:
      return { kind: "notFile", error };
    case FsReadStatus.TOO_LARGE:
      return { kind: "tooLarge", error };
    case FsReadStatus.UNSPECIFIED:
      return { kind: "daemonOutdated", error: OUTDATED_READ };
    default:
      // ERROR, or a status newer than this client.
      return { kind: "failed", error };
  }
}

export function fileReadFailure(error: unknown): FileReadResult {
  return errorCode(error) === DAEMON_OUTDATED_CODE
    ? { kind: "daemonOutdated", error: errorText(error) }
    : { kind: "failed", error: errorText(error) };
}
