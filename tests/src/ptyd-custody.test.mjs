import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
// @xterm/headless 6 只发布 CJS 的 webpack 包（lib-headless/xterm-headless.js），Node 探测不出具名导出，
// 只能拿默认导出（= module.exports）再取 Terminal。
import xtermHeadless from "@xterm/headless";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice, utf8 } from "./device-harness.mjs";

// plan 20260918-ptyd-terminal-custody M6：替换 supervisor 时终端活着、屏幕不变、序号连续、输入恰好一次；
// 杀掉 supervisor 同样恢复；环绕过的 ring 配合 checkpoint 仍能重建。PTY 全程在 ptyd 里，supervisor 只是客户端。
const PORT = 8830;
const { Terminal } = xtermHeadless;
let stack;
const repos = [];

before(async () => {
  stack = await startStack({ port: PORT });
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

/**
 * 把 marker 写成 shell 会拼回原样、但**回显里看不到原样**的形式（`KEEP_''ALIVE`）：终端会先回显敲进去
 * 的命令行，等"marker 出现在输出里"若不这样写就会在回显上立刻命中，命令本身的输出还没来。
 */
function typed(marker) {
  return `${marker.slice(0, 3)}''${marker.slice(3)}`;
}

/** 把一份 ANSI snapshot 交给 headless xterm，读回可见文本行（去掉行尾空白）。 */
async function screenLines(snapshot, cols, rows) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 10000 });
  await new Promise((resolve) => terminal.write(snapshot, resolve));
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  terminal.dispose();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 当前 catalog 里某 session 的条目。 */
async function catalogEntry(device, sessionId) {
  const catalog = await device.catalog();
  return catalog.sessions.find((session) => session.sessionId === sessionId);
}

/** 输出命令并等它**自己的输出**（不是回显）到达。 */
async function run(device, sessionId, command, marker, timeout = 10000) {
  const from = device.mark();
  await device.input(sessionId, `${command}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId && utf8(m.data).includes(marker), marker, timeout, from);
  return from;
}

/**
 * 等 shell 安静：supervisor 报告的 output_seq 连续两次（间隔 400ms）不变。命令的输出（还有 shell 集成的
 * mark、下一条提示符）在 marker 之后仍会流一会儿；在它停下来之前取基线，就会把"还在流"误判成"替换改了序号"。
 */
async function settle(device, sessionId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let previous = (await catalogEntry(device, sessionId)).outputSeq;
  while (Date.now() < deadline) {
    await sleep(400);
    const current = (await catalogEntry(device, sessionId)).outputSeq;
    if (current === previous) return current;
    previous = current;
  }
  throw new Error("shell 迟迟不安静");
}

/** 起一个终端，打上 marker 并等它的输出出现；返回 device 与 session 坐标。 */
async function openTerminal(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openNativeDevice(stack);
  const control = device.control;
  control.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await control.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  control.send({ case: "taskCreate", workspaceId: main.workspace.id, title: marker });
  const idle = await control.waitFor((m) => m.case === "taskUpdated" && m.task.title === marker, "idle");
  const taskId = idle.task.id;
  control.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const running = await control.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = running.task.sessionId;
  await device.attach(sessionId);
  await run(device, sessionId, `echo ${typed(marker)}`, marker);
  return { device, taskId, sessionId };
}

/** supervisor 替换 / 崩溃后 worker 也换了一代：等设备重新在线，再开一条新的 native transport。 */
async function reconnect(device) {
  await stack.waitDaemonOnline(30000);
  await device.openNative();
}

/** 从 `from` 起收集该 session 的 ptyOutput，直到文本里出现 `until`；返回分片列表。 */
async function collectUntil(device, sessionId, from, until, timeout = 15000) {
  await device.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId && utf8(m.data).includes(until), until, timeout, from);
  return device.log.slice(from).filter((m) => m.case === "ptyOutput" && m.sessionId === sessionId);
}

test("替换 supervisor：shell 进程不变、序号逐字节相同、屏幕逐行相同、输入照常", async () => {
  const { device, sessionId } = await openTerminal("KEEP_ALIVE_MARK");
  // 基线必须在 shell 安静之后取：marker 之后还有 shell 集成的 mark 与下一条提示符在流。
  const settledSeq = await settle(device, sessionId);
  const before = await catalogEntry(device, sessionId);
  assert.ok(before, "替换前 session 在 catalog 里");
  assert.equal(before.outputSeq, settledSeq);
  const beforeSnapshot = await device.request("sessionSnapshotRequest", "sessionSnapshot", { sessionId });
  assert.equal(beforeSnapshot.snapshotSeq, before.outputSeq);
  const linesBefore = await screenLines(beforeSnapshot.ansiSnapshot, 80, 24);
  assert.ok(linesBefore.some((line) => line === "KEEP_ALIVE_MARK"), `屏幕上应有 marker 那一行：\n${linesBefore.join("\n")}`);
  const oldSupervisor = stack.supervisorPid();

  await stack.replaceSupervisor();
  assert.notEqual(stack.supervisorPid(), oldSupervisor, "确实换了一个 supervisor 进程");
  await reconnect(device);

  const after = await catalogEntry(device, sessionId);
  assert.ok(after, "替换后 session 仍在 catalog 里（没有变成 tombstone）");
  assert.equal(after.pid, before.pid, "shell 进程一个都没换");
  assert.equal(after.taskId, before.taskId, "task 归属从 ptyd 的标签里原样拿回");
  // 序号逐字节相同：重建既没有把已经数过的字节再数一遍（会大于），也没有跳过任何字节（会小于）。
  assert.equal(after.outputSeq, before.outputSeq, "shell 安静时替换前后序号必须逐字节相同");
  const afterSnapshot = await device.request("sessionSnapshotRequest", "sessionSnapshot", { sessionId });
  assert.equal(afterSnapshot.snapshotSeq, before.outputSeq);
  assert.deepEqual(await screenLines(afterSnapshot.ansiSnapshot, 80, 24), linesBefore, "屏幕与回滚逐行相同");

  // 用替换前的序号 resume：新 supervisor 必须认这个序号（不退化成整屏、也没有东西要补）。
  const resumed = await device.attach(sessionId, { resumeFromSeq: before.outputSeq });
  assert.equal(resumed.snapshotSeq, before.outputSeq, "替换前的 seq 在新 supervisor 里仍然有效");
  assert.equal(resumed.ansiSnapshot?.byteLength ?? 0, 0, "序号一致时 resume 不退化成整屏重绘");
  await run(device, sessionId, `echo ${typed("AFTER_REPLACE")}`, "AFTER_REPLACE");
  device.close();
});

test("替换期间的输出不丢，序号连续：计数器没有洞，resume 不退化成整屏", async () => {
  const { device, sessionId } = await openTerminal("COUNTER_MARK");
  const from = device.mark();
  // 每 20ms 一行递增计数，横跨整个替换窗口；最后一行是可等待的终止符（写法保证回显里不出现它）。
  await device.input(sessionId, `i=0; while [ $i -lt 200 ]; do i=$((i+1)); echo C$i; sleep 0.02; done; echo ${typed("COUNTER_END")}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId && utf8(m.data).includes("C10\r"), "计数已开始", 10000, from);
  const seen = device.log.slice(from).filter((m) => m.case === "ptyOutput" && m.sessionId === sessionId);
  const lastSeq = seen[seen.length - 1].toSeq;

  await stack.replaceSupervisor();
  await reconnect(device);
  // attach 的 replay 紧跟在 sessionAttached 之后，可能在 attach() 返回前就已入日志：起点取在 attach 之前。
  const resumeFrom = device.mark();
  const resumed = await device.attach(sessionId, { resumeFromSeq: lastSeq });
  assert.equal(resumed.ansiSnapshot?.byteLength ?? 0, 0, "按 seq 续上，不是整屏重绘");
  assert.equal(resumed.snapshotSeq, lastSeq);
  const chunks = await collectUntil(device, sessionId, resumeFrom, "COUNTER_END", 30000);
  // 序号首尾相接，且从 lastSeq + 1 开始。
  let expected = lastSeq + 1n;
  for (const chunk of chunks) {
    assert.equal(chunk.fromSeq, expected, `序号必须连续：期望 ${expected}，收到 ${chunk.fromSeq}`);
    expected = chunk.toSeq + 1n;
  }
  // 计数没有洞：替换前后拼起来的文本里 C1..C200 每个恰好一次、单调递增。第一行紧跟在 shell 集成的
  // OSC 133 mark（BEL 结尾）之后而不是换行之后，所以只认"C<数字>\r\n"这一形状；回显里的 `echo C$i;`
  // 后面跟的是分号，不会误命中。
  const text = [...seen, ...chunks].map((chunk) => utf8(chunk.data)).join("");
  const numbers = [...text.matchAll(/C(\d+)\r\n/g)].map((match) => Number(match[1]));
  assert.equal(numbers.length, 200, `应有 200 行计数，实际 ${numbers.length}`);
  numbers.forEach((value, index) => assert.equal(value, index + 1, `第 ${index + 1} 行应是 C${index + 1}`));
  device.close();
});

test("跨替换在途的输入恰好应用一次：客户端重投同一 seq 拿到重复回执，输出只有一份", async () => {
  const { device, sessionId } = await openTerminal("ONCE_MARK");
  const control = device.sessionControls.get(sessionId);
  const inputSeq = control.inputSeq + 1n;
  // 不等 ack 就替换：这条输入可能已进 PTY，也可能没有——两种情况下重投都必须恰好落地一次。
  device.send("ptyInput", { requestId: "inflight-once", sessionId, holderEpoch: control.holderEpoch, inputSeq, data: new TextEncoder().encode("echo ONCE_MARK_OUT\r") });
  await stack.replaceSupervisor();
  await reconnect(device);
  await device.attach(sessionId);
  const ack = await device.input(sessionId, "echo ONCE_MARK_OUT\r", { inputSeq });
  assert.ok(ack.appliedThroughSeq >= inputSeq, "重投同一 seq 拿到覆盖它的回执");
  await run(device, sessionId, `echo ${typed("ONCE_DONE")}`, "ONCE_DONE");
  const snapshot = await device.request("sessionSnapshotRequest", "sessionSnapshot", { sessionId });
  const lines = await screenLines(snapshot.ansiSnapshot, 80, 24);
  const outputs = lines.filter((line) => line.trim() === "ONCE_MARK_OUT");
  assert.equal(outputs.length, 1, `echo 的输出行应恰好一份，屏幕：\n${lines.join("\n")}`);
  device.close();
});

test("杀掉 supervisor：拉起后同样接回终端，屏幕与输入都在", async () => {
  const { device, sessionId } = await openTerminal("CRASH_MARK");
  await settle(device, sessionId);
  const before = await catalogEntry(device, sessionId);
  await stack.killSupervisor();
  await reconnect(device);
  const after = await catalogEntry(device, sessionId);
  assert.ok(after, "崩溃后 session 仍在");
  assert.equal(after.pid, before.pid);
  assert.equal(after.outputSeq, before.outputSeq, "崩溃恢复后序号逐字节相同");
  const attached = await device.attach(sessionId);
  const lines = await screenLines(attached.ansiSnapshot, 80, 24);
  assert.ok(lines.some((line) => line === "CRASH_MARK"), "屏幕内容在崩溃后仍在");
  await run(device, sessionId, `echo ${typed("AFTER_CRASH")}`, "AFTER_CRASH");
  device.close();
});

test("环绕过的 ring + 有效 checkpoint：超过 4 MiB 输出后替换，仍重建出正确屏幕并能续上", async () => {
  const { device, sessionId } = await openTerminal("WRAP_MARK");
  const from = device.mark();
  // 6 MB 的输出让 ring 环绕、并至少触发两次半环 checkpoint；之后打一个可等待的终止符（回显里不出现）。
  await device.input(sessionId, `yes | head -c 6000000; echo; echo ${typed("WRAP_DONE")}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && m.sessionId === sessionId && utf8(m.data).includes("WRAP_DONE"), "大输出结束", 120000, from);
  await settle(device, sessionId);
  const before = await catalogEntry(device, sessionId);
  assert.ok(before.outputSeq > 4n * 1024n * 1024n, `ring 已经环绕：${before.outputSeq}`);
  const beforeSnapshot = await device.request("sessionSnapshotRequest", "sessionSnapshot", { sessionId });
  const linesBefore = await screenLines(beforeSnapshot.ansiSnapshot, 80, 24);
  assert.ok(linesBefore.some((line) => line === "WRAP_DONE"));
  const seen = device.log.slice(from).filter((m) => m.case === "ptyOutput" && m.sessionId === sessionId);
  const lastSeq = seen[seen.length - 1].toSeq;

  await stack.replaceSupervisor();
  await reconnect(device);
  const after = await catalogEntry(device, sessionId);
  assert.equal(after.outputSeq, before.outputSeq, "序号跨替换逐字节相同");
  const afterSnapshot = await device.request("sessionSnapshotRequest", "sessionSnapshot", { sessionId });
  const linesAfter = await screenLines(afterSnapshot.ansiSnapshot, 80, 24);
  assert.deepEqual(linesAfter.slice(-24), linesBefore.slice(-24), "可见屏幕逐行相同");
  const resumeFrom = device.mark();
  const resumed = await device.attach(sessionId, { resumeFromSeq: lastSeq });
  assert.equal(resumed.snapshotSeq, lastSeq, "ring 覆盖到的位置可以直接续上");
  assert.equal(resumed.ansiSnapshot?.byteLength ?? 0, 0, "不退化成整屏重绘");
  const tail = Math.max(resumeFrom, device.mark());
  await device.input(sessionId, `echo ${typed("AFTER_WRAP")}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_WRAP"), "环绕重建后输入仍可达", 10000, tail);
  device.close();
});

test("停止终端仍然结束 shell：替换不共用 stop 的路径", async () => {
  const { device, sessionId } = await openTerminal("STOP_MARK");
  const before = await catalogEntry(device, sessionId);
  await stack.replaceSupervisor();
  await reconnect(device);
  assert.equal((await catalogEntry(device, sessionId))?.pid, before.pid);
  await device.attach(sessionId);
  const ack = await device.stopSession(sessionId);
  assert.equal(ack.ok, true);
  for (let i = 0; i < 100; i += 1) {
    if (!(await catalogEntry(device, sessionId))) break;
    await sleep(100);
  }
  assert.equal(await catalogEntry(device, sessionId), undefined, "stop 之后 session 退出并进入 tombstone");
  device.close();
});
