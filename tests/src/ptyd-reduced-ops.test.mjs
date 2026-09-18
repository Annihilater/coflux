import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice, utf8 } from "./device-harness.mjs";

// plan 20260918-ptyd-terminal-custody：ptyd 协议的兼容机制是能力握手。这里用测试专用的 op 宣告开关
// 模拟一个"旧 ptyd"（没有 checkpoint / blob / resizes / cursors），supervisor 必须照常建会话、收发输入输出，
// 而不是在第一次调用缺失的 op 时硬失败——否则 supervisor 升级又要求配套的 ptyd，整个方案就白做了。
const PORT = 8831;
const REDUCED_OPS = "open,spawn,list,subscribe,read,write,resize,kill,remove,status,shutdown";
let stack;
const repos = [];

before(async () => {
  stack = await startStack({ port: PORT, daemonEnv: { COFLUX_PTYD_TEST_OPS: REDUCED_OPS } });
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

test("ptyd 只宣告 v1 的一部分 op：supervisor 仍能建会话、写输入、读输出，并跨替换接回", async () => {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openNativeDevice(stack);
  const control = device.control;
  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "reduced" });
  const idle = await control.waitFor((m) => m.case === "taskUpdated" && m.task.title === "reduced", "idle");
  control.send({ case: "taskStart", taskId: idle.task.id, cols: 80, rows: 24 });
  const run = await control.waitFor((m) => m.case === "taskUpdated" && m.task.id === idle.task.id && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  await device.attach(sessionId);
  let from = device.mark();
  await device.input(sessionId, "echo REDUCED_OK\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("REDUCED_OK"), "输入输出照常", 10000, from);
  await device.resize(sessionId, 100, 30);

  // 没有 blob / cursors 也能接回：只回放 ring（退化路径），shell 不变。
  const catalogBefore = await device.catalog();
  const before = catalogBefore.sessions.find((session) => session.sessionId === sessionId);
  await stack.replaceSupervisor();
  await stack.waitDaemonOnline(30000);
  await device.openNative();
  const catalogAfter = await device.catalog();
  const after = catalogAfter.sessions.find((session) => session.sessionId === sessionId);
  assert.ok(after, "退化恢复仍然是一个活 session");
  assert.equal(after.pid, before.pid);
  await device.attach(sessionId);
  from = device.mark();
  await device.input(sessionId, "echo REDUCED_AFTER\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("REDUCED_AFTER"), "替换后输入输出照常", 10000, from);
  device.close();
});
