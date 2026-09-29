import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExecutorTranscriptFragment } from "./runner-protocol.js";
import {
  capToolOutput,
  createTranscriptRecorder,
  REDACTED,
  salientArgument,
  TOOL_OUTPUT_HEAD_CHARS,
  TOOL_OUTPUT_TAIL_CHARS,
  toolEnvironment,
  toolResultText,
} from "./transcript.js";

const API_KEY = "sk-live-0123456789abcdef";

function recorder(secrets: string[] = [API_KEY]) {
  const fragments: ExecutorTranscriptFragment[] = [];
  let tick = 0;
  const rec = createTranscriptRecorder({ emit: (fragment) => fragments.push(fragment), secrets, now: () => ++tick });
  return { rec, fragments };
}

function assistantMessage(rec: ReturnType<typeof recorder>["rec"], text: string, stopReason = "stop") {
  rec.onEvent({ type: "message_start", message: { role: "assistant" } });
  for (const delta of text.split(" ")) {
    rec.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `${delta} ` } });
  }
  rec.onEvent({ type: "message_end", message: { role: "assistant", stopReason } });
}

test("each assistant message becomes one fragment holding only its own text", () => {
  const { rec, fragments } = recorder();
  assistantMessage(rec, "first thought");
  rec.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  rec.onEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "a\nb", isError: false });
  assistantMessage(rec, "second thought");
  // A tool-result message ending must not re-emit the assistant's text.
  rec.onEvent({ type: "message_end", message: { role: "toolResult" } });

  const assistant = fragments.filter((f) => f.kind === "assistant");
  assert.deepEqual(
    assistant.map((f) => (f as { text: string }).text),
    ["first thought", "second thought"],
  );
  assert.equal(rec.lastAssistantText(), "second thought");
  assert.equal(rec.lastStop().reason, "stop");
});

test("a tool call carries its name, salient argument, capped output and failure flag", () => {
  const { rec, fragments } = recorder();
  rec.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "cargo test" } });
  const output = "x".repeat(TOOL_OUTPUT_HEAD_CHARS + TOOL_OUTPUT_TAIL_CHARS + 1000);
  rec.onEvent({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [{ type: "text", text: output }] },
    isError: true,
  });
  assert.equal(fragments.length, 1);
  const tool = fragments[0] as Extract<ExecutorTranscriptFragment, { kind: "tool" }>;
  assert.equal(tool.tool, "bash");
  assert.equal(tool.argument, "cargo test");
  assert.equal(tool.failed, true);
  assert.ok(tool.output.includes("… 1000 bytes omitted …"), tool.output.slice(TOOL_OUTPUT_HEAD_CHARS - 5, TOOL_OUTPUT_HEAD_CHARS + 40));
  assert.ok(tool.output.length < output.length);
  assert.ok(tool.output.startsWith("x".repeat(TOOL_OUTPUT_HEAD_CHARS)));
  assert.ok(tool.output.endsWith("x".repeat(TOOL_OUTPUT_TAIL_CHARS)));
});

test("short outputs are left whole and the cap marker names the omitted bytes", () => {
  assert.equal(capToolOutput("hello"), "hello");
  const exact = "y".repeat(TOOL_OUTPUT_HEAD_CHARS + TOOL_OUTPUT_TAIL_CHARS);
  assert.equal(capToolOutput(exact), exact);
  const capped = capToolOutput(`${exact}z`);
  assert.ok(capped.includes("… 1 bytes omitted …"));
});

test("the salient argument follows the tool: command, path, pattern", () => {
  assert.equal(salientArgument("bash", { command: "git status" }), "git status");
  assert.equal(salientArgument("read", { path: "src/a.ts" }), "src/a.ts");
  assert.equal(salientArgument("edit", { path: "src/b.ts", oldText: "x" }), "src/b.ts");
  assert.equal(salientArgument("grep", { pattern: "TODO", path: "src" }), "TODO src");
  assert.equal(salientArgument("find", { pattern: "*.rs" }), "*.rs");
  assert.equal(salientArgument("mystery", { answer: 42 }), '{"answer":42}');
  assert.equal(salientArgument("bash", undefined), "");
});

test("tool results of every shape pi uses become text", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(toolResultText({ output: "out" }), "out");
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText({ other: 1 }), '{"other":1}');
});

test("the provider credential never appears in any fragment, even when a tool echoes it", () => {
  const { rec, fragments } = recorder();
  // The model repeats the key in prose; a tool dumps its environment; an error message quotes it.
  assistantMessage(rec, `the key is ${API_KEY} ok`);
  rec.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: `echo ${API_KEY}` } });
  rec.onEvent({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: `ANTHROPIC_API_KEY=${API_KEY}\nPATH=/usr/bin\n${"z".repeat(10_000)}${API_KEY}`,
    isError: false,
  });
  rec.error(`401 unauthorized for ${API_KEY}`);
  assert.equal(fragments.length, 3);
  for (const fragment of fragments) {
    const text = JSON.stringify(fragment);
    assert.ok(!text.includes(API_KEY), text.slice(0, 200));
    assert.ok(text.includes(REDACTED), text.slice(0, 200));
  }
});

test("the tool environment drops credential variables by name and by value", () => {
  const env = toolEnvironment(
    {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "other-key",
      MY_OWN_NAME: API_KEY,
      WRAPPED: `Bearer ${API_KEY}`,
      HOME: "/Users/x",
    },
    { TMPDIR: "/scratch", COFLUX_EXECUTOR_RUN_ID: "run-1" },
    [API_KEY],
  );
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/scratch", COFLUX_EXECUTOR_RUN_ID: "run-1" });
  for (const value of Object.values(env)) assert.ok(!String(value).includes(API_KEY));
});

test("a run stopped mid-message still reports the streaming text as its last assistant text", () => {
  const { rec } = recorder();
  assistantMessage(rec, "done part");
  rec.onEvent({ type: "message_start", message: { role: "assistant" } });
  rec.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half way" } });
  assert.equal(rec.lastAssistantText(), "half way");
});
