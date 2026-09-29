/**
 * The message contract between the main process and the executor runner (a utilityProcess child).
 *
 * It is its own file so both sides share one set of types, and so that this file **imports no pi**:
 * the main process should not drag all of pi into its module graph just to name a message type.
 *
 * The credential appears exactly once, in the `start` message. It is never persisted, never placed
 * in a tool process's environment, never transcribed, and never logged.
 */

/**
 * One custom endpoint, as the runner's own `ModelRuntime` needs it.
 *
 * The runner builds a **separate** runtime in its own process, so a provider the main process
 * registered means nothing to it: "I can pick it in the settings page" and "a job with it actually
 * runs" are two different things unless the definition travels in the start message.
 *
 * It deliberately carries no credential — that arrives once, in `apiKey`, and never goes into
 * `registerProvider`.
 */
export type ExecutorRunnerCustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: { id: string; name: string }[];
  authHeader: boolean;
  keyless: boolean;
};

export type ExecutorRunnerStart = {
  type: "start";
  runId: string;
  prompt: string;
  /** true = writable mode. */
  write: boolean;
  /** The workspace root, realpath-resolved. */
  workspaceRoot: string;
  /** This task's private scratch directory (realpath); TMPDIR points at it. */
  scratchDir: string;
  /** Where the generated Seatbelt profile was written; the bash backend passes it to sandbox-exec. */
  sandboxProfilePath: string;
  /** Path to the login shell. */
  shell: string;
  /** The system prompt, fixed by coflux. */
  systemPrompt: string;
  model: { provider: string; id: string };
  /** Custom endpoint definitions to register before resolving the model. */
  customProviders: ExecutorRunnerCustomProvider[];
  /** The provider credential. It appears **only here**; the runner must never forward it to a child
   * process or write it into any output. The runner cannot fetch it itself: a `utilityProcess` has
   * no `safeStorage`, and giving it a second route to the daemon's 0600 cache file would only widen
   * the exposure. */
  apiKey: string;
  /** Wall-clock cap for one task, in milliseconds. */
  timeoutMs: number;
};

export type ExecutorRunnerInbound = ExecutorRunnerStart | { type: "abort" };

/**
 * One transcript fragment (plan 20260929-executor-pip): a whole unit, never a per-token delta.
 *
 * Structured rather than pre-formatted so the desktop can fold a tool's output and render the
 * prose as markdown. It is the shape the host forwards to the daemon and the daemon serves to
 * viewing desktops (`ExecutorTranscriptFragment` on the wire), minus the worker-assigned `seq`.
 *
 * **The credential must never appear in any field.** The runner never puts it in a child's
 * environment, and `capToolOutput` bounds what a tool's output can echo — but the invariant is the
 * runner's, and `runner.test.ts` asserts it.
 */
export type ExecutorTranscriptFragment =
  /** One assistant message: that message's text only, not everything said so far. */
  | { kind: "assistant"; text: string; at: number }
  /** One tool call: its name, its salient argument (the command for bash, the path for file
   * tools), its capped output, and whether it failed. */
  | { kind: "tool"; tool: string; argument: string; output: string; failed: boolean; at: number }
  /** A blocked tool call or a model failure. */
  | { kind: "error"; text: string; at: number };

/** Runner -> host. `progress` is one sentence for the user (it rides the daemon's status report);
 * `transcript` fragments are forwarded by the host to the daemon, which buffers them per run for the
 * picture-in-picture card. They never reach the center. */
export type ExecutorRunnerOutbound =
  | { type: "ready" }
  | { type: "running" }
  | { type: "progress"; note: string }
  /** One transcript fragment; `seq` is the runner's own count and is re-assigned by the daemon. */
  | { type: "transcript"; seq: number; fragment: ExecutorTranscriptFragment }
  | {
      type: "done";
      outcome: "succeeded" | "model_error" | "tool_failed" | "cancelled";
      summary: string;
      changedFiles: string[];
      error?: string;
    };

/** The runner's exit-code meanings, so the main process can still name a definite terminal state
 * when the child vanishes unexpectedly. */
export const EXECUTOR_RUNNER_EXIT = {
  ok: 0,
  /** Could not start (pi failed to load, the model configuration is unusable, ...). */
  startupFailed: 10,
  /** Wound itself down after receiving an abort. */
  aborted: 11,
} as const;
