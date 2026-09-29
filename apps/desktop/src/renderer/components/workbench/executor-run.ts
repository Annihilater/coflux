import type { ExecutorRunState } from "@coflux/client";

/**
 * The executor picture-in-picture card (plan 20260929-executor-pip), the pure half: which runs
 * belong to a terminal, where a dragged card snaps, which transcript lines the collapsed card
 * shows, how long a run has been going, and when a card outlives its run.
 */

/** One transcript fragment as the card renders it (the wire message with `seq` as a number and the
 * kind as a word). */
export type ExecutorFragmentView = {
  seq: number;
  kind: "assistant" | "tool" | "error";
  text: string;
  tool: string;
  argument: string;
  output: string;
  failed: boolean;
  at: number;
};

/** The wire fragment, as protobuf-es decodes it. */
export type WireFragment = {
  seq: bigint;
  kind: number;
  text: string;
  tool: string;
  argument: string;
  output: string;
  failed: boolean;
  at: number;
};

/** `ExecutorFragmentKind` on the wire: 1 assistant, 2 tool, 3 error. Unknown kinds are dropped. */
export function fragmentView(fragment: WireFragment): ExecutorFragmentView | null {
  const kind = fragment.kind === 1 ? "assistant" : fragment.kind === 2 ? "tool" : fragment.kind === 3 ? "error" : null;
  if (!kind) return null;
  return {
    seq: Number(fragment.seq),
    kind,
    text: fragment.text,
    tool: fragment.tool,
    argument: fragment.argument,
    output: fragment.output,
    failed: fragment.failed,
    at: fragment.at,
  };
}

/** The live runs of one terminal, oldest first (the order they were submitted in). */
export function executorRunsForTask(runs: Readonly<Record<string, ExecutorRunState>>, taskId: string): ExecutorRunState[] {
  return Object.values(runs)
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => a.submittedAt - b.submittedAt || a.runId.localeCompare(b.runId));
}

/** The terminals (task ids) that have at least one live run. */
export function executorTaskIds(runs: Readonly<Record<string, ExecutorRunState>>): Set<string> {
  return new Set(Object.values(runs).map((run) => run.taskId));
}

export type ExecutorCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const DEFAULT_EXECUTOR_CORNER: ExecutorCorner = "bottom-right";

/** Picture-in-picture: on release the card goes to the corner nearest to where its centre is,
 * measured inside the pane. Exactly on a midline the right / bottom side wins, matching the
 * default corner. */
export function snapCorner(center: { x: number; y: number }, pane: { width: number; height: number }): ExecutorCorner {
  const left = center.x < pane.width / 2;
  const top = center.y < pane.height / 2;
  if (top) return left ? "top-left" : "top-right";
  return left ? "bottom-left" : "bottom-right";
}

/** One line of the collapsed card's rolling log. */
export type ExecutorLogLine = { kind: "prose" | "command" | "error"; text: string };

/** How many lines the collapsed card shows. */
export const ROLLING_LOG_LINES = 4;

/**
 * The last few lines of the transcript, newest last: an assistant message contributes its
 * non-empty lines as prose, a tool call one monospace `$ command` line (the tool name when it
 * has no salient argument), an error its text in the error colour. The window is taken over the
 * flattened lines, so a long assistant message does not push a fresh command out of view any
 * sooner than its own last lines.
 */
export function rollingLog(fragments: readonly ExecutorFragmentView[], limit = ROLLING_LOG_LINES): ExecutorLogLine[] {
  const lines: ExecutorLogLine[] = [];
  // Walk from the newest fragment back and stop once the window is full: a long transcript must
  // not be re-flattened on every fragment.
  for (let index = fragments.length - 1; index >= 0 && lines.length < limit; index -= 1) {
    const fragment = fragments[index]!;
    const own: ExecutorLogLine[] = [];
    if (fragment.kind === "tool") {
      own.push({ kind: "command", text: `$ ${fragment.argument || fragment.tool}` });
    } else if (fragment.kind === "error") {
      own.push({ kind: "error", text: fragment.text.trim() || "error" });
    } else {
      for (const line of fragment.text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) own.push({ kind: "prose", text: trimmed });
      }
    }
    // Take the fragment's own last lines first (they are the newest).
    for (let cursor = own.length - 1; cursor >= 0 && lines.length < limit; cursor -= 1) lines.unshift(own[cursor]!);
  }
  return lines;
}

/** m:ss under an hour, h:mm:ss beyond; never negative. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The instant a run's clock starts from: when the host reported it running, else when it was
 * submitted (a queued run shows how long it has been waiting). */
export function runClockStart(run: Pick<ExecutorRunState, "startedAt" | "submittedAt">): number {
  return run.startedAt > 0 ? run.startedAt : run.submittedAt;
}

/**
 * Whether a card is still shown once its run has left the live set: only while it is expanded
 * (the panel stays with the final state until the user collapses or closes it). A collapsed card
 * disappears the moment its run ends.
 */
export function retainAfterEnd(state: { live: boolean; expanded: boolean }): boolean {
  return state.live || state.expanded;
}

/** How a terminal state reads on the card. */
export function terminalLabel(terminal: string): string {
  switch (terminal) {
    case "succeeded":
      return "已完成";
    case "rejected":
      return "被拒绝";
    case "model_error":
      return "模型出错";
    case "tool_failed":
      return "工具失败";
    case "cancelled":
      return "已停止";
    case "unknown":
      return "结果未知";
    default:
      return terminal || "已结束";
  }
}

/** A long prompt is folded in the expanded panel: past this many lines or characters. */
export const PROMPT_FOLD_LINES = 6;
export const PROMPT_FOLD_CHARS = 480;

export function promptIsLong(prompt: string): boolean {
  return prompt.length > PROMPT_FOLD_CHARS || prompt.split("\n").length > PROMPT_FOLD_LINES;
}

/** The folded head of a long prompt. */
export function promptHead(prompt: string): string {
  const lines = prompt.split("\n").slice(0, PROMPT_FOLD_LINES).join("\n");
  return lines.length > PROMPT_FOLD_CHARS ? `${lines.slice(0, PROMPT_FOLD_CHARS)}…` : `${lines}…`;
}
