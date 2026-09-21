import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { EXECUTOR_HOST_CAPABILITY } from "./capability.js";
import { createExecutorConfigStore } from "./config.js";
import { createExecutorHostCore } from "./host-core.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

// The executor host capability is one string agreed between two languages, and a mismatch is
// invisible from inside the app: the settings page still reads "ready" and the only symptom is the
// agent being told there is no executor host on this machine. Read the daemon's constant from its
// own source, and the protocol package's copy from its own, so a rename on any side fails here
// instead of silently disabling every executor run.
test("executor host 能力名与 daemon、protocol 两侧常量逐字一致", () => {
  const daemon = readFileSync(join(repoRoot, "crates/worker/src/agent_ctl/executor.rs"), "utf8");
  const declared = daemon.match(/pub const CAPABILITY_EXECUTOR_HOST: &str = "([^"]+)";/);
  assert.ok(declared, "daemon 侧常量没找到（改名了？）");
  assert.equal(EXECUTOR_HOST_CAPABILITY, declared[1]);

  const protocol = readFileSync(join(repoRoot, "packages/protocol/src/index.ts"), "utf8");
  const exported = protocol.match(/export const EXECUTOR_HOST_CAPABILITY = "([^"]+)";/);
  assert.ok(exported, "protocol 侧常量没找到（改名了？）");
  assert.equal(EXECUTOR_HOST_CAPABILITY, exported[1]);
});

// The pin above only covers the spelling. This one covers the wiring: a host that registers with a
// literal of its own would keep the constants in agreement and still be refused by the daemon.
test("host 登记帧带的正是那个共享常量", () => {
  const config = createExecutorConfigStore({ cachePath: join(repoRoot, "no-such-executor-settings.json") });
  try {
    const core = createExecutorHostCore({
      config,
      spawnRunner: () => assert.fail("不该起 runner"),
      send: () => {},
      log: () => {},
    });
    const frame = core.registerFrame(7);
    assert.deepEqual(frame.capabilities, [EXECUTOR_HOST_CAPABILITY]);
    assert.equal(frame.hostEpoch, 7);
    assert.equal(frame.hostId, core.hostId);
    // No configuration on disk means the host registers as not ready, with the reason the calling
    // agent is shown verbatim rather than an empty string.
    assert.equal(frame.ready, false);
    assert.ok(frame.notReadyReason.length > 0);
  } finally {
    config.dispose();
  }
});
