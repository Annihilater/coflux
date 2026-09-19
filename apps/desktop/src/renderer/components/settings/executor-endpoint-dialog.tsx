import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";

import type { DesktopExecutorCustomProvider } from "@/desktop-bridge";

/** 本版暴露的四种 API 形态。pi 的 KnownApi 共十种，其余不暴露——它们要么需要更多配置项
 * （Bedrock 的区域与签名、Vertex 的项目），要么本就是某一家的专用通道。 */
const API_OPTIONS = [
  { value: "openai-completions", label: "OpenAI 兼容（chat/completions）" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

export type ExecutorEndpointDraft = DesktopExecutorCustomProvider & { apiKey?: string };

type Props = {
  open: boolean;
  /** null = 新增；否则编辑这一个 */
  editing: DesktopExecutorCustomProvider | null;
  /** 已存在的 id，用来挡重名；编辑时不含自己 */
  takenIds: string[];
  /** 该端点是否已有凭据（只知道有没有，没有值） */
  hasApiKey: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: ExecutorEndpointDraft) => void;
  onRemove?: () => void;
};

/**
 * 自定义端点的增删改。
 *
 * 一个端点对 pi 来说就是一个 provider，所以存下来之后它直接出现在上面的 provider 下拉里，不做并列的
 * 第二套选择——分两处选会让「我在用哪个」变模糊。
 *
 * 模型 id 手填，一行一个：中转站没有统一的模型清单接口，能问出来的那部分也未必准。手填的模型没有真实
 * 规格，所以设置页对它们一律显示「未知」，不把我们自己编的占位值当事实展示。
 */
export function ExecutorEndpointDialog(props: Props) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authHeader, setAuthHeader] = useState(false);
  const [keyless, setKeyless] = useState(false);

  // 每次打开都从入参重建：对话框是长期挂载的，不重建会把上一次编辑的残留带进新增。
  useEffect(() => {
    if (!props.open) return;
    const editing = props.editing;
    setId(editing?.id ?? "");
    setName(editing?.name ?? "");
    setBaseUrl(editing?.baseUrl ?? "");
    setApi(editing?.api ?? "openai-completions");
    setModels((editing?.models ?? []).map((model) => model.id).join("\n"));
    setApiKey("");
    setAuthHeader(editing?.authHeader ?? false);
    setKeyless(editing?.keyless ?? false);
  }, [props.open, props.editing]);

  const trimmedId = id.trim();
  const modelIds = models
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const duplicate = props.takenIds.includes(trimmedId);
  const error = !trimmedId
    ? "给这个端点起一个 id"
    : !/^[a-z0-9][a-z0-9-]*$/.test(trimmedId)
      ? "id 只能用小写字母、数字与连字符，且以字母或数字开头"
      : duplicate
        ? "已经有一个同 id 的端点了"
        : !baseUrl.trim()
          ? "填上这个端点的 base URL"
          : modelIds.length === 0
            ? "至少填一个模型 id"
            : "";

  function save() {
    if (error) return;
    props.onSave({
      id: trimmedId,
      name: name.trim() || trimmedId,
      baseUrl: baseUrl.trim(),
      api,
      models: modelIds.map((modelId) => ({ id: modelId, name: modelId })),
      authHeader,
      keyless,
      // 留空 = 不改动已存的 key；keyless 端点不需要 key，桌面会自己补占位凭据。
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    props.onOpenChange(false);
  }

  return (
    <Dialog isOpen={props.open} onOpenChange={props.onOpenChange} purpose="form" width={520} padding={0}>
      <DialogHeader title={props.editing ? "编辑端点" : "添加端点"} onOpenChange={props.onOpenChange} />
      <VStack gap={3} hAlign="stretch" padding={4}>
        <HStack gap={3} vAlign="start">
          <TextInput
            label="id"
            value={id}
            onChange={setId}
            placeholder="my-relay"
            isDisabled={!!props.editing}
            description={props.editing ? "已创建的端点不改 id" : "选模型时按它标识这个端点"}
            width="100%"
          />
          <TextInput label="名称" value={name} onChange={setName} placeholder="My relay" width="100%" />
        </HStack>
        <TextInput label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" width="100%" />
        <Selector label="API 形态" options={API_OPTIONS} value={api} onChange={(next) => setApi(next || "openai-completions")} width="100%" />
        <TextArea
          label="模型 id"
          value={models}
          onChange={setModels}
          placeholder={"gpt-4o\nclaude-sonnet-4"}
          description="一行一个。中转站没有统一的模型清单接口，所以这里手填；手填的模型不显示上下文窗口与价格。"
          rows={4}
        />
        <TextInput
          label="API key"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          isDisabled={keyless}
          placeholder={keyless ? "这个端点不需要 key" : props.hasApiKey ? "已保存（留空则不改动）" : "粘贴 API key"}
        />
        <Collapsible trigger="高级" defaultIsOpen={false}>
          <VStack gap={3} hAlign="stretch" padding={2}>
            <Switch
              label="额外带 Authorization 头"
              description="少数中转站除了 API key 还要一个显式的 Authorization 头才认。不确定就别开。"
              value={authHeader}
              onChange={setAuthHeader}
              labelPosition="start"
              labelSpacing="spread"
            />
            <Switch
              label="这个端点不需要 key"
              description="Ollama 这类本机服务用。开了之后桌面会自己补一个占位凭据，你不必填。"
              value={keyless}
              onChange={setKeyless}
              labelPosition="start"
              labelSpacing="spread"
            />
          </VStack>
        </Collapsible>
        {error ? (
          <HStack gap={2} vAlign="center">
            <StatusDot variant="warning" label="还差一项" />
            <Text type="supporting">{error}</Text>
          </HStack>
        ) : null}
        <HStack gap={2} vAlign="center" hAlign="end">
          {props.onRemove ? <Button label="删除" variant="ghost" size="sm" onClick={() => { props.onRemove?.(); props.onOpenChange(false); }} /> : null}
          <Button label="取消" variant="ghost" size="sm" onClick={() => props.onOpenChange(false)} />
          <Button label="保存端点" variant="primary" size="sm" isDisabled={!!error} onClick={save} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
