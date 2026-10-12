import { createStore, type StoreApi } from "zustand/vanilla";

import type { DesktopBridge } from "@/desktop-bridge";
import type { ScreenResolution } from "@/components/workbench/screen-resolution";
import { ScreenSession } from "@/components/workbench/screen-session";
import { createScreenSessionId, serializeScreenRecords, writeScreenRecords, type ScreenRecord, type ScreenRecordStore, type ScreenRecords } from "@/components/workbench/screen-records";

/**
 * The renderer's side of the open remote screens (plan 20261011-standalone-device-screen), one per
 * Workbench, keyed by device: every open screen's record (device, remote session id — persisted as
 * it changes) and the live `ScreenSession` of every mounted view. Sessions are created when a view
 * mounts and disposed when it unmounts; only removing the screen ends the remote session
 * (`ScreenSession.close`), everything else leaves the remote display in place.
 */
export type ScreenRuntime = {
  records: StoreApi<{ records: ScreenRecords }>;
  /**
   * Opens the device's screen when it has none: a new record with a new remote session id, whose
   * first open takes the session over. A device that already has one keeps it — same session id, no
   * takeover. Returns whether a record was created.
   */
  open: (daemonId: string) => boolean;
  /** Disconnects: ends the remote session (the virtual display goes away) and drops the record. */
  remove: (daemonId: string) => void;
  /** The screen's live session, created on first use for a mounted view, starting at `context.resolution`. */
  sessionFor: (daemonId: string, context: { deviceOnline: () => boolean; transportMode: () => string; resolution: ScreenResolution }) => ScreenSession | null;
  /** The screen's session if its view is mounted. */
  sessionOf: (daemonId: string) => ScreenSession | null;
  /** Sessions were created or let go (for `sessionOf` readers outside the view). */
  subscribeSessions: (listener: () => void) => () => void;
  /** The view unmounted (reload, record pruned): let go locally without ending the remote session. */
  release: (daemonId: string) => void;
  /** Keyboard focus into the screen's picture, now or as soon as its view registers. */
  focus: (daemonId: string) => void;
  register: (daemonId: string, handlers: { focus: () => void }) => () => void;
};

export function createScreenRuntime(options: {
  desktop: DesktopBridge;
  recordStore: ScreenRecordStore;
  initialRecords: ScreenRecords;
}): ScreenRuntime {
  const records = createStore<{ records: ScreenRecords }>(() => ({ records: options.initialRecords }));
  let lastRecords: string | null = serializeScreenRecords(options.initialRecords);
  records.subscribe((state) => {
    const serialized = serializeScreenRecords(state.records);
    if (serialized === lastRecords) return;
    lastRecords = serialized;
    writeScreenRecords(options.recordStore, serialized);
  });

  const sessions = new Map<string, ScreenSession>();
  const sessionListeners = new Set<() => void>();
  const handlers = new Map<string, { focus: () => void }>();
  const pendingFocus = new Set<string>();
  // Screens the user just opened: their first open takes the session over; restored ones never do.
  const fresh = new Set<string>();

  function sessionsChanged() {
    for (const listener of [...sessionListeners]) listener();
  }

  return {
    records,
    open(daemonId) {
      if (records.getState().records[daemonId]) return false;
      fresh.add(daemonId);
      const record: ScreenRecord = { daemonId, sessionId: createScreenSessionId(crypto.randomUUID()) };
      records.setState((state) => ({ records: { ...state.records, [daemonId]: record } }));
      return true;
    },
    remove(daemonId) {
      fresh.delete(daemonId);
      pendingFocus.delete(daemonId);
      const session = sessions.get(daemonId);
      sessions.delete(daemonId);
      session?.close();
      records.setState((state) => {
        if (!(daemonId in state.records)) return state;
        const next = { ...state.records };
        delete next[daemonId];
        return { records: next };
      });
      if (session) sessionsChanged();
    },
    sessionFor(daemonId, context) {
      const existing = sessions.get(daemonId);
      if (existing) return existing;
      const record = records.getState().records[daemonId];
      if (!record) return null;
      const session = new ScreenSession({
        sessionId: record.sessionId,
        daemonId: record.daemonId,
        desktop: options.desktop,
        deviceOnline: context.deviceOnline,
        transportMode: context.transportMode,
        takeOverOnOpen: fresh.delete(daemonId),
        resolution: context.resolution,
      });
      sessions.set(daemonId, session);
      sessionsChanged();
      return session;
    },
    sessionOf(daemonId) {
      return sessions.get(daemonId) ?? null;
    },
    subscribeSessions(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    release(daemonId) {
      const session = sessions.get(daemonId);
      sessions.delete(daemonId);
      session?.dispose();
      if (session) sessionsChanged();
    },
    focus(daemonId) {
      const target = handlers.get(daemonId);
      if (target) target.focus();
      else pendingFocus.add(daemonId);
    },
    register(daemonId, target) {
      handlers.set(daemonId, target);
      if (pendingFocus.delete(daemonId)) target.focus();
      return () => {
        if (handlers.get(daemonId) === target) handlers.delete(daemonId);
      };
    },
  };
}
