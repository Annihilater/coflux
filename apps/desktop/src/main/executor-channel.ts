/**
 * When the executor host registers itself with the local daemon.
 *
 * A tiny state machine, pure and on its own, for two reasons. It is the piece that got this wrong
 * before — and the failure is invisible from inside the app: everything keeps running, the settings
 * page still says "ready", and the only symptom appears on the agent's side as "Coflux.app is not
 * running". It is also the one part of `executor-host.ts` that can be exercised directly, since that
 * file imports `electron`, whose package entry is a path string with no named exports.
 *
 * The rule: **a registration belongs to a connection, not to a daemon.** The daemon drops its host
 * record the moment the device channel goes, so every new channel has to produce a fresh
 * registration. Comparing only the daemon id — which a reconnect leaves unchanged — was the bug.
 *
 * The epoch is monotonic across everything that registers (a new channel, a configuration change),
 * so the daemon can judge a late frame from an old connection as stale instead of letting it
 * overwrite the current one.
 */

export type ExecutorChannelEffect =
  /** Send a registration frame with the epoch this call produced. */
  | "register"
  /** The channel went away. Do **not** touch the job table: the runs are still going. */
  | "dropped"
  /** Nothing to do — a repeated announcement of the connection already registered. */
  | "ignore";

export type ExecutorChannelLedger = {
  /** The renderer announced this machine's device channel. `generation` identifies one connection;
   * an empty daemonId or a zero generation both mean "no channel". */
  announce(daemonId: string, generation: number): ExecutorChannelEffect;
  /** The configuration changed: re-register so the daemon's submit gate follows. */
  refresh(): ExecutorChannelEffect;
  /** The epoch of the most recent registration. */
  epoch(): number;
};

export function createExecutorChannelLedger(): ExecutorChannelLedger {
  let daemonId = "";
  let generation = 0;
  let epoch = 0;

  return {
    announce(nextDaemonId, nextGeneration) {
      const live = nextDaemonId !== "" && nextGeneration > 0;
      if (!live) {
        if (daemonId === "") return "ignore";
        daemonId = "";
        generation = 0;
        return "dropped";
      }
      if (nextDaemonId === daemonId && nextGeneration === generation) return "ignore";
      daemonId = nextDaemonId;
      generation = nextGeneration;
      epoch += 1;
      return "register";
    },
    refresh() {
      if (!daemonId) return "ignore";
      epoch += 1;
      return "register";
    },
    epoch: () => epoch,
  };
}
