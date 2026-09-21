/**
 * `@coflux/executor`: the only executor implementation.
 *
 * What a host needs to exist is here — the job table, the manager, the configuration the local
 * daemon writes, the model runtime the settings page browses, and the framing both hosts speak. The
 * two entry points that are *processes* rather than library surface are exported separately:
 * `@coflux/executor/host` (the daemon's standalone stdio host) and `@coflux/executor/runner` (one
 * task, one process).
 *
 * Nothing in this module graph imports Electron. That is the property that lets a headless Linux
 * daemon and Coflux.app run the same code.
 */

export { EXECUTOR_HOST_CAPABILITIES, EXECUTOR_HOST_CAPABILITY } from "./capability.js";
export { EXECUTOR_ENTRY_ENV, EXECUTOR_NODE_ENV } from "./env.js";

export {
  CUSTOM_MODEL_CONTEXT_WINDOW,
  CUSTOM_MODEL_MAX_TOKENS,
  EMPTY_EXECUTOR_CATALOG,
  EXECUTOR_CUSTOM_APIS,
  KEYLESS_PLACEHOLDER_KEY,
  customProviderConfig,
  projectCredentialProviders,
  validateCredentialShape,
  validateExecutorSelection,
  type ExecutorCatalog,
  type ExecutorCustomApi,
  type ExecutorModelOption,
  type ExecutorProviderOption,
  type ExecutorSelection,
  type ExecutorSelectionVerdict,
} from "./catalog.js";

export {
  EXECUTOR_SYSTEM_PROMPT,
  createExecutorConfigStore,
  deriveReadiness,
  toExecutorView,
  type ExecutorConfigOptions,
  type ExecutorConfigStore,
  type ExecutorSecrets,
  type ExecutorSettingsView,
} from "./config.js";

export {
  EMPTY_EXECUTOR_CACHE,
  createExecutorSettingsCache,
  readExecutorSettingsCache,
  type ExecutorCachedCustomProvider,
  type ExecutorCachedModel,
  type ExecutorCachedSettings,
  type ExecutorSettingsCache,
} from "./settings-cache.js";

export {
  createExecutorHostCore,
  type ExecutorHostCore,
  type ExecutorHostCoreOptions,
} from "./host-core.js";

export {
  MAX_HOST_LINE_BYTES,
  type ExecutorHostInbound,
  type ExecutorHostOutbound,
} from "./host-protocol.js";

export {
  ExecutorManager,
  type ExecutorConfigSnapshot,
  type ExecutorManagerDeps,
  type RunnerHandle,
} from "./manager.js";

export {
  DEFAULT_EXECUTOR_LIMITS,
  ExecutorJobTable,
  isTerminal,
  type ExecutorAssignment,
  type ExecutorEffect,
  type ExecutorJob,
  type ExecutorLimits,
  type ExecutorOutcome,
  type ExecutorRunState,
  type HostReadiness,
} from "./jobs.js";

export {
  EXECUTOR_RUNNER_EXIT,
  type ExecutorRunnerCustomProvider,
  type ExecutorRunnerInbound,
  type ExecutorRunnerOutbound,
  type ExecutorRunnerStart,
} from "./runner-protocol.js";

export {
  createExecutorRuntime,
  type ExecutorConnectionTest,
  type ExecutorRuntime,
  type ExecutorRuntimeOptions,
} from "./runtime.js";

export { buildSandboxProfile, otherWorktreePaths, sandboxArgv, type SandboxInput } from "./sandbox.js";
export { collectWorkspaceFacts, type GitRunner, type WorkspaceFacts } from "./workspace.js";
export { guardToolCall, isInsideWorkspace, type GuardInput, type GuardVerdict } from "./guard.js";
