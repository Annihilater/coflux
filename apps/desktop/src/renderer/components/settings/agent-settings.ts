/**
 * Coding agents the desktop can launch from the new-tab menu (plan 20261001-desktop-agents): the
 * fixed four-agent catalog and the rules over the per-agent `{ enabled, command }` configuration.
 *
 * The configuration itself is the account's (plan 20261002-account-agent-settings): it lives on the
 * center and reaches this desktop through `@coflux/client`'s store (`agentSettings`), which keeps
 * any agent id the center holds. This module maps it onto the catalog — ids it does not know are
 * ignored — and stays pure, so the rules that would not show up as a visible failure ("on + empty
 * command is not effective", "unknown or malformed entries read as off") are guarded by node --test.
 * The logos live in agent-logos.tsx (this module stays plain TS for the test runner); the client
 * store views live in agent-settings-store.ts.
 */

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

/** The account's configuration as the client store holds it: agent id → setting, any id. */
export type AccountAgentSettingsShape = Readonly<Record<string, { enabled: boolean; command: string } | undefined>>;

/** An agent offered in the new-tab menu: switched on with a non-empty command. */
export type EffectiveAgent = AgentDefinition & {
  /** The trimmed launch command. */
  command: string;
};

/** A guard against a runaway value, not a product limit. The center enforces the same cap. */
export const MAX_COMMAND_LENGTH = 1000;

const OFF: AgentSetting = Object.freeze({ enabled: false, command: "" });

export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({
  claude: OFF,
  codex: OFF,
  cursor: OFF,
  grok: OFF,
});

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_CATALOG.some((agent) => agent.id === value);
}

export function agentDefinition(id: AgentId): AgentDefinition {
  // The catalog is a constant covering every AgentId; the fallback only narrows the type.
  return AGENT_CATALOG.find((agent) => agent.id === id) ?? AGENT_CATALOG[0]!;
}

/**
 * A command as it is stored: one line (control characters, newlines included, are dropped — the
 * center drops them too, so the echo of a write equals what was sent) and at most MAX_COMMAND_LENGTH.
 */
export function sanitizeAgentCommand(command: string): string {
  // eslint-disable-next-line no-control-regex
  return command.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_COMMAND_LENGTH);
}

/** One account entry; anything unusable reads as off with an empty command. */
function settingOf(value: unknown): AgentSetting {
  if (typeof value !== "object" || value === null) return OFF;
  const entry = value as { enabled?: unknown; command?: unknown };
  return {
    enabled: entry.enabled === true,
    command: typeof entry.command === "string" ? sanitizeAgentCommand(entry.command) : "",
  };
}

/** The account's configuration mapped onto the catalog: catalog agents it lacks are off, ids the catalog does not know are ignored. */
export function agentSettingsFromAccount(account: AccountAgentSettingsShape): AgentSettings {
  return {
    claude: settingOf(account.claude),
    codex: settingOf(account.codex),
    cursor: settingOf(account.cursor),
    grok: settingOf(account.grok),
  };
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
