/**
 * Launcher respawn decision (plan 20261002-runtime-launcher-merge). The launcher owns runtime
 * probation and rollback; the app only answers one question with no version logic: is the launcher
 * gone while the terminals in ptyd are still alive, so that nothing would otherwise bring the device
 * back online? Headless hosts get the same from launchd / systemd KeepAlive. Pure, no I/O.
 */
export type LauncherWatchdogFacts = {
  /** ptyd answers: the terminals are alive and the user did not stop the local runtime */
  ptydAlive: boolean;
  /** something answers runtime.sock (a launcher, or a pre-plan supervisor being migrated) */
  launcherAlive: boolean;
  /** the runtime marker exists: this Mac was set up and the directory to start from is known */
  installed: boolean;
  /** an action (start / stop / update) holds the manager; never interfere */
  busy: boolean;
  /** when the last automatic start failed (ms), or null */
  lastFailureAt: number | null;
  now: number;
  /** minimum spacing between two automatic starts */
  backoffMs: number;
};

export function shouldStartLauncher(facts: LauncherWatchdogFacts): boolean {
  if (!facts.ptydAlive || facts.launcherAlive || !facts.installed || facts.busy) return false;
  if (facts.lastFailureAt !== null && facts.now - facts.lastFailureAt < facts.backoffMs) return false;
  return true;
}
