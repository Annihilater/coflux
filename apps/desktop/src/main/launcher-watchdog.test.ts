import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldStartLauncher, type LauncherWatchdogFacts } from "./launcher-watchdog";

const base: LauncherWatchdogFacts = { ptydAlive: true, launcherAlive: false, installed: true, busy: false, lastFailureAt: null, now: 10_000, backoffMs: 10_000 };

test("a dead launcher over live terminals is started again, with backoff after a failed attempt", () => {
  assert.equal(shouldStartLauncher(base), true);
  assert.equal(shouldStartLauncher({ ...base, launcherAlive: true }), false, "something answers runtime.sock: nothing to do");
  assert.equal(shouldStartLauncher({ ...base, ptydAlive: false }), false, "no ptyd = the user stopped the local runtime; the panel stays stopped");
  assert.equal(shouldStartLauncher({ ...base, installed: false }), false, "never set up: no directory to start from");
  assert.equal(shouldStartLauncher({ ...base, busy: true }), false, "an action in flight owns the manager");
  assert.equal(shouldStartLauncher({ ...base, lastFailureAt: 5_000 }), false, "a failed start is not retried before the backoff");
  assert.equal(shouldStartLauncher({ ...base, lastFailureAt: 0 }), true, "after the backoff it is retried");
});
