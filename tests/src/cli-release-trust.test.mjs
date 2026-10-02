import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  cliReleaseStatement,
  launcherReleaseStatement,
  ptydReleaseStatement,
  runtimeReleaseStatement,
  transportReleaseStatement,
  workerReleaseStatement,
} from "../../scripts/release-statement.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "packages/cli/cofluxd.mjs");
const VERSION = "v9.8.7";

function rustTarget() {
  if (platform() === "darwin") return arch() === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform() === "linux") return arch() === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  throw new Error(`测试不支持 ${platform()}/${arch()}`);
}

function rawPublicKeyHex(publicKey) {
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
}

function releaseFixture(withCli = false, withTransport = false) {
  const target = rustTarget();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // macOS 正向路径会在验签后执行真实 ad-hoc codesign；用一个可签名/可执行的本机 Mach-O
  // fixture（Linux 上同样是小型 ELF），避免测试靠跳过安全步骤获得假绿灯。
  const executable = readFileSync("/usr/bin/true");
  // Schema 3 (plan 20261002-runtime-launcher-merge): launcher + runtime, no worker, no raw signature.
  // ptyd is mandatory in every release: the fixture always carries it.
  const artifacts = { launcher: executable, runtime: executable, cli: executable, transport: executable, ptyd: executable };
  const manifest = { schemaVersion: 3, version: VERSION, runtime: {}, launcher: {} };
  const statements = {
    runtime: runtimeReleaseStatement, launcher: launcherReleaseStatement, cli: cliReleaseStatement,
    transport: transportReleaseStatement, ptyd: ptydReleaseStatement,
  };
  for (const component of ["launcher", "runtime", "ptyd", ...(withCli ? ["cli"] : []), ...(withTransport ? ["transport"] : [])]) {
    manifest[component] ??= {};
    const data = artifacts[component];
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const metadata = { version: VERSION, target, sha256, size: data.byteLength };
    manifest[component][target] = {
      url: `https://example.invalid/${component}`,
      target,
      sha256,
      size: data.byteLength,
      releaseSignature: crypto.sign(null, statements[component](metadata), privateKey).toString("hex"),
    };
  }
  return { target, publicKey, privateKey, artifacts, manifest };
}

// One local server plays both download sources: the R2 mirror under /mirror (its `latest.json` pointer
// plus the release it names) and the GitHub Releases archive under /archive. Both carry the fixture's
// release so a test can prove which one cofluxd chose; `requests` records every path asked for.
// `pointer`: a tag for latest.json, "missing" for a 404, or "broken" for a 500.
async function serveRelease(fixture, { pointer = VERSION } = {}) {
  const requests = [];
  const releaseRoutes = (prefix) => [
    [`${prefix}/manifest.json`, Buffer.from(JSON.stringify(fixture.manifest))],
    [`${prefix}/coflux-launcher-${fixture.target}`, fixture.artifacts.launcher],
    [`${prefix}/coflux-runtime-${fixture.target}`, fixture.artifacts.runtime],
    [`${prefix}/coflux-cli-${fixture.target}`, fixture.artifacts.cli],
    [`${prefix}/coflux-transport-${fixture.target}`, fixture.artifacts.transport],
    [`${prefix}/coflux-ptyd-${fixture.target}`, fixture.artifacts.ptyd],
    [`${prefix}/coflux-transport-NOTICES-${fixture.target}.txt`, Buffer.from("test dependency notices")],
  ];
  const routes = new Map([
    ...releaseRoutes(`/mirror/${VERSION}`),
    ...releaseRoutes(`/archive/${VERSION}`),
    ...(pointer === "missing" || pointer === "broken"
      ? []
      : [["/mirror/latest.json", Buffer.from(JSON.stringify({ version: pointer }))]]),
  ]);
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (pointer === "broken" && req.url === "/mirror/latest.json") {
      res.writeHead(500).end();
      return;
    }
    const body = routes.get(req.url);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-length": body.byteLength });
    res.end(body);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    mirror: `${origin}/mirror`,
    archive: `${origin}/archive`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function makeInstallHome() {
  const home = mkdtempSync(join(tmpdir(), "coflux-cli-release-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "settings.json"), "{}\n");
  writeFileSync(join(bin, "coflux-launcher"), "old launcher\n");
  writeFileSync(join(bin, "coflux-runtime"), "old runtime\n");
  return home;
}

async function runUpdate(home, fixture, endpoint, { latest = false, env = {} } = {}) {
  const args = [CLI, "update", ...(latest ? [] : ["--version", VERSION])];
  return execFileAsync(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      COFLUX_HOME: home,
      COFLUX_RELEASE_DOWNLOAD_BASE: endpoint.mirror,
      COFLUX_RELEASE_ARCHIVE_BASE: endpoint.archive,
      // Same override as the runtime's test / self-keyed entry; production reads the npm package's key.
      COFLUX_WORKER_PUBKEY: rawPublicKeyHex(fixture.publicKey),
      ...env,
    },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

test("cofluxd：两个远端二进制全部验签后才替换", async () => {
  const fixture = releaseFixture();
  const endpoint = await serveRelease(fixture);
  const home = makeInstallHome();
  try {
    await runUpdate(home, fixture, endpoint);
    for (const name of ["coflux-launcher", "coflux-runtime"]) {
      const installed = join(home, "bin", name);
      assert.notEqual(readFileSync(installed, "utf8"), `old ${name.slice("coflux-".length)}\n`);
      assert.equal(spawnSync(installed).status, 0, `${name} 应保持可执行`);
    }
    // ptyd 随同一次安装落盘：没有它 runtime 会拒绝启动（组件表就是它加入安装路径的地方）。
    assert.equal(spawnSync(join(home, "bin", "coflux-ptyd")).status, 0, "coflux-ptyd 应已安装且可执行");
    assert.equal(readFileSync(join(home, "cofluxd.release-floor"), "utf8").trim(), VERSION);
  } finally {
    await endpoint.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cofluxd：任一产物被篡改时不留下半套新二进制", async () => {
  for (const component of ["launcher", "runtime"]) {
    const fixture = releaseFixture();
    fixture.artifacts[component] = Buffer.from(`tampered ${component}\n`);
    const endpoint = await serveRelease(fixture);
    const home = makeInstallHome();
    try {
      await assert.rejects(runUpdate(home, fixture, endpoint));
      assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
      assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cofluxd：version/target/size/sha/signature 元数据错配均 fail closed", async () => {
  const mutations = [
    (fixture) => { fixture.manifest.version = "v9.8.6"; },
    (fixture) => { fixture.manifest.launcher[fixture.target].target = "x86_64-unknown-linux-musl-wrong"; },
    (fixture) => { fixture.manifest.launcher[fixture.target].size += 1; },
    (fixture) => { fixture.manifest.launcher[fixture.target].sha256 = "00".repeat(32); },
    (fixture) => { fixture.manifest.launcher[fixture.target].releaseSignature = "00".repeat(64); },
    (fixture) => { fixture.manifest.runtime[fixture.target].releaseSignature = "00".repeat(64); },
    // A schema 2 manifest (worker + supervisor) is refused outright: this cofluxd installs a launcher.
    (fixture) => { fixture.manifest.schemaVersion = 2; },
  ];
  for (const mutate of mutations) {
    const fixture = releaseFixture();
    mutate(fixture);
    const endpoint = await serveRelease(fixture);
    const home = makeInstallHome();
    try {
      await assert.rejects(runUpdate(home, fixture, endpoint));
      assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
      assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cofluxd：worker domain 的合法签名不能移植给 runtime 或 launcher", async () => {
  // Cross-component invariant: a statement under `coflux-worker-release-v1` over identical
  // metadata verifies neither a runtime nor a launcher entry.
  for (const component of ["runtime", "launcher"]) {
    const fixture = releaseFixture();
    const entry = fixture.manifest[component][fixture.target];
    entry.releaseSignature = crypto.sign(
      null,
      workerReleaseStatement({ version: VERSION, target: fixture.target, sha256: entry.sha256, size: entry.size }),
      fixture.privateKey,
    ).toString("hex");
    // Even with the legacy raw-binary signature a worker release would carry.
    entry.signature = crypto.sign(null, fixture.artifacts[component], fixture.privateKey).toString("hex");
    const endpoint = await serveRelease(fixture);
    const home = makeInstallHome();
    try {
      await assert.rejects(runUpdate(home, fixture, endpoint));
      assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
      assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cofluxd：latest 指向旧的合法签名 release 时仍受本机双 floor 拒绝", async () => {
  const fixture = releaseFixture();
  const endpoint = await serveRelease(fixture);
  const home = makeInstallHome();
  try {
    // The CLI's own floor is lower, the launcher's persisted runtime floor higher; the greater wins.
    writeFileSync(join(home, "cofluxd.release-floor"), "v9.8.6\n", { mode: 0o600 });
    writeFileSync(join(home, "runtime.release-floor"), "v9.8.8\n", { mode: 0o600 });
    await assert.rejects(
      runUpdate(home, fixture, endpoint, { latest: true }),
      /not newer than the version this device already trusts|refusing a downgrade or replay/,
    );
    assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
    assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
    assert.equal(readFileSync(join(home, "cofluxd.release-floor"), "utf8"), "v9.8.6\n");
    assert.equal(readFileSync(join(home, "runtime.release-floor"), "utf8"), "v9.8.8\n");
  } finally {
    await endpoint.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cofluxd：损坏的本机 release floor 不会降级成放行", async () => {
  const fixture = releaseFixture();
  const endpoint = await serveRelease(fixture);
  const home = makeInstallHome();
  try {
    writeFileSync(join(home, "cofluxd.release-floor"), "not-semver\n", { mode: 0o600 });
    await assert.rejects(runUpdate(home, fixture, endpoint), /release-floor is corrupted/);
    assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
    assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
  } finally {
    await endpoint.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cofluxd：macOS ad-hoc 重签失败时保留旧 pair", { skip: platform() !== "darwin" }, async () => {
  const fixture = releaseFixture();
  const endpoint = await serveRelease(fixture);
  const home = makeInstallHome();
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin);
  const codesign = join(fakeBin, "codesign");
  writeFileSync(codesign, "#!/bin/sh\nexit 1\n");
  chmodSync(codesign, 0o755);
  try {
    await assert.rejects(runUpdate(home, fixture, endpoint, {
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    }));
    assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
    assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
    assert.equal(existsSync(join(home, "cofluxd.release-floor")), false, "重签失败发生在 floor/pair 提交之前");
  } finally {
    await endpoint.close();
    rmSync(home, { recursive: true, force: true });
  }
});


test("cofluxd：新版交付三份可执行文件，CLI 验签失败保留完整旧版", async () => {
  for (const damaged of [false, true]) {
    const fixture = releaseFixture(true);
    if (damaged) fixture.artifacts.cli = Buffer.from("damaged cli");
    const endpoint = await serveRelease(fixture);
    const home = makeInstallHome();
    writeFileSync(join(home, "bin/coflux"), "old cli");
    try {
      if (damaged) {
        await assert.rejects(runUpdate(home, fixture, endpoint));
        assert.equal(readFileSync(join(home, "bin/coflux"), "utf8"), "old cli");
        assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
        assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
      } else {
        await runUpdate(home, fixture, endpoint);
        for (const name of ["coflux", "coflux-runtime", "coflux-launcher"]) {
          assert.equal(spawnSync(join(home, "bin", name)).status, 0);
        }
      }
    } finally {
      await endpoint.close();
      rmSync(home, {recursive: true, force: true});
    }
  }
});


test("cofluxd installs four signed components and notices, rejecting a damaged companion atomically", async () => {
  for (const damaged of [false, true]) {
    const fixture = releaseFixture(true, true);
    if (damaged) fixture.artifacts.transport = Buffer.from("damaged helper");
    const endpoint = await serveRelease(fixture), home = makeInstallHome();
    writeFileSync(join(home, "bin/coflux-transport"), "old helper");
    try {
      if (damaged) {
        await assert.rejects(runUpdate(home, fixture, endpoint));
        assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
        assert.equal(readFileSync(join(home, "bin/coflux-transport"), "utf8"), "old helper");
      } else {
        await runUpdate(home, fixture, endpoint);
        assert.equal(spawnSync(join(home, "bin/coflux-transport")).status, 0);
        assert.equal(readFileSync(join(home, "bin/TRANSPORT-NOTICES.txt"), "utf8"), "test dependency notices");
      }
    } finally { await endpoint.close(); rmSync(home, { recursive: true, force: true }); }
  }
});

// Routing (plan 20260930-r2-download-mirror): the mirror holds only the release its latest.json names;
// everything else comes from the GitHub Releases archive, decided by version and never by failure.
test("cofluxd routing: the pointer's tag installs from the mirror, with or without --version", async () => {
  for (const latest of [true, false]) {
    const fixture = releaseFixture();
    const endpoint = await serveRelease(fixture);
    const home = makeInstallHome();
    try {
      await runUpdate(home, fixture, endpoint, { latest });
      assert.equal(readFileSync(join(home, "cofluxd.release-floor"), "utf8").trim(), VERSION);
      assert.equal(spawnSync(join(home, "bin", "coflux-launcher")).status, 0);
      assert.ok(endpoint.requests.includes("/mirror/latest.json"));
      assert.ok(endpoint.requests.includes(`/mirror/${VERSION}/manifest.json`));
      assert.ok(endpoint.requests.includes(`/mirror/${VERSION}/coflux-launcher-${fixture.target}`));
      assert.deepEqual(endpoint.requests.filter((path) => path.startsWith("/archive/")), [], "the archive is never touched");
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cofluxd routing: an explicit version the pointer does not name installs from the archive only", async () => {
  // A newer latest (so VERSION is an older release), and an unreadable pointer (404 or 500).
  for (const pointer of ["v9.9.0", "missing", "broken"]) {
    const fixture = releaseFixture();
    const endpoint = await serveRelease(fixture, { pointer });
    const home = makeInstallHome();
    try {
      await runUpdate(home, fixture, endpoint);
      assert.equal(readFileSync(join(home, "cofluxd.release-floor"), "utf8").trim(), VERSION, pointer);
      assert.ok(endpoint.requests.includes(`/archive/${VERSION}/manifest.json`), pointer);
      assert.ok(endpoint.requests.includes(`/archive/${VERSION}/coflux-runtime-${fixture.target}`), pointer);
      assert.deepEqual(
        endpoint.requests.filter((path) => path.startsWith(`/mirror/${VERSION}/`)),
        [],
        `the mirror's versioned objects are never touched (pointer: ${pointer})`,
      );
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("cofluxd routing: without --version an unreadable pointer fails with the --version hint and changes nothing", async () => {
  for (const pointer of ["missing", "broken", "not-a-tag"]) {
    const fixture = releaseFixture();
    const endpoint = await serveRelease(fixture, { pointer });
    const home = makeInstallHome();
    try {
      await assert.rejects(runUpdate(home, fixture, endpoint, { latest: true }), /--version vX\.Y\.Z/);
      assert.equal(readFileSync(join(home, "bin/coflux-launcher"), "utf8"), "old launcher\n");
      assert.equal(readFileSync(join(home, "bin/coflux-runtime"), "utf8"), "old runtime\n");
      assert.equal(existsSync(join(home, "cofluxd.release-floor")), false);
      assert.deepEqual(endpoint.requests, ["/mirror/latest.json"], `no silent fallback to any download (pointer: ${pointer})`);
    } finally {
      await endpoint.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});
