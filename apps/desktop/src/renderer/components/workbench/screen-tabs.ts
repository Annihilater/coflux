/**
 * Remote screen tabs' stored records (plan 20260929-remote-desktop).
 *
 * A screen tab is a layout entry (terminal-layout.ts, `SCREEN_TAB_PREFIX`); what it shows lives
 * here: its workspace, the device whose screen it is and the remote session id — stable for the
 * life of the tab so that a reconnect or an app restart reattaches to the same remote session and
 * virtual display. Records are written no later than the layout that references them; on restore a
 * screen id without a record is dropped, as is a record no layout references. Local to this
 * machine and scoped by server address like the layouts. Pure: storage is injected.
 */

import { SCREEN_TAB_PREFIX, pruneScreenTabs, screenTabIdsOf, type TerminalLayout } from "./terminal-layout";

export type ScreenTabRecord = {
  workspaceId: string;
  daemonId: string;
  /** The remote session id the tab reattaches to (ScreenSessionOpen.session_id). */
  sessionId: string;
};

export type ScreenTabRecords = Readonly<Record<string, ScreenTabRecord>>;

export type ScreenTabStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
const MAX_RECORDS = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A fresh screen tab id. `unique` is any string unique enough on this machine (a UUID in the app). */
export function createScreenTabId(unique: string): string {
  return `${SCREEN_TAB_PREFIX}${unique.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** The remote session id of a new tab: stable, opaque, and safe as a device envelope id. */
export function createScreenSessionId(unique: string): string {
  return `scr-${unique.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

/** Parses a stored value; anything unusable reads as "nothing stored", a bad entry is skipped. */
export function parseScreenTabRecords(raw: string | null): Record<string, ScreenTabRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.tabs)) return {};
  const records: Record<string, ScreenTabRecord> = {};
  let count = 0;
  for (const [id, value] of Object.entries(parsed.tabs)) {
    if (count >= MAX_RECORDS) break;
    if (!id.startsWith(SCREEN_TAB_PREFIX) || id.length > 128 || !isRecord(value)) continue;
    const workspaceId = cleanId(value.workspaceId);
    const daemonId = cleanId(value.daemonId);
    const sessionId = cleanId(value.sessionId);
    if (!workspaceId || !daemonId || !sessionId) continue;
    records[id] = { workspaceId, daemonId, sessionId };
    count += 1;
  }
  return records;
}

export function serializeScreenTabRecords(records: ScreenTabRecords): string {
  const tabs: Record<string, ScreenTabRecord> = {};
  for (const id of Object.keys(records).sort()) {
    const record = records[id]!;
    tabs[id] = { workspaceId: record.workspaceId, daemonId: record.daemonId, sessionId: record.sessionId };
  }
  return JSON.stringify({ version: STORAGE_VERSION, tabs });
}

/** Storage that throws or holds junk reads as "nothing stored". */
export function readScreenTabRecords(store: ScreenTabStore): Record<string, ScreenTabRecord> {
  try {
    return parseScreenTabRecords(store.storage.getItem(store.key));
  } catch {
    return {};
  }
}

/** Best-effort write; a tab that cannot be remembered is not worth an error. */
export function writeScreenTabRecords(store: ScreenTabStore, serialized: string): boolean {
  try {
    store.storage.setItem(store.key, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cold start: keeps the screen tabs that have both a layout entry and a record for the same
 * workspace, drops the rest from either side. Layouts that did not change are returned as the same
 * objects.
 */
export function restoreScreenTabs(
  layouts: Readonly<Record<string, TerminalLayout>>,
  records: ScreenTabRecords,
): { layouts: Record<string, TerminalLayout>; records: Record<string, ScreenTabRecord> } {
  const nextLayouts: Record<string, TerminalLayout> = {};
  const nextRecords: Record<string, ScreenTabRecord> = {};
  for (const [workspaceId, layout] of Object.entries(layouts)) {
    const pruned = pruneScreenTabs(layout, (id) => records[id]?.workspaceId === workspaceId);
    nextLayouts[workspaceId] = pruned;
    for (const id of screenTabIdsOf(pruned)) nextRecords[id] = records[id]!;
  }
  return { layouts: nextLayouts, records: nextRecords };
}
