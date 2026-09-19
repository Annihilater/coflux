import type {
  DesktopExecutorCustomProvider,
  DesktopExecutorInbound,
  DesktopExecutorSaveInput,
  DesktopNotification,
} from "../shared/desktop-bridge";

// 渲染层 IPC 载荷的校验（纯函数，不 import electron，供 ipc.ts 与单测共用）。

const MAX_ID = 128;
const MAX_TITLE = 200;
const MAX_BODY = 1000;
/** 中心签发的会话 token 是短字符串；超长视为形状不对，丢弃而不是截断（截断会存下一个永远无效的 token）。 */
const MAX_TOKEN = 4096;

/** 渲染层来的载荷只当数据：字段类型与长度都校验，超长截断，形状不对丢弃。 */
export function sanitizeNotification(payload: unknown): DesktopNotification | null {
  if (!payload || typeof payload !== "object") return null;
  const { workspaceId, title, body, notificationId, taskId } = payload as Record<string, unknown>;
  if (typeof workspaceId !== "string" || typeof title !== "string" || typeof body !== "string") return null;
  if (!workspaceId || !title) return null;
  if (notificationId !== undefined && (typeof notificationId !== "string" || !notificationId || notificationId.length > MAX_ID)) return null;
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId || taskId.length > MAX_ID)) return null;
  return { workspaceId: workspaceId.slice(0, MAX_ID), title: title.slice(0, MAX_TITLE), body: body.slice(0, MAX_BODY),
    ...(typeof notificationId === "string" ? { notificationId } : {}), ...(typeof taskId === "string" ? { taskId } : {}) };
}

export function sanitizeBadgeCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isFinite(payload)) return null;
  return Math.min(999, Math.max(0, Math.floor(payload)));
}

/** OSC 52 写剪贴板的文本：源头是远端机器上跑的任意程序，按"只当数据"处理。
 * 渲染层已经在**编码后**的 base64 上拦过一道（osc52-clipboard.ts），这里再按**解码后**的
 * 字符数独立拦一道——两道闸各管一头。超限一律丢弃：半截的剪贴板内容比不复制更糟。
 * 内容本身不清洗（换行、制表、首尾空格都要逐字节还原），只管形状与大小。 */
const MAX_CLIPBOARD_TEXT = 768 * 1024;

export function sanitizeClipboardText(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  if (payload.length === 0 || payload.length > MAX_CLIPBOARD_TEXT) return null;
  return payload;
}

/** 会话 token：非空、不超长、不含控制字符/空白的字符串才落盘。 */
export function sanitizeSessionToken(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  if (payload.length === 0 || payload.length > MAX_TOKEN) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(payload)) return null;
  return payload;
}

// ===== executor（plan 116）=====
//
// 这批载荷的源头是 daemon 经 device 通道推来的帧，由渲染层转进主进程。渲染层是同一个 app 因而可信，
// 但帧的内容不是我们自己造的，照样按「只当数据」处理：类型不对丢弃，超长截断。
// 唯一不能截断的是 runId——截出来的是一个指向别处的合法 id，比丢弃更危险。

const MAX_RUN_ID = 128;
const MAX_PROMPT = 64 * 1024;
const MAX_PATH = 4096;
const MAX_REASON = 2000;
const MAX_PROVIDER = 64;
const MAX_MODEL_ID = 200;
/** 各家 provider 的 key 长度不一，给个宽上限；超了视为形状不对 */
const MAX_API_KEY = 4096;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return value;
}

export function sanitizeExecutorInbound(payload: unknown): DesktopExecutorInbound | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  switch (record.kind) {
    case "assign": {
      const runId = boundedString(record.runId, MAX_RUN_ID);
      const workspaceRoot = boundedString(record.workspaceRoot, MAX_PATH);
      const workspaceId = boundedString(record.workspaceId, MAX_ID);
      if (!runId || !workspaceRoot || !workspaceId) return null;
      if (typeof record.prompt !== "string" || record.prompt.length === 0) return null;
      // 必须是绝对路径：相对路径会被解析到主进程的 cwd 上，那是 app 的目录而不是用户的仓库
      if (!workspaceRoot.startsWith("/")) return null;
      return {
        kind: "assign",
        runId,
        prompt: record.prompt.slice(0, MAX_PROMPT),
        write: record.write === true,
        workspaceId,
        workspaceRoot,
        submittedAt: typeof record.submittedAt === "number" && Number.isFinite(record.submittedAt) ? record.submittedAt : 0,
      };
    }
    case "cancel":
    case "ack": {
      const runId = boundedString(record.runId, MAX_RUN_ID);
      return runId ? { kind: record.kind, runId } : null;
    }
    case "registered": {
      const ids = Array.isArray(record.reconcileRunIds) ? record.reconcileRunIds : [];
      return {
        kind: "registered",
        ok: record.ok === true,
        error: typeof record.error === "string" ? record.error.slice(0, MAX_REASON) : undefined,
        reconcileRunIds: ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_RUN_ID),
      };
    }
    default:
      return null;
  }
}

const MAX_NAME = 256;
const MAX_URL = 2048;
const MAX_CUSTOM_PROVIDERS = 16;
const MAX_CUSTOM_MODELS = 64;

/** 本版暴露的四种 API 形态；名单外的一律丢弃，不放行任意字符串给 pi 当 api 名。 */
const ALLOWED_CUSTOM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

function optionalKey(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  // 空串是有意义的取值（清除），所以这里不能用 boundedString。
  if (typeof value !== "string" || value.length > MAX_API_KEY) return { ok: false };
  return { ok: true, value };
}

function sanitizeCustomProvider(payload: unknown): (DesktopExecutorCustomProvider & { apiKey?: string }) | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const id = boundedString(record.id, MAX_PROVIDER);
  if (!id) return null;
  if (typeof record.api !== "string" || !ALLOWED_CUSTOM_APIS.has(record.api)) return null;
  if (typeof record.baseUrl !== "string" || record.baseUrl.length > MAX_URL) return null;
  if (typeof record.name !== "string" || record.name.length > MAX_NAME) return null;
  const rawModels = Array.isArray(record.models) ? record.models.slice(0, MAX_CUSTOM_MODELS) : [];
  const models: { id: string; name: string }[] = [];
  for (const model of rawModels) {
    if (!model || typeof model !== "object") return null;
    const entry = model as Record<string, unknown>;
    const modelId = boundedString(entry.id, MAX_MODEL_ID);
    if (!modelId) return null;
    if (entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length > MAX_NAME)) return null;
    models.push({ id: modelId, name: typeof entry.name === "string" ? entry.name : modelId });
  }
  const apiKey = optionalKey(record.apiKey);
  if (!apiKey.ok) return null;
  return {
    id,
    name: record.name || id,
    baseUrl: record.baseUrl,
    api: record.api,
    models,
    authHeader: record.authHeader === true,
    keyless: record.keyless === true,
    ...(apiKey.value === undefined ? {} : { apiKey: apiKey.value }),
  };
}

/**
 * 一次保存。provider/modelId 空串合法（等于清空选择）；`apiKey` 缺席表示不改动，空串表示清除——
 * 两者必须区分开，否则「不填 key 直接保存」会把已存的 key 抹掉。
 */
export function sanitizeExecutorSave(payload: unknown): DesktopExecutorSaveInput | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const { provider, modelId } = record;
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  if (provider.length > MAX_PROVIDER || modelId.length > MAX_MODEL_ID) return null;
  const apiKey = optionalKey(record.apiKey);
  if (!apiKey.ok) return null;
  const rawProviders = Array.isArray(record.customProviders) ? record.customProviders : [];
  if (rawProviders.length > MAX_CUSTOM_PROVIDERS) return null;
  const customProviders: (DesktopExecutorCustomProvider & { apiKey?: string })[] = [];
  for (const item of rawProviders) {
    const sanitized = sanitizeCustomProvider(item);
    if (!sanitized) return null;
    customProviders.push(sanitized);
  }
  return { provider, modelId, customProviders, ...(apiKey.value === undefined ? {} : { apiKey: apiKey.value }) };
}

/** device 通道的宣告：daemonId 为空串表示断开；generation 标识这一次连接。 */
export function sanitizeExecutorChannel(payload: unknown): { daemonId: string; generation: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.daemonId !== "string" || record.daemonId.length > MAX_ID) return null;
  const generation = record.generation;
  if (typeof generation !== "number" || !Number.isFinite(generation) || generation < 0) return null;
  return { daemonId: record.daemonId, generation: Math.floor(generation) };
}
