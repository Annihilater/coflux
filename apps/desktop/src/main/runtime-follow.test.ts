import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveRuntimeUpdate, shouldFollowBundledRuntime, type RuntimeFollowFacts } from "./runtime-follow";

const STALE: RuntimeFollowFacts = {
  bundledId: "bundled-1",
  running: { runtimeId: "old-1", supportsLeave: true },
  ptydAlive: true,
  attempted: new Set(),
};

test("not stale: same runtimeId, no runtime or no bundle → nothing to follow", () => {
  assert.equal(resolveRuntimeUpdate({ ...STALE, running: { runtimeId: "bundled-1", supportsLeave: true } }), null);
  assert.equal(resolveRuntimeUpdate({ ...STALE, running: null }), null);
  assert.equal(resolveRuntimeUpdate({ ...STALE, bundledId: null }), null);
  assert.equal(shouldFollowBundledRuntime({ ...STALE, running: null, busy: false }), false);
});

test("leave-capable stale runtime with ptyd alive is replaced automatically, but never while busy", () => {
  assert.equal(resolveRuntimeUpdate(STALE), "automatic");
  assert.equal(shouldFollowBundledRuntime({ ...STALE, busy: false }), true);
  assert.equal(shouldFollowBundledRuntime({ ...STALE, busy: true }), false, "an action in flight owns the manager");
});

test("pre-ptyd supervisor (no leave) or missing ptyd keeps the confirmed manual path", () => {
  const preptyd = { ...STALE, running: { runtimeId: "old-1", supportsLeave: false } };
  assert.equal(resolveRuntimeUpdate(preptyd), "manual");
  assert.equal(shouldFollowBundledRuntime({ ...preptyd, busy: false }), false, "replacing it ends terminals: never automatic");
  assert.equal(resolveRuntimeUpdate({ ...STALE, ptydAlive: false }), "manual", "without ptyd the leave path cannot keep terminals");
  // Attempted or not makes no difference to the manual path.
  assert.equal(resolveRuntimeUpdate({ ...preptyd, attempted: new Set(["bundled-1"]) }), "manual");
});

test("at most one automatic attempt per launch per bundled runtimeId: afterwards it is failed, only 重试 tries again", () => {
  const attempted = new Set<string>();
  assert.equal(shouldFollowBundledRuntime({ ...STALE, attempted, busy: false }), true);
  attempted.add("bundled-1");
  assert.equal(shouldFollowBundledRuntime({ ...STALE, attempted, busy: false }), false, "no second automatic attempt");
  assert.equal(resolveRuntimeUpdate({ ...STALE, attempted }), "failed");
  // A different bundled id (the app updated again) gets its own single attempt.
  assert.equal(shouldFollowBundledRuntime({ ...STALE, bundledId: "bundled-2", attempted, busy: false }), true);
  assert.equal(resolveRuntimeUpdate({ ...STALE, bundledId: "bundled-2", attempted }), "automatic");
  // Once the running id matches, the attempt record is irrelevant.
  assert.equal(resolveRuntimeUpdate({ ...STALE, running: { runtimeId: "bundled-1", supportsLeave: true }, attempted }), null);
});
