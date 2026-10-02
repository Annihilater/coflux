import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice, utf8 } from "./device-harness.mjs";

// Runtime switch through the launcher (plan 20261002-runtime-launcher-merge): the centre pushes
// `workerUpgrade` → runtime → private launcher channel → launcher switches, runs probation and
// commits or rolls back. Sessions live in ptyd throughout. No downloads here (the signed path is
// signed-upgrade.test.mjs): switches move between versions registered with the launcher.
//
// The health gate is checked by the launcher itself: the candidate must echo the per-spawn nonce,
// report every live session ptyd holds, and report a gateway port that accepts a connection. Each
// stub below defeats exactly one of those and must never commit.
const PORT = 8828;
const ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME_BIN = process.env.COFLUX_RUNTIME_BIN || join(ROOT, "target", "debug", "coflux-runtime");

/** A stub that connects to the launcher channel and sends one JSON line (or nothing). */
function stub(body) {
  return `
const net = require("node:net");
${body}
setInterval(() => {}, 1000);
`;
}
const CONNECT_ONLY = stub(`
const socket = net.connect(process.env.COFLUX_LAUNCHER_SOCK);
socket.on("data", () => {});
socket.on("error", () => {});
`);
const WRONG_NONCE = stub(`
const socket = net.connect(process.env.COFLUX_LAUNCHER_SOCK, () => {
  socket.write(JSON.stringify({ type: "ready", nonce: "00000000000000000000000000000000", sessions: [], gatewayPort: 1 }) + "\\n");
});
socket.on("data", () => {});
socket.on("error", () => {});
`);
// Right nonce, a listening gateway, but claims to serve no session at all: with a live terminal
// in ptyd the launcher must see the one it did not take over.
const NO_SESSIONS = stub(`
const server = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
  const socket = net.connect(process.env.COFLUX_LAUNCHER_SOCK, () => {
    socket.write(JSON.stringify({ type: "ready", nonce: process.env.COFLUX_LAUNCHER_NONCE, sessions: [], gatewayPort: server.address().port }) + "\\n");
  });
  socket.on("data", () => {});
  socket.on("error", () => {});
});
`);
// Right nonce, no live session to take over (the test runs it with none), but a gateway port
// nothing listens on.
const NO_GATEWAY = stub(`
const probe = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
  const port = probe.address().port;
  probe.close(() => {
    const socket = net.connect(process.env.COFLUX_LAUNCHER_SOCK, () => {
      socket.write(JSON.stringify({ type: "ready", nonce: process.env.COFLUX_LAUNCHER_NONCE, sessions: [], gatewayPort: port }) + "\\n");
    });
    socket.on("data", () => {});
    socket.on("error", () => {});
  });
});
`);

const SPECS = {
  // The real runtime under another name: must pass probation and commit.
  good2: { cmd: RUNTIME_BIN, args: [] },
  // Exits at once: crash-loops and rolls back.
  bad2: { cmd: process.execPath, args: ["-e", "process.exit(1)"] },
  // Alive but never reports: an observation period judging only liveness would commit it.
  silent: { cmd: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
  // Connects to the channel, never sends ready.
  connectOnly: { cmd: process.execPath, args: ["-e", CONNECT_ONLY] },
  // Blind ready with a fixed nonce: must not pass by chance.
  wrongNonce: { cmd: process.execPath, args: ["-e", WRONG_NONCE] },
  noSessions: { cmd: process.execPath, args: ["-e", NO_SESSIONS] },
  noGateway: { cmd: process.execPath, args: ["-e", NO_GATEWAY] },
};

let stack;
const repos = [];

before(async () => {
  stack = await startStack({
    port: PORT,
    daemonEnv: { COFLUX_RUNTIME_SPECS: JSON.stringify(SPECS), COFLUX_RUNTIME_PROBATION_MS: "1500" },
  });
});
after(async () => { await stack?.stop(); repos.forEach((r) => r.cleanup()); });

function readActive() {
  return readFileSync(join(stack.home, "runtime.active"), "utf8").trim();
}
function readRuntimePid() {
  return Number(readFileSync(join(stack.home, "runtime.pid"), "utf8").trim());
}
async function readDaemonState() {
  const p = stack.makeClient();
  try {
    const snap = await p.authSubscribe();
    return snap.daemons.find((d) => d.daemonId === stack.daemonId);
  } catch {
    return undefined;
  } finally {
    p.close();
  }
}

/**
 * Prove a runtime switch really converged:
 * 1) an observer opened before the trigger sees only daemonUpdated events after it;
 * 2) the old daemon must go offline before a connection with the target workerVersion comes online;
 * 3) runtime.pid must change, and a fresh snapshot must still map to the target version.
 */
async function waitRuntimeReconnect(prevPid, expectedVersion, trigger, label) {
  const observer = stack.makeClient();
  await observer.authSubscribe();
  let sawOffline = false;
  const trail = [];
  let timer;
  const transition = new Promise((resolveTransition, rejectTransition) => {
    const unsubscribe = observer.subscribe((m) => {
      if (m.case !== "daemonUpdated" || m.daemon.daemonId !== stack.daemonId) return;
      trail.push((m.daemon.online ? "online" : "offline") + ":" + (m.daemon.workerVersion || "-"));
      if (!m.daemon.online) {
        sawOffline = true;
        return;
      }
      if (sawOffline && m.daemon.workerVersion === expectedVersion) {
        unsubscribe();
        resolveTransition(m.daemon);
      }
    });
    timer = setTimeout(() => {
      unsubscribe();
      rejectTransition(new Error(label + ": no offline → online:" + expectedVersion + " observed, events=" + (trail.join(",") || "none")));
    }, 30000);
  });

  try {
    await trigger();
    const connected = await transition;
    assert.equal(connected.online, true);
    assert.equal(connected.workerVersion, expectedVersion);

    let pid = prevPid;
    for (let i = 0; i < 40 && pid === prevPid; i++) {
      await sleep(50);
      try { pid = readRuntimePid(); } catch { /* runtime.pid being written */ }
    }
    assert.notEqual(pid, prevPid, label + ": the target connection must come from a new runtime process");

    let converged;
    for (let i = 0; i < 40; i++) {
      converged = await readDaemonState();
      if (converged?.online && converged.workerVersion === expectedVersion) break;
      await sleep(100);
    }
    assert.equal(converged?.online, true, label + ": fresh snapshot online");
    assert.equal(converged?.workerVersion, expectedVersion, label + ": fresh snapshot on the target version");
    return pid;
  } finally {
    clearTimeout(timer);
    observer.close();
  }
}

/** Start a running task, type a marker, return its coordinates. */
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openNativeDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "up" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "up", "idle");
  const taskId = idle.task.id;
  a.send({ case: "taskStart", taskId, cols: 80, rows: 24 });
  const run = await a.waitFor((m) => m.case === "taskUpdated" && m.task.id === taskId && m.task.status === TaskStatus.RUNNING, "run");
  const sessionId = run.task.sessionId;
  const attached = await device.attach(sessionId);
  const from = device.mark();
  await device.input(sessionId, `echo ${marker}\r`);
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes(marker), "marker", 10000, from);
  return { device, taskId, sessionId, holderEpoch: attached.holderEpoch };
}

/** Switch to a stub that must never commit; the launcher rolls back to `activeBefore`. */
async function expectRollback(version, label) {
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();
  const c = stack.makeClient();
  await c.authSubscribe();
  const rollbackPid = await waitRuntimeReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version }),
    label,
  );
  assert.ok(rollbackPid, label + ": a healthy runtime is back online after the rollback");
  assert.equal(readActive(), activeBefore, label + ": the candidate never reached runtime.active");
  c.close();
}

test("switch succeeds: good2 passes probation, commits, sessions survive", async () => {
  assert.equal(readActive(), "builtin", "initial version is builtin");
  const { device, sessionId, holderEpoch: _holderEpoch } = await runTaskWithMarker("UP_OK_MARK");
  const pid1 = readRuntimePid();

  const c = device.control;
  const pid2 = await waitRuntimeReconnect(
    pid1,
    "good2",
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "good2" }),
    "switch good2",
  );
  assert.ok(pid2, "the new runtime is up and online");
  let committed = false;
  for (let i = 0; i < 40 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "good2"; } catch { /* marker being replaced */ }
  }
  assert.ok(committed, "after probation runtime.active=good2");

  // Sessions survive the swap: the shell stayed in ptyd, the new runtime rebuilt it. Holders are
  // reclaimed on reattach (accepted: every runtime update resets them).
  await device.openNative();
  const restored = await device.attach(sessionId);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("UP_OK_MARK"), "history kept across the switch");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_UPGRADE\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_UPGRADE"), "input works after the switch", 10000, from);
  device.close();
});

test("crash-loop rollback: bad2 exits at once → automatic rollback, sessions survive", async () => {
  const activeBefore = readActive(); // good2 after the previous test
  const { device, sessionId } = await runTaskWithMarker("ROLLBACK_MARK");
  const pidBefore = readRuntimePid();

  const c = device.control;
  const rollbackPid = await waitRuntimeReconnect(
    pidBefore,
    activeBefore,
    () => c.send({ case: "clientUpgradeDaemon", daemonId: stack.daemonId, version: "bad2" }),
    "bad2 rollback",
  );
  assert.ok(rollbackPid, "a healthy runtime is back after the rollback");
  assert.equal(readActive(), activeBefore, "runtime.active unchanged: bad2 never committed");

  await device.openNative();
  const restored = await device.attach(sessionId);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("ROLLBACK_MARK"), "history kept across the rollback");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_ROLLBACK\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_ROLLBACK"), "input works after the rollback", 10000, from);
  device.close();
});

test("pseudo-healthy rollback: alive but silent never commits", async () => {
  await expectRollback("silent", "silent rollback");
});

test("pseudo-healthy rollback: connects to the channel but never reports ready, never commits", async () => {
  await expectRollback("connectOnly", "connectOnly rollback");
});

test("pseudo-healthy rollback: a blind ready with the wrong nonce never commits", async () => {
  await expectRollback("wrongNonce", "wrongNonce rollback");
});

test("pseudo-healthy rollback: the right nonce but a live ptyd session not taken over never commits", async () => {
  // At least one terminal is live in ptyd from the earlier tests; make sure of it.
  const { device } = await runTaskWithMarker("TAKEOVER_MARK");
  device.close();
  await expectRollback("noSessions", "noSessions rollback");
});

test("pseudo-healthy rollback: the right nonce but a gateway port nothing listens on never commits", async () => {
  // Stop every terminal first so the session check passes with an empty report and only the
  // gateway check can fail. A stop goes through the holder, so attach first; any failure to
  // stop must surface here, not be swallowed into a misleading assertion later.
  const device = await openNativeDevice(stack);
  const catalog = await device.catalog();
  for (const session of catalog.sessions) {
    await device.attach(session.sessionId);
    const ack = await device.stopSession(session.sessionId);
    assert.equal(ack.ok, true, `stop of ${session.sessionId} must be acknowledged`);
  }
  for (let i = 0; i < 100; i += 1) {
    if ((await device.catalog()).sessions.length === 0) break;
    await sleep(100);
  }
  assert.equal((await device.catalog()).sessions.length, 0, "no live session remains");
  device.close();
  await expectRollback("noGateway", "noGateway rollback");
});

test("restart recovery: runtime.active pointing at a pseudo-healthy version ends on builtin", async () => {
  const pidBefore = readRuntimePid();
  // The launcher died after the marker was updated while the candidate can never pass the checks.
  writeFileSync(join(stack.home, "runtime.active"), "silent");
  const fallbackPid = await waitRuntimeReconnect(
    pidBefore,
    "builtin",
    () => stack.restartDaemon(),
    "restart recovery fallback",
  );
  assert.ok(fallbackPid, "builtin is back online after the recovered candidate failed twice");
  assert.equal(readActive(), "builtin", "the unusable persisted active was atomically reset to builtin");
});
