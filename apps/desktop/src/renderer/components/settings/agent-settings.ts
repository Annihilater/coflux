/**
 * Coding agents the desktop can launch from the new-tab menu (plan 20261001-desktop-agents): the
 * fixed four-agent catalog and the per-agent `{ enabled, command }` configuration kept on this Mac.
 *
 * Pure apart from the injected storage, so the rules that would not show up as a visible failure —
 * "on + empty command is not effective", "garbage storage reads as all off" — are guarded by
 * node --test. The logos live in agent-logos.tsx (this module stays plain TS for the test runner);
 * the app's single store instance lives in agent-settings-store.ts, the only reader and writer of
 * the stored value.
 */

import { createStore, type StoreApi } from "zustand/vanilla";

export type AgentId = "claude" | "codex" | "cursor" | "grok";

export type AgentDefinition = {
  id: AgentId;
  /** Display name: settings row, flyout item, and the title of the terminal it opens. */
  name: string;
  /** Shown as the command input's placeholder only. Never used as a launch command. */
  placeholderCommand: string;
};

/** The fixed catalog, in the order every surface lists it. */
export const AGENT_CATALOG: readonly AgentDefinition[] = [
  { id: "claude", name: "Claude Code", placeholderCommand: "claude" },
  { id: "codex", name: "Codex", placeholderCommand: "codex" },
  { id: "cursor", name: "Cursor", placeholderCommand: "cursor-agent" },
  { id: "grok", name: "Grok", placeholderCommand: "grok" },
];

export type AgentSetting = {
  enabled: boolean;
  /** Exactly what the user typed; trimmed only when deciding effectiveness and when launching. */
  command: string;
};

export type AgentSettings = Readonly<Record<AgentId, AgentSetting>>;

/** An agent offered in the new-tab menu: switched on with a non-empty command. */
export type EffectiveAgent = AgentDefinition & {
  /** The trimmed launch command. */
  command: string;
};

const STORAGE_VERSION = 1;
/** A guard against a corrupted or runaway value, not a product limit. */
const MAX_COMMAND_LENGTH = 1000;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({
  claude: { enabled: false, command: "" },
  codex: { enabled: false, command: "" },
  cursor: { enabled: false, command: "" },
  grok: { enabled: false, command: "" },
});

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_CATALOG.some((agent) => agent.id === value);
}

export function agentDefinition(id: AgentId): AgentDefinition {
  // The catalog is a constant covering every AgentId; the fallback only narrows the type.
  return AGENT_CATALOG.find((agent) => agent.id === id) ?? AGENT_CATALOG[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One stored entry; anything unusable falls back to off with an empty command. */
function parseSetting(value: unknown): AgentSetting {
  if (!isRecord(value)) return { enabled: false, command: "" };
  const command = typeof value.command === "string" ? value.command.replace(/[\r\n]/g, "").slice(0, MAX_COMMAND_LENGTH) : "";
  return { enabled: value.enabled === true, command };
}

/** Parses a stored value. Missing or malformed storage reads as all off with empty commands. */
export function parseAgentSettings(raw: string | null): AgentSettings {
  if (!raw) return DEFAULT_AGENT_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.agents)) return DEFAULT_AGENT_SETTINGS;
  const agents = parsed.agents;
  return {
    claude: parseSetting(agents.claude),
    codex: parseSetting(agents.codex),
    cursor: parseSetting(agents.cursor),
    grok: parseSetting(agents.grok),
  };
}

export function serializeAgentSettings(settings: AgentSettings): string {
  return JSON.stringify({ version: STORAGE_VERSION, agents: settings });
}

/** The command to launch with, or null when the agent is not effective (off, or on with a blank command). */
export function launchCommandOf(setting: AgentSetting): string | null {
  if (!setting.enabled) return null;
  const command = setting.command.trim();
  return command.length > 0 ? command : null;
}

/** The effective agents in catalog order. */
export function effectiveAgents(settings: AgentSettings): EffectiveAgent[] {
  const result: EffectiveAgent[] = [];
  for (const agent of AGENT_CATALOG) {
    const command = launchCommandOf(settings[agent.id]);
    if (command !== null) result.push({ ...agent, command });
  }
  return result;
}

/** One agent changed; the others are kept as they are. Switching off keeps the typed command. */
export function withAgentSetting(settings: AgentSettings, id: AgentId, patch: Partial<AgentSetting>): AgentSettings {
  const current = settings[id];
  const next: AgentSetting = {
    enabled: patch.enabled ?? current.enabled,
    command: patch.command !== undefined ? patch.command.replace(/[\r\n]/g, "").slice(0, MAX_COMMAND_LENGTH) : current.command,
  };
  if (next.enabled === current.enabled && next.command === current.command) return settings;
  return { ...settings, [id]: next };
}

export type AgentSettingsStorage = {
  /** Called on every read and write rather than captured once: accessing `localStorage` itself may throw. */
  storage: () => Pick<Storage, "getItem" | "setItem">;
  key: string;
};

export type AgentSettingsState = {
  settings: AgentSettings;
  /** Applies a change and writes it at once (no save button). A failed write keeps the change for this session. */
  update: (id: AgentId, patch: Partial<AgentSetting>) => void;
};

export function readAgentSettings(store: AgentSettingsStorage): AgentSettings {
  try {
    return parseAgentSettings(store.storage().getItem(store.key));
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function writeAgentSettings(store: AgentSettingsStorage, settings: AgentSettings): boolean {
  try {
    store.storage().setItem(store.key, serializeAgentSettings(settings));
    return true;
  } catch {
    return false;
  }
}

/**
 * A subscribable store over the stored configuration: Settings writes through it and the new-tab
 * menu reads it, so a change is reflected in the menu without a reload.
 */
export function createAgentSettingsStore(store: AgentSettingsStorage): StoreApi<AgentSettingsState> {
  return createStore<AgentSettingsState>((set, get) => ({
    settings: readAgentSettings(store),
    update: (id, patch) => {
      const current = get().settings;
      const next = withAgentSetting(current, id, patch);
      if (next === current) return;
      set({ settings: next });
      writeAgentSettings(store, next);
    },
  }));
}
