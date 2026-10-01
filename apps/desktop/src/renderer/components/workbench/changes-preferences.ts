import { useSyncExternalStore } from "react";

import type { DiffMode } from "@/components/workbench/parse-diff";

/*
 * The changes view's global choices (plans 20260929-changes-file-tree, 20261001-changes-review-polish):
 * split/inline, the comparison scope and ignore-whitespace. One value per machine, shared by every
 * workspace's view at once — a view is mounted per workspace and stays mounted, so a choice made in
 * one must reach the others without a remount — and persisted across restarts.
 */

/** 「分支全部改动」 (the default) or 「未提交」. */
export type ChangesScope = "branch" | "uncommitted";

export type ChangesPreferences = { mode: DiffMode; scope: ChangesScope; ignoreWhitespace: boolean };

const DIFF_MODE_KEY = "coflux_changes_diff_mode";
const SCOPE_KEY = "coflux_changes_scope";
const IGNORE_WHITESPACE_KEY = "coflux_changes_ignore_whitespace";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without localStorage the choice still holds for this session.
  }
}

let current: ChangesPreferences | null = null;
const listeners = new Set<() => void>();

function snapshot(): ChangesPreferences {
  if (!current) {
    current = {
      mode: read(DIFF_MODE_KEY) === "inline" ? "inline" : "split",
      scope: read(SCOPE_KEY) === "uncommitted" ? "uncommitted" : "branch",
      ignoreWhitespace: read(IGNORE_WHITESPACE_KEY) === "1",
    };
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setChangesPreference<K extends keyof ChangesPreferences>(key: K, value: ChangesPreferences[K]) {
  const previous = snapshot();
  if (previous[key] === value) return;
  current = { ...previous, [key]: value };
  if (key === "mode") write(DIFF_MODE_KEY, String(value));
  else if (key === "scope") write(SCOPE_KEY, String(value));
  else write(IGNORE_WHITESPACE_KEY, value ? "1" : "0");
  for (const listener of listeners) listener();
}

export function useChangesPreferences(): ChangesPreferences {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
