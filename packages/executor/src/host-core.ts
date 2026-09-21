/**
 * The part of a host that is the same wherever it runs.
 *
 * A host is two things: an identity the daemon can recognize (a hostId plus a monotonically
 * increasing epoch), and a job table that turns assignments into runner processes. Both are here.
 * What is *not* here is the carrier — the daemon's host writes JSONL on a pipe, Coflux.app's host
 * relays the same messages through the renderer's device channel — and that is the only thing the
 * two adapters add.
 *
 * `hostId` is per host **instance**: a restarted host gets a new one, so the daemon knows the
 * instance changed and judges the previous instance's unfinished runs unknown rather than assuming
 * someone is still writing those files.
 *
 * Two rules this file exists to keep:
 *
 *  - **A lost carrier is not a dead host.** Nothing here clears the job table when the link drops;
 *    the tasks are still running and reconciliation restores the picture. Re-dispatching a writer
 *    on every disconnect would mean two processes writing the same workspace.
 *  - **A registration belongs to a connection, not to a daemon.** The daemon forgets its host the
 *    moment the link goes, so every new link has to produce a fresh registration. The adapter
 *    decides when that is; the epoch it passes in is what makes a late frame from a dead link
 *    judgeable as stale.
 */

import { randomUUID } from "node:crypto";

import { EXECUTOR_HOST_CAPABILITIES } from "./capability.js";
import { EXECUTOR_SYSTEM_PROMPT, type ExecutorConfigStore } from "./config.js";
import type { ExecutorHostInbound, ExecutorHostOutbound } from "./host-protocol.js";
import { ExecutorManager, type RunnerHandle } from "./manager.js";

export type ExecutorHostCoreOptions = {
  /** The account configuration as the local daemon last wrote it. */
  config: ExecutorConfigStore;
  /** Start one runner child. The daemon host forks node; Coflux.app forks a utilityProcess. */
  spawnRunner: () => RunnerHandle;
  /** Send one frame towards whoever started this host. */
  send: (message: ExecutorHostOutbound) => void;
  log: (message: string) => void;
  /** The login shell tool commands run under. Defaults to `$SHELL`, then `/bin/zsh`. */
  shell?: string;
};

export type ExecutorHostCore = {
  readonly hostId: string;
  /**
   * The frame that claims this machine's host slot, under `epoch`. The caller owns the epoch
   * because it owns the reason to register — a new link, or a configuration change — and the two
   * hosts count those differently.
   */
  registerFrame(epoch: number): Extract<ExecutorHostOutbound, { type: "register" }>;
  /** One frame from the daemon. */
  handle(message: ExecutorHostInbound): void;
  /** The configuration changed: the job table's admission criteria have to follow. */
  refreshReadiness(): void;
  /** Whether the daemon accepted this host. False means another host owns the slot. */
  hosting(): boolean;
  /** Runs still in flight. */
  activeRunIds(): string[];
  /**
   * Everything unfinished reaches a definite terminal state and every tool process group is
   * stopped. Used when the runtime the tasks live in is genuinely going away — never on a dropped
   * link, and never on a configuration change.
   */
  cancelAll(reason: string): void;
};

export function createExecutorHostCore(options: ExecutorHostCoreOptions): ExecutorHostCore {
  const hostId = randomUUID();
  let accepted = false;

  const manager = new ExecutorManager({
    spawnRunner: options.spawnRunner,
    config: () => {
      const view = options.config.view();
      const secrets = options.config.secrets();
      return {
        ready: view.ready,
        reason: view.reason,
        provider: secrets.provider,
        modelId: secrets.modelId,
        apiKey: secrets.apiKey,
        customProviders: secrets.customProviders,
        systemPrompt: EXECUTOR_SYSTEM_PROMPT,
        shell: options.shell || process.env.SHELL || "/bin/zsh",
      };
    },
    sendReport: (report) => options.send({ type: "report", ...report }),
    log: options.log,
  });

  return {
    hostId,

    registerFrame(epoch) {
      const view = options.config.view();
      return {
        type: "register",
        hostId,
        hostEpoch: epoch,
        capabilities: [...EXECUTOR_HOST_CAPABILITIES],
        ready: view.ready,
        notReadyReason: view.reason,
      };
    },

    handle(message) {
      switch (message.type) {
        case "registered":
          if (!message.ok) {
            accepted = false;
            // The daemon is the authority here and this side only records what it was told. The
            // usual reasons are that the link is not loopback, or that this machine's daemon hosts
            // the executor itself and will not let a second host take the slot.
            options.log(`本机 daemon 拒绝了 host 登记：${message.error ?? "未给出原因"}`);
            break;
          }
          accepted = true;
          manager.onReconcile(message.reconcileRunIds);
          break;
        case "assign":
          manager.onAssign({
            runId: message.runId,
            prompt: message.prompt,
            write: message.write,
            workspaceId: message.workspaceId,
            workspaceRoot: message.workspaceRoot,
            submittedAt: message.submittedAt,
          });
          break;
        case "cancel":
          manager.onCancel(message.runId);
          break;
        case "ack":
          manager.onAck(message.runId);
          break;
      }
    },

    refreshReadiness: () => manager.refreshReadiness(),
    hosting: () => accepted,
    activeRunIds: () => manager.activeRunIds(),
    cancelAll: (reason) => manager.cancelAll(reason),
  };
}
