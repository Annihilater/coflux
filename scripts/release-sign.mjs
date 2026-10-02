#!/usr/bin/env node
// Release signing + manifest (schema 3, plan 20261002-runtime-launcher-merge): every daemon
// artifact in the directory gets a domain-separated <name>.release.sig binding
// component/version/target/sha256/size. Components: runtime, launcher, cli, transport, ptyd.
// There is deliberately no `worker` component and no raw-binary `<name>.sig` for anything:
// the raw worker signature was the back door a pre-plan supervisor still checks, and no such
// supervisor may ever verify, install or run a runtime artifact. Old cofluxd fails closed on
// schema 3 (headless machines upgrade the npm package first); the centre parses 2 and 3.
// Manifest URLs: a stable tag points at the R2 download mirror (dl.coflux.dev), which the release
// workflow fills before the GitHub Release exists; a prerelease is never mirrored and keeps GitHub
// URLs. URLs are unsigned download locations, so this choice never touches the trust chain.
//   用法: WORKER_SIGNING_KEY=<PKCS8 PEM> GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>
import crypto from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseVersion,
  cliReleaseStatement,
  launcherReleaseStatement,
  ptydReleaseStatement,
  runtimeReleaseStatement,
  transportReleaseStatement,
} from "./release-statement.mjs";
import { isStableTag, mirrorAssetUrl } from "./release-mirror-layout.mjs";

const dir = process.argv[2];
const version = process.argv[3];
const repo = process.env.GITHUB_REPOSITORY;
if (!dir || !version || !repo) {
  console.error("用法: WORKER_SIGNING_KEY=... GITHUB_REPOSITORY=owner/repo node scripts/release-sign.mjs <dir> <version>");
  process.exit(1);
}
const pem = process.env.WORKER_SIGNING_KEY;
if (!pem) {
  console.error("缺少 WORKER_SIGNING_KEY（PKCS8 PEM）—— 发版前先配好签名密钥（见 docs/RELEASING.md）");
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);
assertReleaseVersion(version);
const mirrored = isStableTag(version);
// The single place that decides where a manifest entry downloads from.
const assetUrl = (name) => mirrored
  ? mirrorAssetUrl(version, name)
  : `https://github.com/${repo}/releases/download/${version}/${name}`;

const manifest = { schemaVersion: 3, version, runtime: {}, launcher: {} };
const sums = [];

/** Sign every `coflux-<component>-<target>` in the directory under the component's own domain. */
function signComponent(component, statement) {
  const prefix = `coflux-${component}-`;
  const targets = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || name.includes(".")) continue;
    const target = name.slice(prefix.length);
    const data = readFileSync(join(dir, name));
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const size = data.byteLength;
    const releaseSignature = crypto.sign(null, statement({ version, target, sha256, size }), key).toString("hex");
    writeFileSync(join(dir, `${name}.release.sig`), releaseSignature);
    sums.push(`${sha256}  ${name}`);
    manifest[component] ??= {};
    manifest[component][target] = { url: assetUrl(name), target, sha256, size, releaseSignature };
    targets.add(target);
  }
  return [...targets].sort();
}

// The runtime is the unit the centre pushes; its target set is the baseline every other
// component must match exactly.
const runtimeTargets = signComponent("runtime", runtimeReleaseStatement);
if (runtimeTargets.length === 0) {
  console.error("runtime target 集合不完整：runtime=<空>");
  process.exit(1);
}
const same = (targets) => targets.join("\n") === runtimeTargets.join("\n");
// cofluxd executes the launcher directly, so it carries its own domain: a valid runtime can never
// be renamed into a launcher.
const launcherTargets = signComponent("launcher", launcherReleaseStatement);
if (!same(launcherTargets)) {
  console.error(`runtime/launcher target 集合不完整：runtime=${runtimeTargets.join(",")}；launcher=${launcherTargets.join(",") || "<空>"}`);
  process.exit(1);
}
// The CLI embeds the integration and is independently domain-separated from daemon artifacts.
const cliTargets = signComponent("cli", cliReleaseStatement);
if (cliTargets.length && !same(cliTargets)) throw new Error("CLI targets must match runtime targets");
// Companion artifacts retain their own signing domain and the exact runtime target set.
const transportTargets = signComponent("transport", transportReleaseStatement);
if (!transportTargets.length) throw new Error("Release is missing the mandatory native transport component");
if (!same(transportTargets)) throw new Error("Transport targets must match runtime targets");
// The PTY custody process (plan 20260918-ptyd-terminal-custody) is mandatory: a release without it
// installs a runtime that refuses to start.
const ptydTargets = signComponent("ptyd", ptydReleaseStatement);
if (!ptydTargets.length) throw new Error("Release is missing the mandatory ptyd component");
if (!same(ptydTargets)) throw new Error("ptyd targets must match runtime targets");
if (manifest.worker !== undefined || readdirSync(dir).some((name) => name.endsWith(".sig") && !name.endsWith(".release.sig"))) {
  throw new Error("schema 3 carries no worker component and no raw-binary signature");
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
console.error(`signed ${runtimeTargets.length} runtime/launcher target(s); wrote manifest.json / SHA256SUMS`);
