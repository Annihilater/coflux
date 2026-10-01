import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setInterval } from "node:timers";

import type { DesktopDaemonBusy, DesktopDaemonFda, DesktopDaemonState } from "../shared/desktop-bridge";
import { daemonServerUrl } from "../shared/daemon-urls";
import type { DaemonBundle } from "./daemon-bundle";
import { buildDaemonSettings, daemonSettingsJson, parseCredentialsDaemonId, parseFdaStatus, parsePendingAuth, parseSupervisorVersion } from "./daemon-files";
import { LAUNCHD_LABEL, type DaemonHomePaths } from "./daemon-paths";
import { deriveDaemonState, type DaemonFacts } from "./daemon-state";
import { bundlePtydId, bundleRuntimeId, leaveRuntime, ptydStatus, runtimeStatus, runtimeSupportsLeave, stageRuntime, startPtyd, startRuntime, stopPtyd, stopRuntime, type PtydStatus, type RuntimeStatus } from "./desktop-runtime";
import { resolveRuntimeUpdate, shouldFollowBundledRuntime, type RuntimeFollowFacts } from "./runtime-follow";
import { replaceSupervisor, shouldRestartSupervisor } from "./runtime-replace";

/**
 * 会结束本机终端的操作：退出 / 退出登录 / 停止 / 迁移旧 LaunchAgent / 更新 ptyd 本身，以及
 * 一种例外——在跑的 supervisor 早于 ptyd（没有 leave），这一次更新仍要结束终端（"最后一次痛"）。
 * 普通的 supervisor 更新与重启**不在**这里：终端留在 ptyd 里，不需要确认。
 */
export type StopReason = "quit" | "logout" | "stop" | "restart" | "migrate" | "update-ptyd";
export type DaemonCommands = {
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  openExternal: (url: string) => void;
  showItemInFolder: (path: string) => void;
};
export type DaemonManagerOptions = {
  paths: DaemonHomePaths;
  bundle: DaemonBundle | null;
  claudePluginDir: string | null;
  clientServerUrl: string;
  hostname: string;
  uid: number;
  platform: NodeJS.Platform;
  appPath: string;
  confirmStop: (reason: StopReason, count: number | null) => Promise<boolean>;
  /**
   * Every outcome of a local-runtime stop, confirmed or not. The single choke point for anything
   * that must react to the runtime going away — today the executor host, which cancels its running
   * jobs (see `executor-lifecycle`). Declined stops are reported too, so the listener can tell "the
   * user backed out" from "it never happened"; it must not be used to infer a stop on its own.
   */
  onStopOutcome?: (reason: StopReason, confirmed: boolean) => void;
  commands: DaemonCommands;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};
export type DaemonManager = {
  getState: () => DesktopDaemonState;
  refresh: () => Promise<void>;
  onChange: (listener: (state: DesktopDaemonState) => void) => () => void;
  /**
   * Runs the account check that precedes an enrollment and reports whether it passed, so the caller
   * can skip `enroll()` on failure. It shares `busy` / `error` with the other actions — a failure
   * shows up in the same status line and onboarding step — and differs from `run()` in three ways
   * that matter here: it returns its outcome, it waits for an in-flight action instead of quietly
   * skipping the check, and it stays out of the `action` slot so `stopForExit` never has to wait out
   * a stalled network handshake.
   */
  verifyAccount: (check: () => Promise<void>) => Promise<boolean>;
  enroll: () => Promise<void>;
  /**
   * 重启 / 更新 supervisor：终端留在 ptyd 里，不确认；新版起不来自动回滚到上一版。
   * A stale leave-capable runtime is replaced automatically once per launch
   * (plan 20261002-runtime-follows-app); this verb is 「重试」 after that attempt failed, and the
   * confirmed 「更新」 for a supervisor that predates ptyd.
   */
  restart: () => Promise<void>;
  /** 更新 ptyd 本身：会结束终端，确认后停掉两者再从内置版本起 */
  updatePtyd: () => Promise<void>;
  stop: () => Promise<void>;
  remove: () => Promise<void>;
  stopForExit: (reason: "quit" | "logout") => Promise<boolean>;
  openFdaGuide: () => void;
  dismissError: () => void;
  dispose: () => void;
};
export function execCommand(file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(file, [...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  }));
}
function readText(path: string): string | null { try { return readFileSync(path, "utf8"); } catch { return null; } }

/** 权限授予主应用，由主进程重新探测；不能沿用跨更新存活内核的启动时缓存。只打开目录，不读取内容。 */
function appFdaStatus(): DesktopDaemonFda {
  try { opendirSync(join(homedir(), "Library/Safari")).closeSync(); return "granted"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "denied" : "unknown";
  }
}

/** 两次自动拉起 supervisor 之间的最短间隔：起不来就别每 1.5 秒撞一次。 */
const SUPERVISOR_RESTART_BACKOFF_MS = 10_000;

/**
 * 桌面拥有生命周期，托管实例可跨更新存活。旧 LaunchAgent 仅用于有确认的迁移。
 *
 * plan 20260918-ptyd-terminal-custody：两个进程——ptyd（持 PTY，长生）与 supervisor（可随时换）。
 * "运行中"与"几个终端"两个事实来自 ptyd，不只来自 supervisor：supervisor 缺席的那几秒里面板不能翻成
 * 「已停止」去引诱用户起第二个实例。supervisor 崩了由看门狗自动拉起；更新 supervisor 不确认、不结束终端。
 */
export function createDaemonManager(options: DaemonManagerOptions): DaemonManager {
  const { paths, bundle, commands, log } = options;
  const desiredId = bundle ? bundleRuntimeId(bundle) : null;
  const desiredPtydId = bundle ? bundlePtydId(bundle) : null;
  const marker = join(paths.home, "desktop-runtime");
  const runtimeDir = (id: string) => join(paths.home, "desktop-runtimes", id);
  const listeners = new Set<(state: DesktopDaemonState) => void>();
  let runtime: RuntimeStatus | null = null;
  let ptyd: PtydStatus | null = null;
  let busy: DesktopDaemonBusy | undefined;
  let error: DaemonFacts["error"];
  let refreshError: DaemonFacts["error"];
  let disposed = false;
  let action: Promise<void> | null = null;
  let lastAutoRestartFailureAt: number | null = null;
  /**
   * Bundled runtime ids an automatic replacement was dispatched for during this app launch
   * (plan 20261002-runtime-follows-app). Never cleared: a version that failed to start does not
   * get a second automatic try; only the user's 「重试」 does, and an app restart starts afresh.
   */
  const followAttempted = new Set<string>();
  let state = derive();

  function liveTerminals(): number {
    if (ptyd) return ptyd.sessions.filter((session) => !session.exited).length;
    return runtime?.sessions.length ?? 0;
  }
  function followFacts(): RuntimeFollowFacts {
    return {
      bundledId: desiredId,
      running: runtime ? { runtimeId: runtime.runtimeId, supportsLeave: runtimeSupportsLeave(runtime) } : null,
      ptydAlive: ptyd !== null,
      attempted: followAttempted,
    };
  }
  function derive(): DesktopDaemonState {
    const registered = existsSync(paths.credentials);
    const installed = existsSync(marker);
    const runtimeUpdate = resolveRuntimeUpdate(followFacts());
    const facts: DaemonFacts = {
      bundle: bundle ? { version: bundle.version } : null,
      installationExists: installed, supervisorExists: installed, workerExists: installed,
      registered, daemonId: registered ? parseCredentialsDaemonId(readText(paths.credentials)) : null,
      pendingAuth: registered ? null : parsePendingAuth(readText(paths.pendingAuth)),
      // ptyd 活着就是"在跑"：supervisor 正在被替换 / 被看门狗拉起的窗口里终端一个都没少。
      running: runtime !== null || ptyd !== null,
      fda: options.platform === "darwin" ? appFdaStatus() : parseFdaStatus(readText(paths.fdaStatus)),
      runningVersion: runtime?.version ?? parseSupervisorVersion(readText(paths.supervisorVersion)),
      binDir: paths.binDir,
      updateReadyOverride: runtimeUpdate !== null,
      ...(busy ? { busy } : {}), ...((error ?? refreshError) ? { error: error ?? refreshError } : {}),
    };
    return {
      ...deriveDaemonState(facts),
      runningTerminals: liveTerminals(),
      legacyInstallation: !installed && existsSync(paths.plist),
      // ptyd 的身份单独比：只换 supervisor 的更新不清这个标志，也不会把旧 ptyd 当成已更新。
      ptydUpdateReady: !!(ptyd && desiredPtydId && ptyd.identity !== desiredPtydId),
      ...(runtimeUpdate ? { runtimeUpdate } : {}),
    };
  }
  function emit(): void { if (!disposed) { state = derive(); for (const listener of listeners) listener(state); } }
  async function refresh(): Promise<void> {
    try { runtime = await runtimeStatus(paths.home); refreshError = undefined; }
    catch (failure) { refreshError = { action: "start", message: failure instanceof Error ? failure.message : String(failure) }; }
    try { ptyd = await ptydStatus(paths.home); }
    catch (failure) { log.warn("读取本机终端托管进程状态失败", String(failure)); ptyd = null; }
    emit();
    watchdog();
    follow();
  }
  /**
   * The runtime follows the app (plan 20261002-runtime-follows-app): a running, leave-capable
   * supervisor on another runtimeId than the bundled one is replaced without a click — on app
   * start, including the restart after an app auto-update. Terminals stay in ptyd. Once per launch
   * per bundled id: the attempt is recorded before it runs, so a failure (rolled back by
   * `restartSupervisor`) stays on the panel as 「更新未能应用」 + 「重试」 and never loops.
   */
  function follow(): void {
    if (disposed || !desiredId) return;
    if (!shouldFollowBundledRuntime({ ...followFacts(), busy: action !== null })) return;
    followAttempted.add(desiredId);
    log.info("本机运行组件与内置版本不同，自动更新到内置版本", { running: runtime?.runtimeId, bundled: desiredId });
    void run("update", restartSupervisor);
  }
  /** supervisor 崩了（ptyd 还在、标记还在、没有动作在跑）：从标记指向的目录把它拉起来，不停在「已停止」等人点。 */
  function watchdog(): void {
    if (disposed) return;
    const facts = {
      ptydAlive: ptyd !== null, supervisorAlive: runtime !== null, installed: existsSync(marker), busy: action !== null,
      lastFailureAt: lastAutoRestartFailureAt, now: Date.now(), backoffMs: SUPERVISOR_RESTART_BACKOFF_MS,
    };
    if (!shouldRestartSupervisor(facts)) return;
    log.info("本机运行组件不在而终端托管进程仍在，自动拉起 supervisor");
    void run("start", async () => {
      const id = readText(marker)?.trim();
      if (!id || !existsSync(runtimeDir(id))) throw new Error("找不到本机运行组件目录，请重新接入");
      try { runtime = await startRuntime(paths.home, runtimeDir(id), id, paths.logFile); }
      catch (failure) { lastAutoRestartFailureAt = Date.now(); throw failure; }
      lastAutoRestartFailureAt = null;
    });
  }
  async function run(kind: DesktopDaemonBusy, body: () => Promise<void>): Promise<void> {
    if (action) return action;
    busy = kind;
    error = undefined;
    emit();
    action = (async () => {
      try { await body(); }
      catch (failure) {
        error = { action: kind, message: failure instanceof Error ? failure.message : String(failure) };
        log.warn("本机操作失败", { action: kind, message: error.message });
      } finally { busy = undefined; action = null; await refresh(); }
    })();
    return action;
  }
  /** See `DaemonManager.verifyAccount`. Deliberately beside `run()`, not inside it. */
  async function verifyAccount(check: () => Promise<void>): Promise<boolean> {
    // Waiting, never returning the in-flight action: a reconnect landing during a restart must
    // still verify the account, not inherit that action's result.
    while (action) await action;
    busy = "connect";
    error = undefined;
    emit();
    try {
      await check();
      return true;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      log.warn("本机操作失败", { action: "connect", message });
      // Staying out of the `action` slot means a run() can start while `check()` is still in flight,
      // and it then owns `busy` / `error` — it cleared `error` for itself and the user is watching
      // the restart they just asked for. Write only while the `connect` slot is still ours.
      if (busy === "connect") error = { action: "connect", message };
      return false;
    } finally { if (busy === "connect") { busy = undefined; emit(); } }
  }
  async function migrateLegacy(): Promise<boolean> {
    if (!existsSync(paths.plist)) return true;
    // 不自动接管系统服务：用户必须知道迁移会结束其终端。
    if (!await options.confirmStop("migrate", null)) return false;
    if (options.platform === "darwin") {
      const found = await commands.exec("/bin/launchctl", ["print", `gui/${options.uid}/${LAUNCHD_LABEL}`]);
      if (found.code === 0) {
        const stopped = await commands.exec("/bin/launchctl", ["unload", paths.plist]);
        if (stopped.code !== 0) throw new Error("旧版本仍在运行，已取消切换，请稍后重试");
      }
    }
    rmSync(paths.plist, { force: true });
    return true;
  }
  function installCli(): void {
    if (!bundle) return;
    mkdirSync(paths.binDir, { recursive: true });
    const temporary = `${paths.cliBin}.staged-${process.pid}`;
    try {
      copyFileSync(join(bundle.dir, "coflux"), temporary);
      chmodSync(temporary, 0o755);
      renameSync(temporary, paths.cliBin);
      // 清掉旧桌面注入的同名操作工具，避免它在 PATH 中遮住 npm 的宿主入口。
      rmSync(join(paths.binDir, "cofluxd"), { force: true });
    } finally { rmSync(temporary, { force: true }); }
  }
  /** 落盘配置、内容寻址目录、CLI；返回新目录。 */
  function prepare(): string {
    if (!bundle || !desiredId) throw new Error("此安装包不完整，请重新安装 Coflux");
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    chmodSync(paths.home, 0o700);
    let previous: unknown;
    try { previous = JSON.parse(readText(paths.settings) ?? "null"); } catch { previous = null; }
    writeFileSync(paths.settings, daemonSettingsJson(buildDaemonSettings(previous, {
      serverUrl: daemonServerUrl(options.clientServerUrl), hostname: options.hostname,
    })), { mode: 0o600 });
    const directory = stageRuntime(paths.home, bundle, desiredId);
    installCli();
    return directory;
  }
  function writeMarker(id: string): void { writeFileSync(marker, `${id}\n`, { mode: 0o600 }); }
  async function start(): Promise<void> {
    // 先验证真实运行实例，不因版本变化杀掉它或重写它使用的插件/CLI。
    runtime = await runtimeStatus(paths.home);
    ptyd = await ptydStatus(paths.home);
    if (runtime) { installCli(); return; }
    if (!bundle || !desiredId || !desiredPtydId) throw new Error("此安装包不完整，请重新安装 Coflux");
    if (!await migrateLegacy()) return;
    const directory = prepare();
    // ptyd 先于 supervisor：supervisor 连不上它会直接退出。ptyd 已在跑（看门狗 / 上次更新留下的）就沿用——
    // 它的身份与内置不同时面板另给「更新终端组件」动作，绝不在这里悄悄换掉它。
    if (!ptyd) ptyd = await startPtyd(paths.home, directory, desiredPtydId, paths.logFile);
    writeMarker(desiredId);
    runtime = await startRuntime(paths.home, directory, desiredId, paths.logFile);
  }
  /**
   * 重启 / 更新 supervisor：leave → 起内置版本 → 标记指向新目录；起不来就把上一版目录再起一次、标记回退，
   * 并把「更新未能应用」报到面板。终端全程留在 ptyd 里。在跑的 supervisor 早于 ptyd 时没有 leave，
   * 这一次只能走有确认的停止 + 启动（发行说明里写明的那"最后一次痛"）。
   */
  async function restartSupervisor(): Promise<void> {
    runtime = await runtimeStatus(paths.home);
    ptyd = await ptydStatus(paths.home);
    if (!runtime) { await start(); return; }
    if (!runtimeSupportsLeave(runtime) || !ptyd) {
      if (await stopConfirmed("restart")) await start();
      return;
    }
    if (!bundle || !desiredId) throw new Error("此安装包不完整，请重新安装 Coflux");
    const previousId = readText(marker)?.trim() || runtime.runtimeId;
    const previousDir = runtimeDir(previousId);
    const nextDir = prepare();
    const current = runtime;
    const outcome = await replaceSupervisor<RuntimeStatus>({
      leave: () => leaveRuntime(paths.home, current),
      startNext: () => startRuntime(paths.home, nextDir, desiredId, paths.logFile),
      startPrevious: () => existsSync(previousDir)
        ? startRuntime(paths.home, previousDir, previousId, paths.logFile)
        : Promise.reject(new Error("上一版本目录已不存在")),
      writeMarker,
      nextId: desiredId,
      previousId,
    });
    if (outcome.ok) { runtime = outcome.status; return; }
    runtime = await runtimeStatus(paths.home);
    if (outcome.rolledBack) throw new Error(`更新未能应用，已恢复上一版本，终端未受影响：${outcome.error.message}`);
    throw new Error(`更新未能应用，且上一版本也未能重新启动：${outcome.error.message}（${outcome.rollbackError?.message ?? ""}）`);
  }
  /**
   * 结束本机全部终端：先让 supervisor 走 stop（它让 ptyd 杀掉每个 shell），再让 ptyd 退出。
   * supervisor 不在而 ptyd 在（替换窗口 / 崩溃）时只停 ptyd——那同样结束终端，所以同样要确认。
   */
  async function stopConfirmed(reason: StopReason): Promise<boolean> {
    const outcome = (confirmed: boolean): boolean => {
      options.onStopOutcome?.(reason, confirmed);
      return confirmed;
    };
    runtime = await runtimeStatus(paths.home);
    ptyd = await ptydStatus(paths.home);
    // Nothing to stop, but the caller still proceeds with the stop; report it as confirmed.
    if (!runtime && !ptyd) return outcome(true);
    const count = liveTerminals();
    if (count && !await options.confirmStop(reason, count)) return outcome(false);
    if (runtime) await stopRuntime(paths.home, runtime);
    runtime = null;
    if (ptyd) await stopPtyd(paths.home, ptyd);
    ptyd = null;
    emit();
    return outcome(true);
  }
  const poll = setInterval(() => { if (!action) void refresh(); }, 1500);
  poll.unref();
  void refresh();
  return {
    getState: () => state, refresh,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    verifyAccount,
    enroll: () => run("start", start),
    // A restart that lands on another runtime is an update (「重试」 / the pre-ptyd 「更新」): its
    // status line and failure line must say so.
    restart: () => run(resolveRuntimeUpdate(followFacts()) ? "update" : "restart", restartSupervisor),
    updatePtyd: () => run("restart", async () => { if (await stopConfirmed("update-ptyd")) await start(); }),
    stop: () => run("stop", async () => { await stopConfirmed("stop"); }),
    remove: () => run("remove", async () => { if (await stopConfirmed("stop")) rmSync(marker, { force: true }); }),
    stopForExit: async (reason) => {
      if (action) await action;
      return stopConfirmed(reason);
    },
    openFdaGuide: () => {
      commands.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      commands.showItemInFolder(options.appPath);
    },
    dismissError: () => { error = undefined; emit(); },
    dispose: () => { disposed = true; clearInterval(poll); listeners.clear(); },
  };
}
