/**
 * Open remote screens' stored records (plan 20261011-standalone-device-screen).
 *
 * A screen belongs to a device, not to a workspace: at most one per device, keyed by the device id.
 * The record holds the remote session id — stable for as long as the screen is open, so that a
 * reconnect or an app restart reattaches to the same remote session and virtual display. Local to
 * this machine and scoped by server address. The old per-tab records (plan 20260929-remote-desktop)
 * live under another key and are never read. Pure: storage is injected.
 */

export type ScreenRecord = {
  daemonId: string;
  /** The remote session id the screen reattaches to (ScreenSessionOpen.session_id). */
  sessionId: string;
};

/** Device id → its open screen. */
export type ScreenRecords = Readonly<Record<string, ScreenRecord>>;

export type ScreenRecordStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
const MAX_RECORDS = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The remote session id of a newly opened screen: stable, opaque, and safe as a device envelope id. */
export function createScreenSessionId(unique: string): string {
  return `scr-${unique.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

/**
 * Parses a stored value; anything unusable reads as "nothing stored", a bad entry is skipped, and a
 * second entry for a device already seen is ignored — one screen per device.
 */
export function parseScreenRecords(raw: string | null): Record<string, ScreenRecord> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.screens)) return {};
  const records: Record<string, ScreenRecord> = {};
  let count = 0;
  for (const value of parsed.screens) {
    if (count >= MAX_RECORDS) break;
    if (!isRecord(value)) continue;
    const daemonId = cleanId(value.daemonId);
    const sessionId = cleanId(value.sessionId);
    if (!daemonId || !sessionId || daemonId in records) continue;
    records[daemonId] = { daemonId, sessionId };
    count += 1;
  }
  return records;
}

export function serializeScreenRecords(records: ScreenRecords): string {
  const screens = Object.keys(records)
    .sort()
    .map((daemonId) => ({ daemonId, sessionId: records[daemonId]!.sessionId }));
  return JSON.stringify({ version: STORAGE_VERSION, screens });
}

/** Storage that throws or holds junk reads as "nothing stored". */
export function readScreenRecords(store: ScreenRecordStore): Record<string, ScreenRecord> {
  try {
    return parseScreenRecords(store.storage.getItem(store.key));
  } catch {
    return {};
  }
}

/** Best-effort write; a screen that cannot be remembered is not worth an error. */
export function writeScreenRecords(store: ScreenRecordStore, serialized: string): boolean {
  try {
    store.storage.setItem(store.key, serialized);
    return true;
  } catch {
    return false;
  }
}
