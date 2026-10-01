import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { TaskStatus, type Task } from "@coflux/protocol";
import type { CofluxClient } from "@coflux/client";

import { agentDefinition, type AgentId } from "@/components/settings/agent-settings";
import {
  answersAgentCreate,
  pruneAgentTabRecords,
  readAgentTabRecords,
  writeAgentTabRecords,
  type AgentTabRecords,
  type AgentTabStore,
} from "@/components/workbench/agent-tabs";
import { AGENT_TABS_KEY } from "@/config";

const AGENT_TAB_STORE: AgentTabStore = { storage: localStorage, key: AGENT_TABS_KEY };

/**
 * How long after this client starts holding the new terminal the launch command is typed when no
 * live prompt-start mark has arrived. This is the common path, not a corner case: a prompt drawn
 * before the attach (usual locally, near-certain remotely) is inside the attach snapshot, which
 * carries no OSC 133.
 */
const PROMPT_FALLBACK_MS = 1000;
/** How often waiting launches look at whether the terminal is held yet. */
const POLL_MS = 100;

/** What one agent create carries until its task answers it. */
export type AgentLaunchRequest = {
  agentId: AgentId;
  /** The trimmed launch command from Settings at the moment the agent was chosen. */
  command: string;
  /** The title sent in `taskCreate`: the correlation key for the task that answers it. */
  title: string;
};

type BoundLaunch = {
  agentId: AgentId;
  command: string;
  /** When this client was first seen holding the terminal (null = not held yet, or lost again). */
  heldSince: number | null;
};

/** A launch failure shown to the user. Desktop-local: never the client's `lastError` (see below). */
export type AgentLaunchNotice = { id: number; message: string };

export type AgentLaunches = {
  /** Task id → agent id of terminals opened as an agent, for their tab icon. */
  records: AgentTabRecords;
  /** The latest launch failure, until dismissed. */
  notice: AgentLaunchNotice | null;
  dismissNotice: () => void;
  /** A pending create was started for an agent. */
  beginCreate: (pendingId: string, request: AgentLaunchRequest) => void;
  /** The pending create was dropped (its timeout or an error broadcast): its launch command goes with it. */
  discardCreate: (pendingId: string) => void;
  /** The created task replaced the pending tab: the launch binds to it only if it answers this create. */
  settleCreate: (pendingId: string, taskId: string) => void;
  /** An authenticated OSC 133 prompt-start mark arrived in a terminal pane. */
  handlePromptStart: (taskId: string) => void;
};

/**
 * Launching an agent in a new terminal (plan 20261001-desktop-agents). The desktop types the launch
 * command itself, as the terminal's holder: the worker's agent input path refuses while a human
 * holds the terminal, and the newly opened pane is that holder.
 *
 * Owned at the workbench level, above the panes, keyed first by pending tab id and then by task id,
 * in memory only: a reconnect, re-attach, reload or restart never types a command again. A launch
 * is typed once this client holds the terminal, on the first live prompt-start mark or after
 * PROMPT_FALLBACK_MS, command and Enter in one write; it is discarded when the task is removed or
 * exits, or when its pending create is dropped. Holding the terminal is not under the renderer's
 * control (a hidden group, an offline device), so a launch may wait indefinitely for it.
 *
 * A send that fails, or a created task that does not answer this create, is reported as a
 * desktop-local notice, deliberately not through `client.reportLocalError`: the client's `lastError`
 * stops every terminal mid-attach (terminal-attach.ts) and drops every in-flight create
 * (workbench.tsx) — including the very terminal just created.
 */
export function useAgentLaunches(client: CofluxClient, { tasks, snapshotReady }: { tasks: readonly Task[]; snapshotReady: boolean }): AgentLaunches {
  const [records, setRecords] = useState<AgentTabRecords>(() => readAgentTabRecords(AGENT_TAB_STORE));
  const recordsRef = useRef(records);
  const pendingRef = useRef(new Map<string, AgentLaunchRequest>());
  const launchesRef = useRef(new Map<string, BoundLaunch>());
  const pollRef = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState<AgentLaunchNotice | null>(null);
  const noticeSeqRef = useRef(0);

  function reportNotice(message: string) {
    setNotice({ id: ++noticeSeqRef.current, message });
  }

  function commitRecords(next: AgentTabRecords) {
    if (next === recordsRef.current) return;
    recordsRef.current = next;
    setRecords(next);
    writeAgentTabRecords(AGENT_TAB_STORE, next);
  }

  function stopPolling() {
    if (pollRef.current === undefined) return;
    window.clearInterval(pollRef.current);
    pollRef.current = undefined;
  }

  function deliver(taskId: string, launch: BoundLaunch) {
    // Consumed before sending: whatever happens next, it is never typed twice.
    launchesRef.current.delete(taskId);
    if (launchesRef.current.size === 0) stopPolling();
    if (!client.typeIntoHeldTerminal(taskId, `${launch.command}\r`)) {
      reportNotice(`没能把 ${agentDefinition(launch.agentId).name} 的启动命令送进终端，请在终端里手动输入。`);
    }
  }

  function tick() {
    const now = Date.now();
    const liveTasks = client.store.getState().tasks;
    for (const [taskId, launch] of [...launchesRef.current]) {
      const task = liveTasks.find((item) => item.id === taskId);
      if (!task || task.status === TaskStatus.EXITED) {
        launchesRef.current.delete(taskId);
        continue;
      }
      if (!client.holdsTaskTerminal(taskId)) {
        launch.heldSince = null;
        continue;
      }
      if (launch.heldSince === null) {
        launch.heldSince = now;
        continue;
      }
      if (now - launch.heldSince >= PROMPT_FALLBACK_MS) deliver(taskId, launch);
    }
    if (launchesRef.current.size === 0) stopPolling();
  }
  // The polling interval is started from event handlers, so it calls the latest tick through a ref
  // kept current after every commit.
  const tickRef = useRef(tick);
  useLayoutEffect(() => {
    tickRef.current = tick;
  });

  function startPolling() {
    if (pollRef.current !== undefined) return;
    pollRef.current = window.setInterval(() => tickRef.current(), POLL_MS);
  }

  useEffect(() => () => stopPolling(), []);

  // Records follow the task list: a task that is gone takes its record with it. Only once the first
  // snapshot is in — an empty pre-login or offline list would wipe every record.
  const pruneRecords = useEffectEvent((liveTaskIds: ReadonlySet<string>) => {
    commitRecords(pruneAgentTabRecords(recordsRef.current, liveTaskIds));
  });
  useEffect(() => {
    if (!snapshotReady) return;
    pruneRecords(new Set(tasks.map((task) => task.id)));
  }, [tasks, snapshotReady]);

  return {
    records,
    notice,
    dismissNotice: () => setNotice(null),
    beginCreate: (pendingId, request) => {
      pendingRef.current.set(pendingId, request);
    },
    discardCreate: (pendingId) => {
      pendingRef.current.delete(pendingId);
    },
    settleCreate: (pendingId, taskId) => {
      const request = pendingRef.current.get(pendingId);
      if (!request) return;
      pendingRef.current.delete(pendingId);
      const task = client.store.getState().tasks.find((item) => item.id === taskId);
      if (!answersAgentCreate(task?.title, request.title)) {
        reportNotice(
          `没有启动 ${agentDefinition(request.agentId).name}：新出现的终端不是这次创建的那个，启动命令没有输入。`,
        );
        return;
      }
      commitRecords({ ...recordsRef.current, [taskId]: request.agentId });
      launchesRef.current.set(taskId, { agentId: request.agentId, command: request.command, heldSince: null });
      startPolling();
    },
    handlePromptStart: (taskId) => {
      const launch = launchesRef.current.get(taskId);
      if (!launch || !client.holdsTaskTerminal(taskId)) return;
      deliver(taskId, launch);
    },
  };
}
