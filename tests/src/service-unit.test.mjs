// The service units cofluxd writes must carry the executor runtime.
//
// This is the one thing on that path a person cannot notice: a unit missing
// COFLUX_EXECUTOR_NODE / COFLUX_EXECUTOR_ENTRY still starts a perfectly healthy daemon, and the
// only symptom appears much later, on another machine's agent, as "this machine has no executor
// host". Everything else about `cofluxd up` announces itself the first time you run it.
//
// Pure functions only: no ports, no stack, no processes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EXECUTOR_ENTRY_ENV,
  EXECUTOR_NODE_ENV,
  executorRuntime,
  plistXml,
  systemdUnit,
  WATCHER_ENV_ALLOWLIST,
  watcherEnv,
} from "../../packages/cli/service-unit.mjs";

const executor = { node: "/opt/node/bin/node", entry: "/opt/coflux/executor/dist/host.js" };
const base = { launcherBin: "/home/u/.coflux/bin/coflux-launcher", home: "/home/u/.coflux", logFile: "/home/u/.coflux/daemon.log" };

test("launchd plist carries the executor runtime as absolute paths", () => {
  const plist = plistXml({ ...base, executor });
  assert.match(plist, new RegExp(`<key>${EXECUTOR_NODE_ENV}</key><string>${executor.node}</string>`));
  assert.match(plist, new RegExp(`<key>${EXECUTOR_ENTRY_ENV}</key><string>${executor.entry}</string>`));
  // COFLUX_HOME must survive the change; it is what everything else on the daemon reads.
  assert.match(plist, /<key>COFLUX_HOME<\/key><string>\/home\/u\/\.coflux<\/string>/);
});

test("systemd unit carries the executor runtime, one Environment line each", () => {
  const unit = systemdUnit({ ...base, executor });
  assert.ok(unit.includes(`Environment=${EXECUTOR_NODE_ENV}=${executor.node}`));
  assert.ok(unit.includes(`Environment=${EXECUTOR_ENTRY_ENV}=${executor.entry}`));
  assert.ok(unit.includes("Environment=COFLUX_HOME=/home/u/.coflux"));
});

test("no executor runtime means no variables, not empty ones", () => {
  // An empty value would look configured to the runtime, which then fails to spawn a host on every
  // start. Absent is the state that makes it fall back to "this machine does not host one".
  for (const text of [plistXml({ ...base, executor: null }), systemdUnit({ ...base, executor: null })]) {
    assert.ok(!text.includes(EXECUTOR_NODE_ENV), text);
    assert.ok(!text.includes(EXECUTOR_ENTRY_ENV), text);
  }
});

test("the self-managed service carries the executor runtime and only its own COFLUX_* variables", () => {
  // `cofluxd up` run inside a Coflux terminal inherits that terminal's service coordinates. Passed on,
  // they would make the new launcher and runtime bind another service's sockets.
  const inherited = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/u",
    LANG: "C.UTF-8",
    COFLUX_HOME: "/home/u/.other",
    COFLUX_LAUNCHER_SOCK: "/home/u/.other/launcher.sock",
    COFLUX_LAUNCHER_NONCE: "nonce",
    COFLUX_TRANSPORT_PAIR: "1",
    COFLUX_TRANSPORT_REQUIRED: "1",
    COFLUX_LOCAL_GATEWAY_PORT: "9999",
    COFLUX_SESSION_ID: "session",
    COFLUX_RUNTIME_CMD: "/Applications/Coflux.app/runtime",
    COFLUX_RUNTIME_CONTROL: "1",
    COFLUX_EXECUTOR_NODE: "/stale/node",
    COFLUX_WORKER_PUBKEY: "ab".repeat(32),
    COFLUX_RUNTIME_PROBATION_MS: "500",
  };
  const env = watcherEnv(inherited, { home: base.home, executor });
  assert.equal(env.COFLUX_HOME, base.home);
  assert.equal(env[EXECUTOR_NODE_ENV], executor.node);
  assert.equal(env[EXECUTOR_ENTRY_ENV], executor.entry);
  for (const key of ["COFLUX_LAUNCHER_SOCK", "COFLUX_LAUNCHER_NONCE", "COFLUX_TRANSPORT_PAIR", "COFLUX_TRANSPORT_REQUIRED", "COFLUX_LOCAL_GATEWAY_PORT", "COFLUX_SESSION_ID", "COFLUX_RUNTIME_CMD", "COFLUX_RUNTIME_CONTROL"]) {
    assert.ok(!(key in env), `${key} must not reach the self-managed service`);
  }
  assert.ok(WATCHER_ENV_ALLOWLIST.includes("COFLUX_WORKER_PUBKEY"));
  assert.equal(env.COFLUX_WORKER_PUBKEY, inherited.COFLUX_WORKER_PUBKEY);
  assert.equal(env.COFLUX_RUNTIME_PROBATION_MS, "500");
  for (const key of ["PATH", "HOME", "LANG"]) assert.equal(env[key], inherited[key]);
  for (const key of Object.keys(env)) {
    if (key.startsWith("COFLUX_")) {
      assert.ok(key === "COFLUX_HOME" || key === EXECUTOR_NODE_ENV || key === EXECUTOR_ENTRY_ENV || WATCHER_ENV_ALLOWLIST.includes(key), key);
    }
  }
});

test("no executor runtime leaves no executor variables in the self-managed service", () => {
  const env = watcherEnv({ COFLUX_EXECUTOR_NODE: "/stale/node", COFLUX_EXECUTOR_ENTRY: "/stale/host.js" }, { home: base.home, executor: null });
  assert.ok(!(EXECUTOR_NODE_ENV in env));
  assert.ok(!(EXECUTOR_ENTRY_ENV in env));
  assert.equal(env.COFLUX_HOME, base.home);
});

test("a path with XML metacharacters cannot break out of the plist", () => {
  const plist = plistXml({ ...base, executor: { node: "/opt/a&b/node", entry: "/opt/<x>/host.js" } });
  assert.ok(plist.includes("/opt/a&amp;b/node"));
  assert.ok(plist.includes("/opt/&lt;x&gt;/host.js"));
});

test("cofluxd ships the executor itself and can resolve its host entry", () => {
  // `@coflux/executor` is workspace-internal and never published, so what makes `npm i -g cofluxd`
  // self-sufficient is three things together: prepack bundles the host and runner into `executor/`,
  // the publish manifest carries that directory, and pi — left external by the bundle — is a real
  // dependency users resolve from the registry. Drop any one and the daemon installs fine and
  // silently has no executor.
  const manifest = JSON.parse(readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"));
  assert.ok(manifest.scripts?.prepack?.includes("esbuild"), "prepack 必须把 executor 打进包里");
  assert.ok(manifest.files.includes("executor"), "发布清单必须带上 executor 产物目录");
  assert.ok(manifest.files.includes("service-unit.mjs"), "发布清单必须带上 service-unit.mjs");
  assert.ok(
    manifest.dependencies?.["@earendil-works/pi-coding-agent"],
    "pi 在 bundle 里是 external，必须是 cofluxd 的真实依赖",
  );
  assert.ok(!manifest.dependencies?.["@coflux/executor"], "workspace 内部包不会发布，不能出现在 dependencies 里");

  const runtime = executorRuntime();
  assert.ok(runtime, "executor host 入口必须能被 cofluxd 解析到");
  assert.ok(runtime.node.startsWith("/"));
  assert.ok(runtime.entry.startsWith("/"));
});
