import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Maximize2, Minimize2, Square, Unplug, X } from "lucide-react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useToast } from "@astryxdesign/core/Toast";
import type { CofluxClient, ExecutorRunState, ExecutorTranscriptEvent } from "@coflux/client";

import {
  CARD_LOG_CENTER,
  CARD_LOG_HEIGHT,
  CARD_LOG_LINE_HEIGHT,
  CARD_LOG_LINES,
  CARD_LOG_TOP,
  DeckController,
} from "@/components/workbench/executor-deck";
import {
  DEFAULT_EXECUTOR_CORNER,
  executorRunsForTask,
  formatElapsed,
  fragmentView,
  promptHead,
  promptIsLong,
  reconcileDeck,
  retainAfterEnd,
  rollingLog,
  runClockStart,
  terminalLabel,
  type ExecutorCorner,
  type ExecutorFragmentView,
  type ExecutorLogLine,
} from "@/components/workbench/executor-run";
import { ActivityDots } from "@/components/workbench/pending-dots";
import { PaperMarkdown } from "@/components/workbench/terminal-paper";
import { cn } from "@/lib/utils";

/**
 * The executor picture-in-picture card (plan 20260929-executor-pip, motion from plan
 * 20260930-executor-pip-motion): a read-only card on the pane of the terminal whose agent ran
 * `coflux executor run`, on every desktop of the account that can see that terminal.
 *
 * Shape, as the user settled it:
 *   - collapsed in a corner of the pane (top-right to start), draggable; on release the deck is
 *     thrown to the corner its velocity points at and springs there;
 *   - several runs of one terminal form a carousel deck: the front card upright, the next peeking
 *     on the right, the previous on the left; hovering the deck shows the header controls and the
 *     switch arrows;
 *   - click expands the front card into a large panel over most of the pane, margins left so it
 *     still reads as floating over the terminal; Esc or the collapse button shrinks it back;
 *   - a stop button on both sizes: one click, no confirmation;
 *   - a card springs out the moment its run ends — unless it is expanded, in which case the panel
 *     stays with the final state until the user collapses or closes it.
 *
 * The run's existence comes from the center's snapshot (the store); everything shown inside comes
 * over the device channel of the device hosting the run: the prompt, the transcript, the end.
 *
 * Layout and motion belong to the deck (`DeckController`, which writes styles from its own
 * animation loop); each card owns its run: its transcript subscription, its clock, its stop.
 *
 * Keys: while a panel is expanded the pane yields its shortcuts (TerminalPane gates on
 * `onExpandedChange`), and Esc is taken on the window's capture phase exactly as the paper does —
 * a stray Esc reaching the shell would interrupt the agent's turn.
 */

export type ExecutorCardClient = Pick<CofluxClient, "subscribeExecutorTranscript" | "stopExecutorRun">;

/** How many fragments a card keeps; past it the oldest go and the omitted marker shows. */
const MAX_FRAGMENTS = 2000;
/** Lines the rolling log keeps beyond what fits, so there is always one to fade out at the top. */
const ROLLING_LOG_KEPT = CARD_LOG_LINES + 4;
const LOG_EASE = "cubic-bezier(.2,.8,.2,1)";

type DeckState = { order: string[]; leaving: string[] };
type PanelState = { runId: string; open: boolean } | null;
type CardRole = "front" | "back" | "leaving";

const byArrival = (a: ExecutorRunState, b: ExecutorRunState) => a.submittedAt - b.submittedAt || a.runId.localeCompare(b.runId);

export function ExecutorRunCards({
  runs,
  taskId,
  client,
  focused,
  onExpandedChange,
  onRestoreFocus,
  onTopRightChange,
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
  /** Whether cards occupy the pane's top-right corner, where the paper's toggle button lives. */
  onTopRightChange: (occupied: boolean) => void;
}) {
  const [controller] = useState(() => new DeckController(DEFAULT_EXECUTOR_CORNER));
  const [corner, setCorner] = useState<ExecutorCorner>(DEFAULT_EXECUTOR_CORNER);
  // Front first; `leaving` holds runs whose cards are springing out.
  const [deck, setDeck] = useState<DeckState>({ order: [], leaving: [] });
  // Runs whose worker sent its end batch (the card reports it; the center may still list them).
  const [ended, setEnded] = useState<ReadonlySet<string>>(() => new Set());
  // The expanded run: `open` until the user collapses it, then kept until it is back in its slot.
  const [panel, setPanel] = useState<PanelState>(null);
  // Where an expanded panel is rendered (a portal target over the whole pane).
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null);
  // The last snapshot of every run shown here, so a card whose run the store already dropped can
  // still render: while its panel stays open, and while it springs out.
  const lastSeen = useRef(new Map<string, ExecutorRunState>());

  const live = executorRunsForTask(runs, taskId);
  for (const run of live) lastSeen.current.set(run.runId, run);
  const liveIds = new Set(live.map((run) => run.runId));
  const panelRunId = panel?.runId ?? null;
  // A run stays in the deck while it goes by both signals; the expanded one until its panel closed.
  const present = live
    .filter((run) => retainAfterEnd({ live: true, ended: ended.has(run.runId), expanded: run.runId === panelRunId }))
    .map((run) => run.runId);
  if (panelRunId !== null && !liveIds.has(panelRunId) && lastSeen.current.has(panelRunId)) present.push(panelRunId);
  const reconciled = reconcileDeck(deck, present);
  if (reconciled) setDeck(reconciled);
  const current = reconciled ?? deck;

  const mountedIds = new Set([...current.order, ...current.leaving]);
  for (const id of [...lastSeen.current.keys()]) {
    if (!mountedIds.has(id) && !liveIds.has(id)) lastSeen.current.delete(id);
  }
  if ([...ended].some((id) => !liveIds.has(id) && !mountedIds.has(id))) {
    setEnded(new Set([...ended].filter((id) => liveIds.has(id) || mountedIds.has(id))));
  }
  const mounted = [...mountedIds]
    .map((id) => lastSeen.current.get(id))
    .filter((run): run is ExecutorRunState => run !== undefined)
    .sort(byArrival);

  const panelOpen = panel?.open === true;
  useEffect(() => {
    onExpandedChange(panelOpen);
  }, [panelOpen, onExpandedChange]);

  const occupiesTopRight = (current.order.length > 0 && corner === "top-right") || panel !== null;
  useEffect(() => {
    onTopRightChange(occupiesTopRight);
  }, [occupiesTopRight, onTopRightChange]);

  const expand = useCallback((runId: string) => {
    setPanel((cur) => (cur && cur.runId !== runId ? cur : { runId, open: true }));
  }, []);

  const collapse = useCallback(() => {
    setPanel((cur) => (cur && cur.open ? { ...cur, open: false } : cur));
    onRestoreFocus();
  }, [onRestoreFocus]);

  // Next: the front card goes to the back. Previous: the back card comes to the front.
  const cycle = useCallback((step: 1 | -1) => {
    setDeck((cur) => {
      if (cur.order.length < 2) return cur;
      const order = [...cur.order];
      if (step > 0) order.push(order.shift()!);
      else order.unshift(order.pop()!);
      return { ...cur, order };
    });
  }, []);

  // Esc collapses the expanded panel: window capture phase, so it never reaches xterm.
  useEffect(() => {
    if (!panelOpen || !focused) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [panelOpen, focused, collapse]);

  // Hand the deck its runs after every render, before paint: a new card is placed before it shows.
  useLayoutEffect(() => {
    controller.setCallbacks({
      bringToFront: (runId) =>
        setDeck((cur) => {
          const index = cur.order.indexOf(runId);
          if (index <= 0) return cur;
          return { ...cur, order: [runId, ...cur.order.filter((id) => id !== runId)] };
        }),
      expand,
      cornerChanged: setCorner,
      gone: (runId) => setDeck((cur) => (cur.leaving.includes(runId) ? { ...cur, leaving: cur.leaving.filter((id) => id !== runId) } : cur)),
      panelClosed: (runId) => setPanel((cur) => (cur && cur.runId === runId && !cur.open ? null : cur)),
    });
    controller.sync({ order: current.order, leaving: current.leaving, panel });
  });

  if (mounted.length === 0) return null;

  // The counter shows the front card's place in arrival order.
  const arrival = mounted.filter((run) => current.order.includes(run.runId));
  const counter = current.order.length > 1 ? `${arrival.findIndex((run) => run.runId === current.order[0]) + 1}/${current.order.length}` : null;

  return (
    // Clips to the pane: a rubber-banded or tilted card never paints over a neighbouring pane.
    <div ref={controller.rootRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* The deck: above the terminal, below the paper, the ⌘F box and secret requests (z-30);
          while a panel is out it rises to the paper's level (z-40), still under the paper's button. */}
      <div ref={controller.deckRef} className={cn("group/deck absolute inset-0", panel ? "z-40" : "z-30")}>
        {mounted.map((run) => {
          const runId = run.runId;
          const role: CardRole = current.order[0] === runId ? "front" : current.order.includes(runId) ? "back" : "leaving";
          return (
            <ExecutorRunCard
              key={runId}
              run={run}
              live={liveIds.has(runId)}
              client={client}
              controller={controller}
              role={role}
              counter={role === "front" ? counter : null}
              expanded={panelOpen && panel?.runId === runId}
              panelSlot={panelSlot}
              onExpand={() => expand(runId)}
              onCollapse={collapse}
              onEnded={() => setEnded((cur) => (cur.has(runId) ? cur : new Set([...cur, runId])))}
            />
          );
        })}
        {current.order.length > 1 && !panel ? <DeckSwitch controller={controller} onSlide={cycle} /> : null}
      </div>
      <div ref={setPanelSlot} className="pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

const SWITCH_BUTTON =
  "pointer-events-none absolute flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-foreground/6 text-muted-foreground opacity-0 backdrop-blur-sm transition-[opacity,translate,scale,background-color,color] duration-150 hover:bg-foreground/14 hover:text-foreground active:scale-90 group-data-[switch]/deck:pointer-events-auto group-data-[switch]/deck:translate-x-0 group-data-[switch]/deck:opacity-100";

/**
 * The switch arrows and the edge fades beneath them belong to the deck, not to a card: one overlay
 * the loop keeps exactly over the front slot, so they stay put while cards slide underneath and
 * hovering never flickers as the front card changes. The arrows sit on the log's vertical centre.
 * `‹` slides the deck left (the card peeking on the right comes to the front); `›` slides it right.
 */
function DeckSwitch({ controller, onSlide }: { controller: DeckController; onSlide: (step: 1 | -1) => void }) {
  return (
    <div ref={controller.overlayRef} className="pointer-events-none absolute left-0 top-0 z-[1100] w-80 origin-center">
      <div
        aria-hidden
        className="absolute left-px w-[30px] bg-gradient-to-r from-popover from-20% to-transparent opacity-0 transition-opacity duration-150 group-data-[switch]/deck:opacity-100"
        style={{ top: CARD_LOG_TOP, height: CARD_LOG_HEIGHT }}
      />
      <div
        aria-hidden
        className="absolute right-px w-[30px] bg-gradient-to-l from-popover from-20% to-transparent opacity-0 transition-opacity duration-150 group-data-[switch]/deck:opacity-100"
        style={{ top: CARD_LOG_TOP, height: CARD_LOG_HEIGHT }}
      />
      <Tooltip content="往左切换">
        <button className={cn(SWITCH_BUTTON, "left-1.5 -translate-x-0.5")} style={{ top: CARD_LOG_CENTER }} aria-label="往左切换" onClick={() => onSlide(1)}>
          <ChevronLeft className="size-3" strokeWidth={2.6} />
        </button>
      </Tooltip>
      <Tooltip content="往右切换">
        <button className={cn(SWITCH_BUTTON, "right-1.5 translate-x-0.5")} style={{ top: CARD_LOG_CENTER }} aria-label="往右切换" onClick={() => onSlide(-1)}>
          <ChevronRight className="size-3" strokeWidth={2.6} />
        </button>
      </Tooltip>
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
  controller,
  role,
  counter,
  expanded,
  panelSlot,
  onExpand,
  onCollapse,
  onEnded,
}: {
  run: ExecutorRunState;
  live: boolean;
  client: ExecutorCardClient;
  controller: DeckController;
  role: CardRole;
  /** `n/N` on the front card when the deck holds several runs. */
  counter: string | null;
  expanded: boolean;
  panelSlot: HTMLDivElement | null;
  onExpand: () => void;
  onCollapse: () => void;
  /** The worker's end batch arrived: the deck decides when the card leaves. */
  onEnded: () => void;
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

  // The card never removes itself: it reports the end and the deck springs it out (or keeps its
  // panel open until the user closes it).
  const hasEnd = transcript.end !== null;
  useEffect(() => {
    if (hasEnd) onEnded();
  }, [hasEnd, onEnded]);

  // The end can also arrive from the center alone (an old worker, a lost device): the run left the
  // live set without an `ended` event. Freeze the clock then.
  const ended = hasEnd || !live;
  const endedAt = transcript.end?.at;
  const elapsed = useElapsed(runClockStart(run), ended, endedAt);

  const stop = useCallback(() => {
    if (ended) return;
    if (!client.stopExecutorRun(run)) showToast({ body: "设备通道未连接，稍后再试", type: "error" });
  }, [client, run, ended, showToast]);

  const state: CardState = ended
    // An empty terminal = the center dropped the run before (or without) the worker's end frame.
    ? { kind: "ended", terminal: transcript.end?.terminal ?? "" }
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
      controller={controller}
      role={role}
      counter={counter}
      onStop={stop}
      onExpand={onExpand}
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
      ) : state.terminal === "" ? (
        <Check className="size-3 shrink-0 text-muted-foreground" aria-label={terminalLabel(state.terminal)} />
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
 * Collapsed: fixed size, rolling log; the deck moves it
 * ------------------------------------------------------------------ */

function CollapsedCard({
  run,
  state,
  elapsed,
  transcript,
  controller,
  role,
  counter,
  onStop,
  onExpand,
}: {
  run: ExecutorRunState;
  state: CardState;
  elapsed: string;
  transcript: TranscriptState;
  controller: DeckController;
  role: CardRole;
  counter: string | null;
  onStop: () => void;
  onExpand: () => void;
}) {
  const front = role === "front";
  const lines = rollingLog(transcript.fragments, ROLLING_LOG_KEPT);
  const placeholder = transcript.unsupported
    ? "这台设备的 daemon 版本过旧，看不到执行过程"
    : lines.length === 0
      ? state.kind === "queued"
        ? "等待主机接单…"
        : state.kind === "host-lost"
          ? "主机连接中断，等待它重连"
          : "还没有输出"
      : null;

  return (
    // Position, scale, rotation and opacity are written by the deck's loop: no React `style` here.
    <div
      ref={controller.cardRef(run.runId)}
      role="status"
      aria-label={`executor：${run.title}`}
      className={cn(
        "absolute left-0 top-0 w-80 select-none overflow-hidden rounded-lg border border-border bg-popover/95 text-popover-foreground backdrop-blur transition-shadow duration-200",
        front && "pointer-events-auto cursor-grab shadow-lg group-data-[lifted]/deck:cursor-grabbing group-data-[lifted]/deck:shadow-2xl",
        role === "back" && "pointer-events-auto cursor-pointer shadow-md",
        role === "leaving" && "pointer-events-none shadow-md",
      )}
      onPointerDown={(event) => controller.pointerDown(event.nativeEvent, event.currentTarget, run.runId)}
      onPointerMove={(event) => controller.pointerMove(event.nativeEvent)}
      onPointerUp={(event) => controller.pointerUp(event.nativeEvent)}
      onPointerCancel={(event) => controller.pointerCancel(event.nativeEvent)}
    >
      <div data-deck-part="content" className={cn(state.kind === "host-lost" && "[&>*]:opacity-70")}>
        <div className="relative grid h-9 grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-x-2 px-3">
          <span className="flex h-4 items-center justify-center">
            <StateGlyph state={state} />
          </span>
          <span className="truncate text-base font-medium leading-4">{run.title}</span>
          {/* Hovering the deck swaps these for the controls, which overlay them instead of
              reserving width while hidden. */}
          <div className={cn("flex items-center gap-2 transition-opacity duration-150", front && "group-data-[hover]/deck:opacity-0")}>
            <ModeBadge write={run.write} />
            <span className="min-w-7 text-right text-sm tabular-nums leading-4 text-muted-foreground">{elapsed}</span>
          </div>
          {front ? (
            <div className="pointer-events-none absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-gradient-to-r from-transparent to-popover to-[16px] pl-5 opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-data-[hover]/deck:pointer-events-auto group-data-[hover]/deck:opacity-100">
              {counter ? <span className="px-1 text-xs tabular-nums leading-4 text-muted-foreground">{counter}</span> : null}
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
          ) : null}
        </div>
        <RollingLog lines={lines} placeholder={placeholder} />
      </div>
    </div>
  );
}

/**
 * The collapsed card's log, at the card's full width, flowing top-down. Once full, the newest line
 * stays at the bottom: each new line slides the block up by one line and the oldest leave through
 * a fade at the top edge. While not yet full, a new line fades in below the previous one.
 */
function RollingLog({ lines, placeholder }: { lines: ExecutorLogLine[]; placeholder: string | null }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const seen = useRef<ReadonlySet<string> | null>(null);
  const clipped = placeholder === null && lines.length > CARD_LOG_LINES;

  // Plain CSS transitions on elements React gives no `style` (the global reduced-motion rule
  // shortens them to nothing).
  useLayoutEffect(() => {
    const list = listRef.current;
    const previous = seen.current;
    seen.current = new Set(placeholder === null ? lines.map((line) => line.key) : []);
    if (!list || previous === null || placeholder !== null) return;
    const added = lines.filter((line) => !previous.has(line.key)).length;
    if (added === 0) return;
    if (clipped) {
      list.style.transition = "none";
      list.style.transform = `translateY(${Math.min(added, CARD_LOG_LINES) * CARD_LOG_LINE_HEIGHT}px)`;
      void list.offsetHeight;
      list.style.transition = `transform 260ms ${LOG_EASE}`;
      list.style.transform = "translateY(0)";
      return;
    }
    const rows = Array.from(list.children).slice(-added) as HTMLElement[];
    for (const row of rows) {
      row.style.transition = "none";
      row.style.opacity = "0";
      row.style.transform = "translateY(4px)";
    }
    void list.offsetHeight;
    for (const row of rows) {
      row.style.transition = `opacity 220ms ${LOG_EASE}, transform 220ms ${LOG_EASE}`;
      row.style.opacity = "1";
      row.style.transform = "translateY(0)";
    }
  });

  return (
    // Fixed height (CARD_LOG_HEIGHT: four 18 px lines) and bottom gap (CARD_LOG_BOTTOM): content
    // changes never resize the card.
    <div
      data-deck-part="mini"
      className={cn(
        "mb-2.5 flex h-[72px] flex-col overflow-hidden px-3 text-sm leading-[18px]",
        clipped ? "justify-end [mask-image:linear-gradient(to_bottom,transparent,black_26px)]" : "justify-start",
      )}
    >
      {placeholder !== null ? (
        <p className="truncate text-muted-foreground">{placeholder}</p>
      ) : (
        <div ref={listRef}>
          {lines.map((line) => (
            <p
              key={line.key}
              className={cn(
                "h-[18px] truncate",
                line.kind === "command" && "font-mono text-foreground/85",
                line.kind === "prose" && "text-muted-foreground",
                line.kind === "error" && "text-destructive",
              )}
            >
              {line.text}
            </p>
          ))}
        </div>
      )}
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
