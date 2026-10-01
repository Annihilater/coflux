/**
 * File tabs' stored records (plan 20261001-terminal-file-tab).
 *
 * A file tab is a layout entry (terminal-layout.ts, `FILE_TAB_PREFIX`); what it shows lives here:
 * its workspace, the file's canonical workspace-relative path (as the device's fsStat reported it —
 * the file's identity, never normalised on this side) and the line it was last opened at. Paths are
 * not id-safe, so they stay out of the tab id. Records are written no later than the layout that
 * references them; on restore a file id without a record is dropped, as is a record no layout
 * references. Local to this machine, scoped by server address like the layouts, never synced to
 * the account. Pure: storage is injected.
 */

import { FILE_TAB_PREFIX, fileTabIdsOf, pruneFileTabs, type TerminalLayout } from "./terminal-layout";

export type FileTabRecord = {
  workspaceId: string;
  /** Canonical workspace-relative path. */
  path: string;
  /** 1-based line to centre and highlight; absent = open at the top. */
  line?: number;
};

export type FileTabRecords = Readonly<Record<string, FileTabRecord>>;

export type FileTabStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
const MAX_RECORDS = 200;
const MAX_PATH_LENGTH = 4096;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A fresh file tab id. `unique` is any string unique enough on this machine (a UUID in the app). */
export function createFileTabId(unique: string): string {
  return `${FILE_TAB_PREFIX}${unique.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** The tab already showing this file of this workspace, if any: a second open focuses it. */
export function findFileTab(records: FileTabRecords, workspaceId: string, path: string): string | null {
  for (const [id, record] of Object.entries(records)) {
    if (record.workspaceId === workspaceId && record.path === path) return id;
  }
  return null;
}

/** The last segment of a workspace-relative path: the tab's title. */
export function fileTabTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function cleanPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes("\0") ? value : null;
}

function cleanLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 10_000_000 ? value : undefined;
}

/** Parses a stored value; anything unusable reads as "nothing stored", a bad entry is skipped. */
export function parseFileTabRecords(raw: string | null): Record<string, FileTabRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.tabs)) return {};
  const records: Record<string, FileTabRecord> = {};
  let count = 0;
  for (const [id, value] of Object.entries(parsed.tabs)) {
    if (count >= MAX_RECORDS) break;
    if (!id.startsWith(FILE_TAB_PREFIX) || id.length > 128 || !isRecord(value)) continue;
    const workspaceId = cleanId(value.workspaceId);
    const path = cleanPath(value.path);
    if (!workspaceId || !path) continue;
    const line = cleanLine(value.line);
    records[id] = line === undefined ? { workspaceId, path } : { workspaceId, path, line };
    count += 1;
  }
  return records;
}

export function serializeFileTabRecords(records: FileTabRecords): string {
  const tabs: Record<string, FileTabRecord> = {};
  for (const id of Object.keys(records).sort()) {
    const record = records[id]!;
    tabs[id] = record.line === undefined ? { workspaceId: record.workspaceId, path: record.path } : { workspaceId: record.workspaceId, path: record.path, line: record.line };
  }
  return JSON.stringify({ version: STORAGE_VERSION, tabs });
}

/** Storage that throws or holds junk reads as "nothing stored". */
export function readFileTabRecords(store: FileTabStore): Record<string, FileTabRecord> {
  try {
    return parseFileTabRecords(store.storage.getItem(store.key));
  } catch {
    return {};
  }
}

/** Best-effort write; a tab that cannot be remembered is not worth an error. */
export function writeFileTabRecords(store: FileTabStore, serialized: string): boolean {
  try {
    store.storage.setItem(store.key, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cold start: keeps the file tabs that have both a layout entry and a record for the same
 * workspace, drops the rest from either side. Layouts that did not change are returned as the same
 * objects.
 */
export function restoreFileTabs(
  layouts: Readonly<Record<string, TerminalLayout>>,
  records: FileTabRecords,
): { layouts: Record<string, TerminalLayout>; records: Record<string, FileTabRecord> } {
  const nextLayouts: Record<string, TerminalLayout> = {};
  const nextRecords: Record<string, FileTabRecord> = {};
  for (const [workspaceId, layout] of Object.entries(layouts)) {
    const pruned = pruneFileTabs(layout, (id) => records[id]?.workspaceId === workspaceId);
    nextLayouts[workspaceId] = pruned;
    for (const id of fileTabIdsOf(pruned)) nextRecords[id] = records[id]!;
  }
  return { layouts: nextLayouts, records: nextRecords };
}
