import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTerminalFit, TERMINAL_FIT_LIMITS } from "./terminal-fit";
import { canSendTerminalInput, canSendTerminalResize } from "./terminal-control-state";

const small = { cols: 80, rows: 24, bufferLines: 24 };
const large = { cols: 80, rows: 24, bufferLines: TERMINAL_FIT_LIMITS.reflowLineThreshold + 1 };

test("尺寸没变、量不出尺寸、量出 NaN：都不 fit", () => {
  assert.equal(decideTerminalFit(small, { cols: 80, rows: 24 }), "skip");
  assert.equal(decideTerminalFit(small, undefined), "skip");
  assert.equal(decideTerminalFit(small, { cols: Number.NaN, rows: 24 }), "skip");
  assert.equal(decideTerminalFit(small, { cols: 80, rows: Number.NaN }), "skip");
});

test("buffer 小的时候一律立即 fit：WebGL 加载后那次纠正亚像素度量差的 fit 不能被拖延", () => {
  assert.equal(decideTerminalFit(small, { cols: 81, rows: 24 }), "immediate");
  assert.equal(decideTerminalFit(small, { cols: 80, rows: 25 }), "immediate");
  assert.equal(decideTerminalFit({ ...small, bufferLines: TERMINAL_FIT_LIMITS.reflowLineThreshold }, { cols: 81, rows: 24 }), "immediate");
});

test("buffer 大 + 列数变（会触发整段 scrollback 重排）才防抖；只变行数仍然立即执行", () => {
  assert.equal(decideTerminalFit(large, { cols: 81, rows: 24 }), "defer");
  assert.equal(decideTerminalFit(large, { cols: 79, rows: 30 }), "defer");
  assert.equal(decideTerminalFit(large, { cols: 80, rows: 30 }), "immediate");
});

test("阈值可注入，判定只看注入的那一份", () => {
  const limits = { reflowLineThreshold: 10, debounceMs: 5 };
  assert.equal(decideTerminalFit({ cols: 80, rows: 24, bufferLines: 11 }, { cols: 81, rows: 24 }, limits), "defer");
  assert.equal(decideTerminalFit({ cols: 80, rows: 24, bufferLines: 10 }, { cols: 81, rows: 24 }, limits), "immediate");
});

test("attaching 期间的按键放行（不再被面板吞掉），但尺寸仍只在 owned 时上报", () => {
  assert.equal(canSendTerminalInput("owned"), true);
  assert.equal(canSendTerminalInput("attaching"), true);
  for (const state of ["stopped", "idle", "detached"] as const) {
    assert.equal(canSendTerminalInput(state), false, state);
  }
  assert.equal(canSendTerminalResize("owned"), true);
  for (const state of ["stopped", "idle", "attaching", "detached"] as const) {
    assert.equal(canSendTerminalResize(state), false, state);
  }
});
