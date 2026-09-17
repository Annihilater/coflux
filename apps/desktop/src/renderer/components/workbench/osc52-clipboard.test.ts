import assert from "node:assert/strict";
import { test } from "node:test";

import { OSC52_MAX_ENCODED_LENGTH, parseOsc52Payload } from "./osc52-clipboard";

function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

test("clipboard 载荷解码成 Unicode 文本，非 ASCII 与首尾空白逐字节还原", () => {
  assert.deepEqual(parseOsc52Payload(`c;${encoded("hello")}`), { kind: "write", text: "hello" });
  const tricky = "中文 emoji 🎉 trailing space ";
  assert.deepEqual(parseOsc52Payload(`c;${encoded(tricky)}`), { kind: "write", text: tricky });
  const multiline = "line one\nline two\n";
  assert.deepEqual(parseOsc52Payload(`c;${encoded(multiline)}`), { kind: "write", text: multiline });
  // atob() 直出的 Latin-1 原文会把这些字节当成一个个字符，长度对不上——这条就是那道分界线
  assert.equal((parseOsc52Payload(`c;${encoded("🎉")}`) as { text: string }).text.length, 2);
});

test("查询载荷单独成一类：调用方据此消费而不回写任何字节", () => {
  assert.deepEqual(parseOsc52Payload("c;?"), { kind: "query" });
  assert.deepEqual(parseOsc52Payload(";?"), { kind: "query" });
});

test("selection：留空与含 c/s 认剪贴板，只写 primary/cut buffer 的不认", () => {
  assert.deepEqual(parseOsc52Payload(`;${encoded("x")}`), { kind: "write", text: "x" });
  assert.deepEqual(parseOsc52Payload(`cs;${encoded("x")}`), { kind: "write", text: "x" });
  assert.deepEqual(parseOsc52Payload(`s0;${encoded("x")}`), { kind: "write", text: "x" });
  assert.deepEqual(parseOsc52Payload(`p;${encoded("x")}`), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload(`q;${encoded("x")}`), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload(`0;${encoded("x")}`), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload(`bogus;${encoded("x")}`), { kind: "ignore" });
});

test("形状不对 / 载荷为空的一律忽略，绝不落一个半截值到剪贴板", () => {
  assert.deepEqual(parseOsc52Payload(""), { kind: "ignore" }); // 没有分隔符
  assert.deepEqual(parseOsc52Payload("c"), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload("c;"), { kind: "ignore" }); // 空 = 规范里的"清空"，不替用户清
  assert.deepEqual(parseOsc52Payload(";"), { kind: "ignore" });
});

test("base64 不合法就整条丢弃，不做尽力而为的部分解码", () => {
  assert.deepEqual(parseOsc52Payload("c;!!!notbase64"), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload("c;aGVsbG8h?="), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload("c;A"), { kind: "ignore" }); // 长度 %4===1，补不出合法长度
  assert.deepEqual(parseOsc52Payload("c;===="), { kind: "ignore" });
  assert.deepEqual(parseOsc52Payload("c;aGVs bG8="), { kind: "ignore" }); // 中间的空白不当作可忽略
});

test("解出来不是合法 UTF-8 就丢弃，而不是写进乱码", () => {
  const lone = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
  assert.deepEqual(parseOsc52Payload(`c;${lone}`), { kind: "ignore" });
  const truncatedCjk = Buffer.from([0xe4, 0xb8]).toString("base64"); // "中" 的前两个字节
  assert.deepEqual(parseOsc52Payload(`c;${truncatedCjk}`), { kind: "ignore" });
});

test("上限压在编码后的长度上：超限在解码之前就拒了", () => {
  const chunk = encoded("AAA"); // 4 个 base64 字符 → 3 字节，正好整除，拼出精确长度
  const atLimit = chunk.repeat(OSC52_MAX_ENCODED_LENGTH / chunk.length);
  assert.equal(atLimit.length, OSC52_MAX_ENCODED_LENGTH);
  const parsed = parseOsc52Payload(`c;${atLimit}`);
  assert.equal(parsed.kind, "write");
  assert.equal((parsed as { text: string }).text.length, (OSC52_MAX_ENCODED_LENGTH / 4) * 3);
  assert.deepEqual(parseOsc52Payload(`c;${atLimit}${chunk}`), { kind: "ignore" });
});
