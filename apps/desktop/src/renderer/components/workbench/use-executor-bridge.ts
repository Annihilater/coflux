import { useEffect } from "react";
import { useStore } from "zustand";
import type { CofluxClient } from "@coflux/client";

import { desktop } from "@/config";

/**
 * The executor's renderer side: **a messenger and nothing more**.
 *
 * The job table, the write lock, the runner and the credentials all live in the main process. This
 * holds no run state and makes no decisions. It does three things:
 *   1. Takes an **independent, permanent retain** on the local daemon. The workbench otherwise only
 *      does `measureOnly` for non-selected devices, which creates no connection demand,
 *      while the daemon accepts executor frames only from a loopback channel. The executor
 *      service also must not depend on which workspace the user happens to be looking at.
 *   2. Relays the four frames the daemon pushes into the main process.
 *   3. Sends the two frames the main process produces out over the device channel.
 *
 * The local daemon's identity comes from the desktop side's `daemonState.daemonId` (the app has
 * managed this machine's daemon since plan 113). Without it this does nothing — the executor only
 * serves the machine the desktop app is on.
 *
 * **The channel is announced per connection, not per daemon.** The daemon forgets its host the
 * moment the device channel drops, so a reconnect has to produce a fresh registration. Announcing
 * only when `localDaemonId` changes meant the second connection never heard from this app again:
 * the daemon's host slot stayed empty and `coflux executor run` reported "Coflux.app is not
 * running" while it was plainly running. The device transport's `generation` identifies one
 * connection, so it is what this watches — and it also fixes the first announcement, which used to
 * race the lane coming up and could be sent before any channel existed.
 */
export function useExecutorBridge(client: CofluxClient, localDaemonId: string | undefined): void {
  // A number, not the transport object: the object is replaced on every heartbeat reading, and
  // selecting it would re-render this subtree every fifteen seconds for nothing.
  const liveGeneration = useStore(client.store, (state) => liveChannelGeneration(localDaemonId, state.deviceTransports));

  useEffect(() => {
    if (!localDaemonId) {
      desktop.setExecutorChannel("", 0);
      return;
    }

    // Executor hosting requires real connection demand; sidebar observation alone opens no lane.
    const release = client.retainDevice(localDaemonId);

    const unsubscribeInbound = client.subscribeExecutor((event) => {
      // Only from this machine's daemon; no other device should push executor frames, and one that
      // does is ignored.
      if (event.daemonId !== localDaemonId) return;
      if (event.kind === "assign") {
        desktop.sendExecutorInbound({
          kind: "assign",
          runId: event.runId,
          prompt: event.prompt,
          write: event.write,
          workspaceId: event.workspaceId,
          workspaceRoot: event.workspaceRoot,
          submittedAt: event.submittedAt,
        });
      } else if (event.kind === "cancel") {
        desktop.sendExecutorInbound({ kind: "cancel", runId: event.runId });
      } else if (event.kind === "ack") {
        desktop.sendExecutorInbound({ kind: "ack", runId: event.runId });
      } else {
        desktop.sendExecutorInbound({
          kind: "registered",
          ok: event.ok,
          error: event.error,
          reconcileRunIds: event.reconcileRunIds,
        });
      }
    });

    const unsubscribeOutbound = desktop.onExecutorOutbound((message) => {
      if (message.kind === "register") {
        client.sendExecutorHostRegister(localDaemonId, {
          hostId: message.hostId,
          hostEpoch: BigInt(message.hostEpoch),
          capabilities: message.capabilities,
          ready: message.ready,
          notReadyReason: message.notReadyReason,
        });
      } else {
        client.sendExecutorReport(localDaemonId, {
          $typeName: "coflux.v1.DeviceExecutorReport",
          runId: message.runId,
          state: executorStateToWire(message.state),
          note: message.note,
          summary: message.summary,
          changedFiles: message.changedFiles ?? [],
          error: message.error,
          reportedAt: Date.now(),
        });
      }
    });

    return () => {
      desktop.setExecutorChannel("", 0);
      unsubscribeInbound();
      unsubscribeOutbound();
      release();
    };
  }, [client, localDaemonId]);

  /**
   * The announcement is its own effect, on purpose. Folding it into the one above would make a
   * reconnect tear down the retain and both subscriptions — and dropping the retain is itself a
   * reason for the channel to go away, so the two would chase each other. This effect runs after
   * that one on the same commit, so the outbound subscription is always in place before the main
   * process is told it has somewhere to send its registration frame.
   */
  useEffect(() => {
    if (!localDaemonId) return;
    // A zero generation means there is no channel; the main process then knows not to register.
    desktop.setExecutorChannel(liveGeneration ? localDaemonId : "", liveGeneration);
  }, [localDaemonId, liveGeneration]);
}

/**
 * The generation of this daemon's live device channel, or 0 when there is none.
 *
 * `idle` / `offline` / `probing` all mean no lane is up, so there is nothing to register over. A
 * relayed channel still counts: whether executor frames are accepted over it is the daemon's own
 * loopback judgement, not this side's.
 *
 * A reconnect to the same daemon produces a different number, and that difference is the whole
 * reason the main process registers again — the rule itself is pinned in main/executor-channel.ts.
 */
function liveChannelGeneration(
  daemonId: string | undefined,
  transports: Record<string, { mode: string; generation: number } | undefined>,
): number {
  if (!daemonId) return 0;
  const transport = transports[daemonId];
  if (!transport) return 0;
  if (transport.mode === "idle" || transport.mode === "offline" || transport.mode === "probing") return 0;
  return transport.generation;
}

/** The main process expresses state as strings (they read and assert better across IPC); on the
 * wire it is a proto enum. */
function executorStateToWire(state: string): number {
  switch (state) {
    case "accepted":
      return 1;
    case "running":
      return 2;
    case "succeeded":
      return 3;
    case "rejected":
      return 4;
    case "model_error":
      return 5;
    case "tool_failed":
      return 6;
    case "cancelled":
      return 7;
    case "unknown":
      return 8;
    default:
      return 0;
  }
}
