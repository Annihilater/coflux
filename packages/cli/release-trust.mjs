import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

export const WORKER_RELEASE_STATEMENT_DOMAIN = Buffer.from(
  "coflux-worker-release-v1\0",
  "utf8",
);
export const SUPERVISOR_RELEASE_STATEMENT_DOMAIN = Buffer.from(
  "coflux-supervisor-release-v1\0",
  "utf8",
);

export const CLI_RELEASE_STATEMENT_DOMAIN = Buffer.from("coflux-cli-release-v1\0", "utf8");

/**
 * The runtime and the launcher (plan 20261002-runtime-launcher-merge) each have their own domain,
 * distinct from `coflux-worker-release-v1` / `coflux-supervisor-release-v1`: a runtime statement
 * never verifies against the worker transcript built from identical metadata, so no pre-plan
 * supervisor can accept a runtime artifact as a worker. Runtime artifacts carry no legacy raw
 * signature at all.
 */
export const RUNTIME_RELEASE_STATEMENT_DOMAIN = Buffer.from("coflux-runtime-release-v1\0", "utf8");
export const LAUNCHER_RELEASE_STATEMENT_DOMAIN = Buffer.from("coflux-launcher-release-v1\0", "utf8");
export function runtimeReleaseStatement(metadata) { return artifactReleaseStatement(RUNTIME_RELEASE_STATEMENT_DOMAIN, metadata); }
export function launcherReleaseStatement(metadata) { return artifactReleaseStatement(LAUNCHER_RELEASE_STATEMENT_DOMAIN, metadata); }

export const TRANSPORT_RELEASE_STATEMENT_DOMAIN = Buffer.from("coflux-transport-release-v1\0", "utf8");
export function transportReleaseStatement(metadata) { return artifactReleaseStatement(TRANSPORT_RELEASE_STATEMENT_DOMAIN, metadata); }

/** PTY 托管进程（plan 20260918-ptyd-terminal-custody）：独立 domain，合法的其它组件签名不能移植过来。 */
export const PTYD_RELEASE_STATEMENT_DOMAIN = Buffer.from("coflux-ptyd-release-v1\0", "utf8");
export function ptydReleaseStatement(metadata) { return artifactReleaseStatement(PTYD_RELEASE_STATEMENT_DOMAIN, metadata); }

/** Components of a schema 3 manifest. `worker` / `supervisor` are schema 2 only. */
export const RELEASE_COMPONENTS = ["runtime", "launcher", "cli", "transport", "ptyd"];
export const RELEASE_MANIFEST_SCHEMA_VERSION = 3;

function releaseStatementFor(component, metadata) {
  switch (component) {
    case "runtime": return runtimeReleaseStatement(metadata);
    case "launcher": return launcherReleaseStatement(metadata);
    case "worker": return workerReleaseStatement(metadata);
    case "supervisor": return supervisorReleaseStatement(metadata);
    case "cli": return cliReleaseStatement(metadata);
    case "transport": return transportReleaseStatement(metadata);
    case "ptyd": return ptydReleaseStatement(metadata);
    default: throw new Error(`Unknown release component: ${JSON.stringify(component)}`);
  }
}

const STRICT_RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;
const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
export const MAX_RELEASE_ARTIFACT_BYTES = 128 * 1024 * 1024;

function parseReleaseVersion(version) {
  const match = typeof version === "string" ? STRICT_RELEASE_VERSION.exec(version) : null;
  if (!match) throw new Error(`Release version must be strict SemVer with a v prefix: ${JSON.stringify(version)}`);
  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => {
      if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error(`Release version has a numeric prerelease identifier with a leading zero: ${JSON.stringify(version)}`);
      }
      return /^\d+$/.test(identifier)
        ? { numeric: true, value: BigInt(identifier) }
        : { numeric: false, value: identifier };
    })
    : [];
  return {
    raw: version,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

/** 与 Rust semver crate 一致的 release tag 子集：必须带 v，数字标识符禁止前导 0。 */
export function assertReleaseVersion(version) {
  parseReleaseVersion(version);
  return version;
}

/** SemVer precedence；build metadata 不参与比较。 */
export function compareReleaseVersions(leftVersion, rightVersion) {
  const left = parseReleaseVersion(leftVersion);
  const right = parseReleaseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const common = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < common; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a.numeric && b.numeric) {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    } else if (a.numeric !== b.numeric) {
      return a.numeric ? -1 : 1;
    } else {
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
    }
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

function lenPrefixed(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return [length, bytes];
}

function artifactReleaseStatement(domain, { version, target, sha256, size }) {
  assertReleaseVersion(version);
  if (typeof target !== "string" || !target || Buffer.byteLength(target) > 128) {
    throw new Error("Release target is invalid");
  }
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new Error("Release sha256 must be 32 bytes of hex");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RELEASE_ARTIFACT_BYTES) {
    throw new Error("Release size must be a positive integer within bounds");
  }
  const sizeBytes = Buffer.allocUnsafe(8);
  sizeBytes.writeBigUInt64BE(BigInt(size));
  return Buffer.concat([
    domain,
    ...lenPrefixed(version),
    ...lenPrefixed(target),
    Buffer.from(sha256, "hex"),
    sizeBytes,
  ]);
}

/** worker 热升级沿用的 v1 transcript；不得改变 domain 或字段顺序。 */
export function workerReleaseStatement(metadata) {
  return artifactReleaseStatement(WORKER_RELEASE_STATEMENT_DOMAIN, metadata);
}

/** supervisor 安装专用 transcript；独立 domain 防止合法 worker 签名被横向移植。 */
export function supervisorReleaseStatement(metadata) {
  return artifactReleaseStatement(SUPERVISOR_RELEASE_STATEMENT_DOMAIN, metadata);
}

export function cliReleaseStatement(metadata) {
  return artifactReleaseStatement(CLI_RELEASE_STATEMENT_DOMAIN, metadata);
}

export function createReleasePublicKey(publicKeyHex) {
  const normalized = typeof publicKeyHex === "string" ? publicKeyHex.trim() : "";
  if (!ED25519_PUBLIC_KEY_HEX.test(normalized)) {
    throw new Error("The release public key must be 32 bytes of hex");
  }
  return crypto.createPublicKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(normalized, "hex").toString("base64url"),
    },
  });
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从 schema 3 manifest 取指定 component/target。额外顶层字段允许滚动扩展；
 * 但参与信任裁决的 version/target/size/hash/signature 全部严格校验。
 * A schema 2 manifest (worker/supervisor) is refused outright: this cofluxd installs a launcher
 * and a runtime, and a `worker` lookup in a schema 3 manifest throws.
 */
export function parseReleaseManifestEntry(manifest, component, version, target) {
  assertReleaseVersion(version);
  if (!RELEASE_COMPONENTS.includes(component)) {
    throw new Error(`Unknown release component: ${JSON.stringify(component)}`);
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || manifest.version !== version) {
    throw new Error("Release manifest schema/version does not match the request");
  }
  const entries = manifest[component];
  const entry = isRecord(entries) ? entries[target] : undefined;
  if (!isRecord(entry) || entry.target !== target) {
    throw new Error(`Release manifest has no matching ${component}/${target}`);
  }
  if (
    typeof entry.sha256 !== "string" ||
    !SHA256_HEX.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    entry.size > MAX_RELEASE_ARTIFACT_BYTES ||
    typeof entry.releaseSignature !== "string" ||
    !ED25519_SIGNATURE_HEX.test(entry.releaseSignature)
  ) {
    throw new Error(`Release manifest metadata is invalid for ${component}/${target}`);
  }
  // No component of schema 3 carries a legacy raw-binary signature (the worker's was the back
  // door old supervisors still check); a stray `signature` field is ignored, never trusted.
  return {
    target,
    sha256: entry.sha256.toLowerCase(),
    size: entry.size,
    releaseSignature: entry.releaseSignature.toLowerCase(),
  };
}

/** 校验实际 bytes 与 manifest 元数据及 component-separated release 签名。 */
export function verifyReleaseArtifact({ component, version, entry, data, publicKey }) {
  if (!Buffer.isBuffer(data)) throw new Error("Release artifact must be a Buffer");
  if (data.byteLength !== entry.size) {
    throw new Error(`${component} artifact size does not match: expected ${entry.size}, got ${data.byteLength}`);
  }
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`${component} artifact sha256 does not match`);
  }
  const metadata = { version, target: entry.target, sha256, size: data.byteLength };
  const statement = releaseStatementFor(component, metadata);
  if (!crypto.verify(null, statement, publicKey, Buffer.from(entry.releaseSignature, "hex"))) {
    throw new Error(`${component} artifact release Ed25519 signature is invalid`);
  }
}

/**
 * 两个已验证/本地显式信任的暂存文件一起进入替换阶段；任一 rename 失败都会恢复旧 pair。
 * 单文件 rename 是原子的，pair 级失败用同文件系统内备份回滚，绝不把“只更新一半”当成功。
 */
export function installStagedPair(staged) {
  if (
    !Array.isArray(staged) ||
    staged.length < 2 || staged.length > 6 ||
    staged.some(({ source, destination }) =>
      typeof source !== "string" || !source || typeof destination !== "string" || !destination)
  ) {
    throw new Error("daemon installation requires two to six valid staged artifacts");
  }
  const installed = [];
  const backups = [];
  try {
    for (const { source, destination } of staged) {
      const backup = `${source}.previous`;
      if (fs.existsSync(destination)) {
        fs.renameSync(destination, backup);
        backups.push({ backup, destination });
      }
      fs.renameSync(source, destination);
      installed.push(destination);
    }
  } catch (error) {
    for (const destination of installed.reverse()) {
      try { fs.rmSync(destination, { force: true }); } catch {}
    }
    const restoreFailures = [];
    for (const { backup, destination } of backups.reverse()) {
      try { fs.renameSync(backup, destination); }
      catch (restoreError) { restoreFailures.push(restoreError); }
    }
    if (restoreFailures.length > 0) {
      throw new AggregateError([error, ...restoreFailures], "Replacing the binaries failed and the previous version could not be fully restored");
    }
    throw error;
  }
}

/** Publish a complete native release before changing any executable entry point.
 * A runtime reached through a bin symlink resolves current_exe into its immutable
 * release directory, so interruption between entry-point updates cannot pair
 * that runtime with a helper from another release. */
export function installNativeRelease(staged) {
  if (!staged.some(({ destination }) => path.basename(destination) === "coflux-transport")) return installStagedPair(staged);
  const binDir = path.dirname(staged[0].destination);
  if (staged.some(({ destination }) => path.dirname(destination) !== binDir)) throw new Error("Native release destinations must share one binary directory");
  const digest = crypto.createHash("sha256");
  const entries = staged.map(({ source, destination }) => ({ source, destination, name: path.basename(destination) })).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error("Duplicate native release entry point");
  for (const entry of entries) digest.update(entry.name).update("\0").update(fs.readFileSync(entry.source));
  const id = digest.digest("hex"), releases = path.join(binDir, "releases"), directory = path.join(releases, id);
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const sync = name => { const fd = fs.openSync(name, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  if (!fs.existsSync(directory)) {
    const temporary = fs.mkdtempSync(path.join(releases, ".staging-"));
    try {
      for (const entry of entries) {
        const output = path.join(temporary, entry.name);
        fs.copyFileSync(entry.source, output);
        fs.chmodSync(output, entry.name.endsWith(".txt") ? 0o644 : 0o755);
        sync(output);
      }
      sync(temporary); fs.renameSync(temporary, directory); sync(releases);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const actual = crypto.createHash("sha256");
  for (const entry of entries) {
    const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid immutable native release member");
    actual.update(entry.name).update("\0").update(fs.readFileSync(file));
  }
  if (actual.digest("hex") !== id) throw new Error("Immutable native release digest mismatch");
  const links = fs.mkdtempSync(path.join(binDir, ".native-links-"));
  try {
    const entryPoints = entries.map(entry => {
      const source = path.join(links, entry.name);
      fs.symlinkSync(path.join(directory, entry.name), source);
      return { source, destination: entry.destination };
    });
    installStagedPair(entryPoints); sync(binDir);
  } finally { fs.rmSync(links, { recursive: true, force: true }); }
}
