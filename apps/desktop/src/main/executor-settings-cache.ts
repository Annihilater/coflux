/**
 * The executor configuration as the local daemon last left it.
 *
 * The centre owns this configuration and pushes it down the daemon link; the daemon writes it to
 * `$COFLUX_HOME/executor-settings.json` (0600, temp file + rename) and the main process reads that
 * file directly. **That is the whole read path** — no IPC, no renderer, no network. It exists in
 * this shape for one reason: the executor must still be able to take work while the machine is
 * offline, so only *changing* the configuration may require the centre.
 *
 * The file carries API keys in the clear. Nothing here may hand them to the renderer; the view the
 * renderer gets is assembled in `executor-config.ts` and deliberately has no credential field.
 *
 * Change detection is a poll, not `fs.watch`: the daemon writes through a rename, the file may not
 * exist yet when the app starts, and `$COFLUX_HOME` itself may appear later — a two-second stat of
 * one small file covers all three cases with no watcher lifecycle to get wrong.
 */

import { readFileSync, statSync } from "node:fs";

export type ExecutorCachedModel = { id: string; name: string };

export type ExecutorCachedCustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: ExecutorCachedModel[];
  authHeader: boolean;
  keyless: boolean;
};

export type ExecutorCachedSettings = {
  /** false = the daemon has never written the file (not running, or too old to know the message). */
  present: boolean;
  revision: number;
  provider: string;
  modelId: string;
  customProviders: ExecutorCachedCustomProvider[];
  /** providerId -> API key. **Never leaves the main process.** */
  credentials: Record<string, string>;
  /** Readable reason the centre could not produce credentials (a rotated server key, say). */
  credentialError: string;
};

export const EMPTY_EXECUTOR_CACHE: ExecutorCachedSettings = {
  present: false,
  revision: 0,
  provider: "",
  modelId: "",
  customProviders: [],
  credentials: {},
  credentialError: "",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseCustomProviders(value: unknown): ExecutorCachedCustomProvider[] {
  if (!Array.isArray(value)) return [];
  const out: ExecutorCachedCustomProvider[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asString(record.id);
    if (!id) continue;
    out.push({
      id,
      name: asString(record.name) || id,
      baseUrl: asString(record.baseUrl),
      api: asString(record.api),
      models: Array.isArray(record.models)
        ? record.models
            .filter((model): model is Record<string, unknown> => !!model && typeof model === "object")
            .map((model) => ({ id: asString(model.id), name: asString(model.name) || asString(model.id) }))
            .filter((model) => model.id.length > 0)
        : [],
      authHeader: record.authHeader === true,
      keyless: record.keyless === true,
    });
  }
  return out;
}

function parseCredentials(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const providerId = asString(record.providerId);
    const apiKey = asString(record.apiKey);
    // Only api_key this version. An oauth entry is not an error — it is simply a credential this
    // build cannot use yet, and dropping it is better than half-understanding it.
    if (!providerId || record.type !== "api_key" || !apiKey) continue;
    out[providerId] = apiKey;
  }
  return out;
}

/**
 * A missing, unreadable or malformed file all read as "the daemon has not delivered anything",
 * never as an exception: this runs on the settings page's read path and on every job submission.
 */
export function readExecutorSettingsCache(path: string): ExecutorCachedSettings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return EMPTY_EXECUTOR_CACHE;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_EXECUTOR_CACHE;
    const record = parsed as Record<string, unknown>;
    return {
      present: true,
      revision: typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0,
      provider: asString(record.provider),
      modelId: asString(record.modelId),
      customProviders: parseCustomProviders(record.customProviders),
      credentials: parseCredentials(record.credentials),
      credentialError: asString(record.credentialError),
    };
  } catch {
    // A truncated read should not look like "you never configured anything". The rename-based write
    // makes this near-impossible, but if it happens, say the file is there and unusable.
    return { ...EMPTY_EXECUTOR_CACHE, present: true, credentialError: "本机的 executor 配置缓存无法解析，等待 daemon 重新下发" };
  }
}

export type ExecutorSettingsCache = {
  snapshot(): ExecutorCachedSettings;
  /** Re-read now and report whether anything changed. */
  refresh(): boolean;
  /**
   * Resolve once the cache has caught up to `revision`. Used right after a write to the centre:
   * not catching up in time is the readable symptom of "this machine's daemon is too old to know
   * the configuration message", which is otherwise an endless spinner.
   */
  waitForRevision(revision: number, timeoutMs: number): Promise<boolean>;
  dispose(): void;
};

export type ExecutorSettingsCacheOptions = {
  path: string;
  onChange?: (settings: ExecutorCachedSettings) => void;
  /** Injected in tests; production polls every two seconds. */
  pollMs?: number;
  read?: (path: string) => ExecutorCachedSettings;
  stat?: (path: string) => { mtimeMs: number; size: number } | undefined;
};

function defaultStat(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

export function createExecutorSettingsCache(options: ExecutorSettingsCacheOptions): ExecutorSettingsCache {
  const read = options.read ?? readExecutorSettingsCache;
  const stat = options.stat ?? defaultStat;
  const pollMs = options.pollMs ?? 2_000;

  let current = read(options.path);
  let fingerprint = fingerprintOf(stat(options.path));

  function fingerprintOf(stats: { mtimeMs: number; size: number } | undefined): string {
    return stats ? `${stats.mtimeMs}:${stats.size}` : "";
  }

  function refresh(): boolean {
    const next = fingerprintOf(stat(options.path));
    // The fingerprint is a cheap gate, not the truth: a same-millisecond, same-size rewrite still
    // has to be picked up, so a revision that went backwards or a first read both force a re-read.
    if (next === fingerprint && current.present) return false;
    fingerprint = next;
    const settings = read(options.path);
    const changed = JSON.stringify(settings) !== JSON.stringify(current);
    current = settings;
    if (changed) options.onChange?.(settings);
    return changed;
  }

  // unref: this poll must never be the reason the process stays alive.
  const timer = setInterval(refresh, pollMs);
  timer.unref();

  return {
    snapshot: () => current,
    refresh,
    async waitForRevision(revision, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        refresh();
        if (current.present && current.revision >= revision) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    dispose: () => clearInterval(timer),
  };
}
