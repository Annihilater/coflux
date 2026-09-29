import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorRunState } from "@coflux/client";

import {
  executorRunsForTask,
  executorTaskIds,
  formatElapsed,
  fragmentView,
  promptHead,
  promptIsLong,
  retainAfterEnd,
  rollingLog,
  runClockStart,
  snapCorner,
  type ExecutorFragmentView,
} from "./executor-run";

function run(runId: string, taskId: string, submittedAt = 1): ExecutorRunState {
  return {
    runId,
    daemonId: "d1",
    sessionId: `s-${taskId}`,
    taskId,
    title: runId,
    write: false,
    phase: "running",
    submittedAt,
    startedAt: 0,
    hostLost: false,
  };
}

function assistant(seq: number, text: string): ExecutorFragmentView {
  return { seq, kind: "assistant", text, tool: "", argument: "", output: "", failed: false, at: seq };
}

function tool(seq: number, argument: string, tool = "bash"): ExecutorFragmentView {
  return { seq, kind: "tool", text: "", tool, argument, output: "", failed: false, at: seq };
}

test("a dragged card snaps to the nearest of the pane's four corners", () => {
  const pane = { width: 1000, height: 600 };
  assert.equal(snapCorner({ x: 10, y: 10 }, pane), "top-left");
  assert.equal(snapCorner({ x: 990, y: 10 }, pane), "top-right");
  assert.equal(snapCorner({ x: 10, y: 590 }, pane), "bottom-left");
  assert.equal(snapCorner({ x: 990, y: 590 }, pane), "bottom-right");
  // Exactly on both midlines the default corner wins.
  assert.equal(snapCorner({ x: 500, y: 300 }, pane), "bottom-right");
  assert.equal(snapCorner({ x: 499, y: 300 }, pane), "bottom-left");
});

test("the rolling log shows the last lines: prose lines, $ commands and errors, newest last", () => {
  const fragments: ExecutorFragmentView[] = [
    assistant(1, "Let me look.\n\nFirst the tests."),
    tool(2, "cargo test"),
    { seq: 3, kind: "error", text: " blocked ", tool: "", argument: "", output: "", failed: false, at: 3 },
    assistant(4, "Two failures.\nFixing the first."),
  ];
  assert.deepEqual(rollingLog(fragments), [
    { kind: "command", text: "$ cargo test" },
    { kind: "error", text: "blocked" },
    { kind: "prose", text: "Two failures." },
    { kind: "prose", text: "Fixing the first." },
  ]);
  assert.deepEqual(rollingLog(fragments, 2), [
    { kind: "prose", text: "Two failures." },
    { kind: "prose", text: "Fixing the first." },
  ]);
  // A tool without a salient argument shows its name; empty transcripts show nothing.
  assert.deepEqual(rollingLog([tool(1, "", "ls")]), [{ kind: "command", text: "$ ls" }]);
  assert.deepEqual(rollingLog([]), []);
});

test("elapsed time reads m:ss under an hour and h:mm:ss beyond, and the clock starts when the run did", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7_400), "0:07");
  assert.equal(formatElapsed(754_000), "12:34");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(runClockStart({ startedAt: 0, submittedAt: 10 }), 10);
  assert.equal(runClockStart({ startedAt: 25, submittedAt: 10 }), 25);
});

test("a card outlives its run only while expanded", () => {
  assert.equal(retainAfterEnd({ live: true, expanded: false }), true);
  assert.equal(retainAfterEnd({ live: true, expanded: true }), true);
  assert.equal(retainAfterEnd({ live: false, expanded: true }), true);
  assert.equal(retainAfterEnd({ live: false, expanded: false }), false);
});

test("runs are grouped by their caller terminal in submit order", () => {
  const runs = { b: run("b", "t1", 5), a: run("a", "t1", 2), c: run("c", "t2", 1) };
  assert.deepEqual(
    executorRunsForTask(runs, "t1").map((entry) => entry.runId),
    ["a", "b"],
  );
  assert.deepEqual(executorRunsForTask(runs, "t3"), []);
  assert.deepEqual([...executorTaskIds(runs)].sort(), ["t1", "t2"]);
});

test("wire fragments map onto the view and unknown kinds are dropped", () => {
  const base = { seq: 7n, text: "hi", tool: "", argument: "", output: "", failed: false, at: 1 };
  assert.equal(fragmentView({ ...base, kind: 1 })?.kind, "assistant");
  assert.equal(fragmentView({ ...base, kind: 2 })?.kind, "tool");
  assert.equal(fragmentView({ ...base, kind: 3 })?.kind, "error");
  assert.equal(fragmentView({ ...base, kind: 1 })?.seq, 7);
  assert.equal(fragmentView({ ...base, kind: 9 }), null);
});

test("a long prompt folds to its head", () => {
  assert.equal(promptIsLong("short"), false);
  const many = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(promptIsLong(many), true);
  assert.equal(promptHead(many), "line 0\nline 1\nline 2\nline 3\nline 4\nline 5…");
  assert.equal(promptIsLong("x".repeat(500)), true);
  assert.ok(promptHead("x".repeat(500)).endsWith("…"));
});
