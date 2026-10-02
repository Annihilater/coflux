import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, arch } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { TaskStatus } from "@coflux/protocol";
import { startStack, mkRepo } from "./harness.mjs";
import { openNativeDevice, utf8 } from "./device-harness.mjs";
import { runtimeReleaseStatement, transportReleaseStatement, workerReleaseStatement } from "../../scripts/release-statement.mjs";

// Remote download + ed25519 verification of a runtime release (plan 20261002-runtime-launcher-merge):
// the runtime downloads and verifies, installs into <home>/runtimes/<version>/, and asks the launcher
// to switch; the launcher owns runtime.active and the release floor. The first-class cases are
// negative: tampered or mis-signed artifacts are refused and the current version stays. Isolation:
// a temporary 127.0.0.1 HTTP server serves the artifacts (no network), a temporary ed25519 key whose
// public half reaches the runtime through the environment, and a temporary COFLUX_HOME.
const PORT = 8829;
const ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME_BIN = process.env.COFLUX_RUNTIME_BIN || join(ROOT, "target", "debug", "coflux-runtime");

function hostTarget() {
  const p = platform(), a = arch();
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (p === "linux") return a === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  throw new Error(`unsupported test host platform: ${p}/${a}`);
}
const TARGET = hostTarget();
const CROSS_TARGET = TARGET === "aarch64-apple-darwin" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";

// Temporary ed25519: the public key (hex) is injected into the runtime, the private key signs.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBKEY_HEX = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
const sign = (buf) => crypto.sign(null, buf, privateKey).toString("hex");
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A runtime release carries no raw-binary signature: the statement is the only one.
function signedRelease(version, artifact = ARTIFACT, target = TARGET) {
  const sha256 = sha256hex(artifact);
  const size = artifact.byteLength;
  return {
    version,
    sha256,
    target,
    artifactSize: BigInt(size),
    releaseSignature: sign(runtimeReleaseStatement({ version, target, sha256, size })),
    transport: { url: `${baseUrl}/helper`, sha256: sha256hex(HELPER), size: BigInt(HELPER.length),
      releaseSignature: sign(transportReleaseStatement({ version, target, sha256: sha256hex(HELPER), size: HELPER.length })) },
  };
}

// pretest builds without debug info: Linux DWARF would push the debug binary past the production
// 128 MiB download cap; the real runtime binary still plays the "new release" artifact.
const ARTIFACT = readFileSync(RUNTIME_BIN);
const HELPER = readFileSync(process.env.COFLUX_TRANSPORT_BIN || join(ROOT, "target/debug/coflux-transport"));
const TAMPERED = Buffer.from(ARTIFACT);
TAMPERED[0] ^= 0xff; // 改一个字节

let stack;
let clientToken;
let httpServer;
let baseUrl;
const repos = [];
let slowDownloadHits = 0;
const requestHits = new Map();

before(async () => {
  httpServer = http.createServer((req, res) => {
    requestHits.set(req.url, (requestHits.get(req.url) ?? 0) + 1);
    if (req.url === "/helper") return void res.writeHead(200).end(HELPER);
    if (req.url === "/good") return void res.writeHead(200).end(ARTIFACT);
    if (req.url === "/slow-old") {
      slowDownloadHits++;
      return void setTimeout(() => res.writeHead(200).end(ARTIFACT), 1800);
    }
    if (req.url === "/oversize-header") {
      return void res.writeHead(200, { "content-length": String(128 * 1024 * 1024 + 1) }).end();
    }
    if (req.url === "/tampered") return void res.writeHead(200).end(TAMPERED);
    res.writeHead(404).end();
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  stack = await startStack({ port: PORT, daemonEnv: { COFLUX_WORKER_PUBKEY: PUBKEY_HEX, COFLUX_RUNTIME_PROBATION_MS: "1500" } });
  // Reuse the session for upgrade polling instead of exhausting password-login limits.
  const client = stack.makeClient();
  try {
    await client.authSubscribe();
    const auth = await client.waitFor((m) => m.case === "authOk", "fixture authentication");
    assert.ok(auth.clientToken, "fixture authentication must issue a session token");
    clientToken = auth.clientToken;
  } finally {
    client.close();
  }
});
after(async () => {
  await stack?.stop();
  httpServer?.close();
  repos.forEach((r) => r.cleanup());
});

function readActive() {
  return readFileSync(join(stack.home, "runtime.active"), "utf8").trim();
}
function readRuntimePid() {
  return Number(readFileSync(join(stack.home, "runtime.pid"), "utf8").trim());
}
async function isOnline() {
  const p = stack.makeClient();
  try {
    const snap = await p.authTokenSubscribe(clientToken);
    return !!snap.daemons.find((d) => d.daemonId === stack.daemonId && d.online);
  } catch {
    return false;
  } finally {
    p.close();
  }
}
async function waitNewRuntime(prevPid) {
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    let pid;
    try { pid = readRuntimePid(); } catch { continue; }
    if (pid !== prevPid && (await isOnline())) return pid;
  }
  return 0;
}
async function waitActive(version, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(250);
    try { if (readActive() === version) return true; } catch { /* marker 原子替换期间也不应缺失，保守重试 */ }
  }
  return false;
}
async function waitDaemonVersion(version, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const c = stack.makeClient();
    try {
      const snap = await c.authTokenSubscribe(clientToken);
      const daemon = snap.daemons.find((item) => item.daemonId === stack.daemonId);
      if (daemon?.online && daemon.workerVersion === version) return true;
    } catch { /* supervisor/worker 正在重启 */ }
    finally { c.close(); }
    await sleep(250);
  }
  return false;
}
async function runTaskWithMarker(marker) {
  const repo = mkRepo();
  repos.push(repo);
  const device = await openNativeDevice(stack);
  const a = device.control;
  a.send({ case: "projectImport", daemonId: stack.daemonId, path: repo.dir });
  const main = await a.waitFor((m) => m.case === "workspaceCreated" && m.workspace.isMain, "main");
  a.send({ case: "taskCreate", workspaceId: main.workspace.id, title: "su" });
  const idle = await a.waitFor((m) => m.case === "taskUpdated" && m.task.title === "su", "idle");
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

test("远程下载 + 验签：合法签名产物升级成功、会话存活", async () => {
  assert.equal(readActive(), "builtin");
  const { device, sessionId, holderEpoch } = await runTaskWithMarker("SIGNED_OK");
  const pid1 = readRuntimePid();

  const c = device.control;
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.0.0"),
  });

  assert.ok(await waitNewRuntime(pid1), "the verified release starts and comes online");
  let committed = false;
  for (let i = 0; i < 80 && !committed; i++) {
    await sleep(250);
    try { committed = readActive() === "v1.0.0"; } catch { /* marker being replaced */ }
  }
  assert.ok(committed, "the verified release commits: runtime.active=v1.0.0");
  assert.equal(existsSync(join(stack.home, "runtimes", "v1.0.0", "coflux-runtime")), true, "installed into the launcher's store");

  await device.openNative();
  const restored = await device.attach(sessionId);
  void holderEpoch; // holders are reclaimed on reattach by design (every runtime update resets them)
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("SIGNED_OK"), "升级后 snapshot 保留历史");
  const from = device.mark();
  await device.input(sessionId, "echo AFTER_SIGNED\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("AFTER_SIGNED"), "升级后交互恢复", 10000, from);
  device.close();
});

test("launcher restart: recovers the committed runtime from runtime.active + the store", async () => {
  const pidBefore = readRuntimePid();
  await stack.restartDaemon();

  assert.ok(await waitDaemonVersion("v1.0.0"), "after the restart the stored v1.0.0 runs, not the builtin");
  assert.notEqual(readRuntimePid(), pidBefore, "the runtime is a fresh process started by the new launcher");
  await sleep(2000); // 跨过 1500ms 观察期，确认不是短暂启动后回退。
  assert.ok(await waitDaemonVersion("v1.0.0"), "恢复候选通过 UDS/resync 复检后继续运行");
  assert.equal(readActive(), "v1.0.0", "恢复复检后仍提交为 v1.0.0");
});

test("并发远程升级：新请求优先，旧慢下载后到不得覆盖", async () => {
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/slow-old`,
    ...signedRelease("v1.1.0"),
  });
  for (let i = 0; i < 40 && slowDownloadHits === 0; i++) await sleep(25);
  assert.equal(slowDownloadHits, 1, "旧请求已开始下载，构造真实后到竞态");

  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.2.0"),
  });
  assert.ok(await waitActive("v1.2.0"), "新请求先完成并提交");
  await sleep(2200); // 旧响应此时必已返回并完成验签；generation 应将其丢弃。
  assert.equal(readActive(), "v1.2.0", "旧下载晚到没有反向切回");
  assert.equal(existsSync(join(stack.home, "runtimes", "v1.1.0", "coflux-runtime")), false, "过期下载没有晋升到正式路径");
  assert.ok(await isOnline(), "最终 daemon 仍在线");
  c.close();
});

test("anti-rollback 持久化：重启后降级与同版本重放均在下载前拒绝", async () => {
  const pidBeforeRestart = readRuntimePid();
  await stack.restartDaemon();
  assert.ok(await waitDaemonVersion("v1.2.0"), "重启后恢复已提交 release");
  assert.notEqual(readRuntimePid(), pidBeforeRestart);
  await sleep(2000);
  assert.equal(readFileSync(join(stack.home, "runtime.release-floor"), "utf8").trim(), "v1.2.0");

  const pidBefore = readRuntimePid();
  const hitsBefore = requestHits.get("/good") ?? 0;
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.1.0"),
  });
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.2.0"),
  });
  await sleep(750);
  assert.equal(requestHits.get("/good") ?? 0, hitsBefore, "a downgrade and a replay never reach the network");
  assert.equal(readActive(), "v1.2.0");
  assert.equal(readRuntimePid(), pidBefore, "a refused request never restarts the runtime");
  c.close();
});

test("tampered release metadata is refused: a statement over another version never verifies", async () => {
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();
  const signed = signedRelease("v1.3.0");
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signed,
    version: "v1.3.1", // the statement was signed for v1.3.0 and must fail for v1.3.1
  });
  await sleep(1500);
  assert.equal(readActive(), activeBefore);
  assert.equal(readRuntimePid(), pidBefore);
  c.close();
});

test("跨 target 发布被拒：合法签名的其他架构也不下载/执行", async () => {
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();
  const hitsBefore = requestHits.get("/good") ?? 0;
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.3.2", ARTIFACT, CROSS_TARGET),
  });
  await sleep(750);
  assert.equal(requestHits.get("/good") ?? 0, hitsBefore, "target 不匹配在网络前 fail closed");
  assert.equal(readActive(), activeBefore);
  assert.equal(readRuntimePid(), pidBefore);
  c.close();
});

test("篡改产物被拒：sha256 不符 → 不切换、保持当前版本、会话不受影响", async () => {
  const activeBefore = readActive();
  const { device, sessionId } = await runTaskWithMarker("TAMPER_MARK");
  const pidBefore = readRuntimePid();

  const c = device.control;
  // 下发被篡改的 url，但 sha256/signature 仍是原始产物的 → 校验必失败
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/tampered`,
    ...signedRelease("v1.4.0"),
  });

  await sleep(1500); // 给下载+验签线程足够时间（localhost 很快），它应当拒绝
  assert.equal(readActive(), activeBefore, "refused: runtime.active unchanged");
  assert.equal(readRuntimePid(), pidBefore, "the runtime was not restarted (verification fails before any switch)");
  assert.ok(await isOnline(), "daemon 仍在线");

  const restored = await device.attach(sessionId);
  assert.ok(utf8(restored.ansiSnapshot ?? new Uint8Array()).includes("TAMPER_MARK"), "篡改被拒后 snapshot 历史保留");
  const from = device.mark();
  await device.input(sessionId, "echo STILL_ALIVE\r");
  await device.waitFor((m) => m.case === "ptyOutput" && utf8(m.data).includes("STILL_ALIVE"), "篡改被拒后会话仍存活", 10000, from);
  device.close();
});

test("a mismatched statement signature is refused: valid bytes, signature over other data", async () => {
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();

  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease("v1.5.0"),
    releaseSignature: sign(Buffer.from("not the statement")),
  });

  await sleep(1500);
  assert.equal(readActive(), activeBefore, "refused: runtime.active unchanged");
  assert.equal(readRuntimePid(), pidBefore, "the runtime was not restarted");
  assert.ok(await isOnline(), "daemon still online");
  c.close();
});

test("cross-component: a worker-domain statement over identical metadata never verifies a runtime", async () => {
  // The invariant that keeps a pre-plan supervisor and a runtime apart: same version, target,
  // sha256 and size, signed under `coflux-worker-release-v1`, is not a runtime release.
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();
  const version = "v1.5.1";
  const sha256 = sha256hex(ARTIFACT);
  const size = ARTIFACT.byteLength;
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/good`,
    ...signedRelease(version),
    releaseSignature: sign(workerReleaseStatement({ version, target: TARGET, sha256, size })),
    // Even with the legacy raw-binary signature a worker release would carry.
    signature: sign(ARTIFACT),
  });
  await sleep(1500);
  assert.equal(readActive(), activeBefore, "a worker-domain statement is refused for a runtime");
  assert.equal(readRuntimePid(), pidBefore, "the runtime was not restarted");
  assert.equal(existsSync(join(stack.home, "runtimes", version, "coflux-runtime")), false, "nothing was installed");
  assert.ok(await isOnline(), "daemon still online");
  c.close();
});

test("超大下载被拒：仅凭 Content-Length 即在读取前失败，不重启 worker", async () => {
  const activeBefore = readActive();
  const pidBefore = readRuntimePid();
  const c = stack.makeClient();
  await c.authTokenSubscribe(clientToken);
  c.send({
    case: "clientUpgradeDaemon",
    daemonId: stack.daemonId,
    url: `${baseUrl}/oversize-header`,
    ...signedRelease("v1.6.0"),
  });
  await sleep(750);
  assert.equal(readActive(), activeBefore, "超过 128 MiB 硬上限的声明未改变 active");
  assert.equal(readRuntimePid(), pidBefore, "refused before any switch, the runtime was not restarted");
  assert.equal(existsSync(join(stack.home, "runtimes", "v1.6.0", "coflux-runtime")), false, "未写入正式产物");
  c.close();
});
