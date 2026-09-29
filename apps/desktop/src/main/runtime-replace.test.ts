import assert from "node:assert/strict";
import { test } from "node:test";

import { replaceSupervisor, shouldRestartSupervisor } from "./runtime-replace";

test("替换 supervisor：新目录起不来 → 上一版目录再起 → 运行时标记回到旧 id，并报告更新未能应用", async () => {
  const trail: string[] = [];
  const marker: string[] = [];
  const outcome = await replaceSupervisor({
    leave: async () => { trail.push("leave"); },
    startNext: async () => { trail.push("start-next"); throw new Error("新版 supervisor 启动失败"); },
    startPrevious: async () => { trail.push("start-previous"); return "previous-status"; },
    writeMarker: (id) => marker.push(id),
    nextId: "new-id",
    previousId: "old-id",
  });
  assert.deepEqual(trail, ["leave", "start-next", "start-previous"], "先 leave，再试新版，失败才回上一版");
  assert.deepEqual(marker, ["old-id"], "标记只在回滚时写回旧 id，新 id 从未落盘");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rolledBack, true);
  assert.match(outcome.error.message, /新版 supervisor 启动失败/);
});

test("替换 supervisor：新目录起来了 → 标记写成新 id，不碰上一版", async () => {
  const trail: string[] = [];
  const marker: string[] = [];
  const outcome = await replaceSupervisor({
    leave: async () => { trail.push("leave"); },
    startNext: async () => { trail.push("start-next"); return "next-status"; },
    startPrevious: async () => { trail.push("start-previous"); return "previous-status"; },
    writeMarker: (id) => marker.push(id),
    nextId: "new-id",
    previousId: "old-id",
  });
  assert.deepEqual(trail, ["leave", "start-next"]);
  assert.deepEqual(marker, ["new-id"]);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.status, "next-status");
});

test("替换 supervisor：连上一版都起不来时两个错误都带出来，标记不动", async () => {
  const marker: string[] = [];
  const outcome = await replaceSupervisor({
    leave: async () => {},
    startNext: async () => { throw new Error("next broken"); },
    startPrevious: async () => { throw new Error("previous broken"); },
    writeMarker: (id) => marker.push(id),
    nextId: "new-id",
    previousId: "old-id",
  });
  assert.deepEqual(marker, []);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rolledBack, false);
  assert.match(outcome.rollbackError?.message ?? "", /previous broken/);
});

test("崩溃看门狗：ptyd 在、supervisor 不在、已接入、没有动作在进行 → 自动重启；其余情形不动", () => {
  const base = { ptydAlive: true, supervisorAlive: false, installed: true, busy: false, lastFailureAt: null, now: 10_000, backoffMs: 10_000 };
  assert.equal(shouldRestartSupervisor(base), true);
  assert.equal(shouldRestartSupervisor({ ...base, supervisorAlive: true }), false, "在跑就不重启");
  assert.equal(shouldRestartSupervisor({ ...base, ptydAlive: false }), false, "ptyd 不在 = 用户停了本机终端，面板停在已停止");
  assert.equal(shouldRestartSupervisor({ ...base, installed: false }), false, "没接入过不知道从哪个目录起");
  assert.equal(shouldRestartSupervisor({ ...base, busy: true }), false, "替换/停止进行中不能插一脚");
  assert.equal(shouldRestartSupervisor({ ...base, lastFailureAt: 5_000 }), false, "上次失败不到退避间隔不重试");
  assert.equal(shouldRestartSupervisor({ ...base, lastFailureAt: 0 }), true, "退避过了再试");
});
