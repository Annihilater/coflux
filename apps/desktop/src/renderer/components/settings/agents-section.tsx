import { HStack, VStack } from "@astryxdesign/core/Layout";
import { ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

import { AgentLogo } from "@/components/settings/agent-logos";
import { AGENT_CATALOG, launchCommandOf, type AgentDefinition, type AgentSetting } from "@/components/settings/agent-settings";
import { agentSettingsStore, useAgentSettings } from "@/components/settings/agent-settings-store";
import { SETTINGS_ROW_PADDING, SettingsGroup } from "@/components/settings/settings-group";

/**
 * Settings → 「Agents」 (plan 20261001-desktop-agents): one card, one row per catalog agent in the
 * fixed order — logo, name, switch. Everything is off by default. Switching one on reveals its
 * 「启动命令」 input, empty with the default command as placeholder only; the agent is offered in
 * the new-tab menu once the command is filled in. Every change is written at once and stays on this
 * Mac; switching off keeps the typed command for next time.
 */
export function AgentsSection() {
  const settings = useAgentSettings();
  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="新建标签页菜单">
        {AGENT_CATALOG.map((agent) => (
          <AgentRow key={agent.id} agent={agent} setting={settings[agent.id]} />
        ))}
      </SettingsGroup>
      <Text type="supporting">
        选中 agent 会在新终端里输入这里的启动命令，和自己敲一样；命令不存在或远程设备没装时，报错就显示在那个终端里。
      </Text>
    </VStack>
  );
}

function AgentRow({ agent, setting }: { agent: AgentDefinition; setting: AgentSetting }) {
  const update = agentSettingsStore.getState().update;
  const waitingForCommand = setting.enabled && launchCommandOf(setting) === null;
  return (
    <ListItem
      label={agent.name}
      startContent={<AgentLogo agent={agent.id} className="size-5" />}
      // The command input lives in the description slot so the row stays one list item (one
      // divider) whether or not it is expanded. The row has no onClick, so nothing competes with it.
      description={
        setting.enabled ? (
          <VStack gap={1.5} hAlign="stretch" className="pt-2">
            <TextInput
              label="启动命令"
              size="sm"
              value={setting.command}
              onChange={(command) => update(agent.id, { command })}
              placeholder={agent.placeholderCommand}
              autoComplete="off"
              width="100%"
            />
            {waitingForCommand ? (
              <HStack gap={2} vAlign="center">
                <StatusDot variant="warning" label="注意" />
                <Text type="supporting">填写启动命令后生效</Text>
              </HStack>
            ) : null}
          </VStack>
        ) : undefined
      }
      endContent={
        <Switch
          label={`在新建标签页菜单中提供 ${agent.name}`}
          isLabelHidden
          size="sm"
          value={setting.enabled}
          onChange={(enabled) => update(agent.id, { enabled })}
        />
      }
      className={SETTINGS_ROW_PADDING}
    />
  );
}
