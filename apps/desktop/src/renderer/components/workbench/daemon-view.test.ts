import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopDaemonState } from "@/desktop-bridge";
import {
  authorizeStepDetail,
  daemonStatusLine,
  resolveDaemonActions,
  resolveOnboardingPage,
  resolveOnboardingSteps,
  shouldOfferOnboarding,
} from "./daemon-view";

const RUNNING: DesktopDaemonState = {
  status: "running",
  bundled: true,
  bundledVersion: "v0.0.0-desktop.0.1.7",
  runningVersion: "v0.0.0-desktop.0.1.7",
  installed: true,
  running: true,
  registered: true,
  fda: "granted",
  daemonId: "d-1",
  binDir: "/Users/alice/.coflux/bin",
};
const NOT_INSTALLED: DesktopDaemonState = { status: "not-installed", bundled: true, installed: false, running: false, registered: false, fda: "unknown", binDir: "/Users/alice/.coflux/bin" };
const PENDING: DesktopDaemonState = { ...RUNNING, status: "pending-auth", registered: false, daemonId: undefined, authToken: "tok", fda: "unknown" };

test("移除接入永远要二次确认，且是破坏性动作", () => {
  const remove = resolveDaemonActions(RUNNING, 0).find((action) => action.id === "remove");
  assert.ok(remove?.confirm, "移除接入永远二次确认");
  assert.equal(remove?.kind, "destructive");
});

test("supervisor 的重启与更新不再确认（终端留在 ptyd 里）；停止、移除、更新终端组件才确认", () => {
  // 有 3 个终端在跑：过去重启 / 更新都要确认，现在不确认——终端不会结束。
  const running = resolveDaemonActions(RUNNING, 3);
  assert.equal(running.find((action) => action.id === "restart")?.confirm, undefined, "重启不结束终端，不确认");
  assert.ok(running.find((action) => action.id === "stop")?.confirm, "停止结束终端，仍确认");
  assert.ok(running.find((action) => action.id === "remove")?.confirm);
  assert.equal(running.find((action) => action.id === "update-ptyd"), undefined, "ptyd 没变就没有这个动作");

  const updateReady = resolveDaemonActions({ ...RUNNING, status: "update-ready", bundledVersion: "v2.2.0" }, 3);
  const update = updateReady.find((action) => action.id === "update");
  assert.ok(update, "有更新时给出更新动作");
  assert.equal(update?.confirm, undefined, "更新 supervisor 不结束终端，不确认");
  assert.equal(update?.kind, "primary");

  // ptyd 本身变了：单独的动作，永远确认，文案带终端数并说明会结束终端。
  const ptydChanged = resolveDaemonActions({ ...RUNNING, ptydUpdateReady: true }, 2);
  const updatePtyd = ptydChanged.find((action) => action.id === "update-ptyd");
  assert.ok(updatePtyd?.confirm, "更新终端组件结束终端，必须确认");
  assert.match(updatePtyd?.confirm?.description ?? "", /会结束本机 2 个正在运行的终端/);
  assert.equal(ptydChanged.find((action) => action.id === "restart")?.confirm, undefined, "同时不影响 supervisor 重启的无确认");
  // 也出现在 update-ready 与 pending-auth 里，且不与 supervisor 更新合并成一个动作。
  const both = resolveDaemonActions({ ...RUNNING, status: "update-ready", ptydUpdateReady: true }, 1);
  assert.ok(both.find((action) => action.id === "update"));
  assert.ok(both.find((action) => action.id === "update-ptyd")?.confirm);
  assert.ok(resolveDaemonActions({ ...PENDING, ptydUpdateReady: true }, 0).find((action) => action.id === "update-ptyd"));

  assert.match(daemonStatusLine({ ...RUNNING, status: "update-ready", bundledVersion: "v2.2.0" }).detail, /保留本机终端/);
});

test("运行组件跟随应用：留在 ptyd 里的旧运行组件自动更新、没有「更新」；失败后给「重试」；旧 supervisor 保留「更新」", () => {
  const stale: DesktopDaemonState = { ...RUNNING, status: "update-ready", bundledVersion: "v2.16.0", runningVersion: "v2.15.0" };

  // 主进程正自己换：面板上没有任何更新动作，状态行说明会自动更新并保留终端。
  const automatic = resolveDaemonActions({ ...stale, runtimeUpdate: "automatic" }, 3);
  assert.equal(automatic.find((action) => action.id === "update"), undefined, "自动更新不需要点击");
  assert.ok(automatic.find((action) => action.id === "stop")?.confirm, "停止仍在、仍确认");
  assert.match(daemonStatusLine({ ...stale, runtimeUpdate: "automatic" }).detail, /自动更新.*保留本机终端/);

  // 自动更新起不来、已回滚：「重试」是主动作、不确认；错误行被清掉后状态行仍说明没应用。
  const failed = resolveDaemonActions({ ...stale, runtimeUpdate: "failed" }, 3);
  const retry = failed.find((action) => action.id === "update");
  assert.equal(retry?.label, "重试");
  assert.equal(retry?.kind, "primary");
  assert.equal(retry?.confirm, undefined, "重试同样不结束终端，不确认");
  assert.match(daemonStatusLine({ ...stale, runtimeUpdate: "failed" }).detail, /更新未能应用/);
  const failedLine = daemonStatusLine({ ...stale, runtimeUpdate: "failed", error: { action: "update", message: "更新未能应用，已恢复上一版本，终端未受影响：新版启动超时" } });
  assert.equal(failedLine.detail, "更新服务失败：更新未能应用，已恢复上一版本，终端未受影响：新版启动超时");
  assert.equal(failedLine.tone, "error");
  assert.equal(daemonStatusLine({ ...stale, busy: "update" }).label, "正在更新服务…");

  // 早于 ptyd 的 supervisor：没有 leave，只能由用户点「更新」（主进程在原生对话框里确认结束终端）。
  const manual = resolveDaemonActions({ ...stale, runtimeUpdate: "manual" }, 3);
  assert.equal(manual.find((action) => action.id === "update")?.label, "更新");
  assert.equal(manual[0]?.id, "update", "「更新」仍是第一个动作");
  // 「更新终端组件」在三种情况下都单独保留。
  for (const runtimeUpdate of ["automatic", "failed", "manual"] as const) {
    assert.ok(resolveDaemonActions({ ...stale, runtimeUpdate, ptydUpdateReady: true }, 1).find((action) => action.id === "update-ptyd")?.confirm);
  }
});

test("自动弹引导：只在中心已连上的 authed + 未接入 + 带 daemon + 没点过暂不 + 本次登录未弹过", () => {
  const base = { authState: "authed" as const, connection: "connected" as const, state: NOT_INSTALLED, dismissed: false, alreadyOffered: false };
  assert.equal(shouldOfferOnboarding(base), true);
  assert.equal(shouldOfferOnboarding({ ...base, connection: "connecting" }), false, "离线冷启动的 authed 来自缓存，不弹");
  assert.equal(shouldOfferOnboarding({ ...base, connection: "disconnected" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, authState: "authenticating" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, authState: "need-login" }), false);
  assert.equal(shouldOfferOnboarding({ ...base, state: null }), false, "状态未到不弹");
  assert.equal(shouldOfferOnboarding({ ...base, state: RUNNING }), false, "已接入静默");
  assert.equal(shouldOfferOnboarding({ ...base, state: { ...RUNNING, status: "stopped", running: false } }), false);
  assert.equal(shouldOfferOnboarding({ ...base, state: { ...NOT_INSTALLED, bundled: false } }), false);
  assert.equal(shouldOfferOnboarding({ ...base, dismissed: true }), false);
  assert.equal(shouldOfferOnboarding({ ...base, alreadyOffered: true }), false);
});

test("引导页：未开始且未接入 = 说明页；进行中 = 进度页；已登记 = FDA 页或完成页", () => {
  const fresh = { started: false, authError: null, fdaSettled: false };
  assert.equal(resolveOnboardingPage(NOT_INSTALLED, fresh), "intro");
  assert.equal(resolveOnboardingPage(NOT_INSTALLED, { ...fresh, started: true }), "progress");
  assert.equal(resolveOnboardingPage({ ...NOT_INSTALLED, busy: "install" }, { ...fresh, started: true }), "progress");
  assert.equal(resolveOnboardingPage(PENDING, fresh), "progress", "从账号菜单进来时等待授权直接是进度页");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "unknown" }, fresh), "fda");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "denied" }, fresh), "fda");
  assert.equal(resolveOnboardingPage(RUNNING, fresh), "done", "已授予 FDA 直接完成");
  assert.equal(resolveOnboardingPage({ ...RUNNING, fda: "denied" }, { ...fresh, fdaSettled: true }), "done");
  // FDA 页点「重启服务」后进程短暂不在：不打回进度页
  assert.equal(resolveOnboardingPage({ ...RUNNING, status: "stopped", running: false, fda: "denied" }, { ...fresh, fdaSettled: true }), "done");
  assert.equal(resolveOnboardingPage({ ...RUNNING, status: "stopped", running: false, fda: "denied" }, fresh), "fda");
});

test("引导三步：安装 → 启动 → 授权 依次推进；失败落到对应步并给出重试动作", () => {
  const local = { started: true, authError: null, fdaSettled: false };
  const installing = resolveOnboardingSteps({ ...NOT_INSTALLED, busy: "install" }, local);
  assert.deepEqual([installing.install, installing.start, installing.authorize], ["active", "pending", "pending"]);
  assert.equal(installing.failure, null);

  const starting = resolveOnboardingSteps({ ...NOT_INSTALLED, installed: true, busy: "start" }, local);
  assert.deepEqual([starting.install, starting.start, starting.authorize], ["done", "active", "pending"]);
  // launchctl load 返回后、pid 还没出现：启动步仍是进行中
  const waitingPid = resolveOnboardingSteps({ ...RUNNING, status: "stopped", running: false, registered: false }, local);
  assert.deepEqual([waitingPid.install, waitingPid.start, waitingPid.authorize], ["done", "active", "pending"]);

  const authorizing = resolveOnboardingSteps(PENDING, local);
  assert.deepEqual([authorizing.install, authorizing.start, authorizing.authorize], ["done", "done", "active"]);
  assert.equal(authorizeStepDetail(PENDING, local), "授权中…（用当前登录账号）");
  assert.match(authorizeStepDetail({ ...PENDING, authToken: undefined }, local), /正在连接账号服务器/);

  const done = resolveOnboardingSteps(RUNNING, local);
  assert.deepEqual([done.install, done.start, done.authorize], ["done", "done", "done"]);
  assert.equal(authorizeStepDetail(RUNNING, local), "已用当前登录账号完成");

  const installFailed = resolveOnboardingSteps({ ...NOT_INSTALLED, error: { action: "install", message: "codesign 重签失败" } }, local);
  assert.equal(installFailed.install, "failed");
  assert.equal(installFailed.start, "pending");
  assert.equal(installFailed.failure, "安装组件失败：codesign 重签失败");
  assert.equal(installFailed.retry, "enroll");

  const startFailed = resolveOnboardingSteps({ ...NOT_INSTALLED, installed: true, error: { action: "start", message: "launchctl load 失败" } }, local);
  assert.deepEqual([startFailed.install, startFailed.start], ["done", "failed"]);
  assert.equal(startFailed.retry, "enroll");

  const authFailed = resolveOnboardingSteps(PENDING, { ...local, authError: "token 已过期" });
  assert.equal(authFailed.authorize, "failed");
  assert.equal(authFailed.failure, "授权失败：token 已过期");
  assert.equal(authFailed.retry, "authorize");
  assert.equal(authorizeStepDetail(PENDING, { ...local, authError: "token 已过期" }), "token 已过期");
  // 未开始（说明页）时三步全 pending
  const idle = resolveOnboardingSteps(NOT_INSTALLED, { ...local, started: false });
  assert.deepEqual([idle.install, idle.start, idle.authorize], ["pending", "pending", "pending"]);
});

test("账号接入是自己的一步：状态行说「接入账号」，引导里落在第一步并可重试", () => {
  // 失败的自动接入不再弹窗，只留在这台 Mac 的状态行上（plan 20260916）
  assert.equal(daemonStatusLine({ ...NOT_INSTALLED, busy: "connect" }).label, "正在接入账号…");
  const stalled = daemonStatusLine({ ...NOT_INSTALLED, error: { action: "connect", message: "连接账号服务器超时，请检查网络后重试" } });
  assert.equal(stalled.detail, "接入账号失败：连接账号服务器超时，请检查网络后重试");
  assert.equal(stalled.tone, "error");
  // 本机已在跑、只是账号校验失败：状态行仍要把原因说出来，而不是说启动失败
  const whileRunning = daemonStatusLine({ ...RUNNING, error: { action: "connect", message: "请先退出当前账号，再切换账号" } });
  assert.equal(whileRunning.label, "运行中");
  assert.equal(whileRunning.detail, "接入账号失败：请先退出当前账号，再切换账号");

  const local = { started: true, authError: null, fdaSettled: false };
  const checking = resolveOnboardingSteps({ ...NOT_INSTALLED, busy: "connect" }, local);
  assert.deepEqual([checking.install, checking.start, checking.authorize], ["active", "pending", "pending"]);
  assert.equal(checking.failure, null);
  const failed = resolveOnboardingSteps({ ...NOT_INSTALLED, error: { action: "connect", message: "请先登录 Coflux" } }, local);
  assert.deepEqual([failed.install, failed.start, failed.authorize], ["failed", "pending", "pending"]);
  assert.equal(failed.failure, "接入账号失败：请先登录 Coflux");
  assert.equal(failed.retry, "enroll");
});
