import { useStore } from "zustand";

import { createAgentSettingsStore, type AgentSettings } from "@/components/settings/agent-settings";
import { AGENT_SETTINGS_KEY } from "@/config";

/**
 * The app's one agent-configuration store (plan 20261001-desktop-agents): the only reader and
 * writer of the stored value. The Settings 「Agents」 section writes through it; the new-tab menu
 * subscribes to it.
 */
export const agentSettingsStore = createAgentSettingsStore({ storage: () => localStorage, key: AGENT_SETTINGS_KEY });

export function useAgentSettings(): AgentSettings {
  return useStore(agentSettingsStore, (state) => state.settings);
}
