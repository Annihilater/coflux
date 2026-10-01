import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DaemonBundle } from "./daemon-bundle";
import { DAEMON_BINARIES, DAEMON_VERSION_FILE, PTYD_BINARY, RUNTIME_BINARIES, SCREEN_HELPER_BINARY, SCREEN_HELPER_ENV, SCREEN_HELPER_VERSION_ENV } from "./daemon-paths";

export type RuntimeStatus = {
  ok: true;
  protocol: 1;
  instanceId: string;
  runtimeId: string;
  version: string;
  /** "ptyd" = 这个 supervisor 的 PTY 在 coflux-ptyd 里，支持 `leave`（替换时终端不动）；缺失 = 旧 supervisor */
  custody?: string;
  sessions: { id: string; taskId: string; pid: number }[];
};

/** coflux-ptyd 的只读状态（plan 20260918-ptyd-terminal-custody）：supervisor 缺席期间桌面靠它数终端、判断"还在跑"。 */
export type PtydStatus = {
  protocolVersion: number;
  /** 二进制身份（app 启动它时经 COFLUX_PTYD_ID 交下去的 bundlePtydId），与内置的比较得出「ptyd 有更新」 */
  identity: string;
  instanceId: string;
  pid: number;
  sessions: { id: string; pid: number; exited: boolean }[];
};

export const PTYD_SOCKET = "ptyd.sock";

/** Upper bound for a starting supervisor to answer; session recovery grows with the number of live terminals. */
const RUNTIME_START_TIMEOUT_MS = 60_000;

/** ptyd record：`[u32 总长][u32 header_len][header JSON][raw]`（与 crates/protocol/src/ptyd.rs 一致）。 */
function encodePtydRecord(header: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const record = Buffer.alloc(8 + json.length);
  record.writeUInt32BE(4 + json.length, 0);
  record.writeUInt32BE(json.length, 4);
  json.copy(record, 8);
  return record;
}

/**
 * 一次 ptyd 请求：连上先收 hello，再发带 `id: 1` 的请求，等同 id 的回执。只读 header（status /
 * ok / error 都没有 raw 段）。与 `runtimeRequest` 同样有界：一次请求、3 秒超时、1 MiB 上限。
 */
export function ptydRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let sent = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value ?? {});
    };
    socket.setTimeout(3000, () => finish(new Error("本机终端托管进程未响应，请稍后重试")));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish(new Error("本机终端托管进程响应过大"));
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        if (payload.length < 4) return finish(new Error("本机终端托管进程响应无效"));
        const headerLength = payload.readUInt32BE(0);
        let header: Record<string, unknown>;
        try { header = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8")) as Record<string, unknown>; }
        catch { return finish(new Error("本机终端托管进程响应无效")); }
        if (header.kind === "hello") {
          if (!sent) { sent = true; socket.write(encodePtydRecord({ id: 1, ...request })); }
          continue;
        }
        if (header.id === 1) return finish(undefined, header);
      }
    });
    socket.once("end", () => finish(Object.assign(new Error("本机终端托管进程响应不完整"), { code: "ERR_RUNTIME_INCOMPLETE" })));
  });
}

export async function ptydStatus(home: string): Promise<PtydStatus | null> {
  let value: Record<string, unknown>;
  try { value = await ptydRequest(join(home, PTYD_SOCKET), { op: "status" }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
  const sessions = value.sessions;
  if (value.kind !== "status" || typeof value.identity !== "string" || typeof value.instance_id !== "string" ||
    typeof value.pid !== "number" || typeof value.protocol_version !== "number" || !Array.isArray(sessions) ||
    !sessions.every((s) => s && typeof s.session_id === "string" && typeof s.pid === "number" && typeof s.exited === "boolean")) {
    throw new Error("本机终端托管进程版本不兼容，现有终端已保留，请稍后更新");
  }
  return {
    protocolVersion: value.protocol_version,
    identity: value.identity,
    instanceId: value.instance_id,
    pid: value.pid,
    sessions: (sessions as { session_id: string; pid: number; exited: boolean }[]).map((s) => ({ id: s.session_id, pid: s.pid, exited: s.exited })),
  };
}

/** 结束本机全部终端并让 ptyd 退出（"停止" / 退出 / 退出登录 / ptyd 自身更新）。 */
export async function stopPtyd(home: string, status: PtydStatus): Promise<void> {
  const gone = (error: unknown) => ["ERR_RUNTIME_INCOMPLETE", "ECONNRESET", "EPIPE", "ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
  try {
    const result = await ptydRequest(join(home, PTYD_SOCKET), { op: "shutdown", instance_id: status.instanceId });
    if (result.kind !== "ok") throw new Error("本机终端托管进程状态已变化，请重新确认");
  } catch (error) { if (!gone(error)) throw error; }
  for (let i = 0; i < 100; i++) {
    try {
      const current = await ptydStatus(home);
      if (!current) return;
      if (current.instanceId !== status.instanceId) throw new Error("本机出现新的终端托管进程，已保留，请重新确认");
    } catch (error) { if (!gone(error)) throw error; }
    await delay(50);
  }
  throw new Error("本机终端托管进程尚未退出，已取消");
}

/**
 * 启动 ptyd（与 supervisor 平级、由主应用直接 spawn、detached）。只有生命周期拥有者会启动它，
 * supervisor 永远不会。`ptydId` 是内置二进制的身份，ptyd 原样报回来，之后拿它判断"ptyd 有更新"。
 */
export async function startPtyd(home: string, directory: string, ptydId: string, logFile: string): Promise<PtydStatus> {
  const existing = await ptydStatus(home);
  if (existing) return existing;
  const logFd = openSync(logFile, "a", 0o600);
  let launchError: Error | undefined;
  let exited = false;
  try {
    const child = spawn(join(directory, PTYD_BINARY), [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, COFLUX_HOME: home, COFLUX_PTYD_ID: ptydId },
    });
    child.once("error", (error) => { launchError = error; });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally { closeSync(logFd); }
  for (let i = 0; i < 200; i++) {
    const status = await ptydStatus(home);
    if (status) return status;
    if (launchError) throw launchError;
    if (exited) throw new Error("本机终端托管进程启动失败，请查看 Coflux 日志");
    await delay(50);
  }
  throw new Error("本机终端托管进程启动超时，请稍后重试");
}

/**
 * 让 supervisor 走 leave-sessions 退出：杀 worker、退出，shell 全留在 ptyd 里。与 `stopRuntime`
 * 不共用路径——那条会结束每个终端。旧 supervisor（status 没有 custody）不认识 `leave`，调用方
 * 必须先看 `runtimeSupportsLeave`，别把一个会结束终端的更新伪装成无感更新。
 */
export function runtimeSupportsLeave(status: RuntimeStatus): boolean {
  return status.custody === "ptyd";
}

export async function leaveRuntime(home: string, status: RuntimeStatus): Promise<void> {
  const gone = (error: unknown) => ["ERR_RUNTIME_INCOMPLETE", "ECONNRESET", "EPIPE", "ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
  try {
    const result = await runtimeRequest(join(home, "runtime.sock"), { op: "leave", instanceId: status.instanceId }) as { ok?: boolean };
    if (result?.ok !== true) throw new Error("本机运行状态已变化，请重新确认");
  } catch (error) { if (!gone(error)) throw error; }
  for (let i = 0; i < 100; i++) {
    try {
      const current = await runtimeStatus(home);
      if (!current) return;
      if (current.instanceId !== status.instanceId) throw new Error("本机出现新运行实例，已保留，请重新确认");
    } catch (error) { if (!gone(error)) throw error; }
    await delay(50);
  }
  throw new Error("本机运行组件尚未退出，已取消更新");
}

/** 每次只发一个有界请求。实例随机标识防止退出确认跨过进程重启后误停新实例。 */
export function runtimeRequest(socketPath: string, request: { op: "status" | "stop" | "leave"; instanceId?: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => finish(Object.assign(new Error("本机运行组件未响应，请稍后重试"), { code: "ERR_RUNTIME_TIMEOUT" })));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1024 * 1024) return finish(new Error("本机运行组件响应过大"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try { finish(undefined, JSON.parse(data.slice(0, end))); }
      catch { finish(new Error("本机运行组件响应无效")); }
    });
    socket.once("end", () => finish(Object.assign(new Error("本机运行组件响应不完整"), { code: "ERR_RUNTIME_INCOMPLETE" })));
  });
}

export async function runtimeStatus(home: string): Promise<RuntimeStatus | null> {
  let value: unknown;
  try { value = await runtimeRequest(join(home, "runtime.sock"), { op: "status" }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
  const status = value as Partial<RuntimeStatus> | null;
  if (!status || status.ok !== true || status.protocol !== 1 || typeof status.instanceId !== "string" ||
    typeof status.runtimeId !== "string" || typeof status.version !== "string" || !Array.isArray(status.sessions) ||
    !status.sessions.every((s) => s && typeof s.id === "string" && typeof s.taskId === "string" && typeof s.pid === "number")) {
    throw new Error("本机运行组件版本不兼容，现有终端已保留，请稍后更新");
  }
  return status as RuntimeStatus;
}

/** 结束本机全部终端后让 supervisor 退出（"停止"）。ptyd 由调用方另行 `stopPtyd`。 */
export async function stopRuntime(home: string, status: RuntimeStatus): Promise<void> {
  // 停止会关闭 UDS；ack 或紧随其后的 status 都可能遇到 EOF。只能重查同一实例是否
  // 消失，不能把 EOF 直接当成功，也不能向可能已替换的新实例重发 stop。
  const stoppingConnection = (error: unknown) => ["ERR_RUNTIME_INCOMPLETE", "ECONNRESET", "EPIPE", "ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
  try {
    const result = await runtimeRequest(join(home, "runtime.sock"), { op: "stop", instanceId: status.instanceId }) as { ok?: boolean };
    if (result?.ok !== true) throw new Error("本机运行状态已变化，请重新确认");
  } catch (error) { if (!stoppingConnection(error)) throw error; }
  for (let i = 0; i < 100; i++) {
    try {
      const current = await runtimeStatus(home);
      if (!current) return;
      if (current.instanceId !== status.instanceId) throw new Error("本机出现新运行实例，已保留，请重新确认");
    } catch (error) { if (!stoppingConnection(error)) throw error; }
    await delay(50);
  }
  throw new Error("本机终端尚未结束，已取消退出");
}

/** 运行目录按内容寻址。更新 .app 不会删掉活进程使用的 worker、CLI 或插件文件。ptyd 不参与：它的身份单独比较。 */
export function bundleRuntimeId(bundle: DaemonBundle): string {
  const hash = createHash("sha256");
  hash.update(bundle.version ?? "dev");
  for (const binary of RUNTIME_BINARIES) hash.update(readFileSync(join(bundle.dir, binary)));
  // 插件版本变化也需要新目录，但不强制重启持有旧终端的进程。
  const manifest = join(bundle.dir, "claude-plugin", ".claude-plugin", "plugin.json");
  if (existsSync(manifest)) hash.update(readFileSync(manifest));
  return hash.digest("hex").slice(0, 24);
}

/** 内置 ptyd 的身份：只由它自己的字节决定，不含版本戳——ptyd 不变则跨任意多次发版都相同。 */
export function bundlePtydId(bundle: DaemonBundle): string {
  return createHash("sha256").update(readFileSync(join(bundle.dir, PTYD_BINARY))).digest("hex").slice(0, 24);
}

export function stageRuntime(home: string, bundle: DaemonBundle, runtimeId: string): string {
  const parent = join(home, "desktop-runtimes");
  const destination = join(parent, runtimeId);
  if (existsSync(destination)) return destination;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    cpSync(bundle.dir, temporary, { recursive: true });
    for (const binary of DAEMON_BINARIES) chmodSync(join(temporary, binary), 0o755);
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return destination;
}

/**
 * 启动 supervisor（由主应用直接启动，保持应用的权限责任链；不交给独立 LaunchAgent，也不重签二进制）。
 * ptyd 必须已经在跑（`startPtyd`）：supervisor 找不到它会立刻退出。
 */
/** The staged runtime's VERSION stamp (CI writes vX.Y.Z; a local pack falls back to dev). */
function readVersionStamp(directory: string): string {
  try { return readFileSync(join(directory, DAEMON_VERSION_FILE), "utf8").trim() || "dev"; } catch { return "dev"; }
}

export async function startRuntime(home: string, directory: string, runtimeId: string, logFile: string): Promise<RuntimeStatus> {
  const existing = await runtimeStatus(home);
  if (existing) return existing;
  const temporaryHome = join(home, "terminal-data");
  mkdirSync(temporaryHome, { recursive: true, mode: 0o700 });
  const logFd = openSync(logFile, "a", 0o600);
  let launchError: Error | undefined;
  let exited = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(join(directory, "coflux-supervisor"), [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, TMPDIR: temporaryHome, COFLUX_HOME: home, COFLUX_RUNTIME_CONTROL: "1", COFLUX_RUNTIME_ID: runtimeId,
        COFLUX_WORKER_CMD: join(directory, "coflux-worker"), COFLUX_CLAUDE_PLUGIN_DIR: join(directory, "claude-plugin"),
        // The supervisor passes its environment through to every worker, hot-upgraded ones included.
        [SCREEN_HELPER_ENV]: join(directory, SCREEN_HELPER_BINARY), [SCREEN_HELPER_VERSION_ENV]: readVersionStamp(directory) },
    });
    child.once("error", (error) => { launchError = error; });
    child.once("exit", () => { exited = true; });
    child.unref();
  } finally { closeSync(logFd); }
  // The supervisor binds runtime.sock before it re-attaches the sessions left in ptyd, and only
  // answers once that is done; with a few dozen terminals that takes seconds. A status request that
  // times out while our child is still alive means "still starting", not "failed" — treating it as a
  // failure rolled back updates that were in fact coming up.
  const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let status: RuntimeStatus | null = null;
    try { status = await runtimeStatus(home); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_RUNTIME_TIMEOUT" || exited) throw error; }
    if (status) return status;
    if (launchError) throw launchError;
    if (exited) throw new Error("本机运行组件启动失败，请查看 Coflux 日志");
    await delay(50);
  }
  // Give up on this instance for good, so a rollback that starts the previous version cannot
  // mistake it, answering a moment later, for the one it started.
  if (!exited) child.kill("SIGTERM");
  throw new Error("本机运行组件启动超时，请稍后重试");
}
