import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setInterval } from "node:timers";

import type { DesktopDaemonBusy, DesktopDaemonFda, DesktopDaemonState } from "../shared/desktop-bridge";
import { daemonServerUrl } from "../shared/daemon-urls";
import type { DaemonBundle } from "./daemon-bundle";
import { buildDaemonSettings, daemonSettingsJson, parseCredentialsDaemonId, parseFdaStatus, parsePendingAuth, parseRuntimeVersion } from "./daemon-files";
import { LAUNCHD_LABEL, type DaemonHomePaths } from "./daemon-paths";
import { deriveDaemonState, type DaemonFacts } from "./daemon-state";
import { bundleLauncherId, bundlePtydId, bundleRuntimeId, leaveRuntime, ptydStatus, readVersionStamp, runtimeIsLauncher, runtimeStatus, runtimeSupportsLeave, stageRuntime, startPtyd, startRuntime, stopPtyd, stopRuntime, switchRuntime, type PtydStatus, type RuntimeStatus } from "./desktop-runtime";
import { resolveRuntimeUpdate, shouldFollowBundledRuntime, type RuntimeFollowFacts } from "./runtime-follow";

/**
 * 会结束本机终端的操作：退出 / 退出登录 / 停止 / 迁移旧 LaunchAgent / 更新 ptyd 本身，以及
 * 一种例外——在跑的 supervisor 早于 ptyd（没有 leave），这一次更新仍要结束终端（"最后一次痛"）。
 * 普通的运行组件更新与重启**不在**这里：终端留在 ptyd 里，不需要确认。
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
   * 重启 / 更新运行组件：终端留在 ptyd 里，不确认；launcher 自己观察新版本、起不来自动回滚。
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

/**
 * 桌面拥有生命周期，托管实例可跨更新存活。旧 LaunchAgent 仅用于有确认的迁移。
 *
 * plan 20261002-runtime-launcher-merge：三个进程——ptyd（持 PTY，长生）、launcher（持 runtime.sock，
 * 管版本指针、观察期与回滚，很少变）与 runtime（会话权威 + 中心连接，随 app 更新）。app 只起
 * launcher，之后请它切换 runtime；它自己不起、不杀、不回滚 runtime。"运行中"与"几个终端"两个事实来自
 * ptyd 与 launcher：launcher 在，runtime 换来换去面板都不翻；launcher 不在而 ptyd 还在（launcher 崩了）
 * 面板停在「已停止」让用户点「启动」——起 launcher 接回终端，没有 app 侧看门狗。
 */
export function createDaemonManager(options: DaemonManagerOptions): DaemonManager {
  const { paths, bundle, commands, log } = options;
  const desiredId = bundle ? bundleRuntimeId(bundle) : null;
  const desiredPtydId = bundle ? bundlePtydId(bundle) : null;
  const desiredLauncherId = bundle ? bundleLauncherId(bundle) : null;
  const marker = join(paths.home, "desktop-runtime");
  const listeners = new Set<(state: DesktopDaemonState) => void>();
  let runtime: RuntimeStatus | null = null;
  let ptyd: PtydStatus | null = null;
  let busy: DesktopDaemonBusy | undefined;
  let error: DaemonFacts["error"];
  let refreshError: DaemonFacts["error"];
  let disposed = false;
  let action: Promise<void> | null = null;
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
      installationExists: installed, launcherExists: installed, runtimeExists: installed,
      registered, daemonId: registered ? parseCredentialsDaemonId(readText(paths.credentials)) : null,
      pendingAuth: registered ? null : parsePendingAuth(readText(paths.pendingAuth)),
      // The launcher answers across runtime swaps; while the app itself is replacing the launcher
      // (an action is in flight) the terminals in ptyd keep the panel from flipping to 「已停止」.
      running: runtime !== null || (ptyd !== null && action !== null),
      fda: options.platform === "darwin" ? appFdaStatus() : parseFdaStatus(readText(paths.fdaStatus)),
      runningVersion: parseRuntimeVersion(readText(paths.runtimeVersion)) ?? runtime?.runtimeVersion ?? null,
      binDir: paths.binDir,
      updateReadyOverride: runtimeUpdate !== null,
      ...(busy ? { busy } : {}), ...((error ?? refreshError) ? { error: error ?? refreshError } : {}),
    };
    return {
      ...deriveDaemonState(facts),
      runningTerminals: liveTerminals(),
      legacyInstallation: !installed && existsSync(paths.plist),
      // ptyd 的身份单独比：只换 launcher / runtime 的更新不清这个标志，也不会把旧 ptyd 当成已更新。
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
    follow();
  }
  /**
   * The runtime follows the app (plan 20261002-runtime-follows-app): a running, leave-capable
   * process on another runtimeId than the bundled one is replaced without a click — on app start,
   * including the restart after an app auto-update. Terminals stay in ptyd. Once per launch per
   * bundled id: the attempt is recorded before it runs, so a failure (rolled back by the launcher)
   * stays on the panel as 「更新未能应用」 + 「重试」 and never loops.
   */
  function follow(): void {
    if (disposed || !desiredId) return;
    if (!shouldFollowBundledRuntime({ ...followFacts(), busy: action !== null })) return;
    followAttempted.add(desiredId);
    log.info("本机运行组件与内置版本不同，自动更新到内置版本", { running: runtime?.runtimeId, bundled: desiredId });
    void run("update", followBundledRuntime);
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
  /** Start the bundled launcher from `directory` (ptyd must already answer). */
  async function startLauncher(directory: string): Promise<void> {
    if (!desiredId || !desiredLauncherId) throw new Error("此安装包不完整，请重新安装 Coflux");
    runtime = await startRuntime(paths.home, directory, desiredId, desiredLauncherId, paths.logFile);
    writeMarker(desiredId);
  }
  async function start(): Promise<void> {
    // 先验证真实运行实例，不因版本变化杀掉它或重写它使用的插件/CLI。
    runtime = await runtimeStatus(paths.home);
    ptyd = await ptydStatus(paths.home);
    if (runtime) { installCli(); return; }
    if (!bundle || !desiredId || !desiredPtydId) throw new Error("此安装包不完整，请重新安装 Coflux");
    if (!await migrateLegacy()) return;
    const directory = prepare();
    // ptyd 先于 launcher：runtime 连不上它会直接退出。ptyd 已在跑（上次更新留下的 / launcher 崩了）就沿用——
    // 它的身份与内置不同时面板另给「更新终端组件」动作，绝不在这里悄悄换掉它。
    if (!ptyd) ptyd = await startPtyd(paths.home, directory, desiredPtydId, paths.logFile);
    await startLauncher(directory);
  }
  /**
   * Move the running process onto the bundled version with terminals kept, or plainly restart it
   * (plan 20261002-runtime-launcher-merge):
   * - no process on runtime.sock → start;
   * - a supervisor that predates ptyd (no `leave`), or no ptyd → the confirmed stop + start
   *   (the "last painful upgrade");
   * - a pre-plan leave-capable supervisor → `leave` it and start the launcher (migration);
   * - a launcher whose binary differs from the bundled one, or a plain restart → `leave` it and
   *   start the bundled launcher, which runs the bundled runtime;
   * - a launcher on another runtime → ask it to switch; it observes the candidate and rolls back
   *   by itself, and the failure surfaces as 「更新未能应用」.
   */
  async function followBundledRuntime(): Promise<void> {
    runtime = await runtimeStatus(paths.home);
    ptyd = await ptydStatus(paths.home);
    if (!runtime) { await start(); return; }
    if (!runtimeSupportsLeave(runtime) || !ptyd) {
      if (await stopConfirmed("restart")) await start();
      return;
    }
    if (!bundle || !desiredId || !desiredLauncherId) throw new Error("此安装包不完整，请重新安装 Coflux");
    const directory = prepare();
    const current = runtime;
    const launcherCurrent = runtimeIsLauncher(current) && current.launcherId === desiredLauncherId;
    if (launcherCurrent && current.runtimeId !== desiredId) {
      runtime = await switchRuntime(paths.home, current, { runtimeId: desiredId, directory, version: readVersionStamp(directory) });
      writeMarker(desiredId);
      return;
    }
    // Launcher replacement (or migration from a pre-plan supervisor): terminals stay in ptyd.
    await leaveRuntime(paths.home, current);
    await startLauncher(directory);
  }
  /**
   * 结束本机全部终端：先让 launcher 走 stop（它让 ptyd 杀掉每个 shell），再让 ptyd 退出。
   * launcher 不在而 ptyd 在时只停 ptyd——那同样结束终端，所以同样要确认。
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
    restart: () => run(resolveRuntimeUpdate(followFacts()) ? "update" : "restart", followBundledRuntime),
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
