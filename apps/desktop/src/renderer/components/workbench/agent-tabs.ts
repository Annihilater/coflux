/**
 * Which terminal tabs were opened as an agent (plan 20261001-desktop-agents): task id → agent id,
 * kept on this machine for the tab icon. Written when the created task takes the pending tab's
 * place (and only when it answers this client's create, see use-agent-launches.ts); pruned when
 * the task is gone. The agent is never inferred from the title — titles are user-visible text and
 * an OSC title can replace what the tab shows.
 *
 * Pure: storage is injected, as for the layouts and the browser tab records.
 */

import { isAgentId, type AgentId } from "../settings/agent-settings";

export type AgentTabRecords = Readonly<Record<string, AgentId>>;

export type AgentTabStore = {
  storage: Pick<Storage, "getItem" | "setItem">;
  key: string;
};

const STORAGE_VERSION = 1;
/** More than anyone keeps open; a guard against a corrupted or runaway value, not a product limit. */
const MAX_RECORDS = 500;
const MAX_TASK_ID_LENGTH = 200;

export const NO_AGENT_TABS: AgentTabRecords = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a stored value; anything unusable reads as "nothing stored", a bad entry is skipped. */
export function parseAgentTabRecords(raw: string | null): AgentTabRecords {
  if (!raw) return NO_AGENT_TABS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_AGENT_TABS;
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.tabs)) return NO_AGENT_TABS;
  const records: Record<string, AgentId> = {};
  let count = 0;
  for (const [taskId, agent] of Object.entries(parsed.tabs)) {
    if (count >= MAX_RECORDS) break;
    if (!taskId || taskId.length > MAX_TASK_ID_LENGTH || !isAgentId(agent)) continue;
    records[taskId] = agent;
    count++;
  }
  return records;
}

export function serializeAgentTabRecords(records: AgentTabRecords): string {
  return JSON.stringify({ version: STORAGE_VERSION, tabs: records });
}

export function readAgentTabRecords(store: AgentTabStore): AgentTabRecords {
  try {
    return parseAgentTabRecords(store.storage.getItem(store.key));
  } catch {
    return NO_AGENT_TABS;
  }
}

export function writeAgentTabRecords(store: AgentTabStore, records: AgentTabRecords): boolean {
  try {
    store.storage.setItem(store.key, serializeAgentTabRecords(records));
    return true;
  } catch {
    return false;
  }
}

/** Records whose task is still live. Returns the same object when nothing was pruned. */
export function pruneAgentTabRecords(records: AgentTabRecords, liveTaskIds: ReadonlySet<string>): AgentTabRecords {
  let next: Record<string, AgentId> | null = null;
  for (const taskId of Object.keys(records)) {
    if (liveTaskIds.has(taskId)) continue;
    next ??= { ...records };
    delete next[taskId];
  }
  return next ?? records;
}

/**
 * Whether a created task may take the launch bound to the pending create it replaced. `TaskCreate`
 * carries no request id and the pending slot goes to the first task the workspace did not know, so
 * a terminal created concurrently elsewhere can take it; the title this client sent is the
 * correlation key, compared exactly.
 */
export function answersAgentCreate(createdTitle: string | undefined, sentTitle: string): boolean {
  return createdTitle !== undefined && createdTitle === sentTitle;
}
