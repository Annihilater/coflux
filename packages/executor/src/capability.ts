/**
 * The capability name an executor host declares when it registers with the local daemon.
 *
 * The daemon gates registration on this **exact** string (`CAPABILITY_EXECUTOR_HOST` in
 * `crates/worker/src/agent_ctl/executor.rs`), with no version comparison, so the copies must stay
 * identical. A mismatch is invisible from inside the app — the settings page still reads "ready" —
 * and surfaces only on the agent's side as "there is no executor host on this machine". `src/capability.test.ts`
 * reads the daemon's own source and this file's third copy in `packages/protocol/src/index.ts`, so
 * a rename on any one side fails the build instead of silently disabling every executor run.
 */
export const EXECUTOR_HOST_CAPABILITY = "executor_host_v1";

/** What a host sends in its registration frame. Capabilities are gated by name; the array shape is
 * what the wire carries. */
export const EXECUTOR_HOST_CAPABILITIES = [EXECUTOR_HOST_CAPABILITY] as const;
