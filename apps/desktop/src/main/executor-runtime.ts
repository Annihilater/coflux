/**
 * The main process's long-lived `ModelRuntime`.
 *
 * Why it exists at all: before this, a runtime was only ever created inside a runner child process,
 * against a scratch directory deleted when the task finished. The main process held three strings
 * and had no way to list providers, resolve a model, or check a credential — which is exactly why
 * the settings page could only be three free-text boxes and a mistake surfaced as "the model in the
 * desktop configuration is unavailable", much later, from another process.
 *
 * Three boundaries that do not move:
 *
 *  1. **Isolation from the user's own `~/.pi` is unchanged.** What became persistent is the
 *     directory's lifetime, not the boundary. `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`
 *     are set **before pi is imported** (pi's `getAgentDir()` falls back to the real `~/.pi/agent`,
 *     and `ModelRuntime` resolves its own paths independently of anything handed to a session), and
 *     `authPath` / `modelsPath` / `modelsStorePath` still point explicitly into coflux's own
 *     directory. Without this the executor could silently use the user's own subscription
 *     credentials, and the model set would vary with their `models.json`.
 *
 *  2. **Credentials are memory-only.** The runtime gets an in-memory `CredentialStore` and keys go
 *     in through `setRuntimeApiKey`. Persistence is the daemon cache file's job; a second copy on
 *     the same disk — safeStorage-encrypted or not — buys nothing next to the 0600 plaintext it
 *     would sit beside, and letting pi write `auth.json` would make a third.
 *
 *  3. **A credential never reaches `registerProvider`.** Its `apiKey` and `headers` are parsed as pi
 *     "config values": `!…` is executed as a shell command, `$…` reads an environment variable. The
 *     configuration is now account-shared, so that path would let anyone who can edit the account's
 *     settings run commands in every desktop main process on it. `setRuntimeApiKey` returns the
 *     value verbatim and is the only way in.
 *
 * `allowModelNetwork: false`: the built-in catalogue plus `models-store.json` already yields every
 * provider and model the two-step picker needs, and refreshing it would be a new outbound request
 * the user never asked for, with failure modes (timeout, blocked) that stall the settings page. The
 * connection test is a separate, explicit request and is unaffected.
 */

import { mkdirSync } from "node:fs";

import {
  customProviderConfig,
  EMPTY_EXECUTOR_CATALOG,
  KEYLESS_PLACEHOLDER_KEY,
  type ExecutorCatalog,
  type ExecutorModelOption,
  type ExecutorProviderOption,
} from "./executor-catalog";
import type { ExecutorCachedSettings } from "./executor-settings-cache";

/** The slice of pi this file uses. Narrow on purpose: it is also the seam tests inject through. */
type PiModelRuntime = {
  getProviders(): readonly { id: string; name: string }[];
  getProvider(providerId: string): { id: string; name: string } | undefined;
  getModels(providerId?: string): readonly {
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    cost: { input: number; output: number };
  }[];
  getModel(providerId: string, modelId: string): unknown;
  registerProvider(providerId: string, config: unknown): void;
  unregisterProvider(providerId: string): void;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey(providerId: string): Promise<void>;
  completeSimple(model: unknown, context: unknown, options?: unknown): Promise<{ usage?: { totalTokens?: number }; stopReason?: string; errorMessage?: string }>;
};

type PiModule = {
  ModelRuntime: { create(options: Record<string, unknown>): Promise<PiModelRuntime> };
};

export type ExecutorRuntimeOptions = {
  /** coflux's own pi directory, under the app's userData. Never the user's `~/.pi`. */
  agentDir: string;
  log: (message: string) => void;
  /** Injected in tests. Production loads the real package, after the environment is set. */
  loadPi?: () => Promise<PiModule>;
};

export type ExecutorConnectionTest = { ok: boolean; error: string; tokens: number; ms: number };

export type ExecutorRuntime = {
  /** Built-in providers plus whatever custom endpoints the given settings describe. */
  catalog(settings: ExecutorCachedSettings): Promise<ExecutorCatalog>;
  /** Make the runtime reflect these settings: register endpoints, inject credentials. */
  apply(settings: ExecutorCachedSettings): Promise<string>;
  /** One minimal real request against the configured model. Costs money; only on an explicit ask. */
  test(settings: ExecutorCachedSettings): Promise<ExecutorConnectionTest>;
  dispose(): void;
};

/** The only credential shape this version stores. Matches pi's `ApiKeyCredential`; the `oauth`
 * branch of its `Credential` union is next version's problem. Concrete rather than `unknown` on
 * purpose: `CredentialStore.modify` is checked against pi's own signature, and a widened return
 * type makes the store fail to satisfy it. */
type MemoryCredential = { type: "api_key"; key: string };

/**
 * An in-memory `CredentialStore` for pi. `ModelRuntime.create` otherwise defaults to a file at
 * `authPath`; handing it this makes "no credential reaches a disk from here" structural rather than
 * a property of the code path currently taken. Persistence belongs to the daemon's cache file, and
 * a second copy beside that 0600 plaintext would buy nothing.
 */
function memoryCredentialStore() {
  const entries = new Map<string, MemoryCredential>();
  return {
    async read(providerId: string): Promise<MemoryCredential | undefined> {
      return entries.get(providerId);
    },
    async list(): Promise<readonly { providerId: string; type: "api_key" }[]> {
      return [...entries.keys()].map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    async modify(
      providerId: string,
      fn: (current: MemoryCredential | undefined) => Promise<MemoryCredential | undefined>,
    ): Promise<MemoryCredential | undefined> {
      const next = await fn(entries.get(providerId));
      if (next) entries.set(providerId, next);
      else entries.delete(providerId);
      return next;
    },
    async delete(providerId: string): Promise<void> {
      entries.delete(providerId);
    },
  };
}

export function createExecutorRuntime(options: ExecutorRuntimeOptions): ExecutorRuntime {
  let runtimePromise: Promise<PiModelRuntime> | undefined;
  /** Provider ids currently registered and keyed, so a removed endpoint is actually withdrawn. */
  let registered = new Set<string>();
  let keyed = new Set<string>();

  async function runtime(): Promise<PiModelRuntime> {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      mkdirSync(options.agentDir, { recursive: true, mode: 0o700 });
      // Set before pi is imported: pi resolves anything it was not handed explicitly through
      // `getAgentDir()`, which otherwise lands in the user's real `~/.pi/agent`.
      process.env.PI_CODING_AGENT_DIR = options.agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = `${options.agentDir}/sessions`;
      const pi = options.loadPi ? await options.loadPi() : ((await import("@earendil-works/pi-coding-agent")) as unknown as PiModule);
      return pi.ModelRuntime.create({
        allowModelNetwork: false,
        credentials: memoryCredentialStore(),
        authPath: `${options.agentDir}/auth.json`,
        modelsPath: `${options.agentDir}/models.json`,
        modelsStorePath: `${options.agentDir}/models-store.json`,
      });
    })().catch((error: unknown) => {
      // A failed load must not be cached as a permanently broken runtime: the next attempt retries.
      runtimePromise = undefined;
      throw error;
    });
    return runtimePromise;
  }

  async function applyTo(model: PiModelRuntime, settings: ExecutorCachedSettings): Promise<void> {
    const wanted = new Set(settings.customProviders.map((provider) => provider.id));
    for (const providerId of registered) {
      if (!wanted.has(providerId)) model.unregisterProvider(providerId);
    }
    for (const provider of settings.customProviders) {
      model.registerProvider(provider.id, customProviderConfig(provider));
    }
    registered = wanted;

    const nextKeyed = new Set<string>();
    for (const [providerId, apiKey] of Object.entries(settings.credentials)) {
      // Must be awaited: it is asynchronous and runs through pi's internal credential queue, so
      // without the await the first request can go out before the key is in place.
      await model.setRuntimeApiKey(providerId, apiKey);
      nextKeyed.add(providerId);
    }
    // Keyless local servers still need *a* credential for pi to consider their models usable, and
    // the placeholder goes through the same memory path — never `registerProvider({apiKey})`.
    for (const provider of settings.customProviders) {
      if (!provider.keyless || nextKeyed.has(provider.id)) continue;
      await model.setRuntimeApiKey(provider.id, KEYLESS_PLACEHOLDER_KEY);
      nextKeyed.add(provider.id);
    }
    for (const providerId of keyed) {
      if (!nextKeyed.has(providerId)) await model.removeRuntimeApiKey(providerId);
    }
    keyed = nextKeyed;
  }

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  return {
    async catalog(settings) {
      let model: PiModelRuntime;
      try {
        model = await runtime();
        await applyTo(model, settings);
      } catch (error) {
        const message = describe(error);
        options.log(`[executor] 模型目录不可用：${message}`);
        return { ...EMPTY_EXECUTOR_CATALOG, error: message };
      }
      const customById = new Map(settings.customProviders.map((provider) => [provider.id, provider] as const));
      const providers: ExecutorProviderOption[] = model.getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        custom: customById.has(provider.id),
        keyless: customById.get(provider.id)?.keyless === true,
      }));
      const providerNames = new Map(providers.map((provider) => [provider.id, provider.name] as const));
      const models: ExecutorModelOption[] = model.getModels().map((entry) => {
        const custom = customById.has(entry.provider);
        return {
          provider: entry.provider,
          providerName: providerNames.get(entry.provider) ?? entry.provider,
          id: entry.id,
          name: entry.name || entry.id,
          // Custom models carry the placeholder metadata this app invented for them; reporting it
          // as a context window or a price would be presenting a made-up number as a fact.
          contextWindow: custom ? null : entry.contextWindow,
          cost: custom ? null : { input: entry.cost.input, output: entry.cost.output },
        };
      });
      return { ready: true, error: "", providers, models };
    },

    async apply(settings) {
      try {
        await applyTo(await runtime(), settings);
        return "";
      } catch (error) {
        const message = describe(error);
        options.log(`[executor] 应用模型配置失败：${message}`);
        return message;
      }
    },

    async test(settings) {
      const started = Date.now();
      try {
        const model = await runtime();
        await applyTo(model, settings);
        const selected = model.getModel(settings.provider, settings.modelId);
        if (!selected) return { ok: false, error: `模型不可用：${settings.provider}/${settings.modelId}`, tokens: 0, ms: 0 };
        const reply = await model.completeSimple(
          selected,
          { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
          { maxTokens: 16 },
        );
        // `complete()` returning is not success: pi reports model-side failures on stopReason.
        if (reply.stopReason === "error") {
          return { ok: false, error: reply.errorMessage || "模型返回了错误，未给出原因", tokens: 0, ms: Date.now() - started };
        }
        return { ok: true, error: "", tokens: reply.usage?.totalTokens ?? 0, ms: Date.now() - started };
      } catch (error) {
        return { ok: false, error: describe(error), tokens: 0, ms: Date.now() - started };
      }
    },

    dispose() {
      runtimePromise = undefined;
      registered = new Set();
      keyed = new Set();
    },
  };
}
