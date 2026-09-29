#!/usr/bin/env node
// Build coflux-screen, the Swift remote-screen helper (native/screen), for the desktop runtime
// bundle (plan 20260929-remote-desktop). macOS only: the helper ships inside Coflux.app next to
// the other runtime binaries and is never part of the worker's hot-upgrade artifact set.
//
//   node scripts/build-screen-helper.mjs [output directory = target/release] [--test]
//
// The SDK is pinned explicitly rather than left to the toolchain default: on machines where the
// Command Line Tools ship a MacOSX27 SDK the installed clang/ld reject its .tbd files
// ("unknown architecture arm64e.x1"), so unless COFLUX_MACOS_SDK names one, the newest 26.x SDK
// beside the default is preferred over a 27.x default. Warnings in the helper's own sources fail
// the build; the dependency (swift-protobuf) is left to its own warnings.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "native/screen");
const args = process.argv.slice(2);
const runTests = args.includes("--test");
const destination = resolve(args.find((arg) => !arg.startsWith("--")) ?? resolve(root, "target/release"));

if (process.platform !== "darwin") {
  console.log("build-screen-helper: coflux-screen is macOS only; nothing to build on this platform");
  process.exit(0);
}

function pickSdk() {
  const pinned = process.env.COFLUX_MACOS_SDK?.trim();
  if (pinned) {
    if (!existsSync(pinned)) throw new Error(`COFLUX_MACOS_SDK does not exist: ${pinned}`);
    return pinned;
  }
  const fallback = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
  const version = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" }).trim();
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  if (major < 27) return fallback;
  const siblings = readdirSync(dirname(fallback))
    .filter((name) => /^MacOSX26(\.\d+)?\.sdk$/.test(name))
    .sort()
    .reverse();
  if (siblings.length === 0) return fallback;
  const chosen = join(dirname(fallback), siblings[0]);
  console.log(`build-screen-helper: default SDK is ${version}; pinning ${basename(chosen)} instead`);
  return chosen;
}

const sdk = pickSdk();
const common = ["--package-path", packagePath, "--arch", "arm64", "-Xswiftc", "-sdk", "-Xswiftc", sdk];

function swift(subcommand, extra) {
  const result = spawnSync("swift", [subcommand, ...common, ...extra], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const warnings = output.split("\n").filter((line) => /native\/screen\/(Sources|Tests)\/.*: warning:/.test(line));
  if (warnings.length > 0) {
    console.error(`build-screen-helper: ${warnings.length} warning(s) in native/screen must be fixed:\n${warnings.join("\n")}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (runTests) {
  swift("test", []);
}
swift("build", ["-c", "release"]);
const binPath = execFileSync("swift", ["build", ...common, "-c", "release", "--show-bin-path"], { cwd: root, encoding: "utf8" }).trim();
const built = join(binPath, "coflux-screen");
if (!existsSync(built)) throw new Error(`build produced no binary at ${built}`);
mkdirSync(destination, { recursive: true });
const target = join(destination, "coflux-screen");
copyFileSync(built, target);
chmodSync(target, 0o755);
console.log(`✓ build-screen-helper: ${target} (SDK ${basename(sdk)})`);
