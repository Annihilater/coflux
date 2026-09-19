/**
 * The model catalogue the settings page chooses from, and the rules for turning a hand-typed custom
 * endpoint into something pi will accept.
 *
 * Pure on purpose: the parts that are easy to get wrong — what a custom model may claim about
 * itself, which credential a selection needs, what shape a credential may not have — are decided
 * from data and can be reasoned about without a `ModelRuntime`. `executor-runtime.ts` supplies the
 * pi-shaped input and performs the side effects; searching the catalogue happens in the renderer,
 * which is where the query lives.
 */

import type { ExecutorCachedCustomProvider, ExecutorCachedSettings } from "./executor-settings-cache";

/** The four API shapes this version exposes. pi's `KnownApi` has ten; the rest stay out of the UI. */
export const EXECUTOR_CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type ExecutorCustomApi = (typeof EXECUTOR_CUSTOM_APIS)[number];

/**
 * `registerProvider`'s `models[]` is not a list of model ids: every entry must carry
 * `name / reasoning / input / cost / contextWindow / maxTokens`. A hand-typed custom model has none
 * of those, so these are the values invented for it — and because they are invented, the settings
 * page must show 「未知」 for a custom model's specification rather than presenting them as fact.
 */
export const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000;
export const CUSTOM_MODEL_MAX_TOKENS = 8_192;

/** Keyless local servers (Ollama and friends) still need *a* credential — pi treats a provider with
 * no credential as having no usable models. The placeholder goes in through the credential store,
 * never through `registerProvider({apiKey})`. */
export const KEYLESS_PLACEHOLDER_KEY = "coflux-keyless";

export type ExecutorProviderOption = {
  id: string;
  name: string;
  /** true = one of the user's own endpoints. Custom and built-in share one list: to pi a custom
   * endpoint *is* a provider, and splitting the choice in two makes "which am I using" fuzzy. */
  custom: boolean;
  /** true = this provider needs no key (a keyless custom endpoint). */
  keyless: boolean;
};

export type ExecutorModelOption = {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  /** null = unknown. Custom models carry placeholder metadata, which must never be shown as a spec. */
  contextWindow: number | null;
  /** Per-million-token input/output price, or null when unknown (same reason). */
  cost: { input: number; output: number } | null;
};

export type ExecutorCatalog = {
  /** false = the runtime could not be brought up; `error` says why and the page stays read-only. */
  ready: boolean;
  error: string;
  providers: ExecutorProviderOption[];
  models: ExecutorModelOption[];
};

export const EMPTY_EXECUTOR_CATALOG: ExecutorCatalog = { ready: false, error: "", providers: [], models: [] };

/**
 * A custom endpoint as `ModelRuntime.registerProvider()` wants it.
 *
 * **No `apiKey`, and no `headers`.** pi resolves both as "config values": a value starting with `!`
 * is executed as a shell command and its stdout used, `$` reads an environment variable. Now that
 * the configuration is account-shared, anything that reaches that resolver is a way for whoever can
 * edit the account's settings to run commands in every desktop main process on the account.
 * Credentials go in through `setRuntimeApiKey` / an in-memory `CredentialStore`, which return the
 * value verbatim.
 */
export function customProviderConfig(provider: ExecutorCachedCustomProvider) {
  return {
    name: provider.name || provider.id,
    baseUrl: provider.baseUrl,
    api: provider.api,
    authHeader: provider.authHeader,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CUSTOM_MODEL_CONTEXT_WINDOW,
      maxTokens: CUSTOM_MODEL_MAX_TOKENS,
    })),
  };
}

/** What a saved selection needs, expressed without pi so it can be asserted directly. */
export type ExecutorSelection = {
  provider: string;
  modelId: string;
  /** Provider ids that will have a credential after this save. */
  credentialProviders: readonly string[];
  customProviders: readonly ExecutorCachedCustomProvider[];
};

/**
 * Save-time checks that cost nothing. They are split by cause on purpose: "that provider does not
 * exist", "that model does not exist under it" and "the key is not usable" are three different
 * things to fix, and one merged "configuration invalid" sends the user hunting.
 *
 * Whether the model *answers* is a separate, explicit action — see the connection test.
 */
export function validateExecutorSelection(catalog: ExecutorCatalog, selection: ExecutorSelection): { ok: boolean; error: string } {
  if (!selection.provider) return { ok: false, error: "先选一个 provider" };
  if (!selection.modelId) return { ok: false, error: "先选一个模型" };
  const provider = catalog.providers.find((option) => option.id === selection.provider);
  if (!provider) return { ok: false, error: `provider 不存在：${selection.provider}` };
  const model = catalog.models.find((option) => option.provider === selection.provider && option.id === selection.modelId);
  if (!model) return { ok: false, error: `${selection.provider} 下没有这个模型：${selection.modelId}` };
  const custom = selection.customProviders.find((entry) => entry.id === selection.provider);
  if (custom?.keyless) return { ok: true, error: "" };
  if (!selection.credentialProviders.includes(selection.provider)) {
    return { ok: false, error: `还没填 ${provider.name} 的 API key` };
  }
  return { ok: true, error: "" };
}

/**
 * pi parses an API key as a config value only on the `registerProvider` path, which this code never
 * uses — but a key shaped like a command is a mistake worth catching at the point the user types it,
 * because the value would otherwise be sent to the provider verbatim and fail with something
 * unhelpful. This is a second line, not the defence.
 */
export function validateCredentialShape(apiKey: string): { ok: boolean; error: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: "API key 是空的" };
  if (trimmed.startsWith("!") || trimmed.startsWith("$")) {
    return { ok: false, error: "API key 不能以 ! 或 $ 开头：这两种形态会被当成命令或环境变量名，不是字面值" };
  }
  if (/\s/.test(trimmed)) return { ok: false, error: "API key 里有空白字符，检查是不是粘贴多了" };
  return { ok: true, error: "" };
}

/** Which provider ids hold a credential, given what is cached plus what this save changes. */
export function projectCredentialProviders(
  cached: ExecutorCachedSettings,
  changes: Readonly<Record<string, string>>,
): string[] {
  const providers = new Set(Object.keys(cached.credentials));
  for (const [providerId, key] of Object.entries(changes)) {
    if (key.trim()) providers.add(providerId);
    else providers.delete(providerId);
  }
  return [...providers].sort();
}
