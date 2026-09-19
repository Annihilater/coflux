/**
 * executor 模型配置的中心侧领域模型（plan 20260918-executor-settings-central）。
 *
 * 中心**只存不判断**：provider 是否存在、模型是否可用、凭据形式对不对，全部由桌面主进程的
 * `ModelRuntime` 判定——中心没有 pi，也不该有。这里只做与持久化直接相关的形状校验（长度、枚举、
 * 重复 id），以及凭据的合并与加解密。
 *
 * 自定义端点对 pi 来说就是一个 provider，所以它与内置 provider 走同一个 `provider` 字段，不另立
 * 「我在用内置还是自定义」的维度。
 */
import { randomUUID } from "node:crypto";

import type { ExecutorSecrets } from "./executor-secrets.js";
import { ExecutorSecretsUndecryptableError } from "./executor-secrets.js";

/** 本版向用户暴露的四种 API 形态。pi 的 `KnownApi` 共十种，其余不暴露。 */
export const EXECUTOR_CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type ExecutorCustomApi = (typeof EXECUTOR_CUSTOM_APIS)[number];

export const MAX_EXECUTOR_CUSTOM_PROVIDERS = 16;
export const MAX_EXECUTOR_CUSTOM_MODELS = 64;
export const MAX_EXECUTOR_CREDENTIAL_BYTES = 8 * 1024;

/** 自定义端点的定义。**不含任何凭据**——凭据统一走 credentials 那一路加密存。 */
export type ExecutorCustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  api: ExecutorCustomApi;
  models: { id: string; name: string }[];
  /** pi 的兼容开关：是否额外带 Authorization 头（中转站偶尔需要）。 */
  authHeader: boolean;
  /** Ollama 这类本机 keyless 服务：桌面会自动补一个占位凭据，否则 pi 认为模型不可用。 */
  keyless: boolean;
};

/** 一条凭据。本版只实现 api_key 分支，形状对齐 pi 的 `Credential` 联合类型，给 OAuth 留位。 */
export type ExecutorCredential = { providerId: string; type: "api_key"; apiKey: string };

export type ExecutorSettingsRecord = {
  accountId: string;
  deviceId: string | null;
  provider: string;
  modelId: string;
  customProviders: ExecutorCustomProvider[];
  credentialProviderIds: string[];
  credentialsCiphertext: string;
  revision: number;
  updatedAt: number;
};

/** 下发给 daemon 的形状：凭据已解密。`credentialError` 非空表示「配过但读不出来」。 */
export type ExecutorSettingsDelivery = {
  revision: number;
  provider: string;
  modelId: string;
  customProviders: ExecutorCustomProvider[];
  credentials: ExecutorCredential[];
  credentialError: string;
};

export type ExecutorSettingsPatch = {
  provider?: string;
  modelId?: string;
  customProviders?: ExecutorCustomProvider[];
  /** providerId -> key。空串 = 清除该 provider 的凭据；缺席 = 不改动。 */
  credentials?: Record<string, string>;
};

export const EMPTY_EXECUTOR_SETTINGS: ExecutorSettingsDelivery = {
  revision: 0,
  provider: "",
  modelId: "",
  customProviders: [],
  credentials: [],
  credentialError: "",
};

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 落库的 JSON 列读回来时按当前形状规整；坏数据按「没配」处理而不是让整条链路炸掉。 */
export function parseCustomProviders(raw: string): ExecutorCustomProvider[] {
  const out: ExecutorCustomProvider[] = [];
  for (const item of parseJsonArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const api = typeof record.api === "string" ? record.api : "";
    if (!id || !(EXECUTOR_CUSTOM_APIS as readonly string[]).includes(api)) continue;
    out.push({
      id,
      name: typeof record.name === "string" ? record.name : id,
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
      api: api as ExecutorCustomApi,
      models: Array.isArray(record.models)
        ? record.models
            .filter((model): model is Record<string, unknown> => !!model && typeof model === "object")
            .map((model) => ({
              id: typeof model.id === "string" ? model.id : "",
              name: typeof model.name === "string" && model.name ? model.name : typeof model.id === "string" ? model.id : "",
            }))
            .filter((model) => model.id.length > 0)
        : [],
      authHeader: record.authHeader === true,
      keyless: record.keyless === true,
    });
  }
  return out;
}

export function parseCredentialProviderIds(raw: string): string[] {
  return parseJsonArray(raw).filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** 凭据明文的落库形态：providerId -> Credential。加密后整块存一列。 */
export type CredentialMap = Record<string, { type: "api_key"; key: string }>;

function parseCredentialMap(plaintext: string): CredentialMap {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object") return {};
    const out: CredentialMap = {};
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (record.type !== "api_key" || typeof record.key !== "string" || !record.key) continue;
      out[providerId] = { type: "api_key", key: record.key };
    }
    return out;
  } catch {
    return {};
  }
}

export type CredentialDecryption = { map: CredentialMap; error: string };

/** 解密失败要变成一条可读错误往下传，**不能**退化成空配置——那会让用户以为自己从没配过。 */
export function decryptCredentials(secrets: ExecutorSecrets, ciphertext: string): CredentialDecryption {
  if (!ciphertext) return { map: {}, error: "" };
  try {
    return { map: parseCredentialMap(secrets.decrypt(ciphertext)), error: "" };
  } catch (error) {
    if (error instanceof ExecutorSecretsUndecryptableError) return { map: {}, error: error.message };
    return { map: {}, error: "服务端无法读取已保存的 API key，请重新填写" };
  }
}

/** 空配置（一行都没有）与「有行但没凭据」在下发上是同一件事。 */
export function toDelivery(record: ExecutorSettingsRecord | undefined, secrets: ExecutorSecrets): ExecutorSettingsDelivery {
  if (!record) return EMPTY_EXECUTOR_SETTINGS;
  const decrypted = decryptCredentials(secrets, record.credentialsCiphertext);
  return {
    revision: record.revision,
    provider: record.provider,
    modelId: record.modelId,
    customProviders: record.customProviders,
    credentials: Object.entries(decrypted.map).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
      apiKey: credential.key,
    })),
    credentialError: decrypted.error,
  };
}

export type ExecutorSettingsMerge = {
  record: Omit<ExecutorSettingsRecord, "accountId" | "deviceId">;
  /** 旧密文读不出来时给调用方的一句提醒；不是失败。 */
  warning: string;
};

/**
 * 把一次 patch 合并到既有行上，产出新的待落库形状。
 *
 * 凭据是**只写**的：patch 里没提到的 provider 保持原样，空串表示清除。需要写入任何凭据而中心又没有
 * 配置加密密钥时抛 `ExecutorSecretsUnavailableError`，由调用方转成可读错误——绝不降级成明文。
 */
export function mergeExecutorSettings(
  previous: ExecutorSettingsRecord | undefined,
  patch: ExecutorSettingsPatch,
  secrets: ExecutorSecrets,
  now: number,
): ExecutorSettingsMerge {
  const decrypted = previous ? decryptCredentials(secrets, previous.credentialsCiphertext) : { map: {} as CredentialMap, error: "" };
  const credentials: CredentialMap = { ...decrypted.map };
  let credentialsChanged = false;
  for (const [providerId, key] of Object.entries(patch.credentials ?? {})) {
    const trimmed = key.trim();
    if (!trimmed) {
      if (credentials[providerId]) credentialsChanged = true;
      delete credentials[providerId];
      continue;
    }
    credentials[providerId] = { type: "api_key", key: trimmed };
    credentialsChanged = true;
  }

  const customProviders = patch.customProviders ?? previous?.customProviders ?? [];
  // 自定义端点被删掉时它的凭据跟着走：留一把没有归属的 key 在库里没有任何用处。内置 provider 不在
  // customProviders 里，所以这里只清理「曾经是自定义端点、现在没了」的那些。
  const stillCustom = new Set(customProviders.map((provider) => provider.id));
  for (const provider of previous?.customProviders ?? []) {
    if (stillCustom.has(provider.id) || !credentials[provider.id]) continue;
    delete credentials[provider.id];
    credentialsChanged = true;
  }

  // 凭据没动过就原样保留旧密文与旧索引：重新加密既无必要，也会把一条读不出来的旧密文悄悄换成空
  // （解密失败时 decrypted.map 是空的），让用户以为自己从没配过。
  const keepPrevious = previous !== undefined && !credentialsChanged;
  const credentialsCiphertext = keepPrevious
    ? previous.credentialsCiphertext
    : Object.keys(credentials).length === 0
      ? ""
      : secrets.encrypt(JSON.stringify(credentials));

  return {
    record: {
      provider: patch.provider ?? previous?.provider ?? "",
      modelId: patch.modelId ?? previous?.modelId ?? "",
      customProviders,
      credentialProviderIds: keepPrevious ? previous.credentialProviderIds : Object.keys(credentials).sort(),
      credentialsCiphertext,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: now,
    },
    warning: decrypted.error && credentialsChanged ? decrypted.error : "",
  };
}

export function newExecutorSettingsId(): string {
  return randomUUID();
}

/** 保存成功后回给桌面的形状——**没有任何凭据**，只有「哪些 provider 配过」。 */
export type ExecutorSettingsSaveResult = {
  revision: number;
  provider: string;
  modelId: string;
  customProviders: ExecutorCustomProvider[];
  credentialProviderIds: string[];
  /** 旧密文读不出来时的提醒；保存本身仍然成功。 */
  warning: string;
  /** 本账号当前在线的 daemon 数，以及其中真正收到下发的数目（能力门禁）。 */
  online: number;
  pushed: number;
};

/**
 * 凭据形态的防线之二。
 *
 * 真正的防线是「凭据不走 `registerProvider({apiKey})`，只走 `setRuntimeApiKey` / 内存 CredentialStore」
 * ——pi 把前者当 config value 解析，`!` 开头会被当 shell 命令**执行**、`$` 开头读环境变量。配置改成
 * 账号级共享之后，走错路径就等于给任何能改账号配置的人一条在每台桌面主进程里执行任意命令的通道。
 * 这里顺手把这两种形态挡在入库之前，但它**不是**唯一的防线，删掉输入校验也不该让系统变得可利用。
 */
export function rejectDangerousCredential(providerId: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("!") || trimmed.startsWith("$")) {
    return `${providerId} 的 API key 不能以 ! 或 $ 开头：这两种形态在模型运行时会被当成命令或环境变量名解析，不是字面值`;
  }
  return "";
}

/** 领域形状 → 线格式。线上的字段名是 `provider_id`，领域里是 `id`，只有这一处换算。 */
export function toWireCustomProvider(provider: ExecutorCustomProvider) {
  return {
    providerId: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api as string,
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    authHeader: provider.authHeader,
    keyless: provider.keyless,
  };
}
