#!/usr/bin/env node
// Build the in-process Tailcat client for iOS as a static-library xcframework.
//
// iOS cannot spawn the helper subprocess the desktop and headless owners use,
// so the same internal/backend dependency boundary is compiled with
// -buildmode=c-archive and linked into the app. This needs CGO and the Xcode
// iPhoneOS SDK, unlike the shipped helper, which is built CGO-free; the two
// builds share no settings on purpose.
//
// The artifact is local build output: it is gitignored and never committed, and
// CI does not build iOS at all.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [destination = resolve(root, "apps/ios/Frameworks")] = process.argv.slice(2);
// Lower than the app's own deployment target on purpose: a lower minimum links
// into a higher-target app, never the other way round.
const minimum = process.env.COFLUX_IOS_MIN_VERSION || "17.0";
if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(minimum)) throw new Error("Invalid iOS minimum version");

const cwd = resolve(root, "transport/tailcat");
// The SDK comes from Xcode through xcrun, not from the Command Line Tools:
// host cgo links are broken on that SDK while this cross-build is unaffected.
const sdk = execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"], { encoding: "utf8" }).trim();
const clang = execFileSync("xcrun", ["--sdk", "iphoneos", "--find", "clang"], { encoding: "utf8" }).trim();
const flags = `-isysroot ${sdk} -miphoneos-version-min=${minimum} -arch arm64`;
const env = {
  ...process.env,
  GOOS: "ios",
  GOARCH: "arm64",
  CGO_ENABLED: "1",
  CC: clang,
  CGO_CFLAGS: flags,
  CGO_LDFLAGS: flags,
  // transport/tailcat requires a newer Go than most hosts have; let the
  // toolchain fetch it rather than failing for an unrelated reason.
  GOTOOLCHAIN: "go1.27.1",
};

const staging = resolve(root, "target/ios-transport");
rmSync(staging, { recursive: true, force: true });
mkdirSync(resolve(staging, "Headers"), { recursive: true });
const archive = resolve(staging, "libcofluxtailcat.a");
execFileSync("go", [
  "build", "-mod=readonly", "-trimpath", "-buildmode=c-archive",
  "-o", archive, "./cmd/coflux-transport-ios",
], { cwd, env, stdio: "inherit" });
// cgo emits the header beside the archive; the xcframework wants it in a directory of its own.
cpSync(resolve(staging, "libcofluxtailcat.h"), resolve(staging, "Headers/libcofluxtailcat.h"));

const framework = resolve(destination, "CofluxTailcat.xcframework");
rmSync(framework, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
execFileSync("xcodebuild", [
  "-create-xcframework",
  "-library", archive,
  "-headers", resolve(staging, "Headers"),
  "-output", framework,
], { stdio: "inherit" });
console.log(`built ${framework}`);
