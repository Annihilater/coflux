/**
 * The local runtime follows the app (plan 20261002-runtime-follows-app): pure decisions about a
 * running supervisor whose `runtimeId` is not the bundled one. No I/O; the daemon manager feeds
 * it facts and acts on the answer, so `node --test` can pin the once-per-launch rule without
 * starting a process.
 */

import type { DesktopRuntimeUpdate } from "../shared/desktop-bridge";

export type RuntimeFollowFacts = {
  /** `bundleRuntimeId` of this build; null = the build ships no daemon */
  bundledId: string | null;
  /** The supervisor answering runtime.sock; null = none */
  running: { runtimeId: string; supportsLeave: boolean } | null;
  /** ptyd answers: the `leave` path can hand the terminals over to the next supervisor */
  ptydAlive: boolean;
  /** Bundled ids an automatic attempt was already dispatched for during this app launch */
  attempted: ReadonlySet<string>;
};

/**
 * How a stale runtime gets onto the bundled version; null when it is not stale (or nothing runs).
 * - "manual": the running supervisor predates ptyd (no `leave`) or ptyd is not there to keep the
 *   terminals, so replacing it ends them; only the user's confirmed 「更新」 does that.
 * - "automatic": leave-capable and not yet attempted this launch; the main process replaces it
 *   by itself, no click.
 * - "failed": attempted this launch and still stale — the new version did not come up and the
 *   previous one was restored; only the user's 「重试」 tries again. A version that cannot start
 *   must never loop.
 */
export function resolveRuntimeUpdate(facts: RuntimeFollowFacts): DesktopRuntimeUpdate | null {
  if (!facts.bundledId || !facts.running || facts.running.runtimeId === facts.bundledId) return null;
  if (!facts.running.supportsLeave || !facts.ptydAlive) return "manual";
  return facts.attempted.has(facts.bundledId) ? "failed" : "automatic";
}

/** Replace now, without a click: the update is automatic and no other action holds the manager. */
export function shouldFollowBundledRuntime(facts: RuntimeFollowFacts & { busy: boolean }): boolean {
  return !facts.busy && resolveRuntimeUpdate(facts) === "automatic";
}
