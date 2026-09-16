import assert from "node:assert/strict";
import { test } from "node:test";

import { commandOutputText, createCommandMarkReader } from "./terminal-command-marks";

// 测试夹具，不是真实凭据：真实值由 supervisor 每会话随机生成，只走环境变量给 shell。
const MARK_TOKEN = "aabbcc";
const OTHER_TOKEN = "ddeeff";

test("三种标记按 supervisor 发的形状解析，D 带退出码", () => {
  const reader = createCommandMarkReader();
  assert.deepEqual(reader.read(`A;coflux=${MARK_TOKEN}`), { kind: "prompt-start" });
  assert.deepEqual(reader.read(`C;coflux=${MARK_TOKEN}`), { kind: "command-start" });
  assert.deepEqual(reader.read(`D;0;coflux=${MARK_TOKEN}`), { kind: "command-end", exitCode: 0 });
  assert.deepEqual(reader.read(`D;130;coflux=${MARK_TOKEN}`), { kind: "command-end", exitCode: 130 });
});

test("D 的状态位不是数字（shell 没填/被 exec 掉）时退出码未知，而不是当成 0", () => {
  const reader = createCommandMarkReader();
  assert.deepEqual(reader.read(`D;coflux=${MARK_TOKEN}`), { kind: "command-end", exitCode: undefined });
  assert.deepEqual(reader.read(`D;;coflux=${MARK_TOKEN}`), { kind: "command-end", exitCode: undefined });
  assert.deepEqual(reader.read(`D;oops;coflux=${MARK_TOKEN}`), { kind: "command-end", exitCode: undefined });
});

test("不带本会话标识的 OSC 133 一律不认：远端主机、嵌套 shell、提示符框架发的都被挡在外面", () => {
  const reader = createCommandMarkReader();
  assert.deepEqual(reader.read(`A;coflux=${MARK_TOKEN}`), { kind: "prompt-start" }); // 先由第一条标记确立本会话的标识
  assert.equal(reader.read("A"), null);
  assert.equal(reader.read("A;"), null);
  assert.equal(reader.read("C;other=1"), null);
  assert.equal(reader.read(`A;coflux=${OTHER_TOKEN}`), null);
});

test("认不出的标记类型不会把 TOFU 的第一枪骗走", () => {
  const reader = createCommandMarkReader();
  assert.equal(reader.read(`Z;coflux=${OTHER_TOKEN}`), null);
  assert.equal(reader.read(`;coflux=${OTHER_TOKEN}`), null);
  // 真正的第一条标记仍然能确立本会话的标识，冒名的那个依旧被拒。
  assert.deepEqual(reader.read(`A;coflux=${MARK_TOKEN}`), { kind: "prompt-start" });
  assert.equal(reader.read(`A;coflux=${OTHER_TOKEN}`), null);
});

test("返回的标记里不含会话标识（它只活在 reader 闭包里）", () => {
  const reader = createCommandMarkReader();
  const mark = reader.read(`D;0;coflux=${MARK_TOKEN}`);
  assert.ok(mark);
  assert.equal(JSON.stringify(mark).includes(MARK_TOKEN), false);
  assert.deepEqual(Object.keys(reader), ["read"]);
});

test("命令输出去掉尾部空行，中间的空行保留", () => {
  assert.equal(commandOutputText(["a", "", "b", "", "   "]), "a\n\nb");
  assert.equal(commandOutputText(["", "  "]), "");
  assert.equal(commandOutputText([]), "");
});
