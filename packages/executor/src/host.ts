/**
 * The daemon's executor host: a plain Node process the Rust worker starts, speaking JSONL over
 * inherited stdio.
 *
 * This is the entry point `cofluxd` records in the launchd / systemd unit it writes, so a machine
 * that installed coflux from npm can host the executor with no desktop app anywhere near it. It
 * imports nothing Electron-shaped; the job table, the sandbox, the guard and the runner are the
 * same modules Coflux.app uses.
 *
 * Three behaviours worth naming, because they are the ones that are wrong by default:
 *
 *  1. **stdout is the wire.** Nothing else may write to it. Diagnostics go to stderr (the worker
 *     logs them) and the runner children are forked with their stdout discarded — a stray
 *     `console.log` from a dependency would otherwise corrupt a frame and desynchronize the link.
 *  2. **Losing the parent does not kill the tasks.** When the worker exits — a hot upgrade is the
 *     ordinary reason — stdin reaches EOF. The host then *drains*: it accepts nothing new and waits
 *     for the tasks already running to finish before exiting. Killing them mid-write is strictly
 *     worse than losing track of them, because a half-written file cannot be un-written.
 *  3. **Exactly one host per machine, including during a drain.** A successor spawned by the new
 *     worker waits for the lock the draining predecessor still holds. Without it, a hot upgrade
 *     could put two hosts on one workspace, and the whole write-lock design assumes there is one.
 */

import { fork } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createExecutorConfigStore } from "./config.js";
import { createExecutorHostCore } from "./host-core.js";
import { MAX_HOST_LINE_BYTES, type ExecutorHostInbound, type ExecutorHostOutbound } from "./host-protocol.js";
import type { RunnerHandle } from "./manager.js";
import type { ExecutorRunnerOutbound } from "./runner-protocol.js";

/** How long a successor waits for a draining predecessor to release the host lock. A task's own cap
 * is 20 minutes, so this has to outlast one; past it, staying out is still the right answer. */
const LOCK_WAIT_MS = 25 * 60 * 1000;
const LOCK_POLL_MS = 500;
/** Upper bound on a drain. Past it the tasks are not going to finish on their own. */
const DRAIN_TIMEOUT_MS = 25 * 60 * 1000;
const DRAIN_POLL_MS = 1_000;

function homeDir(): string {
  const configured = process.env.COFLUX_HOME?.trim();
  return configured || join(homedir(), ".coflux");
}

function logLine(message: string): void {
  // stderr, never stdout: stdout carries the frames.
  process.stderr.write(`[executor-host] ${message}\n`);
}

/* --------------------------------- the single-host lock --------------------------------- */

/**
 * Take the machine's host lock, waiting for a predecessor that is still draining.
 *
 * A lock file holding a pid, not an advisory `flock`: Node has no portable flock, and the pid makes
 * a stale lock (the holder was killed) recoverable without a human. `process.kill(pid, 0)` answers
 * "is that pid alive"; anything it cannot confirm is treated as stale, because refusing to start
 * forever after one SIGKILL is the worse failure.
 */
async function acquireHostLock(path: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          // Only remove a lock that is still ours: a successor may already have taken over after a
          // stale-lock recovery, and deleting its file would let a third host in.
          if (readHolder(path) === process.pid) unlinkSync(path);
        } catch {
          // Nothing useful to do while exiting.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readHolder(path);
    if (holder === null || !alive(holder)) {
      try {
        unlinkSync(path);
      } catch {
        // Someone else won the race to clear it; the next iteration finds out.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`本机已有 executor host 在跑（pid ${holder}），等待超时`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

function readHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/* ----------------------------------- the stdio wire ----------------------------------- */

/** Write one frame. A broken pipe is not an error worth crashing on: it only means the worker went
 * away, which the drain already handles. */
function sendFrame(message: ExecutorHostOutbound): void {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The drain path owns what happens next.
  }
}

/** Assemble stdin into lines, with a cap. An unbounded buffer on a pipe is how a wedged peer turns
 * into an out-of-memory kill. */
function readFrames(onFrame: (message: ExecutorHostInbound) => void, onEnd: () => void): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_HOST_LINE_BYTES) {
      logLine("上行帧超过长度上限，丢弃缓冲");
      buffer = "";
      return;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          onFrame(JSON.parse(line) as ExecutorHostInbound);
        } catch {
          logLine("收到无法解析的帧，已忽略");
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);
  process.stdin.on("error", onEnd);
}

/* ------------------------------------ runner children ------------------------------------ */

/** Where this package's runner entry sits next to the host entry, after the build. */
function runnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "runner.js");
}

/**
 * Fork one runner. `stdio` is explicit and deliberate: the runner's stdout is **discarded** rather
 * than inherited, because this process's stdout is the wire; its stderr is piped back into the
 * daemon's log so a failure is diagnosable.
 */
function forkRunner(): RunnerHandle {
  const child = fork(runnerPath(), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) logLine(`runner: ${line.trim()}`);
  });
  return {
    postMessage: (message) => {
      // `RunnerHandle` is transport-agnostic, so the payload arrives as `unknown`; the IPC channel
      // wants a structured-clonable value, which every message on this link is.
      if (child.connected) child.send(message as import("node:child_process").Serializable);
    },
    kill: () => void child.kill(),
    on(event: "message" | "exit", listener: never) {
      if (event === "message") child.on("message", listener as unknown as (m: ExecutorRunnerOutbound) => void);
      else child.on("exit", listener as unknown as (code: number) => void);
    },
  };
}

/* --------------------------------------- the host --------------------------------------- */

export async function runExecutorHost(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const release = await acquireHostLock(join(home, "executor-host.lock"));

  let epoch = 0;
  let draining = false;

  const config = createExecutorConfigStore({
    cachePath: join(home, "executor-settings.json"),
    onChange: () => {
      // Two things follow a configuration change: the job table's admission criteria, and a fresh
      // registration — the daemon's submit gate only moves when a host registers again.
      core.refreshReadiness();
      if (!draining) register();
    },
  });

  const core = createExecutorHostCore({
    config,
    spawnRunner: forkRunner,
    send: sendFrame,
    log: logLine,
  });

  function register(): void {
    epoch += 1;
    sendFrame(core.registerFrame(epoch));
    logLine(`已向本机 daemon 报到（hostId=${core.hostId}，epoch=${epoch}）`);
  }

  readFrames(
    (message) => {
      if (draining) return;
      core.handle(message);
    },
    () => {
      if (draining) return;
      draining = true;
      // The worker is gone (a hot upgrade, a crash, a restart). Leave the running tasks alone and
      // wait them out: their files are half-written and killing them now cannot un-write anything.
      const active = core.activeRunIds().length;
      logLine(active === 0 ? "daemon 链路已断，无在跑任务，退出" : `daemon 链路已断，等待 ${active} 个在跑任务收尾后退出`);
      void drain();
    },
  );

  async function drain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (core.activeRunIds().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    if (core.activeRunIds().length > 0) {
      logLine("在跑任务超过收尾上限，强制停止后退出");
      core.cancelAll("daemon 已退出且任务未能在限期内收尾");
    }
    config.dispose();
    release();
    process.exit(0);
  }

  // A broken stdout must not become an uncaught exception during a drain.
  process.stdout.on("error", () => {});
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logLine(`收到 ${signal}，停止所有在跑任务`);
      core.cancelAll("本机 daemon 停止了 executor host，任务被中断");
      config.dispose();
      release();
      process.exit(0);
    });
  }

  register();
}

/**
 * Started as a process, not imported: run. The comparison goes through realpath on both sides
 * because the worker may have been handed a path through a symlinked prefix, and it **fails open** —
 * if the entry cannot be identified, starting the host is the right guess, since the only other
 * importer of this module imports it for types, which executes nothing.
 */
function startedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (startedDirectly()) {
  runExecutorHost().catch((error: unknown) => {
    logLine(`启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
