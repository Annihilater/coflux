import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { CofluxClient } from "@coflux/client";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";

import { SETTINGS_ROW_PADDING, SettingsGroup, SettingsRow } from "@/components/settings/settings-group";
import { ExecutorEndpointDialog, type ExecutorEndpointDraft } from "@/components/settings/executor-endpoint-dialog";
import {
  describeModelSpec,
  searchModelOptions,
  type ExecutorModelChoice,
} from "@/components/settings/executor-model-search";
import type {
  DesktopBridge,
  DesktopExecutorCatalog,
  DesktopExecutorCustomProvider,
  DesktopExecutorModelOption,
  DesktopExecutorSettings,
} from "@/desktop-bridge";

/**
 * 设置页的 Executor 分区。
 *
 * **配置跟账号走，不跟机器走**：真相源在中心，本机读的是 daemon 落下来的缓存。所以这一页有两条
 * 明确的行为：读永远可用（断网也看得见、executor 也照常能发任务），改必须在线且会同步到账号下所有
 * 设备。离线时修改控件置灰并说明原因，而不是让保存按下去之后失败。
 *
 * **凭据是只写的**：主进程从不把 key 交给渲染层，这里只知道「哪些 provider 配过」。所以已有 key 时
 * 输入框仍然留空、占位文案写明留空不改动，清除要单独按按钮——这比画一排假圆点诚实：用户把假值当成
 * 自己的 key，一次误覆盖就找不回来了。
 *
 * **保存与测试连接是两个动作**：保存只做不花钱的校验（provider 存在、模型存在、凭据形式正确），
 * 测试连接才真发一次最小请求并回报 token 数与延迟。
 */
export function ExecutorSection({ bridge, client }: { bridge: DesktopBridge; client: CofluxClient }) {
  // 改配置必须够得着中心：读走本机缓存，写只能联网。控件据此置灰并说明原因，而不是让保存按下去才失败。
  const online = useStore(client.store, (state) => state.status === "connected");
  const [settings, setSettings] = useState<DesktopExecutorSettings | null>(null);
  const [catalog, setCatalog] = useState<DesktopExecutorCatalog | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState<ExecutorModelChoice | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [customProviders, setCustomProviders] = useState<DesktopExecutorCustomProvider[]>([]);
  /** 端点的待存凭据：id -> key。只在这一次保存里有意义，保存完清空。 */
  const [endpointKeys, setEndpointKeys] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<{ open: boolean; editing: DesktopExecutorCustomProvider | null }>({ open: false, editing: null });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ kind: "ok" | "error"; text: string; warning?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /** 把一份配置装进表单。凭据永远不在里面，所以输入框一律回到空。 */
  const adopt = useCallback((next: DesktopExecutorSettings) => {
    setSettings(next);
    setProvider(next.provider);
    setCustomProviders(next.customProviders);
    setApiKey("");
    setEndpointKeys({});
  }, []);

  useEffect(() => {
    let alive = true;
    void bridge.getExecutorSettings().then((next) => {
      if (alive) adopt(next);
    });
    return () => {
      alive = false;
    };
  }, [bridge, adopt]);

  // 配置也可能从别的设备改过来：daemon 把新版本落到本机，主进程就推一次。
  useEffect(() => bridge.onExecutorSettings(adopt), [bridge, adopt]);

  useEffect(() => {
    let alive = true;
    void bridge.getExecutorCatalog().then((next) => {
      if (alive) setCatalog(next);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const models = catalog?.models ?? [];

  // 已保存的那个模型要显示出来，但它只有在目录里能找到时才算数——找不到说明 provider 被删了或
  // 模型下架了，这时候留空比显示一个选不中的名字诚实。
  useEffect(() => {
    if (!settings || models.length === 0) return;
    const found = models.find((entry) => entry.provider === settings.provider && entry.id === settings.modelId);
    setModel(found ? toChoice(found) : null);
  }, [settings, models]);

  const providerOptions = useMemo(() => {
    const options = (catalog?.providers ?? []).map((entry) => ({
      value: entry.id,
      label: entry.custom ? `${entry.name}（自定义）` : entry.name,
      description: entry.id,
    }));
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }, [catalog]);

  // 模型搜索是跨 provider 的：输 sonnet 直接出 anthropic/claude-sonnet-5，不必先选家。
  // openrouter 一家就有三百多个模型，纯下拉翻不动，所以这是主路径而不是便利功能。
  const searchSource = useMemo(
    () => ({
      search: (query: string) => searchModelOptions(models, query, provider),
      bootstrap: () => searchModelOptions(models, "", provider),
    }),
    [models, provider],
  );

  const selectedProvider = catalog?.providers.find((entry) => entry.id === provider);
  const keyless = selectedProvider?.keyless === true;
  const hasKey = settings?.credentialProviders.includes(provider) === true;
  const ready = settings?.ready === true;
  const catalogError = catalog && !catalog.ready ? catalog.error : "";
  // 目录起不来时连校验都做不了，保存只会失败得更晚；离线则是中心够不着。
  const editingDisabled = !online || !!catalogError || saving;
  const disabledReason = !online
    ? "executor 配置存在账号上，离线时可以照常使用，但改不了"
    : catalogError
      ? `模型运行时不可用：${catalogError}`
      : undefined;

  async function save(nextProviders?: DesktopExecutorCustomProvider[], nextKeys?: Record<string, string>) {
    const providers = nextProviders ?? customProviders;
    const keys = nextKeys ?? endpointKeys;
    setSaving(true);
    setSaveResult(null);
    setTestResult(null);
    try {
      const result = await bridge.saveExecutorSettings({
        provider,
        modelId: model?.auxiliaryData.id ?? "",
        // 留空表示别动已存的 key；keyless 端点根本不需要。
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        customProviders: providers.map((entry) => ({
          ...entry,
          ...(keys[entry.id] ? { apiKey: keys[entry.id] } : {}),
        })),
      });
      if (!result.ok) {
        setSaveResult({ kind: "error", text: result.error ?? "保存失败" });
        return;
      }
      setApiKey("");
      setEndpointKeys({});
      setSaveResult({ kind: "ok", text: result.validated ?? "已保存", warning: result.warning });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await bridge.testExecutorConnection();
      setTestResult(
        result.ok
          ? { kind: "ok", text: `已联通：${result.tokens ?? 0} token · ${result.ms ?? 0}ms` }
          : { kind: "error", text: result.error ?? "连接失败" },
      );
    } finally {
      setTesting(false);
    }
  }

  function upsertEndpoint(draft: ExecutorEndpointDraft) {
    const { apiKey: draftKey, ...definition } = draft;
    const next = customProviders.some((entry) => entry.id === definition.id)
      ? customProviders.map((entry) => (entry.id === definition.id ? definition : entry))
      : [...customProviders, definition];
    const keys = draftKey ? { ...endpointKeys, [definition.id]: draftKey } : endpointKeys;
    setCustomProviders(next);
    setEndpointKeys(keys);
    // 端点改完立刻保存：它是一条独立的配置，让用户再去按一次上面的「保存」很容易被理解成没生效。
    void save(next, keys);
  }

  function removeEndpoint(id: string) {
    const next = customProviders.filter((entry) => entry.id !== id);
    const keys = { ...endpointKeys };
    delete keys[id];
    setCustomProviders(next);
    setEndpointKeys(keys);
    void save(next, keys);
  }

  return (
    <VStack gap={5} hAlign="stretch">
      <SettingsGroup title="状态">
        <SettingsRow
          label={ready ? "已就绪" : "未就绪"}
          description={ready ? "agent 现在可以发起任务" : (settings?.reason ?? "正在读取配置…")}
          control={<StatusDot variant={ready ? "success" : "warning"} label={ready ? "已就绪" : "未就绪"} />}
        />
        <SettingsRow
          label="怎么用"
          description={
            <>
              你的 agent 在终端里用 <Text type="code">coflux executor run</Text> 发起。executor 只能改发起它的那个工作区里的文件，不会提交，执行命令时也没有网络。
            </>
          }
        />
        <SettingsRow
          label="生效范围"
          description="这份配置存在账号上，对账号下所有设备生效。换机器、重装应用之后它还在；离线时能看能用，改不了。"
        />
      </SettingsGroup>

      <VStack gap={1.5} hAlign="stretch">
        <Text type="label" color="secondary">模型</Text>
        <Card variant="muted" width="100%">
          <VStack gap={3} hAlign="stretch">
            <Selector
              label="Provider"
              options={providerOptions}
              value={provider}
              onChange={(next) => {
                setProvider(next || "");
                setModel(null);
              }}
              hasSearch
              searchPlaceholder="搜 provider…"
              placeholder={catalog ? "选一个 provider" : "正在读取模型目录…"}
              isDisabled={editingDisabled}
              disabledMessage={disabledReason}
              isLoading={!catalog}
              width="100%"
            />
            <Typeahead<ExecutorModelChoice>
              label="模型"
              searchSource={searchSource}
              value={model}
              onChange={setModel}
              hasEntriesOnFocus
              maxMenuItems={12}
              minQueryLength={0}
              debounceMs={0}
              placeholder="搜模型，例如 sonnet；可以跨 provider 搜"
              isDisabled={editingDisabled}
              disabledMessage={disabledReason}
              renderItem={(item) => (
                <TypeaheadItem item={item} description={`${item.auxiliaryData.providerName} · ${describeModelSpec(item.auxiliaryData)}`} />
              )}
              width="100%"
            />
            {model ? <Text type="supporting">{describeModelSpec(model.auxiliaryData)}</Text> : null}

            <TextInput
              label="API key"
              type="password"
              value={apiKey}
              onChange={setApiKey}
              isDisabled={editingDisabled || keyless}
              disabledMessage={keyless ? "这个端点不需要 key" : disabledReason}
              placeholder={keyless ? "这个端点不需要 key" : hasKey ? "已保存（留空则不改动）" : "粘贴 API key"}
            />
            <Text type="supporting">key 加密保存在账号里，下发到你的设备后只在本机使用；不会传给 executor 执行的命令，也不会回显。</Text>

            <HStack gap={2} vAlign="center">
              <Button label="保存" variant="primary" size="sm" isDisabled={editingDisabled} isLoading={saving} onClick={() => void save()} />
              <Button
                label="测试连接"
                variant="secondary"
                size="sm"
                isDisabled={!ready || testing || !online}
                isLoading={testing}
                onClick={() => void test()}
              />
              {hasKey && !keyless ? (
                <Button
                  label="清除 key"
                  variant="ghost"
                  size="sm"
                  isDisabled={editingDisabled}
                  onClick={() => {
                    setApiKey("");
                    void bridge
                      .saveExecutorSettings({ provider, modelId: model?.auxiliaryData.id ?? "", apiKey: "", customProviders })
                      .then((result) =>
                        setSaveResult(result.ok ? { kind: "ok", text: "已清除这个 provider 的 key" } : { kind: "error", text: result.error ?? "清除失败" }),
                      );
                  }}
                />
              ) : null}
            </HStack>

            {/* 保存与测试连接各有自己的一行结果：一个是不花钱的校验，一个是真发过一次请求。 */}
            {saveResult ? <FeedbackLine variant={saveResult.kind === "ok" ? "success" : "error"} text={saveResult.text} /> : null}
            {saveResult?.warning ? <FeedbackLine variant="warning" text={saveResult.warning} /> : null}
            {testResult ? <FeedbackLine variant={testResult.kind === "ok" ? "success" : "error"} text={testResult.text} /> : null}
            {settings?.credentialError ? <FeedbackLine variant="error" text={settings.credentialError} /> : null}
            {disabledReason ? <FeedbackLine variant="warning" text={disabledReason} /> : null}
          </VStack>
        </Card>
      </VStack>

      <VStack gap={1.5} hAlign="stretch">
        <Text type="label" color="secondary">自定义端点</Text>
        <Card padding={0} variant="muted" width="100%">
          <List hasDividers density="balanced">
            {customProviders.map((entry) => (
              <ListItem
                key={entry.id}
                label={entry.name || entry.id}
                description={`${entry.baseUrl || "未填 base URL"} · ${entry.api}${entry.keyless ? " · 无需 key" : ""}`}
                endContent={
                  <Button
                    label="编辑"
                    variant="ghost"
                    size="sm"
                    isDisabled={editingDisabled}
                    onClick={() => setDialog({ open: true, editing: entry })}
                  />
                }
                className={SETTINGS_ROW_PADDING}
              />
            ))}
            <ListItem
              label="添加端点"
              description="中转站、Ollama，或任何 OpenAI / Anthropic / Google 兼容的端点。加完直接出现在上面的 provider 里。"
              endContent={
                <Button
                  label="+ 添加"
                  variant="secondary"
                  size="sm"
                  isDisabled={editingDisabled}
                  onClick={() => setDialog({ open: true, editing: null })}
                />
              }
              className={SETTINGS_ROW_PADDING}
            />
          </List>
        </Card>
      </VStack>

      <ExecutorEndpointDialog
        open={dialog.open}
        editing={dialog.editing}
        takenIds={customProviders.filter((entry) => entry.id !== dialog.editing?.id).map((entry) => entry.id)}
        hasApiKey={dialog.editing ? settings?.credentialProviders.includes(dialog.editing.id) === true : false}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSave={upsertEndpoint}
        onRemove={dialog.editing ? () => removeEndpoint(dialog.editing!.id) : undefined}
      />
    </VStack>
  );
}

/** 一行状态反馈。Text 的 color 只有语义中性的几档，状态色由 StatusDot 承担——它同时给出非颜色线索。 */
function FeedbackLine({ variant, text }: { variant: "success" | "warning" | "error"; text: string }) {
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={variant} label={variant === "success" ? "成功" : variant === "warning" ? "注意" : "失败"} />
      <Text type="supporting">{text}</Text>
    </HStack>
  );
}

function toChoice(option: DesktopExecutorModelOption): ExecutorModelChoice {
  return { id: `${option.provider}/${option.id}`, label: option.name, auxiliaryData: option };
}
