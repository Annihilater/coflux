/**
 * The message contract between a host and whatever started it.
 *
 * There are two carriers and one contract. The daemon's worker spawns the host as a child process
 * and exchanges these messages as JSONL over inherited stdio; Coflux.app runs the host inside its
 * own main process and relays the same messages through the renderer's device channel. The shapes
 * below are the ones the device envelope already carries (`DeviceExecutorHostRegister`,
 * `DeviceExecutorAssign`, `DeviceExecutorReport`, ...), minus the envelope — so neither side has to
 * translate, and the daemon's ledger sees one kind of host.
 *
 * **No credential ever appears here.** The host reads the account configuration from the file the
 * local daemon wrote (0600, `$COFLUX_HOME/executor-settings.json`) and hands the key straight to a
 * runner. Sending it up this link would put it in a process that has no use for it.
 */

import type { ExecutorRunState } from "./jobs.js";

/** Host -> whoever started it. */
export type ExecutorHostOutbound =
  /**
   * Claim this machine's single executor host slot. `hostEpoch` is monotonic across everything that
   * registers, so a late frame from a dead connection can be judged stale rather than allowed to
   * overwrite the current registration.
   */
  | {
      type: "register";
      hostId: string;
      hostEpoch: number;
      capabilities: string[];
      ready: boolean;
      notReadyReason: string;
    }
  /** One run's state. Terminal states are re-sent until acked. */
  | {
      type: "report";
      runId: string;
      state: ExecutorRunState;
      note: string;
      summary?: string;
      changedFiles?: string[];
      error?: string;
    }
  /** A line for the daemon's log. The host has no log file of its own. */
  | { type: "log"; message: string };

/** Whoever started the host -> the host. */
export type ExecutorHostInbound =
  /** The daemon accepted or refused the registration. On acceptance, `reconcileRunIds` is the list
   * of runs it still has unfinished and expects to be re-reported one by one. */
  | { type: "registered"; ok: boolean; error?: string; reconcileRunIds: string[] }
  | {
      type: "assign";
      runId: string;
      prompt: string;
      write: boolean;
      workspaceId: string;
      workspaceRoot: string;
      submittedAt: number;
    }
  | { type: "cancel"; runId: string }
  /** The daemon stored a terminal state; the host may drop its copy. */
  | { type: "ack"; runId: string };

/** The largest single JSONL line either side will accept. A report carries the executor's final
 * reply, so the cap is generous — but unbounded line assembly on a pipe is how a wedged peer turns
 * into an out-of-memory kill. */
export const MAX_HOST_LINE_BYTES = 4 * 1024 * 1024;
