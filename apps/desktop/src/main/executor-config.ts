/**
 * The executor's configuration as the rest of the main process sees it.
 *
 * The configuration now follows the **account**, not the machine: the centre's `executor_settings`
 * table is the source of truth, the daemon writes it to a local cache file, and this module reads
 * that file. Changes go the other way, straight out over HTTPS to the centre.
 *
 * Two properties that this file exists to hold:
 *
 *  - **The read path never leaves the machine.** Submitting a job reads a local file, so the
 *    executor keeps working while offline; only *changing* the configuration needs the centre.
 *  - **The credential never reaches the renderer.** `view()` is what crosses IPC and has no
 *    credential field in any form, plaintext or otherwise — only which providers have one.
 *    `secrets()` is for spawning a runner and nothing else.
 */

import {
  createExecutorSettingsCache,
  type ExecutorCachedCustomProvider,
  type ExecutorCachedSettings,
  type ExecutorSettingsCache,
} from "./executor-settings-cache";

/** The configuration shape the renderer can see — **no credential**, only which providers have one. */
export type ExecutorSettingsView = {
  provider: string;
  modelId: string;
  hasApiKey: boolean;
  ready: boolean;
  reason: string;
  /** false = the daemon has not delivered a configuration to this machine yet. */
  present: boolean;
  /** Readable reason the centre could not produce credentials; not the same as "never configured". */
  credentialError: string;
  customProviders: ExecutorCachedCustomProvider[];
  /** Provider ids that have a credential. Ids only. */
  credentialProviders: string[];
  revision: number;
};

/**
 * The system prompt, fixed by coflux. **Neither user-configurable nor passed by the calling agent** —
 * the executor's persona and boundaries are part of the product; making them configurable would mean
 * every caller has to think them through again, and the boundaries would get missed.
 */
export const EXECUTOR_SYSTEM_PROMPT = [
  "You are the coflux executor: a focused sub-agent that another coding agent delegates a single, bounded task to.",
  "",
  "Hard boundaries, enforced by a kernel sandbox — do not fight them, work within them:",
  "- You can only modify files inside the workspace you were started in. Paths outside it are unreadable and unwritable.",
  "- Git metadata is read-only. You cannot commit, stage, or rewrite history. Leave the changes in the working tree; the agent that called you reviews and commits them.",
  "- Your shell has no network access. Do not try to install dependencies or fetch anything; assume what is already present is all you get.",
  "- Use absolute paths for every file tool call.",
  "",
  "How to work:",
  "- You get one prompt and no follow-up. There is nobody to ask, so make reasonable assumptions and say what you assumed.",
  "- Finish the whole task. If part of it is impossible under the boundaries above, do the rest and state plainly what you skipped and why.",
  "- Your final message is the entire report the calling agent receives. Lead with what you did and what changed, then anything that needs attention. Be concise and concrete.",
].join("\n");

/** Everything a runner needs to build its own runtime. Holds the key in the clear — use it and drop it. */
export type ExecutorSecrets = {
  provider: string;
  modelId: string;
  apiKey: string;
  /** The custom endpoint definitions, so the runner's own runtime can register them too. */
  customProviders: ExecutorCachedCustomProvider[];
  /** True when the selected provider needs no key (a keyless local server). */
  keyless: boolean;
};

export type ExecutorConfigStore = {
  view(): ExecutorSettingsView;
  /** Called only when spawning a runner; the returned object holds the key in the clear. */
  secrets(): ExecutorSecrets;
  /** The cached settings, for the main process's own runtime. Never crosses IPC. */
  cached(): ExecutorCachedSettings;
  refresh(): boolean;
  waitForRevision(revision: number, timeoutMs: number): Promise<boolean>;
  dispose(): void;
};

export type ExecutorConfigOptions = {
  /** `$COFLUX_HOME/executor-settings.json`, written by the local daemon. */
  cachePath: string;
  onChange?: (view: ExecutorSettingsView) => void;
  pollMs?: number;
};

/**
 * Readiness, and the reason a submission was refused. The reason is passed verbatim to the calling
 * agent, so each branch names the one thing to fix — and, since the configuration now lives on the
 * account, points at the settings page rather than the account menu's old dialog, which no longer
 * exists.
 */
export function deriveReadiness(settings: ExecutorCachedSettings): { ready: boolean; reason: string } {
  if (settings.credentialError) {
    return { ready: false, reason: `executor 的 API key 读不出来：${settings.credentialError}（在 Coflux 设置页的 Executor 分区重新填一次）` };
  }
  if (!settings.present) {
    return {
      ready: false,
      reason: "本机还没收到账号里的 executor 配置：确认 Coflux 已接入这台机器、daemon 在跑且是最新版本",
    };
  }
  if (!settings.provider || !settings.modelId) {
    return { ready: false, reason: "账号里还没配 executor 的 provider 与模型：在 Coflux 设置页的 Executor 分区选好再发" };
  }
  const custom = settings.customProviders.find((provider) => provider.id === settings.provider);
  if (!custom?.keyless && !settings.credentials[settings.provider]) {
    return { ready: false, reason: `账号里 ${settings.provider} 的 API key 还没填：在 Coflux 设置页的 Executor 分区填好再发` };
  }
  return { ready: true, reason: "" };
}

export function toExecutorView(settings: ExecutorCachedSettings): ExecutorSettingsView {
  const credentialProviders = Object.keys(settings.credentials).sort();
  return {
    provider: settings.provider,
    modelId: settings.modelId,
    hasApiKey: settings.provider ? credentialProviders.includes(settings.provider) : credentialProviders.length > 0,
    present: settings.present,
    credentialError: settings.credentialError,
    customProviders: settings.customProviders,
    credentialProviders,
    revision: settings.revision,
    ...deriveReadiness(settings),
  };
}

export function createExecutorConfigStore(options: ExecutorConfigOptions): ExecutorConfigStore {
  const cache: ExecutorSettingsCache = createExecutorSettingsCache({
    path: options.cachePath,
    pollMs: options.pollMs,
    onChange: (settings) => options.onChange?.(toExecutorView(settings)),
  });

  return {
    view: () => toExecutorView(cache.snapshot()),
    secrets() {
      const settings = cache.snapshot();
      const custom = settings.customProviders.find((provider) => provider.id === settings.provider);
      return {
        provider: settings.provider,
        modelId: settings.modelId,
        apiKey: settings.credentials[settings.provider] ?? "",
        customProviders: settings.customProviders,
        keyless: custom?.keyless === true,
      };
    },
    cached: () => cache.snapshot(),
    refresh: () => cache.refresh(),
    waitForRevision: (revision, timeoutMs) => cache.waitForRevision(revision, timeoutMs),
    dispose: () => cache.dispose(),
  };
}
