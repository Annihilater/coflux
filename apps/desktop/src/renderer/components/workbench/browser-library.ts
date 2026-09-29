/**
 * The built-in browser's history (plan 20260924-desktop-browser-tab).
 *
 * Global on this Mac — shared by every workspace and every server — and never synced. History is
 * capped (oldest visits dropped first). Fields that older versions wrote next to the history in the
 * same version-1 record are ignored when read and not written back.
 *
 * Pure: the storage is injected, and every read tolerates missing or corrupt data by falling back
 * to an empty library rather than failing the workbench.
 */

import { isWebUrl } from "./browser-address";

export type HistoryEntry = { url: string; title: string; visitCount: number; lastVisitedAt: number };

export type BrowserLibrary = {
  /** Most recently visited first. */
  history: readonly HistoryEntry[];
};

export type BrowserLibraryStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

export type BrowserSuggestion = { url: string; title: string };

export const HISTORY_CAP = 1000;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 4096;
/** Changing this (or the version check) would wipe every existing user's history. */
const STORAGE_VERSION = 1;

export const EMPTY_LIBRARY: BrowserLibrary = Object.freeze({ history: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_URL_LENGTH && isWebUrl(value);
}

function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TITLE_LENGTH) : "";
}

function finiteTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Keeps the most recently visited `cap` entries, most recent first. */
function capHistory(entries: readonly HistoryEntry[], cap = HISTORY_CAP): HistoryEntry[] {
  const sorted = [...entries].sort((left, right) => right.lastVisitedAt - left.lastVisitedAt);
  return sorted.slice(0, cap);
}

export function parseLibrary(raw: string | null): BrowserLibrary {
  if (!raw) return EMPTY_LIBRARY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LIBRARY;
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) return EMPTY_LIBRARY;

  const history: HistoryEntry[] = [];
  const seenHistory = new Set<string>();
  for (const value of Array.isArray(parsed.history) ? parsed.history : []) {
    if (!isRecord(value) || !usableUrl(value.url) || seenHistory.has(value.url)) continue;
    seenHistory.add(value.url);
    const visitCount = typeof value.visitCount === "number" && Number.isInteger(value.visitCount) && value.visitCount > 0 ? value.visitCount : 1;
    history.push({ url: value.url, title: cleanTitle(value.title), visitCount, lastVisitedAt: finiteTime(value.lastVisitedAt) });
  }

  return { history: capHistory(history) };
}

export function serializeLibrary(library: BrowserLibrary): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    history: library.history,
  });
}

/** Storage that throws or holds junk reads as an empty library. */
export function readLibrary(store: BrowserLibraryStore): BrowserLibrary {
  try {
    return parseLibrary(store.storage.getItem(store.key));
  } catch {
    return EMPTY_LIBRARY;
  }
}

/** Best-effort write. */
export function writeLibrary(store: BrowserLibraryStore, library: BrowserLibrary): boolean {
  try {
    store.storage.setItem(store.key, serializeLibrary(library));
    return true;
  } catch {
    return false;
  }
}

/**
 * A committed visit: moves the URL to the front (counting the visit) or adds it, dropping the
 * oldest entries past the cap. Only http(s) pages are remembered. An empty title keeps the title
 * already known for that URL (the title usually arrives after the navigation).
 */
export function recordVisit(library: BrowserLibrary, visit: { url: string; title: string }, now: number, cap = HISTORY_CAP): BrowserLibrary {
  if (!usableUrl(visit.url)) return library;
  const existing = library.history.find((entry) => entry.url === visit.url);
  const entry: HistoryEntry = {
    url: visit.url,
    title: cleanTitle(visit.title) || existing?.title || "",
    visitCount: (existing?.visitCount ?? 0) + 1,
    lastVisitedAt: now,
  };
  const rest = library.history.filter((item) => item.url !== visit.url);
  return { ...library, history: capHistory([entry, ...rest], cap) };
}

/** The page's title arrived after the visit was recorded. Unknown URLs and unchanged titles are no-ops. */
export function updateHistoryTitle(library: BrowserLibrary, url: string, title: string): BrowserLibrary {
  const clean = cleanTitle(title);
  if (!clean) return library;
  const index = library.history.findIndex((entry) => entry.url === url);
  if (index < 0 || library.history[index]!.title === clean) return library;
  const history = [...library.history];
  history[index] = { ...history[index]!, title: clean };
  return { ...library, history };
}

export function clearHistory(library: BrowserLibrary): BrowserLibrary {
  return library.history.length === 0 ? library : { ...library, history: [] };
}

/** The URL as people type it: no scheme, no `www.`, lowercased. */
function typedForm(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Address bar suggestions for what has been typed so far. A candidate must match: its URL as typed
 * (scheme and `www.` stripped) starting with the query ranks highest, then its host, then a word of
 * its title, then the query anywhere in the URL or title. At equal match strength, frequently and
 * recently visited pages come first. Every term of a multi-word query must match.
 */
export function rankSuggestions(library: BrowserLibrary, query: string, now: number, limit = 8): BrowserSuggestion[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const terms = text.split(/\s+/).filter(Boolean);
  const typedQuery = typedForm(text);

  const scored: { candidate: HistoryEntry; score: number }[] = [];
  for (const candidate of library.history) {
    const typed = typedForm(candidate.url);
    const host = typed.split(/[/?#]/)[0] ?? "";
    const title = candidate.title.toLowerCase();
    const titleWords = title.split(/[\s\p{P}]+/u).filter(Boolean);
    let score = 0;
    if (typed.startsWith(typedQuery)) score = 100;
    else if (host.split(".").some((label) => label.startsWith(typedQuery))) score = 80;
    else if (terms.every((term) => titleWords.some((word) => word.startsWith(term)))) score = 60;
    else if (terms.every((term) => typed.includes(term) || title.includes(term))) score = 40;
    else continue;
    score += Math.min(20, Math.log2(candidate.visitCount + 1) * 5);
    const age = now - candidate.lastVisitedAt;
    if (candidate.lastVisitedAt > 0 && age < DAY_MS) score += 10;
    else if (candidate.lastVisitedAt > 0 && age < 7 * DAY_MS) score += 5;
    scored.push({ candidate, score });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.candidate.lastVisitedAt - left.candidate.lastVisitedAt ||
      (left.candidate.url < right.candidate.url ? -1 : left.candidate.url > right.candidate.url ? 1 : 0),
  );
  return scored.slice(0, limit).map(({ candidate }) => ({ url: candidate.url, title: candidate.title }));
}
