/**
 * `controller.fit()` 的判定（plan 20260916：拖窗口不再一次回调一帧 resize）。
 *
 * 为什么判定放在 `controller.fit` 里而不是 ResizeObserver 回调上：fit 有六个入口
 * （挂载 rAF、WebGL 加载后补的那次、dpr 变化、`[props.active]` effect，以及
 * terminal-attach.ts 里的三处），只给观察器加防抖，另外五个照样直通 PTY。
 *
 * 为什么只防抖「贵」的那一档：列数变了才触发整个 scrollback 的重排（reflow），行数变了不会。
 * 新开的终端 buffer 很小，重排本来就不费事，给它加 100ms 延迟只会让首屏晃一下——
 * 尤其 WebGL 加载后那次 fit 存在的意义就是立刻纠正亚像素度量差（terminal-pane.tsx），
 * 不能被拖延。所以：buffer 大 + 列数变 = 防抖，其余立即执行。
 *
 * 阈值是起点不是规格：Cursor 的 TerminalResizeDebouncer 在发行包里是压缩过的，
 * 200 行 / 100ms 只是从它的行为反推的量级，可以按真机手感调。
 *
 * 协议侧不需要配合：resizeSeq 已经是 last-write-wins（packages/client/src/device-router.ts）。
 */

/** FitAddon.proposeDimensions() 的返回值。 */
export type TerminalFitProposal = { cols: number; rows: number } | undefined;

/** skip = 什么都不用做；immediate = 立刻 fit；defer = 进防抖窗口。 */
export type TerminalFitDecision = "skip" | "immediate" | "defer";

export type TerminalFitLimits = {
  /** buffer（含 scrollback）超过这么多行，列数变化才算「贵」。 */
  reflowLineThreshold: number;
  /** 防抖窗口。 */
  debounceMs: number;
};

export const TERMINAL_FIT_LIMITS: TerminalFitLimits = { reflowLineThreshold: 200, debounceMs: 100 };

export type TerminalFitCurrent = {
  cols: number;
  rows: number;
  /** terminal.buffer.active.length：可视区 + scrollback 的总行数。 */
  bufferLines: number;
};

export function decideTerminalFit(
  current: TerminalFitCurrent,
  proposed: TerminalFitProposal,
  limits: TerminalFitLimits = TERMINAL_FIT_LIMITS,
): TerminalFitDecision {
  // 容器刚切显示、尚无可测尺寸时 proposeDimensions 会返回 undefined 或 NaN。
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return "skip";
  const colsChanged = proposed.cols !== current.cols;
  const rowsChanged = proposed.rows !== current.rows;
  if (!colsChanged && !rowsChanged) return "skip";
  if (colsChanged && current.bufferLines > limits.reflowLineThreshold) return "defer";
  return "immediate";
}
