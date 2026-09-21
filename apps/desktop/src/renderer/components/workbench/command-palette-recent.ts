/**
 * The ⌘P palette's most-recently-visited list (plan 20260921).
 *
 * Storage and key are arguments, never imports: `@/config` requires the desktop bridge at module
 * evaluation time and Node has no `localStorage`, so a module that reached for either could not be
 * unit tested at all. The caller composes a server-scoped key — entity ids are not portable across
 * servers — exactly as the session token and the offline catalog already do.
 *
 * Entries are never pruned against the live catalogue. Reading filters them against the snapshot
 * instead, which keeps a cold start (the offline catalogue arrives before the first snapshot) from
 * writing back a list that forgets places which still exist.
 */

export type RecentPlacesStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
  /** How many places to remember. */
  limit?: number;
};

const DEFAULT_LIMIT = 20;

/**
 * Most recent first. Storage access can throw outright (blocked site data) and the stored value
 * can be anything at all, so every failure mode collapses to "nothing remembered" — an MRU that
 * took the workbench down on startup would be a poor trade for a convenience list.
 */
export function readRecentPlaces(store: RecentPlacesStore): string[] {
  try {
    const raw = store.storage.getItem(store.key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, store.limit ?? DEFAULT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Move-to-front, not append-a-visit: the selection is re-persisted on every snapshot
 * reconciliation, not only on a real navigation, so recording has to be idempotent. Returns the
 * new list for callers that want it; the write itself is best-effort.
 */
export function recordRecentPlace(store: RecentPlacesStore, key: string): string[] {
  if (!key) return readRecentPlaces(store);
  const next = [key, ...readRecentPlaces(store).filter((entry) => entry !== key)].slice(0, store.limit ?? DEFAULT_LIMIT);
  try {
    store.storage.setItem(store.key, JSON.stringify(next));
  } catch {
    // Remembering where you have been is a convenience; failing to is not worth an error.
  }
  return next;
}
