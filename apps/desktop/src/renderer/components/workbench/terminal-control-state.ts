/**
 * 终端控制权状态与输入门控（从 terminal-pane.tsx 提出来，纯值语义，便于无 DOM 单测）。
 *
 * detached 下锁输入是安全语义（他端已接管），不是体验细节。
 * idle = RUNNING 但本端未申请控制权（旁观 / 后台面板），仅用于 Tab 图标呈现为中性态。
 */
export type TerminalControlState = "stopped" | "idle" | "attaching" | "owned" | "detached";

/**
 * 能不能把按键发出去。
 *
 * attaching 放行（plan 20260916）：从点 Tab 到 holder epoch 落地之间有一段窗口，过去这段时间里
 * 敲的键被面板直接丢掉。渲染层不自己排队——client 的 router 已经按条数和字节数双上限保留了
 * 未确认输入（packages/client/src/device-router.ts），这里只要别把键挡在门外就够了。
 *
 * 已知缺口（本 plan 不修，属 client 侧）：router 在会话处于 detached 时返回 false，
 * 所以强制接管（force claim）那条路上的按键仍会丢。
 */
export function canSendTerminalInput(state: TerminalControlState): boolean {
  return state === "owned" || state === "attaching";
}

/**
 * 能不能把尺寸发出去：只有真正持有控制权时才发。
 * attaching 期间的尺寸已经随 taskStart 一起报过（terminal-attach.ts 的 beginAttach），
 * 再补一条只会和对端 holder 的尺寸打架。
 */
export function canSendTerminalResize(state: TerminalControlState): boolean {
  return state === "owned";
}
