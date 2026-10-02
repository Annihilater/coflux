import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  cliReleaseStatement,
  launcherReleaseStatement,
  ptydReleaseStatement,
  runtimeReleaseStatement,
  supervisorReleaseStatement,
  transportReleaseStatement,
  workerReleaseStatement,
} from "../../scripts/release-statement.mjs";
import {
  MAX_RELEASE_ARTIFACT_BYTES,
  RELEASE_COMPONENTS,
  compareReleaseVersions,
  createReleasePublicKey,
  installStagedPair,
  parseReleaseManifestEntry,
  verifyReleaseArtifact,
} from "../../packages/cli/release-trust.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const COMPONENTS = ["runtime", "launcher", "cli", "transport", "ptyd"];

function signRelease(dir, version) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  execFileSync(process.execPath, [join(ROOT, "scripts/release-sign.mjs"), dir, version], {
    cwd: ROOT,
    env: { ...process.env, GITHUB_REPOSITORY: "acme/coflux", WORKER_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }) },
    stdio: "pipe",
  });
  return { publicKey, privateKey, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) };
}

test("release-sign produces a schema 3 manifest: runtime/launcher domains isolated, no worker component, no raw signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-"));
  try {
    const target = "aarch64-unknown-linux-musl";
    const runtimeArtifact = Buffer.from("deterministic runtime artifact\n", "utf8");
    const launcherArtifact = Buffer.from("deterministic launcher artifact\n", "utf8");
    writeFileSync(join(dir, `coflux-runtime-${target}`), runtimeArtifact);
    writeFileSync(join(dir, `coflux-launcher-${target}`), launcherArtifact);
    writeFileSync(join(dir, `coflux-cli-${target}`), runtimeArtifact);
    writeFileSync(join(dir, `coflux-transport-${target}`), runtimeArtifact);
    writeFileSync(join(dir, `coflux-ptyd-${target}`), runtimeArtifact);
    const { publicKey, manifest } = signRelease(dir, "v2.3.4-rc.1");

    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.version, "v2.3.4-rc.1");
    assert.deepEqual(Object.keys(manifest).filter((key) => COMPONENTS.includes(key)).sort(), [...COMPONENTS].sort());
    assert.equal(manifest.worker, undefined, "schema 3 carries no worker component");
    assert.equal(manifest.supervisor, undefined, "schema 3 carries no supervisor component");
    // No raw-binary signature anywhere: that was the back door a pre-plan supervisor still checks.
    assert.equal(existsSync(join(dir, `coflux-runtime-${target}.sig`)), false, "no raw runtime signature asset");
    for (const component of COMPONENTS) {
      assert.equal(manifest[component][target].signature, undefined, `${component} entry carries no raw signature`);
      assert.equal(readFileSync(join(dir, `coflux-${component}-${target}.release.sig`), "utf8"), manifest[component][target].releaseSignature);
    }

    const runtimeEntry = parseReleaseManifestEntry(manifest, "runtime", manifest.version, target);
    verifyReleaseArtifact({ component: "runtime", version: manifest.version, entry: runtimeEntry, data: runtimeArtifact, publicKey });
    assert.equal(runtimeEntry.size, runtimeArtifact.byteLength);
    assert.equal(runtimeEntry.sha256, crypto.createHash("sha256").update(runtimeArtifact).digest("hex"));
    const runtimeSignature = Buffer.from(runtimeEntry.releaseSignature, "hex");
    assert.equal(crypto.verify(null, runtimeReleaseStatement({ version: manifest.version, ...runtimeEntry }), publicKey, runtimeSignature), true);
    // (b) A runtime releaseSignature must fail against the worker-domain statement built from
    // identical metadata — and against the supervisor/launcher domains.
    for (const other of [workerReleaseStatement, supervisorReleaseStatement, launcherReleaseStatement]) {
      assert.equal(crypto.verify(null, other({ version: manifest.version, target, sha256: runtimeEntry.sha256, size: runtimeEntry.size }), publicKey, runtimeSignature), false);
    }
    // (c) Looking up the worker component in a schema 3 manifest throws.
    assert.throws(() => parseReleaseManifestEntry(manifest, "worker", manifest.version, target), /未知 release component/);
    assert.throws(() => parseReleaseManifestEntry(manifest, "supervisor", manifest.version, target), /未知 release component/);

    const launcherEntry = parseReleaseManifestEntry(manifest, "launcher", manifest.version, target);
    verifyReleaseArtifact({ component: "launcher", version: manifest.version, entry: launcherEntry, data: launcherArtifact, publicKey });
    assert.equal(crypto.verify(null, launcherReleaseStatement({ version: manifest.version, ...launcherEntry }), publicKey, Buffer.from(launcherEntry.releaseSignature, "hex")), true);
    assert.throws(() => verifyReleaseArtifact({ component: "runtime", version: manifest.version, entry: launcherEntry, data: launcherArtifact, publicKey }));

    const cliEntry = parseReleaseManifestEntry(manifest, "cli", manifest.version, target);
    verifyReleaseArtifact({ component: "cli", version: manifest.version, entry: cliEntry, data: runtimeArtifact, publicKey });
    assert.equal(crypto.verify(null, cliReleaseStatement({ version: manifest.version, ...cliEntry }), publicKey, Buffer.from(cliEntry.releaseSignature, "hex")), true);
    assert.throws(() => verifyReleaseArtifact({ component: "runtime", version: manifest.version, entry: cliEntry, data: runtimeArtifact, publicKey }));
    const helperEntry = parseReleaseManifestEntry(manifest, "transport", manifest.version, target);
    verifyReleaseArtifact({ component: "transport", version: manifest.version, entry: helperEntry, data: runtimeArtifact, publicKey });
    assert.equal(crypto.verify(null, transportReleaseStatement({ version: manifest.version, ...helperEntry }), publicKey, Buffer.from(helperEntry.releaseSignature, "hex")), true);
    assert.throws(() => verifyReleaseArtifact({ component: "cli", version: manifest.version, entry: helperEntry, data: runtimeArtifact, publicKey }));
    const ptydEntry = parseReleaseManifestEntry(manifest, "ptyd", manifest.version, target);
    verifyReleaseArtifact({ component: "ptyd", version: manifest.version, entry: ptydEntry, data: runtimeArtifact, publicKey });
    assert.equal(crypto.verify(null, ptydReleaseStatement({ version: manifest.version, ...ptydEntry }), publicKey, Buffer.from(ptydEntry.releaseSignature, "hex")), true);
    assert.throws(() => verifyReleaseArtifact({ component: "transport", version: manifest.version, entry: ptydEntry, data: runtimeArtifact, publicKey }));
    assert.throws(() => verifyReleaseArtifact({ component: "ptyd", version: manifest.version, entry: helperEntry, data: runtimeArtifact, publicKey }));

    for (const mutated of [
      { version: "v2.3.5", target, sha256: runtimeEntry.sha256, size: runtimeEntry.size },
      { version: manifest.version, target: "x86_64-unknown-linux-musl", sha256: runtimeEntry.sha256, size: runtimeEntry.size },
      { version: manifest.version, target, sha256: "00".repeat(32), size: runtimeEntry.size },
      { version: manifest.version, target, sha256: runtimeEntry.sha256, size: runtimeEntry.size + 1 },
    ]) {
      assert.equal(crypto.verify(null, runtimeReleaseStatement(mutated), publicKey, runtimeSignature), false, `a changed field breaks the signature: ${JSON.stringify(mutated)}`);
    }
    assert.throws(
      () => runtimeReleaseStatement({ version: "v2.3.4-01", target, sha256: runtimeEntry.sha256, size: runtimeEntry.size }),
      /前导 0/,
      "numeric prerelease identifiers follow Rust strict SemVer",
    );

    // A prerelease is never uploaded to the R2 mirror: every entry keeps its GitHub Release URL.
    assert.deepEqual(manifestUrls(manifest), expectedUrls(target, (name) => `https://github.com/acme/coflux/releases/download/v2.3.4-rc.1/${name}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manifestUrls(manifest) {
  return Object.fromEntries(COMPONENTS.flatMap((component) =>
    Object.entries(manifest[component] ?? {}).map(([target, entry]) => [`${component}/${target}`, entry.url])));
}

function expectedUrls(target, url) {
  return Object.fromEntries(COMPONENTS.map((component) => [`${component}/${target}`, url(`coflux-${component}-${target}`)]));
}

test("release-sign points every component of a stable tag at the R2 mirror, with signatures that ignore the URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-stable-"));
  try {
    const target = "x86_64-unknown-linux-musl";
    const artifact = Buffer.from("stable artifact\n", "utf8");
    for (const component of COMPONENTS) writeFileSync(join(dir, `coflux-${component}-${target}`), artifact);
    const { publicKey, manifest } = signRelease(dir, "v2.3.4");
    assert.deepEqual(manifestUrls(manifest), expectedUrls(target, (name) => `https://dl.coflux.dev/releases/v2.3.4/${name}`));
    assert.doesNotMatch(JSON.stringify(manifest), /github\.com/);
    assert.deepEqual([...RELEASE_COMPONENTS].sort(), [...COMPONENTS].sort(), "cofluxd installs exactly the signed component set");
    // The trust chain is unchanged: the release statement binds version/target/sha256/size, never the URL.
    for (const component of COMPONENTS) {
      const entry = parseReleaseManifestEntry(manifest, component, manifest.version, target);
      verifyReleaseArtifact({ component, version: manifest.version, entry, data: artifact, publicKey });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectSignFailure(dir, version, pattern) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  assert.throws(
    () => execFileSync(process.execPath, [join(ROOT, "scripts/release-sign.mjs"), dir, version], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_REPOSITORY: "acme/coflux", WORKER_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }) },
      stdio: "pipe",
    }),
    (error) => error?.status === 1 && pattern.test(error?.stderr?.toString() ?? ""),
  );
}

test("release-sign fails closed without a launcher for the runtime's target", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-incomplete-"));
  try {
    writeFileSync(join(dir, "coflux-runtime-x86_64-unknown-linux-musl"), "runtime");
    writeFileSync(join(dir, "coflux-transport-x86_64-unknown-linux-musl"), "helper");
    writeFileSync(join(dir, "coflux-ptyd-x86_64-unknown-linux-musl"), "ptyd");
    expectSignFailure(dir, "v1.0.0", /target 集合不完整/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-sign refuses a directory without a runtime, even with a pre-plan worker present", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-sign-worker-only-"));
  try {
    for (const component of ["worker", "supervisor", "cli", "transport", "ptyd"]) writeFileSync(join(dir, `coflux-${component}-x86_64-unknown-linux-musl`), component);
    expectSignFailure(dir, "v1.0.0", /runtime target 集合不完整/);
    assert.equal(existsSync(join(dir, "manifest.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cofluxd's built-in release public key matches the runtime's compiled-in key", () => {
  const runtimeKey = readFileSync(join(ROOT, "crates/runtime/release-pubkey.hex"), "utf8").trim();
  const cliKey = readFileSync(join(ROOT, "packages/cli/release-pubkey.hex"), "utf8").trim();
  assert.equal(cliKey, runtimeKey);
  assert.match(cliKey, /^[0-9a-f]{64}$/);
});

test("cofluxd verifier rejects bytes/hash/size/version/target/missing fields, cross-component transplants and schema 2", () => {
  const version = "v3.4.5";
  const target = "x86_64-unknown-linux-musl";
  const data = Buffer.from("verified runtime bytes", "utf8");
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const verifierKey = createReleasePublicKey(publicKeyHex);
  const metadata = { version, target, sha256, size: data.byteLength };
  const runtimeEntry = {
    target,
    sha256,
    size: data.byteLength,
    releaseSignature: crypto.sign(null, runtimeReleaseStatement(metadata), privateKey).toString("hex"),
  };
  const manifest = {
    schemaVersion: 3,
    version,
    runtime: { [target]: runtimeEntry },
    launcher: {
      [target]: {
        target,
        sha256,
        size: data.byteLength,
        releaseSignature: crypto.sign(null, launcherReleaseStatement(metadata), privateKey).toString("hex"),
      },
    },
  };

  const parsed = parseReleaseManifestEntry(manifest, "runtime", version, target);
  assert.doesNotThrow(() => verifyReleaseArtifact({ component: "runtime", version, entry: parsed, data, publicKey: verifierKey }));

  const tampered = Buffer.from(data);
  tampered[0] ^= 1;
  assert.throws(() => verifyReleaseArtifact({ component: "runtime", version, entry: parsed, data: tampered, publicKey: verifierKey }), /sha256 不匹配/);
  assert.throws(() => verifyReleaseArtifact({ component: "runtime", version, entry: { ...parsed, size: parsed.size + 1 }, data, publicKey: verifierKey }), /大小不匹配/);
  assert.throws(() => verifyReleaseArtifact({ component: "runtime", version, entry: { ...parsed, sha256: "00".repeat(32) }, data, publicKey: verifierKey }), /sha256 不匹配/);
  assert.throws(() => parseReleaseManifestEntry({ ...manifest, version: "v3.4.4" }, "runtime", version, target), /schema\/version/);
  assert.throws(() => parseReleaseManifestEntry({ ...manifest, schemaVersion: 2 }, "runtime", version, target), /schema\/version/, "schema 2 is refused by the new cofluxd");
  assert.throws(() => parseReleaseManifestEntry({ ...manifest, runtime: { [target]: { ...runtimeEntry, target: "aarch64-unknown-linux-musl" } } }, "runtime", version, target), /缺少匹配/);
  for (const field of ["sha256", "size", "releaseSignature"]) {
    const incomplete = { ...runtimeEntry };
    delete incomplete[field];
    assert.throws(() => parseReleaseManifestEntry({ ...manifest, runtime: { [target]: incomplete } }, "runtime", version, target), /元数据非法/, `missing ${field} must be refused`);
  }
  assert.throws(() => parseReleaseManifestEntry({ ...manifest, runtime: { [target]: { ...runtimeEntry, size: MAX_RELEASE_ARTIFACT_BYTES + 1 } } }, "runtime", version, target), /元数据非法/);
  // A stray raw signature on a runtime entry is ignored, never required and never trusted.
  const withRaw = parseReleaseManifestEntry({ ...manifest, runtime: { [target]: { ...runtimeEntry, signature: "00".repeat(64) } } }, "runtime", version, target);
  assert.equal(withRaw.signature, undefined);

  // A worker-domain statement over identical metadata is not a runtime release, nor a launcher one.
  const transplanted = { target, sha256, size: data.byteLength, releaseSignature: crypto.sign(null, workerReleaseStatement(metadata), privateKey).toString("hex") };
  for (const component of ["runtime", "launcher"]) {
    assert.throws(() => verifyReleaseArtifact({ component, version, entry: transplanted, data, publicKey: verifierKey }), /release Ed25519 签名无效/);
  }
  assert.throws(() => verifyReleaseArtifact({ component: "launcher", version, entry: parsed, data, publicKey: verifierKey }), /release Ed25519 签名无效/);
});

test("release SemVer floor comparison rejects downgrades and another build of equal precedence", () => {
  assert.equal(compareReleaseVersions("v2.0.0", "v1.9.9"), 1);
  assert.equal(compareReleaseVersions("v2.0.0-rc.2", "v2.0.0-rc.10"), -1);
  assert.equal(compareReleaseVersions("v2.0.0", "v2.0.0-rc.10"), 1);
  assert.equal(compareReleaseVersions("v2.0.0+build.2", "v2.0.0+build.1"), 0);
});

test("a staged pair whose second replacement fails restores the first's previous version", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-install-rollback-"));
  try {
    const oldLauncher = join(dir, "coflux-launcher");
    const oldRuntime = join(dir, "coflux-runtime");
    const stagedLauncher = join(dir, "new-launcher");
    const missingRuntime = join(dir, "missing-runtime");
    writeFileSync(oldLauncher, "old launcher");
    writeFileSync(oldRuntime, "old runtime");
    writeFileSync(stagedLauncher, "new launcher");
    assert.throws(() => installStagedPair([
      { source: stagedLauncher, destination: oldLauncher },
      { source: missingRuntime, destination: oldRuntime },
    ]));
    assert.equal(readFileSync(oldLauncher, "utf8"), "old launcher");
    assert.equal(readFileSync(oldRuntime, "utf8"), "old runtime");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-sign refuses an entire missing ptyd component", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-no-ptyd-"));
  try {
    for (const component of ["runtime", "launcher", "cli", "transport"]) writeFileSync(join(dir, `coflux-${component}-x86_64-unknown-linux-musl`), component);
    expectSignFailure(dir, "v2.0.0", /mandatory ptyd/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release-sign refuses an entire missing transport component", () => {
  const dir = mkdtempSync(join(tmpdir(), "coflux-release-no-helper-"));
  try {
    for (const component of ["runtime", "launcher", "cli", "ptyd"]) writeFileSync(join(dir, `coflux-${component}-x86_64-unknown-linux-musl`), component);
    expectSignFailure(dir, "v2.0.0", /mandatory native transport/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
