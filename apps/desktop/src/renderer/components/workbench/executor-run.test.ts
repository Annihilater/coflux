import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutorRunState } from "@coflux/client";

import { carouselPosition, deckSides, projectionSeconds } from "./executor-deck";
import {
  DEFAULT_EXECUTOR_CORNER,
  executorRunsForTask,
  executorTaskIds,
  formatElapsed,
  fragmentView,
  promptHead,
  promptIsLong,
  reconcileDeck,
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
  assert.equal(DEFAULT_EXECUTOR_CORNER, "top-right");
  assert.equal(snapCorner({ x: 10, y: 10 }, pane), "top-left");
  assert.equal(snapCorner({ x: 990, y: 10 }, pane), "top-right");
  assert.equal(snapCorner({ x: 10, y: 590 }, pane), "bottom-left");
  assert.equal(snapCorner({ x: 990, y: 590 }, pane), "bottom-right");
  // Exactly on both midlines the default corner wins.
  assert.equal(snapCorner({ x: 500, y: 300 }, pane), "top-right");
  assert.equal(snapCorner({ x: 499, y: 300 }, pane), "top-left");
  assert.equal(snapCorner({ x: 500, y: 301 }, pane), "bottom-right");
});

test("a flick lands on the corner it points at: the release velocity is projected forward", () => {
  const pane = { width: 1000, height: 600 };
  // Released left of centre but thrown right at 1500 px/s: the projection carries it past the midline.
  const seconds = projectionSeconds();
  assert.ok(Math.abs(seconds - 0.997 / 0.003 / 1000) < 1e-9);
  assert.equal(snapCorner({ x: 400 + 1500 * seconds, y: 100 }, pane), "top-right");
  assert.equal(snapCorner({ x: 400, y: 100 }, pane), "top-left");
});

test("the carousel puts the next runs on the right and the previous on the left, two layers a side", () => {
  const positions = (n: number) => Array.from({ length: n }, (_, index) => carouselPosition(index, n));
  assert.deepEqual(positions(1), [0]);
  assert.deepEqual(positions(2), [0, 1]);
  assert.deepEqual(positions(3), [0, 1, -1]);
  assert.deepEqual(positions(4), [0, 1, 2, -1]);
  assert.deepEqual(positions(6), [0, 1, 2, 3, -2, -1]);
  assert.deepEqual(deckSides(1), { left: 0, right: 0 });
  assert.deepEqual(deckSides(2), { left: 0, right: 1 });
  assert.deepEqual(deckSides(3), { left: 1, right: 1 });
  assert.deepEqual(deckSides(6), { left: 2, right: 2 });
});

test("the deck keeps its order, puts a new run in front and lets ended runs leave", () => {
  const empty = { order: [], leaving: [] };
  // Several at once: the newest in front.
  assert.deepEqual(reconcileDeck(empty, ["a", "b"]), { order: ["b", "a"], leaving: [] });
  // Unchanged: nothing to do.
  assert.equal(reconcileDeck({ order: ["b", "a"], leaving: [] }, ["a", "b"]), null);
  // A user-chosen order survives; a new run lands in front of it.
  assert.deepEqual(reconcileDeck({ order: ["a", "b"], leaving: [] }, ["a", "b", "c"]), { order: ["c", "a", "b"], leaving: [] });
  // A run no longer present leaves; one that comes back rejoins at the front.
  assert.deepEqual(reconcileDeck({ order: ["c", "a", "b"], leaving: [] }, ["a", "c"]), { order: ["c", "a"], leaving: ["b"] });
  assert.deepEqual(reconcileDeck({ order: ["c", "a"], leaving: ["b"] }, ["a", "b", "c"]), { order: ["b", "c", "a"], leaving: [] });
});

test("the rolling log shows the last lines: prose lines, $ commands and errors, newest last", () => {
  const fragments: ExecutorFragmentView[] = [
    assistant(1, "Let me look.\n\nFirst the tests."),
    tool(2, "cargo test"),
    { seq: 3, kind: "error", text: " blocked ", tool: "", argument: "", output: "", failed: false, at: 3 },
    assistant(4, "Two failures.\nFixing the first."),
  ];
  assert.deepEqual(rollingLog(fragments), [
    { kind: "command", text: "$ cargo test", key: "2" },
    { kind: "error", text: "blocked", key: "3" },
    { kind: "prose", text: "Two failures.", key: "4:0" },
    { kind: "prose", text: "Fixing the first.", key: "4:1" },
  ]);
  assert.deepEqual(rollingLog(fragments, 2), [
    { kind: "prose", text: "Two failures.", key: "4:0" },
    { kind: "prose", text: "Fixing the first.", key: "4:1" },
  ]);
  // Keys name a line for good: a longer window gives the same lines the same keys.
  assert.deepEqual(
    rollingLog(fragments, 8).map((line) => line.key),
    ["1:0", "1:1", "2", "3", "4:0", "4:1"],
  );
  // A tool without a salient argument shows its name; empty transcripts show nothing.
  assert.deepEqual(rollingLog([tool(1, "", "ls")]), [{ kind: "command", text: "$ ls", key: "1" }]);
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

test("a collapsed card disappears the moment either end signal arrives; only an expanded one outlives its run", () => {
  // Going, by both signals: shown either way.
  assert.equal(retainAfterEnd({ live: true, ended: false, expanded: false }), true);
  assert.equal(retainAfterEnd({ live: true, ended: false, expanded: true }), true);
  // The worker's `ended` batch arrived before the center dropped the run.
  assert.equal(retainAfterEnd({ live: true, ended: true, expanded: false }), false);
  assert.equal(retainAfterEnd({ live: true, ended: true, expanded: true }), true);
  // The center dropped the run before (or without) the worker's end frame.
  assert.equal(retainAfterEnd({ live: false, ended: false, expanded: false }), false);
  assert.equal(retainAfterEnd({ live: false, ended: false, expanded: true }), true);
  // Both signals in: same rule.
  assert.equal(retainAfterEnd({ live: false, ended: true, expanded: false }), false);
  assert.equal(retainAfterEnd({ live: false, ended: true, expanded: true }), true);
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
