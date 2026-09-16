#!/usr/bin/env node
/**
 * Desktop dev preview launcher (plan 20260916-desktop-preview-parallel).
 *
 * One preview per worktree, side by side. Everything an instance needs is derived here, from the
 * absolute path of the worktree root, and handed to the app as labelled environment variables:
 * the profile directory (COFLUX_DESKTOP_USER_DATA), the renderer's HMR port
 * (COFLUX_DESKTOP_RENDERER_PORT) and the instance label (COFLUX_DESKTOP_INSTANCE_LABEL). Neither
 * the main process nor the Vite config computes any of it — multi-instance orchestration must not
 * ship in the packaged app, where it can never run.
 *
 * The same worktree yields the same instance on every run, which is what lets sign-in state,
 * window bounds and the profile's device identity accumulate. The repository's main worktree keeps
 * the baseline `Coflux-dev` profile on port 5274 with no label, i.e. exactly today's behaviour;
 * only linked worktrees derive, and their profiles are seeded once from the baseline so the window
 * opens already signed in.
 *
 * This file is dev-only. It is not covered by typecheck or the test globs, so
 * `COFLUX_DESKTOP_DEV_DRY_RUN=1` exists to execute it end to end without spawning or touching a
 * profile.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Electron's unpackaged userData for this app: `<userData>` + the `-dev` suffix set in src/main/index.ts. */
const BASELINE_PROFILE_DIR = join(homedir(), "Library", "Application Support", "Coflux-dev");
const BASELINE_RENDERER_PORT = 5274;

/**
 * Derived renderer ports come from a contiguous range that avoids every port this repository
 * claims: 5274 (baseline renderer), 5432 (dev Postgres, compose.yaml), 8787 (server), 8788 (the
 * installed app's local gateway) and the black-box suites' fixed 88xx ports. The owner also starts
 * instances by hand on ad-hoc ports, so a taken port never means "this worktree is already running"
 * — the profile lock answers that question, and it is checked first.
 */
const PORT_RANGE_START = 5280;
const PORT_RANGE_SIZE = 100;

/** Seeded once, on the derived profile's first start; afterwards the profiles evolve independently. */
const SEEDED_FILES = ["session-token.bin", "executor.json", "executor-key.bin"];

/**
 * Cascade seed for a new derived profile: parallel windows must not land exactly on top of each
 * other. Plain `{x, y, width, height}`, the format src/main/window-state.ts already reads; the size
 * stays above MIN_WINDOW_SIZE (1024×640) and is a little under the app default so two previews sit
 * side by side comfortably. An offset that lands off-screen is not a problem — `resolveWindowBounds`
 * falls back to centred.
 */
const CASCADE = { originX: 80, originY: 80, step: 32, slots: 6, width: 1180, height: 760 };

/** SIGTERM → bounded wait → SIGKILL. `before-quit` can hold the app on a confirmation dialog. */
const STOP_GRACE_MS = 6000;
const STOP_POLL_MS = 100;

function fail(message) {
  process.stderr.write(`desktop preview: ${message}\n`);
  process.exit(1);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`\`git ${args.join(" ")}\` failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

function digestOf(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

/**
 * The main worktree is the first `worktree` line of `git worktree list --porcelain`, and it is
 * always absolute. `git rev-parse --git-common-dir` cannot be used for this: it is absolute from a
 * linked worktree but relative from the main one, so the comparison would misclassify the main
 * worktree as linked and silently take the baseline profile away from the owner.
 */
function resolveWorktrees() {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const line = git(["worktree", "list", "--porcelain"]).split("\n").find((entry) => entry.startsWith("worktree "));
  if (!line) fail("could not determine the main worktree from `git worktree list --porcelain`");
  return { root, main: line.slice("worktree ".length).trim() };
}

function currentBranch() {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: PACKAGE_ROOT, encoding: "utf8" });
  const name = result.status === 0 ? result.stdout.trim() : "";
  return name && name !== "HEAD" ? name : "(detached)";
}

/** Stable, filesystem-safe, and unique per path: readable name plus a digest of the full path. */
function instanceSlug(worktreeRoot) {
  const name = basename(worktreeRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${name || "worktree"}-${createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 6)}`;
}

/** Human-facing label: the worktree's directory name without the date prefix our worktrees carry. */
function instanceLabel(worktreeRoot) {
  const name = basename(worktreeRoot);
  return (name.replace(/^\d{8}-/, "") || name).slice(0, 32);
}

function rendererPort(worktreeRoot) {
  return PORT_RANGE_START + (digestOf(`renderer:${worktreeRoot}`) % PORT_RANGE_SIZE);
}

function cascadeBounds(worktreeRoot) {
  const slot = digestOf(`window:${worktreeRoot}`) % CASCADE.slots;
  return {
    x: CASCADE.originX + slot * CASCADE.step,
    y: CASCADE.originY + slot * CASCADE.step,
    width: CASCADE.width,
    height: CASCADE.height,
  };
}

function resolveInstance() {
  const { root, main } = resolveWorktrees();
  const derived = resolve(root) !== resolve(main);
  const override = process.env.COFLUX_DESKTOP_USER_DATA;
  const profileDir = override ? resolve(override) : derived ? `${BASELINE_PROFILE_DIR}-${instanceSlug(root)}` : BASELINE_PROFILE_DIR;
  return {
    worktreeRoot: root,
    branch: currentBranch(),
    derived,
    /** An explicit COFLUX_DESKTOP_USER_DATA wins and is never seeded: the caller chose that directory. */
    profileOverridden: Boolean(override),
    profileDir,
    port: derived ? rendererPort(root) : BASELINE_RENDERER_PORT,
    label: derived ? instanceLabel(root) : "",
    bounds: cascadeBounds(root),
  };
}

function printSummary(instance) {
  const serverUrl = process.env.COFLUX_SERVER_URL ?? "ws://localhost:8787/client (dev default)";
  const lines = [
    "Coflux desktop preview",
    `  instance  ${instance.label || "baseline"}${instance.derived ? "" : " (main worktree)"}`,
    `  worktree  ${instance.worktreeRoot}`,
    `  branch    ${instance.branch}`,
    `  profile   ${instance.profileDir}${instance.profileOverridden ? " (COFLUX_DESKTOP_USER_DATA)" : ""}`,
    `  renderer  http://localhost:${instance.port}`,
    `  server    ${serverUrl}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * `SingletonLock` is a *symlink* whose target is `<host>-<pid>` and does not exist as a path —
 * reading it as a file throws ENOENT, which reads as "no lock" and would reclaim a live instance's
 * lock. Always `readlink`.
 */
function readSingletonLock(profileDir) {
  const path = join(profileDir, "SingletonLock");
  let target;
  try {
    target = readlinkSync(path);
  } catch {
    return null;
  }
  const separator = target.lastIndexOf("-");
  const pid = separator < 0 ? Number.NaN : Number.parseInt(target.slice(separator + 1), 10);
  return {
    path,
    target,
    host: separator < 0 ? "" : target.slice(0, separator),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/** A lock held by a live PID is a running instance and is reported, never reclaimed. */
function ensureProfileFree(instance) {
  const lock = readSingletonLock(instance.profileDir);
  if (!lock) return;
  if (lock.host && lock.host !== hostname()) {
    fail(`${instance.profileDir}/SingletonLock is held by another host (${lock.target}); resolve it by hand before starting.`);
  }
  if (lock.pid && pidAlive(lock.pid)) {
    fail(`this worktree's preview is already running (pid ${lock.pid}, lock ${lock.target}). Stop it, or use its window.`);
  }
  try {
    unlinkSync(lock.path);
    process.stdout.write(`  reclaimed a stale profile lock (${lock.target})\n`);
  } catch (error) {
    fail(`could not reclaim the stale profile lock ${lock.path}: ${String(error)}`);
  }
}

/** Shell-safe rendering of a path inside a copy-pasteable command. */
function quoteForShell(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function electronPackageDir() {
  const linked = join(PACKAGE_ROOT, "node_modules", "electron");
  if (existsSync(linked)) return linked;
  try {
    return dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  } catch {
    return null;
  }
}

/**
 * Electron's binary is a download, not a package file: it is never hard-linked out of the pnpm
 * store, so every worktree needs its own copy and a fresh one has the package without `dist/` or
 * `path.txt`. Electron's own `index.js` would fetch it lazily, but electron-vite reads `path.txt`
 * itself and throws a bare `Error: Electron uninstall` — *after* the dev server is already up and
 * the summary has printed. Checking here turns the first start in a new worktree into a diagnostic.
 *
 * Nothing is downloaded automatically, and another worktree's `dist` is never borrowed
 * (`ELECTRON_OVERRIDE_DIST_PATH`): the Electron versions can differ, and that mismatch is silent.
 */
function ensureElectronInstalled() {
  const dir = electronPackageDir();
  if (!dir) fail("the electron package is not installed; run `pnpm install` at the repository root first.");
  let executable = "";
  try {
    executable = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
  } catch {
    executable = "";
  }
  if (executable && existsSync(executable)) return;
  fail(
    [
      "Electron's binary is missing in this worktree.",
      "",
      "It is a download rather than a package file, so it is not shared through the pnpm store and",
      "each worktree installs its own copy once (hundreds of MB, from a shared cache when another",
      "worktree already fetched this version). Install it for this worktree:",
      "",
      `  node ${quoteForShell(join(dir, "install.js"))}`,
      "",
      "Do not point this worktree at another one's dist directory: the versions can differ and the",
      "mismatch fails silently.",
    ].join("\n"),
  );
}

/** Only reached when the profile lock is free, so the listener is something else entirely. */
function ensurePortFree(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return;
  const rows = result.stdout.trim().split("\n").filter(Boolean);
  if (rows.length < 2) return;
  fail(`port ${port} is taken by something else (this worktree's preview is not running):\n${rows.slice(0, 3).join("\n")}`);
}

/**
 * First start of a derived profile: copy the baseline's credentials and executor configuration so
 * the window opens already signed in. The token carries no path binding and every dev instance
 * shares one Keychain entry (decided by the app name), so the copy decrypts. A baseline that is not
 * signed in copies nothing and the instance starts at the sign-in screen, which is correct.
 */
function prepareProfile(instance) {
  if (!instance.derived || instance.profileOverridden || existsSync(instance.profileDir)) return;
  mkdirSync(instance.profileDir, { recursive: true, mode: 0o700 });
  const seeded = [];
  for (const name of SEEDED_FILES) {
    const from = join(BASELINE_PROFILE_DIR, name);
    if (!existsSync(from)) continue;
    const to = join(instance.profileDir, name);
    try {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      seeded.push(name);
    } catch (error) {
      process.stderr.write(`desktop preview: could not seed ${name} from the baseline profile: ${String(error)}\n`);
    }
  }
  writeFileSync(join(instance.profileDir, "window-state.json"), `${JSON.stringify(instance.bounds)}\n`);
  process.stdout.write(`  new profile seeded from ${BASELINE_PROFILE_DIR}${seeded.length ? ` (${seeded.join(", ")})` : " (not signed in)"}\n`);
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * The whole process group goes down, not just the child: an Electron helper that survives keeps the
 * profile lock and the next start exits immediately. `before-quit` calls `preventDefault()` and can
 * put a confirmation dialog in front of the user, so the wait is bounded and escalates to SIGKILL.
 */
async function stopInstance(pid) {
  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await delay(STOP_POLL_MS);
  }
  killGroup(pid, "SIGKILL");
}

function electronViteBin() {
  const candidates = [
    join(PACKAGE_ROOT, "node_modules", ".bin", "electron-vite"),
    join(PACKAGE_ROOT, "..", "..", "node_modules", ".bin", "electron-vite"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) fail("electron-vite is not installed; run `pnpm install` at the repository root first.");
  return found;
}

function start(instance) {
  const env = { ...process.env };
  // The main worktree passes no new variables at all, so its behaviour is byte-for-byte today's.
  if (instance.derived) {
    env.COFLUX_DESKTOP_USER_DATA = instance.profileDir;
    env.COFLUX_DESKTOP_RENDERER_PORT = String(instance.port);
    env.COFLUX_DESKTOP_INSTANCE_LABEL = instance.label;
  }
  // An explicit COFLUX_DESKTOP_USER_DATA is honoured, but passed on resolved: the app resolves a
  // relative value against Electron's working directory, not against the shell's.
  if (instance.profileOverridden) env.COFLUX_DESKTOP_USER_DATA = instance.profileDir;

  const child = spawn(electronViteBin(), ["dev", ...process.argv.slice(2)], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: "inherit",
    // Its own process group: Ctrl-C reaches the launcher alone, and teardown can take the group.
    detached: true,
  });

  let stopping = false;
  const stopAndExit = (code) => {
    if (stopping) return;
    stopping = true;
    void stopInstance(child.pid).finally(() => process.exit(code));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => stopAndExit(signal === "SIGINT" ? 130 : 143));
  }
  // Terminal closed, an uncaught throw, anything else: last-resort synchronous sweep of the group.
  process.on("exit", () => {
    if (child.pid && !child.killed) killGroup(child.pid, "SIGKILL");
  });
  child.on("error", (error) => fail(`could not start electron-vite: ${error.message}`));
  child.on("exit", (code, signal) => {
    // A dev instance locked out of its profile also exits 0 (the main process calls `app.quit()`),
    // so the exit status says nothing about that case. The pre-start lock check is the only signal.
    if (!stopping) stopAndExit(code ?? (signal ? 143 : 0));
  });
}

const instance = resolveInstance();
printSummary(instance);
if (process.env.COFLUX_DESKTOP_DEV_DRY_RUN) process.exit(0);
// Before anything is created or claimed: a missing Electron binary means nothing can start.
ensureElectronInstalled();
ensureProfileFree(instance);
ensurePortFree(instance.port);
prepareProfile(instance);
start(instance);
