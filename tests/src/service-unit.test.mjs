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
} from "../../packages/cli/service-unit.mjs";

const executor = { node: "/opt/node/bin/node", entry: "/opt/coflux/executor/dist/host.js" };
const base = { supervisorBin: "/home/u/.coflux/bin/coflux-supervisor", home: "/home/u/.coflux", logFile: "/home/u/.coflux/daemon.log" };

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
  // An empty value would look configured to the worker, which then fails to spawn a host on every
  // start. Absent is the state that makes it fall back to "this machine does not host one".
  for (const text of [plistXml({ ...base, executor: null }), systemdUnit({ ...base, executor: null })]) {
    assert.ok(!text.includes(EXECUTOR_NODE_ENV), text);
    assert.ok(!text.includes(EXECUTOR_ENTRY_ENV), text);
  }
});

test("a path with XML metacharacters cannot break out of the plist", () => {
  const plist = plistXml({ ...base, executor: { node: "/opt/a&b/node", entry: "/opt/<x>/host.js" } });
  assert.ok(plist.includes("/opt/a&amp;b/node"));
  assert.ok(plist.includes("/opt/&lt;x&gt;/host.js"));
});

test("cofluxd depends on the executor package and can resolve its host entry", () => {
  // The dependency is what makes `npm i -g cofluxd` self-sufficient: without it the daemon installs
  // fine and silently has no executor.
  const manifest = JSON.parse(readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"));
  assert.ok(manifest.dependencies?.["@coflux/executor"], "cofluxd 必须依赖 @coflux/executor");
  assert.ok(manifest.files.includes("service-unit.mjs"), "发布清单必须带上 service-unit.mjs");

  const runtime = executorRuntime();
  assert.ok(runtime, "@coflux/executor/host 必须能被 cofluxd 解析到");
  assert.ok(runtime.node.startsWith("/"));
  assert.ok(runtime.entry.startsWith("/"));
});
