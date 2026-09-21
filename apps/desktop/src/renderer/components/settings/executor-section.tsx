import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { projectSavedSelection } from "@/components/settings/executor-endpoint-save";
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
 *
 * **这一页有两个保存面，语义是刻意不同的**：模型卡片（以及它的「清除 key」）提交表单里的东西；
 * 端点的增删改提交**账号里**的东西，只把端点这一部分换掉——加个端点不该顺手把上面没保存的
 * provider/模型/key 一起写进账号。见 `executor-endpoint-save.ts`。
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
  const [dialog, setDialog] = useState<{ open: boolean; editing: DesktopExecutorCustomProvider | null }>({ open: false, editing: null });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ kind: "ok" | "error"; text: string; warning?: string } | null>(null);
  /** 端点区自己的那行结果：端点保存失败要在端点那儿说，而不是在半屏之外的模型卡片底下。 */
  const [endpointResult, setEndpointResult] = useState<{ kind: "ok" | "error"; text: string; warning?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  /**
   * 上一次装进表单的账号选择。推送过来的配置只有在**账号自己的选择变了**的时候才动表单——
   * 一次端点保存的返回值和它引发的 settings 推送谁先到并没有保证，无条件覆盖会把刚加的端点的
   * 预选（以及用户手上还没保存的选择）悄悄抹掉。
   */
  const adoptedProvider = useRef<string | null>(null);
  const adoptedSelection = useRef<string | null>(null);

  /** 把一份配置装进表单。凭据永远不在里面，所以输入框一律回到空。 */
  const adopt = useCallback((next: DesktopExecutorSettings) => {
    setSettings(next);
    if (adoptedProvider.current !== next.provider) {
      adoptedProvider.current = next.provider;
      setProvider(next.provider);
    }
    setCustomProviders(next.customProviders);
    setApiKey("");
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

  // 目录跟着配置走，而不是只在挂载时读一次：刚存下的端点必须立刻出现在上面的 provider 下拉里，
  // 不能要求用户关掉设置页再打开。主进程每次配置变化都会推一份 settings，所以这一条同时覆盖
  // 「我刚加的端点」和「别的设备加的端点」两种来源。
  useEffect(() => {
    let alive = true;
    void bridge.getExecutorCatalog().then((next) => {
      if (alive) setCatalog(next);
    });
    return () => {
      alive = false;
    };
  }, [bridge, settings]);

  const models = catalog?.models ?? [];

  // 已保存的那个模型要显示出来，但它只有在目录里能找到时才算数——找不到说明 provider 被删了或
  // 模型下架了，这时候留空比显示一个选不中的名字诚实。
  // 只在**账号里的那对选择变了**时同步：端点保存也会推一次 settings，无条件重置会把用户刚挑好、
  // 还没按「保存」的模型抹掉。
  useEffect(() => {
    if (!settings || models.length === 0) return;
    const key = `${settings.provider}\u0000${settings.modelId}`;
    if (adoptedSelection.current === key) return;
    adoptedSelection.current = key;
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
  /** 模型卡片保存的前提：provider 与模型都选了。空选择存得进去，但那是端点保存的事，不是这个按钮的。 */
  const canSaveSelection = !!provider && !!model;
  const catalogError = catalog && !catalog.ready ? catalog.error : "";
  // 目录起不来时连校验都做不了，保存只会失败得更晚；离线则是中心够不着。
  const editingDisabled = !online || !!catalogError || saving;
  const disabledReason = !online
    ? "executor 配置存在账号上，离线时可以照常使用，但改不了"
    : catalogError
      ? `模型运行时不可用：${catalogError}`
      : undefined;

  /** 模型卡片的「保存」：提交表单里的 provider / 模型 / key。空选择在这一层就挡掉，不指望主进程报错。 */
  async function saveSelection() {
    if (!provider || !model) return;
    setSaving(true);
    setSaveResult(null);
    setEndpointResult(null);
    setTestResult(null);
    try {
      const result = await bridge.saveExecutorSettings({
        provider,
        modelId: model.auxiliaryData.id,
        // 留空表示别动已存的 key；keyless 端点根本不需要。
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        customProviders,
      });
      if (!result.ok) {
        setSaveResult({ kind: "error", text: result.error ?? "保存失败" });
        return;
      }
      setApiKey("");
      setSaveResult({ kind: "ok", text: result.validated ?? "已保存", warning: result.warning });
    } finally {
      setSaving(false);
    }
  }

  /**
   * 端点的增删改：立刻保存，但**只换端点这一部分**。
   *
   * provider / 模型提交的是账号现在存着的那对（按这次保存之后还解析得出来的部分投影，见
   * `projectSavedSelection`），顶上那个 key 输入框里没按过「保存」的东西一律不带。
   *
   * 失败就把列表回滚：留一行只存在于这一页、账号里没有的端点，比报错更难发现。这里只认 `ok === false`
   * ——下发没到位的那种成功带的是 warning，把它当失败回滚会把真存进去的端点从列表里抹掉。
   */
  async function saveEndpoints(
    next: DesktopExecutorCustomProvider[],
    rollback: () => void,
    success: string,
    draftKey?: { id: string; apiKey: string },
  ) {
    const selection = projectSavedSelection({
      saved: { provider: settings?.provider ?? "", modelId: settings?.modelId ?? "" },
      endpoints: next,
      catalog,
    });
    setSaving(true);
    setEndpointResult(null);
    // 端点一变，上面那两行讲的就是改之前的事了：留着会和端点这一行互相打架。
    setSaveResult(null);
    setTestResult(null);
    try {
      const result = await bridge.saveExecutorSettings({
        provider: selection.provider,
        modelId: selection.modelId,
        customProviders: next.map((entry) =>
          draftKey && entry.id === draftKey.id ? { ...entry, apiKey: draftKey.apiKey } : entry,
        ),
      });
      if (!result.ok) {
        rollback();
        setEndpointResult({ kind: "error", text: result.error ?? "保存失败" });
        return;
      }
      setEndpointResult({ kind: "ok", text: success, warning: result.warning });
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
    const previous = customProviders;
    const editing = previous.some((entry) => entry.id === definition.id);
    const next = editing
      ? previous.map((entry) => (entry.id === definition.id ? definition : entry))
      : [...previous, definition];
    setCustomProviders(next);
    // 还没选 provider 时，新加的端点替用户选上——他刚填完它，多半就是要用它。这是**纯 UI 选择**：
    // 账号里什么都没写，还得挑模型、按上面的「保存」。编辑已有端点不动当前选择。
    const preselect = !editing && !provider;
    if (preselect) setProvider(definition.id);
    // 端点改完立刻保存：它是一条独立的配置，让用户再去按一次上面的「保存」很容易被理解成没生效。
    void saveEndpoints(
      next,
      () => {
        setCustomProviders(previous);
        if (preselect) setProvider("");
      },
      editing ? "端点已更新到账号" : "端点已保存到账号",
      draftKey ? { id: definition.id, apiKey: draftKey } : undefined,
    );
  }

  function removeEndpoint(id: string) {
    const previous = customProviders;
    const next = previous.filter((entry) => entry.id !== id);
    setCustomProviders(next);
    void saveEndpoints(next, () => setCustomProviders(previous), "端点已删除");
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
              {/* 空选择在这里就按不动：它是合法的存储状态，但「按了保存却什么也没选」不是用户的意图。 */}
              <Button
                label="保存"
                variant="primary"
                size="sm"
                isDisabled={editingDisabled || !canSaveSelection}
                tooltip={!editingDisabled && !canSaveSelection ? "先选好 provider 与模型" : undefined}
                isLoading={saving}
                onClick={() => void saveSelection()}
              />
              <Button
                label="测试连接"
                variant="secondary"
                size="sm"
                isDisabled={!ready || testing || !online}
                isLoading={testing}
                onClick={() => void test()}
              />
              {/* 清除 key 故意留在表单这一侧：它清的是 input.provider 名下的凭据，而这个按钮出不出现
                  又是按**表单里**的 provider 判断的。换成账号里存的那个，就会清掉一个跟屏幕上显示的
                  不是同一家的 key。 */}
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
        {/* 端点的成败在端点这儿说：以前混进模型卡片那一行，在半屏之外，还写得像是模型卡片出了问题。 */}
        {endpointResult ? <FeedbackLine variant={endpointResult.kind === "ok" ? "success" : "error"} text={endpointResult.text} /> : null}
        {endpointResult?.warning ? <FeedbackLine variant="warning" text={endpointResult.warning} /> : null}
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
