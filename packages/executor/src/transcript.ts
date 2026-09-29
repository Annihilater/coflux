/**
 * The transcript recorder (plan 20260929-executor-pip): turns pi's session events into the
 * structured fragments the picture-in-picture card shows.
 *
 * Pure and pi-free on purpose — the runner is a process entry point that loads pi and speaks to
 * its host on import, so nothing in it can be exercised by a unit test. Everything about the
 * transcript that has a rule worth pinning lives here instead:
 *
 *   - **one assistant fragment per assistant message**, holding that message's text only (the old
 *     runner accumulated the whole run and re-emitted everything at every `message_end`);
 *   - **one tool fragment per tool call**, carrying the tool name, its salient argument and its
 *     output **capped to a head and a tail** with an explicit omission marker — a single verbose
 *     build log must never approach the host link's line cap or bloat the daemon's buffer;
 *   - **the provider credential never appears in a fragment.** The runner keeps it out of every
 *     tool's environment (`toolEnvironment`), and on top of that every fragment is passed through
 *     `redact` before it leaves the recorder. Belt and braces: the transcript now leaves the host
 *     process, so this is an invariant, not a discipline.
 */

import type { ExecutorTranscriptFragment } from "./runner-protocol.js";

/** How much of a tool's output survives, from the start and from the end. A few KB each: enough to
 * read a failure and its last lines, far below the 4 MB host line cap and the daemon's per-run
 * buffer. */
export const TOOL_OUTPUT_HEAD_CHARS = 4 * 1024;
export const TOOL_OUTPUT_TAIL_CHARS = 2 * 1024;

/** Marker written in place of a credential wherever one would otherwise be echoed. */
export const REDACTED = "***";

/** Environment variables the runner strips from every tool process regardless of their value:
 * the well-known provider credential names. Anything whose value contains a known secret is
 * stripped too (see `toolEnvironment`). */
export const CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

/** Bound a tool's output: keep a head and a tail, say how much went missing in between. */
export function capToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_HEAD_CHARS + TOOL_OUTPUT_TAIL_CHARS) return text;
  const head = text.slice(0, TOOL_OUTPUT_HEAD_CHARS);
  const tail = text.slice(text.length - TOOL_OUTPUT_TAIL_CHARS);
  const omitted = Buffer.byteLength(text.slice(TOOL_OUTPUT_HEAD_CHARS, text.length - TOOL_OUTPUT_TAIL_CHARS));
  return `${head}\n… ${omitted} bytes omitted …\n${tail}`;
}

/** The one argument worth showing on a tool row: the command for bash, the path for the file
 * tools, the pattern for the search tools. Anything unknown falls back to a compact JSON. */
export function salientArgument(toolName: string, args: unknown): string {
  const input = (args ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  };
  switch (toolName) {
    case "bash":
      return pick("command", "cmd");
    case "read":
    case "write":
    case "edit":
    case "ls":
      return pick("path", "file_path", "filePath", "directory");
    case "grep":
    case "find": {
      const pattern = pick("pattern", "query", "regex", "glob");
      const path = pick("path", "directory");
      return path ? `${pattern} ${path}`.trim() : pattern;
    }
    default: {
      const direct = pick("command", "path", "pattern", "query");
      if (direct) return direct;
      try {
        const json = JSON.stringify(args);
        return json && json !== "{}" && json !== "null" ? json : "";
      } catch {
        return "";
      }
    }
  }
}

/** The text of a tool's result, whatever shape pi handed back: a string, an `{ content: [...] }`
 * message, an `{ output }` object, or something else worth showing as JSON. */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const parts: string[] = [];
    for (const item of record.content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  for (const key of ["output", "text", "stdout", "message", "error"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/** Replace every occurrence of every non-empty secret. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * The environment a tool process gets: the base environment minus every well-known credential
 * variable and minus any variable whose value contains one of `secrets`, plus `extra`.
 *
 * Removing by **value** is what makes "a tool that dumps its environment cannot echo the key"
 * hold even when the key was exported under a name nobody listed.
 */
export function toolEnvironment(
  base: NodeJS.ProcessEnv | undefined,
  extra: Record<string, string>,
  secrets: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const stripped = new Set<string>(CREDENTIAL_ENV_NAMES);
  for (const [name, value] of Object.entries(base ?? {})) {
    if (value === undefined || stripped.has(name)) continue;
    if (secrets.some((secret) => secret && value.includes(secret))) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  return env;
}

/** The subset of pi's session events the recorder reads. Typed loosely on purpose: the recorder
 * must not import pi, and every field is checked before use. */
export type TranscriptEvent = {
  type: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

export type TranscriptRecorder = {
  /** Feed one session event. */
  onEvent(event: TranscriptEvent): void;
  /** Record an error the runner noticed itself (a blocked tool call, a startup failure). */
  error(text: string): void;
  /** The text of the most recent assistant message (complete or still streaming). This is what the
   * run reports as its summary. */
  lastAssistantText(): string;
  /** The stop reason and error message of the last assistant message that carried them. */
  lastStop(): { reason: string; errorMessage: string };
};

export type TranscriptRecorderOptions = {
  emit: (fragment: ExecutorTranscriptFragment) => void;
  /** Values that must never appear in a fragment: the provider credential. */
  secrets: readonly string[];
  now?: () => number;
};

export function createTranscriptRecorder(options: TranscriptRecorderOptions): TranscriptRecorder {
  const now = options.now ?? (() => Date.now());
  const secrets = options.secrets.filter(Boolean);
  const emit = (fragment: ExecutorTranscriptFragment) => {
    // Every field of every kind goes through the redaction, so a new field cannot forget it.
    const clean = Object.fromEntries(
      Object.entries(fragment).map(([key, value]) => [key, typeof value === "string" ? redact(value, secrets) : value]),
    ) as ExecutorTranscriptFragment;
    options.emit(clean);
  };

  /** The assistant message currently streaming. */
  let streaming = "";
  /** The last assistant text worth reporting: the most recent complete message, or the one still
   * streaming when the run stops mid-message. */
  let lastComplete = "";
  let stopReason = "";
  let errorMessage = "";
  /** Tool calls that started and have not ended yet, by pi's call id. */
  const open = new Map<string, { tool: string; argument: string; at: number }>();

  return {
    onEvent(event) {
      switch (event.type) {
        case "message_start": {
          if (event.message?.role === "assistant") streaming = "";
          break;
        }
        case "message_update": {
          const inner = event.assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) streaming += inner.delta;
          break;
        }
        case "message_end": {
          const message = event.message ?? {};
          if (message.stopReason) stopReason = message.stopReason;
          if (message.errorMessage) errorMessage = message.errorMessage;
          if (message.role !== undefined && message.role !== "assistant") break;
          const text = streaming.trim();
          streaming = "";
          if (!text) break;
          lastComplete = text;
          emit({ kind: "assistant", text, at: now() });
          break;
        }
        case "tool_execution_start": {
          const tool = event.toolName || "tool";
          const record = { tool, argument: salientArgument(tool, event.args), at: now() };
          open.set(event.toolCallId || `${tool}-${open.size}`, record);
          break;
        }
        case "tool_execution_end": {
          const tool = event.toolName || "tool";
          const key = event.toolCallId || "";
          const started = open.get(key);
          open.delete(key);
          emit({
            kind: "tool",
            tool,
            argument: started?.argument ?? salientArgument(tool, undefined),
            output: capToolOutput(toolResultText(event.result)),
            failed: event.isError === true,
            at: now(),
          });
          break;
        }
        default:
          break;
      }
    },
    error(text) {
      if (!text) return;
      emit({ kind: "error", text, at: now() });
    },
    lastAssistantText: () => (streaming.trim() ? streaming.trim() : lastComplete),
    lastStop: () => ({ reason: stopReason, errorMessage }),
  };
}
