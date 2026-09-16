/**
 * 中文 IME 直接提交丢字的 workaround（上游 xtermjs/xterm.js#5887，6.1.0-beta.304 仍未修）。
 *
 * 症状：中文输入法直接提交（无 composition 会话）的字符只出现在 textarea 的 'input' 事件里，
 * 但 xterm 的 `_inputEvent` 被 `(!ev.composed || !_keyDownSeen)` 门控挡住（beta 的
 * `CoreBrowserTerminal._inputEvent` 里这行原样还在），兜底的 `CompositionHelper` setTimeout(0)
 * textarea diff 又与 IME 落字时序竞态——表现为全角 ？！ 等（带 Shift 的标点）要连输两次才出一个。
 *
 * 这里改为由 input 事件确定性发送，并停用竞态 diff 路径。
 *
 * ## 为什么单独成模块
 *
 * 补丁踩的全是 xterm 私有内部结构，升级必须复验；更要命的是它**静默失效**：任一字段改名就整体
 * 跳过、行为回落成上游 bug，typecheck 与所有单测都照样全绿，只有真人打中文时才发现。故：
 *
 * - 补丁函数返回 `{ applied, missing }`，调用方在未生效时必须大声报错（见 terminal-pane.tsx）；
 * - 同目录 terminal-ime-patch.test.ts 既测补丁本身的行为，也直接读 `@xterm/xterm` 随包发布的
 *   sourcemap 源码，断言这些内部结构与上游那行门控仍在——升级 xterm 时它会先红。
 *
 * ## 6.0.0 → 6.1.0-beta.304 的差异
 *
 * `CoreBrowserTerminal.cancel(ev)` 整个方法被删了（6.0.0 里它就是
 * `preventDefault() + stopPropagation()`，受默认为 true 的 `cancelEvents` 选项门控），
 * 这里改为直接调这两个方法，语义与 6.0.0 默认选项下一致。
 * `CompositionHelper._isComposing` 新增了公开 getter `isComposing`，优先读公开面。
 */

/** 补丁要改的 input 事件面（MouseEvent/InputEvent 的子集，便于无 DOM 单测）。 */
export type ImeInputEvent = {
  inputType: string;
  data: string | null;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/** xterm 6.1.0-beta.304 私有内部结构（仅补丁用到的字段），升级 @xterm/xterm 必须复验。 */
export type XtermCoreInternals = {
  _compositionHelper?: {
    /** 6.1 起的公开 getter；6.0 只有私有 `_isComposing`。 */
    isComposing?: boolean;
    _isSendingComposition?: boolean;
    _handleAnyTextareaChanges?: () => void;
  };
  _inputEvent?: (ev: ImeInputEvent) => boolean;
  _keyPressHandled?: boolean;
  _unprocessedDeadKey?: boolean;
  coreService?: { triggerDataEvent: (data: string, wasUserInput: boolean) => void };
  textarea?: { value: string };
};

/** 补丁结果：`applied` 为 false 时 `missing` 列出缺失的内部字段，调用方据此大声报错。 */
export type ImePatchResult = { applied: boolean; missing: readonly string[] };

/** 补丁依赖的内部字段清单（缺一不可），也是 missing 的取值域。 */
export const IME_PATCH_INTERNALS = [
  "_compositionHelper.isComposing",
  "_compositionHelper._isSendingComposition",
  "_compositionHelper._handleAnyTextareaChanges",
  "_inputEvent",
  "_keyPressHandled",
  "_unprocessedDeadKey",
  "coreService.triggerDataEvent",
  "textarea",
] as const;

/** DEL：被停用的 diff 路径里"值变短发 DEL"分支对应的字节。 */
const DEL = "\x7f";

/**
 * 给 xterm 的 `_core` 打补丁。纯函数式入口（不依赖 Terminal 类型），便于用假 core 单测。
 *
 * 任一内部字段缺失则整体不改动，返回 `applied: false` 并列出缺的字段——绝不半途改一半。
 */
export function applyImeCommittedInputPatch(core: XtermCoreInternals | null | undefined): ImePatchResult {
  if (!core) return { applied: false, missing: IME_PATCH_INTERNALS };

  const helper = core._compositionHelper;
  const origInputEvent = core._inputEvent;
  const coreService = core.coreService;
  const textarea = core.textarea;

  const missing: string[] = [];
  if (typeof helper?.isComposing !== "boolean") missing.push("_compositionHelper.isComposing");
  if (typeof helper?._isSendingComposition !== "boolean") missing.push("_compositionHelper._isSendingComposition");
  if (typeof helper?._handleAnyTextareaChanges !== "function") missing.push("_compositionHelper._handleAnyTextareaChanges");
  if (typeof origInputEvent !== "function") missing.push("_inputEvent");
  if (typeof core._keyPressHandled !== "boolean") missing.push("_keyPressHandled");
  if (typeof core._unprocessedDeadKey !== "boolean") missing.push("_unprocessedDeadKey");
  if (typeof coreService?.triggerDataEvent !== "function") missing.push("coreService.triggerDataEvent");
  if (!textarea || typeof textarea.value !== "string") missing.push("textarea");
  if (missing.length > 0 || !helper || !origInputEvent || !coreService || !textarea) {
    return { applied: false, missing: missing.length > 0 ? missing : IME_PATCH_INTERNALS };
  }

  // 停用竞态 diff 路径：keydown(229) 会调它，setTimeout(0) 后拿 textarea 前后值做 diff 补发，
  // 与 IME 真正落字的时序竞态，正是"连输两次才出一个"的另一半来源。
  helper._handleAnyTextareaChanges = () => {};

  core._inputEvent = (ev: ImeInputEvent) => {
    if (helper.isComposing || helper._isSendingComposition) return false;
    // Alt/Option 组合字符走 keypress 已发过（_keyPressHandled），不能重复发。
    if (ev.inputType === "insertText" && ev.data && !core._keyPressHandled) {
      core._unprocessedDeadKey = false;
      coreService.triggerDataEvent(ev.data, true);
      textarea.value = ""; // 及时清空，textarea 累积残值正是上游 diff 路径不可靠的来源之一
      cancelInputEvent(ev);
      return true;
    }
    if (ev.inputType === "deleteContentBackward") {
      // 对应被停用的 diff 路径里"值变短发 DEL"分支（IME 吞掉 Backspace keydown 的场景）
      coreService.triggerDataEvent(DEL, true);
      textarea.value = "";
      cancelInputEvent(ev);
      return true;
    }
    return origInputEvent.call(core, ev);
  };

  return { applied: true, missing: [] };
}

/** 6.0.0 的 `CoreBrowserTerminal.cancel(ev)` 在 6.1 beta 被删，这里就是它默认选项下的全部行为。 */
function cancelInputEvent(ev: ImeInputEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
}
