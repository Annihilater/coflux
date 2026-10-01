import { useMemo } from "react";
import { useStore } from "zustand";

import type { CofluxClient } from "@coflux/client";
import { agentSettingsFromAccount, effectiveAgents, type AgentSettings, type EffectiveAgent } from "@/components/settings/agent-settings";
import { LEGACY_AGENT_SETTINGS_KEY } from "@/config";

/**
 * The agent configuration as the renderer sees it (plan 20261002-account-agent-settings): a view over
 * `@coflux/client`'s store, which holds the account's configuration (pushed by the center, cached in
 * the offline catalog). Settings → 「Agents」 writes through `client.setAgentSetting`; the new-tab
 * menu and the launch path read through here. Nothing in the renderer stores it locally.
 */

/** The account's configuration mapped onto the catalog. Selects the stored object (stable between
 * pushes) and derives in render: a selector returning a fresh object would re-render forever. */
export function useAgentSettings(client: CofluxClient): AgentSettings {
  const account = useStore(client.store, (state) => state.agentSettings);
  return useMemo(() => agentSettingsFromAccount(account), [account]);
}

/** The effective agents now, for reading at the moment of choosing. */
export function currentEffectiveAgents(client: CofluxClient): EffectiveAgent[] {
  return effectiveAgents(agentSettingsFromAccount(client.store.getState().agentSettings));
}

/**
 * 2.14.0 kept the configuration in this Mac's `localStorage`. That value is discarded, not migrated
 * (the user's choice): the key is removed and never read. Failure is tolerated.
 */
export function removeLegacyAgentSettings(): void {
  try {
    localStorage.removeItem(LEGACY_AGENT_SETTINGS_KEY);
  } catch {
    /* storage unavailable: nothing reads the key anyway */
  }
}
