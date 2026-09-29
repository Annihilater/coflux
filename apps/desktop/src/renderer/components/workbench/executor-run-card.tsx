import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, CircleAlert, Maximize2, Minimize2, Square, Unplug, X } from "lucide-react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useToast } from "@astryxdesign/core/Toast";
import type { CofluxClient, ExecutorRunState, ExecutorTranscriptEvent } from "@coflux/client";

import {
  DEFAULT_EXECUTOR_CORNER,
  executorRunsForTask,
  formatElapsed,
  fragmentView,
  promptHead,
  promptIsLong,
  retainAfterEnd,
  rollingLog,
  runClockStart,
  snapCorner,
  terminalLabel,
  type ExecutorCorner,
  type ExecutorFragmentView,
} from "@/components/workbench/executor-run";
import { ActivityDots } from "@/components/workbench/pending-dots";
import { PaperMarkdown } from "@/components/workbench/terminal-paper";
import { cn } from "@/lib/utils";

/**
 * The executor picture-in-picture card (plan 20260929-executor-pip): a read-only card on the pane of
 * the terminal whose agent ran `coflux executor run`, on every desktop of the account that can see
 * that terminal.
 *
 * Shape, as the user settled it:
 *   - collapsed in a corner of the pane, draggable, snapping to the nearest corner on release;
 *     controls on hover; several runs from one terminal stack in the same corner;
 *   - click expands it in place into a large panel over most of the pane, margins left so it still
 *     reads as floating over the terminal; Esc or the collapse button shrinks it back;
 *   - a stop button on both sizes: one click, no confirmation;
 *   - the card disappears the moment the run ends — unless it is expanded, in which case the panel
 *     stays with the final state until the user collapses or closes it.
 *
 * The run's existence comes from the center's snapshot (the store); everything shown inside comes
 * over the device channel of the device hosting the run: the prompt, the transcript, the end.
 *
 * Keys: while a panel is expanded the pane yields its shortcuts (TerminalPane gates on
 * `onExpandedChange`), and Esc is taken on the window's capture phase exactly as the paper does —
 * a stray Esc reaching the shell would interrupt the agent's turn.
 */

export type ExecutorCardClient = Pick<CofluxClient, "subscribeExecutorTranscript" | "stopExecutorRun">;

/** How many fragments a card keeps; past it the oldest go and the omitted marker shows. */
const MAX_FRAGMENTS = 2000;
/** A press that moved less than this is a click, not a drag. */
const CLICK_SLOP_PX = 4;

const CORNER_CLASS: Record<ExecutorCorner, string> = {
  "top-left": "left-4 top-4 items-start",
  "top-right": "right-4 top-4 items-end",
  "bottom-left": "bottom-4 left-4 items-start",
  "bottom-right": "bottom-4 right-4 items-end",
};

export function ExecutorRunCards({
  runs,
  taskId,
  client,
  focused,
  onExpandedChange,
  onRestoreFocus,
}: {
  /** Every live run of the account (the store's map); the ones bound to `taskId` are shown. */
  runs: Readonly<Record<string, ExecutorRunState>>;
  taskId: string;
  client: ExecutorCardClient;
  /** Whether this pane is the focused one: only it answers Esc. */
  focused: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** After a collapse, focus goes back to the terminal. */
  onRestoreFocus: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Where an expanded panel is rendered (a portal target): a sibling of the corner stack, so
  // `inset-6` resolves against the pane and not against the stack, while the card component —
  // and the transcript it holds — stays in the stack.
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null);
  const [corner, setCorner] = useState<ExecutorCorner>(DEFAULT_EXECUTOR_CORNER);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // The last snapshot of every run seen here, so a run that ended while expanded can keep its
  // card until the user closes it (the store has already dropped it).
  const lastSeen = useRef(new Map<string, ExecutorRunState>());

  const live = executorRunsForTask(runs, taskId);
  for (const run of live) lastSeen.current.set(run.runId, run);
  const retained = expandedRunId !== null && !live.some((run) => run.runId === expandedRunId) ? lastSeen.current.get(expandedRunId) : undefined;
  const shown = retained ? [...live, retained] : live;
  for (const id of [...lastSeen.current.keys()]) {
    if (!shown.some((run) => run.runId === id)) lastSeen.current.delete(id);
  }

  useEffect(() => {
    onExpandedChange(expandedRunId !== null);
  }, [expandedRunId, onExpandedChange]);

  const collapse = useCallback(() => {
    setExpandedRunId(null);
    onRestoreFocus();
  }, [onRestoreFocus]);

  // Esc collapses the expanded panel: window capture phase, so it never reaches xterm.
  useEffect(() => {
    if (expandedRunId === null || !focused) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [expandedRunId, focused, collapse]);

  if (shown.length === 0) return null;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      <div className={cn("absolute z-30 flex flex-col gap-2", CORNER_CLASS[corner])}>
        {shown.map((run) => (
          <ExecutorRunCard
            key={run.runId}
            run={run}
            live={live.some((entry) => entry.runId === run.runId)}
            client={client}
            expanded={expandedRunId === run.runId}
            panelSlot={panelSlot}
            onExpand={() => setExpandedRunId(run.runId)}
            onCollapse={collapse}
            paneRect={() => rootRef.current?.getBoundingClientRect() ?? null}
            onSnap={setCorner}
          />
        ))}
      </div>
      <div ref={setPanelSlot} className="pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

type TranscriptState = {
  prompt: string;
  fragments: ExecutorFragmentView[];
  omitted: boolean;
  unsupported: boolean;
  end: { terminal: string; summary: string; error: string; at: number } | null;
};

const EMPTY_TRANSCRIPT: TranscriptState = { prompt: "", fragments: [], omitted: false, unsupported: false, end: null };

function ExecutorRunCard({
  run,
  live,
  client,
  expanded,
  panelSlot,
  onExpand,
  onCollapse,
  paneRect,
  onSnap,
}: {
  run: ExecutorRunState;
  live: boolean;
  client: ExecutorCardClient;
  expanded: boolean;
  panelSlot: HTMLDivElement | null;
  onExpand: () => void;
  onCollapse: () => void;
  paneRect: () => DOMRect | null;
  onSnap: (corner: ExecutorCorner) => void;
}) {
  const showToast = useToast();
  const [transcript, setTranscript] = useState<TranscriptState>(EMPTY_TRANSCRIPT);

  // Follow the transcript for the card's whole life, from the start: a desktop that opens the
  // terminal mid-run gets the full record so far, then the live fragments.
  const { daemonId, runId } = run;
  useEffect(() => {
    return client.subscribeExecutorTranscript({ daemonId, runId }, 0, (event: ExecutorTranscriptEvent) => {
      setTranscript((state) => {
        switch (event.kind) {
          case "prompt":
            return { ...state, prompt: event.prompt };
          case "fragments": {
            const incoming = event.fragments.map(fragmentView).filter((fragment): fragment is ExecutorFragmentView => fragment !== null);
            let fragments = [...state.fragments, ...incoming];
            let omitted = state.omitted || event.omitted;
            if (fragments.length > MAX_FRAGMENTS) {
              fragments = fragments.slice(fragments.length - MAX_FRAGMENTS);
              omitted = true;
            }
            return { ...state, fragments, omitted, unsupported: false };
          }
          case "ended":
            return { ...state, end: { terminal: event.terminal, summary: event.summary, error: event.error, at: Date.now() } };
          case "unsupported":
            return { ...state, unsupported: true };
        }
      });
    });
  }, [client, daemonId, runId]);

  // The end can also arrive from the center alone (an old worker, a lost device): the run left the
  // live set without an `ended` event. Freeze the clock then.
  const ended = transcript.end !== null || !live;
  const endedAt = transcript.end?.at;
  const elapsed = useElapsed(runClockStart(run), ended, endedAt);

  const stop = useCallback(() => {
    if (ended) return;
    if (!client.stopExecutorRun(run)) showToast({ body: "设备通道未连接，稍后再试", type: "error" });
  }, [client, run, ended, showToast]);

  if (!retainAfterEnd({ live, expanded })) return null;

  const state: CardState = ended
    ? { kind: "ended", terminal: transcript.end?.terminal ?? "unknown" }
    : run.hostLost
      ? { kind: "host-lost" }
      : run.phase === "running"
        ? { kind: "running" }
        : { kind: "queued" };

  if (expanded) {
    if (!panelSlot) return null;
    return createPortal(
      <ExecutorPanel run={run} state={state} elapsed={elapsed} transcript={transcript} onStop={stop} onCollapse={onCollapse} />,
      panelSlot,
    );
  }
  return (
    <CollapsedCard
      run={run}
      state={state}
      elapsed={elapsed}
      transcript={transcript}
      onStop={stop}
      onExpand={onExpand}
      paneRect={paneRect}
      onSnap={onSnap}
    />
  );
}

type CardState = { kind: "queued" } | { kind: "running" } | { kind: "host-lost" } | { kind: "ended"; terminal: string };

/** Ticks once a second while the run goes; frozen at `endedAt` once it ended. */
function useElapsed(start: number, ended: boolean, endedAt: number | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ended) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ended]);
  return formatElapsed((ended ? (endedAt ?? now) : now) - start);
}

function StateGlyph({ state }: { state: CardState }) {
  switch (state.kind) {
    case "running":
      return <ActivityDots status="active" label="执行中" />;
    case "queued":
      return <ActivityDots status="question" label="排队中" />;
    case "host-lost":
      return <Unplug className="size-3 shrink-0 text-warning" aria-label="主机连接中断" />;
    case "ended":
      return state.terminal === "succeeded" ? (
        <Check className="size-3 shrink-0 text-success" aria-label={terminalLabel(state.terminal)} />
      ) : (
        <CircleAlert className="size-3 shrink-0 text-destructive" aria-label={terminalLabel(state.terminal)} />
      );
  }
}

function stateText(state: CardState): string {
  switch (state.kind) {
    case "running":
      return "执行中";
    case "queued":
      return "排队中";
    case "host-lost":
      return "主机连接中断";
    case "ended":
      return terminalLabel(state.terminal);
  }
}

function ModeBadge({ write }: { write: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-medium leading-none",
        write ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
      )}
    >
      {write ? "可写" : "只读"}
    </span>
  );
}

function StopButton({ onStop, disabled, size }: { onStop: () => void; disabled: boolean; size: "sm" | "md" }) {
  return (
    <Tooltip content="停止">
      <button
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
          size === "sm" ? "size-6" : "size-7",
        )}
        aria-label="停止 executor"
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onStop();
        }}
      >
        <Square className={cn("fill-current", size === "sm" ? "size-2.5" : "size-3")} />
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ *
 * Collapsed: fixed size, rolling log, drag to a corner
 * ------------------------------------------------------------------ */

function CollapsedCard({
  run,
  state,
  elapsed,
  transcript,
  onStop,
  onExpand,
  paneRect,
  onSnap,
}: {
  run: ExecutorRunState;
  state: CardState;
  elapsed: string;
  transcript: TranscriptState;
  onStop: () => void;
  onExpand: () => void;
  paneRect: () => DOMRect | null;
  onSnap: (corner: ExecutorCorner) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    current.moved = true;
    setOffset({ x: dx, y: dy });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.moved) {
      setOffset(null);
      onExpand();
      return;
    }
    // Picture-in-picture: wherever it was let go, it goes to the nearest corner.
    const pane = paneRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (pane && card) {
      onSnap(
        snapCorner(
          { x: card.left + card.width / 2 - pane.left, y: card.top + card.height / 2 - pane.top },
          { width: pane.width, height: pane.height },
        ),
      );
    }
    setOffset(null);
  }

  const lines = rollingLog(transcript.fragments);
  const dragging = offset !== null;
  const style: CSSProperties | undefined = dragging ? { transform: `translate(${offset.x}px, ${offset.y}px)`, transition: "none" } : undefined;

  return (
    <div
      ref={cardRef}
      role="status"
      aria-label={`executor：${run.title}`}
      className={cn(
        "group pointer-events-auto w-80 max-w-full select-none rounded-lg border border-border bg-popover/95 text-popover-foreground shadow-lg backdrop-blur",
        dragging ? "cursor-grabbing shadow-2xl" : "cursor-grab",
        state.kind === "host-lost" && "opacity-70",
      )}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setOffset(null);
      }}
    >
      <div className="flex h-8 items-center gap-2 px-3">
        <StateGlyph state={state} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
        <ModeBadge write={run.write} />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{elapsed}</span>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <StopButton onStop={onStop} disabled={state.kind === "ended"} size="sm" />
          <Tooltip content="展开">
            <button
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="展开 executor 记录"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
            >
              <Maximize2 className="size-3" />
            </button>
          </Tooltip>
        </div>
      </div>
      {/* Fixed height: content changes never resize the card. */}
      <div className="h-[72px] overflow-hidden px-3 pb-2 text-xs leading-[18px]">
        {transcript.unsupported ? (
          <p className="text-muted-foreground">这台设备的 daemon 版本过旧，看不到执行过程</p>
        ) : lines.length === 0 ? (
          <p className="text-muted-foreground">{state.kind === "queued" ? "等待主机接单…" : state.kind === "host-lost" ? "主机连接中断，等待它重连" : "还没有输出"}</p>
        ) : (
          lines.map((line, index) => (
            <p
              key={index}
              className={cn(
                "truncate",
                line.kind === "command" && "font-mono text-foreground/85",
                line.kind === "prose" && "text-muted-foreground",
                line.kind === "error" && "text-destructive",
              )}
            >
              {line.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Expanded: the paper's typography over most of the pane
 * ------------------------------------------------------------------ */

function ExecutorPanel({
  run,
  state,
  elapsed,
  transcript,
  onStop,
  onCollapse,
}: {
  run: ExecutorRunState;
  state: CardState;
  elapsed: string;
  transcript: TranscriptState;
  onStop: () => void;
  onCollapse: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const stickToBottom = useRef(true);

  // The panel takes the focus, so the terminal underneath does not even see keydown.
  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // Follow the newest fragment unless the reader scrolled up to read something.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [transcript.fragments.length, transcript.end]);

  const foldPrompt = promptIsLong(transcript.prompt) && !promptOpen;

  return (
    <div
      role="dialog"
      aria-label={`executor：${run.title}`}
      // inset-6 leaves the terminal visible around the panel: it still reads as floating over it.
      // The slot it is portalled into sits at z-40 (the paper's level), above the collapsed stack.
      className="pointer-events-auto absolute inset-6 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-border px-4">
        <StateGlyph state={state} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.title}</span>
        <ModeBadge write={run.write} />
        <span className="shrink-0 text-xs text-muted-foreground">{stateText(state)}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed}</span>
        <StopButton onStop={onStop} disabled={state.kind === "ended"} size="md" />
        <Tooltip content={state.kind === "ended" ? "关闭" : "收起"}>
          <button
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={state.kind === "ended" ? "关闭" : "收起"}
            onClick={onCollapse}
          >
            {state.kind === "ended" ? <X className="size-3.5" /> : <Minimize2 className="size-3.5" />}
          </button>
        </Tooltip>
      </div>
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="min-h-0 flex-1 cursor-text select-text overflow-y-auto outline-none"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        <div className="mx-auto max-w-[840px] break-words px-8 pb-16 pt-6 font-sans text-lg leading-[1.6]">
          {transcript.prompt ? (
            <div className="flex justify-end pb-5 pt-1">
              <div className="min-w-0 max-w-[80%] rounded-[12px] border border-foreground/12 bg-input px-3 py-2 text-foreground">
                <PaperMarkdown text={foldPrompt ? promptHead(transcript.prompt) : transcript.prompt} />
                {promptIsLong(transcript.prompt) ? (
                  <button
                    className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setPromptOpen((open) => !open)}
                  >
                    {promptOpen ? "收起任务描述" : "展开完整任务描述"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {transcript.unsupported ? (
            <p className="pb-4 text-sm text-muted-foreground">这台设备的 daemon 版本过旧，看不到执行过程；运行 cofluxd update 后再试。</p>
          ) : null}
          {transcript.omitted ? <p className="pb-4 text-xs text-muted-foreground">更早的输出已省略</p> : null}
          <div className="space-y-4">
            {transcript.fragments.map((fragment) => (
              <FragmentEntry key={fragment.seq} fragment={fragment} />
            ))}
          </div>
          {transcript.fragments.length === 0 && !transcript.unsupported && state.kind !== "ended" ? (
            <p className="text-sm text-muted-foreground">{state.kind === "queued" ? "等待主机接单…" : "还没有输出"}</p>
          ) : null}
          {transcript.end ? <EndEntry end={transcript.end} /> : state.kind === "ended" ? (
            <p className="pt-6 text-sm text-muted-foreground">运行已结束</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FragmentEntry({ fragment }: { fragment: ExecutorFragmentView }) {
  if (fragment.kind === "assistant") {
    return (
      <div className="text-foreground/90">
        <PaperMarkdown text={fragment.text} />
      </div>
    );
  }
  if (fragment.kind === "error") {
    return <p className="whitespace-pre-wrap break-words font-mono text-sm text-destructive">{fragment.text}</p>;
  }
  return <ToolEntry fragment={fragment} />;
}

/** A tool call: one `$ command` row, its output folded until clicked. */
function ToolEntry({ fragment }: { fragment: ExecutorFragmentView }) {
  const [open, setOpen] = useState(false);
  const label = fragment.argument || fragment.tool;
  return (
    <div>
      <button
        className={cn(
          "flex w-full items-start gap-1.5 rounded-md py-0.5 pr-2 text-left font-mono text-sm transition-colors hover:bg-accent/60",
          fragment.failed ? "text-destructive" : "text-muted-foreground",
        )}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="mt-1 size-3 shrink-0" /> : <ChevronRight className="mt-1 size-3 shrink-0" />}
        <span className="min-w-0 flex-1 break-all">
          <span className="select-none">{fragment.tool === "bash" ? "$ " : `${fragment.tool} `}</span>
          {label}
        </span>
      </button>
      {open ? (
        <pre
          className={cn(
            "mt-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-base leading-[1.4]",
            fragment.failed && "border-destructive/40",
          )}
        >
          {fragment.output || "（无输出）"}
        </pre>
      ) : null}
    </div>
  );
}

function EndEntry({ end }: { end: { terminal: string; summary: string; error: string } }) {
  const ok = end.terminal === "succeeded";
  return (
    <div className="mt-6 border-t border-border pt-4">
      <p className={cn("text-sm font-medium", ok ? "text-success" : "text-destructive")}>{terminalLabel(end.terminal)}</p>
      {end.error ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-destructive">{end.error}</p> : null}
      {end.summary ? (
        <div className="mt-3 text-foreground/90">
          <PaperMarkdown text={end.summary} />
        </div>
      ) : null}
    </div>
  );
}
