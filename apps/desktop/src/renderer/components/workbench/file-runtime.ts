import { createStore, type StoreApi } from "zustand/vanilla";

import { serializeFileTabRecords, writeFileTabRecords, type FileTabRecord, type FileTabStore } from "@/components/workbench/file-tabs";

/**
 * The renderer's side of the file tabs (plan 20261001-terminal-file-tab), one per Workbench:
 * every tab's record (workspace, canonical path, line — persisted synchronously, before the layout
 * that references it), a per-tab reveal counter (bumped each time the tab is opened again, so its
 * view jumps to the line even when the line did not change), the last content each view showed
 * (so a view that remounts — another tab activated, a group move — shows it at once and only asks
 * whether it changed), and keyboard focus.
 */
/** What a file view shows (file-view.tsx). `revision` is what the next conditional read sends. */
export type FileViewState =
  | { kind: "loading" }
  | { kind: "text"; content: string; revision: string }
  /** A NUL in the first 8000 characters (git's heuristic); polled like text in case it changes. */
  | { kind: "binary"; revision: string }
  | { kind: "tooLarge" }
  | { kind: "missing" }
  | { kind: "notFile" }
  /** The device's worker predates the typed read. */
  | { kind: "outdated" }
  | { kind: "failed"; error: string };

export type FileViewSnapshot = {
  state: FileViewState;
  scrollTop: number;
  /** The reveal counter the view had handled: a newer one means "jump to the line" on remount. */
  reveal: number;
  /** The highlighted line, if any. */
  highlight: number | null;
};

export type FileRuntimeState = {
  tabs: Readonly<Record<string, FileTabRecord>>;
  reveals: Readonly<Record<string, number>>;
};

export type FileRuntime = {
  tabs: StoreApi<FileRuntimeState>;
  createTab: (id: string, record: FileTabRecord) => void;
  /** The tab was opened again: its view jumps to `line`, or stays where it is without one. */
  reveal: (id: string, line: number | undefined) => void;
  removeTab: (id: string) => void;
  snapshotOf: (id: string) => FileViewSnapshot | undefined;
  remember: (id: string, snapshot: FileViewSnapshot) => void;
  /** Keyboard focus into the tab's view, now or as soon as it registers. */
  focus: (tabId: string) => void;
  register: (tabId: string, handlers: { focus: () => void }) => () => void;
};

export function createFileRuntime(options: { tabStore: FileTabStore; initialRecords: Readonly<Record<string, FileTabRecord>> }): FileRuntime {
  const tabs = createStore<FileRuntimeState>(() => ({ tabs: options.initialRecords, reveals: {} }));
  let lastRecords: string | null = serializeFileTabRecords(options.initialRecords);
  tabs.subscribe((state) => {
    const serialized = serializeFileTabRecords(state.tabs);
    if (serialized === lastRecords) return;
    lastRecords = serialized;
    writeFileTabRecords(options.tabStore, serialized);
  });

  const snapshots = new Map<string, FileViewSnapshot>();
  const handlers = new Map<string, { focus: () => void }>();
  const pendingFocus = new Set<string>();

  return {
    tabs,
    createTab(id, record) {
      tabs.setState((state) => ({ tabs: { ...state.tabs, [id]: record }, reveals: { ...state.reveals, [id]: (state.reveals[id] ?? 0) + 1 } }));
    },
    reveal(id, line) {
      tabs.setState((state) => {
        const record = state.tabs[id];
        if (!record) return state;
        // The record keeps the line it was last opened at; opened without one, it has none.
        const next: FileTabRecord = line === undefined ? { workspaceId: record.workspaceId, path: record.path } : { ...record, line };
        return { tabs: { ...state.tabs, [id]: next }, reveals: { ...state.reveals, [id]: (state.reveals[id] ?? 0) + 1 } };
      });
    },
    removeTab(id) {
      snapshots.delete(id);
      pendingFocus.delete(id);
      tabs.setState((state) => {
        if (!(id in state.tabs)) return state;
        const nextTabs = { ...state.tabs };
        delete nextTabs[id];
        const nextReveals = { ...state.reveals };
        delete nextReveals[id];
        return { tabs: nextTabs, reveals: nextReveals };
      });
    },
    snapshotOf(id) {
      return snapshots.get(id);
    },
    remember(id, snapshot) {
      if (id in tabs.getState().tabs) snapshots.set(id, snapshot);
    },
    focus(tabId) {
      const target = handlers.get(tabId);
      if (target) target.focus();
      else pendingFocus.add(tabId);
    },
    register(tabId, target) {
      handlers.set(tabId, target);
      if (pendingFocus.delete(tabId)) target.focus();
      return () => {
        if (handlers.get(tabId) === target) handlers.delete(tabId);
      };
    },
  };
}
