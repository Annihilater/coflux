/**
 * The write half of the executor configuration: main process → HTTPS → centre.
 *
 * Reading and writing go different ways on purpose. Reading is a local file the daemon wrote, so the
 * executor keeps working offline. Writing is the one operation that genuinely needs the centre —
 * the configuration follows the account, so a change has to land there before it can reach the
 * user's other machines.
 *
 * It does **not** go through the renderer. The existing executor register/report frames do
 * (main → IPC → renderer → device channel), and reusing that path would be the obvious move — it
 * would also push API keys through the renderer, which is the one thing this whole design refuses.
 */

const REQUEST_TIMEOUT_MS = 20_000;

export type ExecutorWriteCustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: { id: string; name: string }[];
  authHeader: boolean;
  keyless: boolean;
};

export type ExecutorWriteInput = {
  provider: string;
  modelId: string;
  customProviders: ExecutorWriteCustomProvider[];
  /** providerId -> key. Empty string clears; an absent provider is left untouched. */
  credentials: Record<string, string>;
};

export type ExecutorWriteResult =
  | { ok: true; revision: number; online: number; pushed: number; warning: string }
  | { ok: false; error: string };

export type ExecutorSettingsWriter = { save(input: ExecutorWriteInput): Promise<ExecutorWriteResult> };

/** The control WebSocket URL the app is configured with, as the matching HTTP endpoint. */
export function executorSettingsEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.pathname = "/api/client/executor-settings";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type ExecutorSettingsWriterOptions = {
  serverUrl: string;
  /** The session token the app already holds; empty means signed out. */
  token: () => string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
};

export function createExecutorSettingsWriter(options: ExecutorSettingsWriterOptions): ExecutorSettingsWriter {
  const endpoint = executorSettingsEndpoint(options.serverUrl);
  const call = options.fetchImpl ?? fetch;

  return {
    async save(input) {
      const token = options.token();
      if (!token) return { ok: false, error: "请先登录 Coflux 再修改 executor 配置" };
      let response: Response;
      try {
        response = await call(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ protocolVersion: 1, ...input }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Offline is the expected case here, and it is the one the settings page has to name: the
        // configuration lives on the account, so it cannot be changed without reaching it.
        return { ok: false, error: "连不上 Coflux 服务器：executor 配置存在账号上，离线时可以照常使用，但改不了" };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: `服务器返回了无法解析的响应（HTTP ${response.status}）` };
      }
      const record = (body ?? {}) as { ok?: boolean; error?: string; value?: Record<string, unknown> };
      if (!record.ok) return { ok: false, error: typeof record.error === "string" && record.error ? record.error : `保存失败（HTTP ${response.status}）` };
      const value = record.value ?? {};
      return {
        ok: true,
        revision: typeof value.revision === "number" ? value.revision : 0,
        online: typeof value.online === "number" ? value.online : 0,
        pushed: typeof value.pushed === "number" ? value.pushed : 0,
        warning: typeof value.warning === "string" ? value.warning : "",
      };
    },
  };
}
