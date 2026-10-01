import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import { HStack, VStack } from "@astryxdesign/core/Layout";
import { ListItem } from "@astryxdesign/core/List";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import type { CofluxClient } from "@coflux/client";

import { AgentLogo } from "@/components/settings/agent-logos";
import {
  AGENT_CATALOG,
  agentSettingsFromAccount,
  launchCommandOf,
  sanitizeAgentCommand,
  type AgentDefinition,
  type AgentSetting,
} from "@/components/settings/agent-settings";
import { useAgentSettings } from "@/components/settings/agent-settings-store";
import { SETTINGS_ROW_PADDING, SettingsGroup } from "@/components/settings/settings-group";

/** The command is written after this pause in typing (or on blur), not on every keystroke. */
const COMMAND_WRITE_DELAY_MS = 400;

const OFFLINE_HINT = "配置存在账号上，离线时可以照常使用，但改不了";
const OUTDATED_HINT = "服务器版本较旧，还不能把 agent 配置存到账号上；升级服务器后才能修改";
const SYNCING_HINT = "正在读取账号里的配置…";
const DROPPED_EDIT = "与服务器的连接已断开，修改没有保存";

/**
 * Settings → 「Agents」 (plans 20261001-desktop-agents, 20261002-account-agent-settings): one card,
 * one row per catalog agent in the fixed order — logo, name, switch. Everything is off by default.
 * Switching one on reveals its 「启动命令」 input, empty with the default command as placeholder only;
 * the agent is offered in the new-tab menu once the command is filled in. Switching off keeps the
 * typed command for next time.
 *
 * The configuration is the account's: every change is written to the center at once (no save
 * button) and reaches every other online desktop of the account. Editing needs the center — the
 * section is read-only offline, against a center that does not store agent settings, and until this
 * connection's configuration has arrived (an edit based on a stale value would be broadcast as the
 * truth). A failed write shows a toast and the row shows the account's value again; it never goes
 * through the client's lastError, which would stop every terminal mid-attach.
 */
export function AgentsSection({ client }: { client: CofluxClient }) {
  const online = useStore(client.store, (state) => state.status === "connected");
  const supported = useStore(client.store, (state) => state.agentSettingsSupported);
  const received = useStore(client.store, (state) => state.agentSettingsReceived);
  const settings = useAgentSettings(client);
  const showToast = useToast();
  const disabledReason = !online ? OFFLINE_HINT : !supported ? OUTDATED_HINT : !received ? SYNCING_HINT : undefined;
  const editable = disabledReason === undefined;
  const reportError = (message: string) => showToast({ body: message, type: "error" });
  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="新建标签页菜单">
        {AGENT_CATALOG.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            setting={settings[agent.id]}
            client={client}
            editable={editable}
            disabledReason={disabledReason}
            onError={reportError}
          />
        ))}
      </SettingsGroup>
      {disabledReason ? (
        <HStack gap={2} vAlign="center">
          <StatusDot variant="warning" label="注意" />
          <Text type="supporting">{disabledReason}</Text>
        </HStack>
      ) : null}
      <Text type="supporting">
        选中 agent 会在新终端里输入这里的启动命令，和自己敲一样；命令不存在或远程设备没装时，报错就显示在那个终端里。
      </Text>
    </VStack>
  );
}

/**
 * One agent. `setting` is the account's value. Two local overlays sit on top of it, so this
 * desktop's own writes never fight the input:
 * - the switch shows the value it was just set to until that write settles (then the account's,
 *   which is the same value on success and the old one on failure);
 * - the command input keeps a draft from the first keystroke while it has focus or while its write
 *   is pending. Broadcasts — the echo of its own write included — do not overwrite the draft; it
 *   gives way to the account value on blur once nothing is pending, and whenever a write fails.
 * A pending command write is flushed on blur and on unmount, and dropped (not queued) when editing
 * stops being possible: the connection left, or the account changed.
 */
function AgentRow({
  agent,
  setting,
  client,
  editable,
  disabledReason,
  onError,
}: {
  agent: AgentDefinition;
  setting: AgentSetting;
  client: CofluxClient;
  editable: boolean;
  disabledReason: string | undefined;
  onError: (message: string) => void;
}) {
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // Mirrors of the overlays for the write callbacks, which outlive the render that started them.
  const pendingEnabledRef = useRef<boolean | null>(null);
  const draftRef = useRef<string | null>(null);
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped by every write of the command / the switch: only the latest one's result moves its overlay. */
  const commandSeqRef = useRef(0);
  const switchSeqRef = useRef(0);
  const commandWritesInFlightRef = useRef(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  function updateDraft(value: string | null) {
    draftRef.current = value;
    setDraft(value);
  }
  function updatePendingEnabled(value: boolean | null) {
    pendingEnabledRef.current = value;
    setPendingEnabled(value);
  }
  /** The account's value now (the props may be a render behind inside a callback). */
  function accountSetting(): AgentSetting {
    return agentSettingsFromAccount(client.store.getState().agentSettings)[agent.id];
  }
  function write(next: AgentSetting): Promise<boolean> {
    return client.setAgentSetting(agent.id, next).then((result) => {
      if (!result.ok) onErrorRef.current(result.error);
      return result.ok;
    });
  }
  function takeTimer(): boolean {
    if (timerRef.current === undefined) return false;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    return true;
  }

  /** Sends the draft typed since the last write. */
  function flushCommand() {
    takeTimer();
    const command = draftRef.current;
    if (command === null) return;
    const seq = ++commandSeqRef.current;
    commandWritesInFlightRef.current += 1;
    void write({ enabled: pendingEnabledRef.current ?? accountSetting().enabled, command }).then((ok) => settleCommandWrite(seq, ok));
  }

  /** A write carrying the draft settled. Only the latest one moves the draft: on failure the field
   * shows the account's value again (typing still waiting for its pause goes with it); on success
   * the draft stays while the input is focused or more typing is waiting, so the echo never lands
   * under the caret. */
  function settleCommandWrite(seq: number, ok: boolean) {
    commandWritesInFlightRef.current -= 1;
    if (seq !== commandSeqRef.current) return;
    if (!ok) {
      takeTimer();
      updateDraft(null);
      return;
    }
    if (!focusedRef.current && timerRef.current === undefined) updateDraft(null);
  }

  function changeCommand(text: string) {
    if (!editable) return;
    updateDraft(sanitizeAgentCommand(text));
    takeTimer();
    timerRef.current = setTimeout(flushCommand, COMMAND_WRITE_DELAY_MS);
  }

  function blurCommand() {
    focusedRef.current = false;
    if (timerRef.current !== undefined) flushCommand();
    else if (commandWritesInFlightRef.current === 0) updateDraft(null);
  }

  function changeEnabled(enabled: boolean) {
    if (!editable) return;
    // The switch's write carries the command as shown, so typing still waiting for its pause goes with it.
    const carriesDraft = takeTimer();
    const command = draftRef.current ?? accountSetting().command;
    updatePendingEnabled(enabled);
    const seq = ++switchSeqRef.current;
    const commandSeq = carriesDraft ? ++commandSeqRef.current : null;
    if (carriesDraft) commandWritesInFlightRef.current += 1;
    void write({ enabled, command }).then((ok) => {
      if (seq === switchSeqRef.current) updatePendingEnabled(null);
      if (commandSeq !== null) settleCommandWrite(commandSeq, ok);
    });
  }

  // Editing stopped being possible (offline, account changed, a reconnect not yet synced): drop what
  // was not sent, show the account's value, and let writes still in flight settle without touching
  // the fields (their failure is still reported).
  useEffect(() => {
    if (editable) return;
    if (takeTimer()) onErrorRef.current(DROPPED_EDIT);
    // A disabled input does not reliably report its blur; it gets a fresh focus when editable again.
    focusedRef.current = false;
    commandSeqRef.current += 1;
    switchSeqRef.current += 1;
    draftRef.current = null;
    pendingEnabledRef.current = null;
    setDraft(null);
    setPendingEnabled(null);
  }, [editable]);

  // Leaving the section with typing still waiting for its pause sends it (the client refuses it if
  // the connection is gone by then).
  const flushOnUnmountRef = useRef(flushCommand);
  useEffect(() => {
    flushOnUnmountRef.current = flushCommand;
  });
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) flushOnUnmountRef.current();
    },
    [],
  );

  const enabled = pendingEnabled ?? setting.enabled;
  const command = draft ?? setting.command;
  const waitingForCommand = enabled && launchCommandOf({ enabled, command }) === null;
  return (
    <ListItem
      label={agent.name}
      startContent={<AgentLogo agent={agent.id} className="size-5" />}
      // The command input lives in the description slot so the row stays one list item (one
      // divider) whether or not it is expanded. The row has no onClick, so nothing competes with it.
      description={
        enabled ? (
          <VStack gap={1.5} hAlign="stretch" className="pt-2">
            <TextInput
              label="启动命令"
              size="sm"
              value={command}
              onChange={changeCommand}
              onFocus={() => {
                focusedRef.current = true;
              }}
              onBlur={blurCommand}
              placeholder={agent.placeholderCommand}
              autoComplete="off"
              width="100%"
              isDisabled={!editable}
              disabledMessage={disabledReason}
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
          value={enabled}
          onChange={changeEnabled}
          isDisabled={!editable}
          disabledMessage={disabledReason}
        />
      }
      className={SETTINGS_ROW_PADDING}
    />
  );
}
