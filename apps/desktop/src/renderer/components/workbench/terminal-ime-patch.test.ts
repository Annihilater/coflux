import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyImeCommittedInputPatch, IME_PATCH_INTERNALS, type ImeInputEvent, type XtermCoreInternals } from "./terminal-ime-patch";

type Sent = { data: string; wasUserInput: boolean };

/** 按 6.1.0-beta.304 的 CoreBrowserTerminal / CompositionHelper 形状造的假 core。 */
function fakeCore(overrides: Partial<XtermCoreInternals> = {}) {
  const sent: Sent[] = [];
  const originalCalls: ImeInputEvent[] = [];
  const core: XtermCoreInternals = {
    _compositionHelper: { isComposing: false, _isSendingComposition: false, _handleAnyTextareaChanges: () => {} },
    _inputEvent: (ev) => {
      originalCalls.push(ev);
      return false;
    },
    _keyPressHandled: false,
    _unprocessedDeadKey: false,
    coreService: { triggerDataEvent: (data, wasUserInput) => void sent.push({ data, wasUserInput }) },
    textarea: { value: "" },
    ...overrides,
  };
  return { core, sent, originalCalls };
}

function inputEvent(inputType: string, data: string | null) {
  const cancelled = { prevented: 0, stopped: 0 };
  const ev: ImeInputEvent = {
    inputType,
    data,
    preventDefault: () => void cancelled.prevented++,
    stopPropagation: () => void cancelled.stopped++,
  };
  return { ev, cancelled };
}

test("补丁生效：IME 直接提交的字符由 input 事件确定性发送一次，并清空 textarea", () => {
  const { core, sent } = fakeCore();
  const result = applyImeCommittedInputPatch(core);
  assert.deepEqual(result, { applied: true, missing: [] });

  core.textarea!.value = "？";
  const { ev } = inputEvent("insertText", "？");
  assert.equal(core._inputEvent!(ev), true);
  assert.deepEqual(sent, [{ data: "？", wasUserInput: true }]);
  assert.equal(core.textarea!.value, "");
});

/**
 * 补丁不取消 input 事件。6.0.0 里那句 `core.cancel(ev)` 受内部选项 `cancelEvents` 门控，
 * 而它默认 false、apps/desktop 也从没设过，所以那一刀每次都空转；beta 里方法和选项都已删除。
 * 真去调 stopPropagation 会把事件挡在 textarea 及其祖先的其它监听器之外——那是升级凭空引入的
 * 新行为，不是"保持原样"。这条用例就是拦着它被再加回来。
 */
test("补丁不取消 input 事件：preventDefault / stopPropagation 一次都不调", () => {
  const { core } = fakeCore();
  applyImeCommittedInputPatch(core);

  const committed = inputEvent("insertText", "！");
  core._inputEvent!(committed.ev);
  assert.deepEqual(committed.cancelled, { prevented: 0, stopped: 0 });

  const backspace = inputEvent("deleteContentBackward", null);
  core._inputEvent!(backspace.ev);
  assert.deepEqual(backspace.cancelled, { prevented: 0, stopped: 0 });
});

test("竞态 diff 路径被停用：_handleAnyTextareaChanges 变成 no-op", () => {
  let diffRuns = 0;
  const { core } = fakeCore({
    _compositionHelper: { isComposing: false, _isSendingComposition: false, _handleAnyTextareaChanges: () => void diffRuns++ },
  });
  applyImeCommittedInputPatch(core);
  core._compositionHelper!._handleAnyTextareaChanges!();
  assert.equal(diffRuns, 0);
});

test("composition 会话进行中不抢发，交回上游；keypress 已发过的字符也不重复发", () => {
  const composing = fakeCore({
    _compositionHelper: { isComposing: true, _isSendingComposition: false, _handleAnyTextareaChanges: () => {} },
  });
  applyImeCommittedInputPatch(composing.core);
  assert.equal(composing.core._inputEvent!(inputEvent("insertText", "啊").ev), false);
  assert.deepEqual(composing.sent, []);

  const sending = fakeCore({
    _compositionHelper: { isComposing: false, _isSendingComposition: true, _handleAnyTextareaChanges: () => {} },
  });
  applyImeCommittedInputPatch(sending.core);
  assert.equal(sending.core._inputEvent!(inputEvent("insertText", "啊").ev), false);
  assert.deepEqual(sending.sent, []);

  // Alt/Option 组合字符：keypress 已发过，input 事件必须交回上游而不是再发一次。
  const handled = fakeCore({ _keyPressHandled: true });
  applyImeCommittedInputPatch(handled.core);
  const alt = inputEvent("insertText", "†");
  assert.equal(handled.core._inputEvent!(alt.ev), false);
  assert.deepEqual(handled.sent, []);
  assert.deepEqual(handled.originalCalls, [alt.ev]);
});

test("IME 吞掉 Backspace keydown 时由 deleteContentBackward 补发 DEL；其它 inputType 交回上游", () => {
  const { core, sent, originalCalls } = fakeCore();
  applyImeCommittedInputPatch(core);

  core.textarea!.value = "ab";
  assert.equal(core._inputEvent!(inputEvent("deleteContentBackward", null).ev), true);
  assert.deepEqual(sent, [{ data: "\x7f", wasUserInput: true }]);
  assert.equal(core.textarea!.value, "");

  const other = inputEvent("insertFromPaste", "x");
  assert.equal(core._inputEvent!(other.ev), false);
  assert.deepEqual(originalCalls, [other.ev]);
  assert.equal(sent.length, 1);
});

test("内部字段缺失：整体不打补丁、列出缺的字段，原 _inputEvent 原样保留（静默 no-op 的反面）", () => {
  const { core, originalCalls } = fakeCore({ _compositionHelper: { _isSendingComposition: false, _handleAnyTextareaChanges: () => {} } });
  const original = core._inputEvent;
  const result = applyImeCommittedInputPatch(core);
  assert.equal(result.applied, false);
  assert.deepEqual(result.missing, ["_compositionHelper.isComposing"]);
  assert.equal(core._inputEvent, original);
  assert.deepEqual(originalCalls, []);

  const renamed = fakeCore({ _inputEvent: undefined, coreService: undefined });
  const renamedResult = applyImeCommittedInputPatch(renamed.core);
  assert.equal(renamedResult.applied, false);
  assert.deepEqual([...renamedResult.missing], ["_inputEvent", "coreService.triggerDataEvent"]);

  assert.deepEqual(applyImeCommittedInputPatch(undefined), { applied: false, missing: IME_PATCH_INTERNALS });
});

/**
 * 升级 xterm 的防漂移门（landmine：补丁静默失效是本次升级的默认结局）。
 *
 * 直接读 `@xterm/xterm` 随包发布的 sourcemap 里的 TypeScript 原文，断言补丁依赖的私有结构、
 * 以及补丁存在的理由（上游那行把 IME 直接提交挡掉的门控）都还在。任一条不成立时这条测试先红，
 * 而不是等真人打中文时才发现全角标点要按两次。
 */
function xtermSource(file: string): string {
  const mapPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../node_modules/@xterm/xterm/lib/xterm.mjs.map");
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: string[]; sourcesContent?: (string | null)[] };
  const index = (map.sources ?? []).findIndex((source) => source.endsWith(file));
  const content = index >= 0 ? map.sourcesContent?.[index] : undefined;
  assert.ok(typeof content === "string" && content.length > 0, `@xterm/xterm 的 sourcemap 里找不到 ${file}`);
  return content as string;
}

test("防漂移：xterm 内部结构与上游 IME 门控仍是补丁假设的样子", () => {
  const terminal = xtermSource("src/browser/CoreBrowserTerminal.ts");
  const composition = xtermSource("src/browser/input/CompositionHelper.ts");

  for (const needle of [
    "protected _inputEvent(ev: InputEvent): boolean {",
    "private _keyPressHandled",
    "private _unprocessedDeadKey",
    "private _compositionHelper",
    "public textarea",
  ]) {
    assert.ok(terminal.includes(needle), `CoreBrowserTerminal 不再有 ${needle}，terminal-ime-patch.ts 必须复验`);
  }
  for (const needle of ["public get isComposing()", "private _isSendingComposition", "_handleAnyTextareaChanges(): void"]) {
    assert.ok(composition.includes(needle), `CompositionHelper 不再有 ${needle}，terminal-ime-patch.ts 必须复验`);
  }

  // 补丁存在的理由：上游仍然用这行把「IME 直接提交」挡在 _inputEvent 之外。
  // 它一旦消失，说明 #5887 已修，补丁应当整个删掉而不是继续叠着。
  assert.ok(
    terminal.includes("(!ev.composed || !this._keyDownSeen)"),
    "上游 _inputEvent 的门控变了（#5887 可能已修），terminal-ime-patch.ts 应当复验或删除",
  );
});
