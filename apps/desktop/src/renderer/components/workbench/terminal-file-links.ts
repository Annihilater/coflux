/**
 * Terminal file links (plan 20261001-terminal-file-tab): which recognised references are links.
 *
 * A reference (`src/a.ts:12`) becomes a link only once the device confirms it is a regular file
 * inside the workspace. Existence is checked lazily, for the line under the pointer, and cached per
 * `(workspaceId, raw path)`:
 * - an existing file is cached for a long TTL, with its canonical workspace-relative path (the
 *   file tab's identity — the client never normalises paths itself);
 * - a missing path, a directory or a path outside the workspace for a short TTL (an agent may be
 *   about to create it);
 * - a failed check is not cached at all;
 * - a device whose worker predates the check makes every reference in that workspace plain text
 *   for a while, then asks again (a hot-upgraded worker gets its links back).
 *
 * Pure: the clock is injected and nothing touches xterm or the DOM, so the rules run under Node.
 */

/** What the device said about one requested path (a subset of @coflux/client's FileStat). */
export type FileLinkStat = { path: string; exists: boolean; isFile: boolean; relativePath: string };

export type FileLinkState = { kind: "file"; relativePath: string } | { kind: "absent" };

export const FILE_LINK_TTL_MS = 60_000;
export const ABSENT_LINK_TTL_MS = 3_000;
export const OUTDATED_LINK_TTL_MS = 30_000;
/** The worker refuses a larger batch; a line rarely holds this many references. */
export const MAX_FILE_LINK_BATCH = 64;

type Entry = FileLinkState & { expiresAt: number };

export type FileLinkCache = {
  /** The cached state, or undefined when the device must be asked. */
  get(workspaceId: string, path: string): FileLinkState | undefined;
  /** Record a successful check. */
  record(workspaceId: string, stats: readonly FileLinkStat[]): void;
  /** The device's worker predates the check: no links in this workspace for a while. */
  recordOutdated(workspaceId: string): void;
  /** The distinct paths of `paths` that are not cached, capped to one batch. */
  unknown(workspaceId: string, paths: readonly string[]): string[];
};

export function createFileLinkCache(now: () => number = Date.now): FileLinkCache {
  const entries = new Map<string, Entry>();
  const outdated = new Map<string, number>();
  const key = (workspaceId: string, path: string) => `${workspaceId}\0${path}`;

  function get(workspaceId: string, path: string): FileLinkState | undefined {
    const outdatedUntil = outdated.get(workspaceId);
    if (outdatedUntil !== undefined) {
      if (outdatedUntil > now()) return { kind: "absent" };
      outdated.delete(workspaceId);
    }
    const entry = entries.get(key(workspaceId, path));
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key(workspaceId, path));
      return undefined;
    }
    return entry.kind === "file" ? { kind: "file", relativePath: entry.relativePath } : { kind: "absent" };
  }

  function record(workspaceId: string, stats: readonly FileLinkStat[]): void {
    const at = now();
    for (const stat of stats) {
      const entry: Entry =
        stat.exists && stat.isFile && stat.relativePath
          ? { kind: "file", relativePath: stat.relativePath, expiresAt: at + FILE_LINK_TTL_MS }
          : { kind: "absent", expiresAt: at + ABSENT_LINK_TTL_MS };
      entries.set(key(workspaceId, stat.path), entry);
    }
    // Keep the map from growing without bound over a long session.
    if (entries.size > 4096) {
      for (const [entryKey, entry] of entries) if (entry.expiresAt <= at) entries.delete(entryKey);
    }
  }

  function recordOutdated(workspaceId: string): void {
    outdated.set(workspaceId, now() + OUTDATED_LINK_TTL_MS);
  }

  function unknown(workspaceId: string, paths: readonly string[]): string[] {
    const result: string[] = [];
    for (const path of paths) {
      if (result.length >= MAX_FILE_LINK_BATCH) break;
      if (result.includes(path) || get(workspaceId, path) !== undefined) continue;
      result.push(path);
    }
    return result;
  }

  return { get, record, recordOutdated, unknown };
}

/**
 * Whether a late existence answer may still be handed to xterm's `provideLinks` callback.
 *
 * xterm writes a late reply into whatever line's reply map is current, with the position captured
 * at request time, and does not check that the pointer is still on that line. So the answer is
 * delivered only when no newer request was made since (the pointer has not moved to another line)
 * and the line still holds the same text (output scrolling at the scrollback cap shifts every
 * buffer line by one under a still pointer). Otherwise the callback must never be called — not
 * even with `undefined`, which would also land in the new line's reply map.
 */
export function isLinkReplyCurrent(reply: {
  request: number;
  latestRequest: number;
  requestedText: string;
  currentText: string | null;
}): boolean {
  return reply.request === reply.latestRequest && reply.currentText === reply.requestedText;
}
