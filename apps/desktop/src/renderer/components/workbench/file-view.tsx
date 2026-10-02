import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Binary, CircleAlert, FileWarning, FileX, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import type { CofluxClient, FileReadResult } from "@coflux/client";

import { FileTypeIcon } from "@/components/workbench/changes-file-icon";
import { HeaderButton, LINE_HIGHLIGHT_BACKGROUND as HIGHLIGHT_ROW_BACKGROUND, LINE_HIGHLIGHT_MARKER as HIGHLIGHT_MARKER } from "@/components/workbench/changes-diff-pane";
import { highlightLines, resolveLang, type HighlightToken } from "@/components/workbench/diff-highlight";
import type { FileRuntime, FileViewSnapshot, FileViewState } from "@/components/workbench/file-runtime";
import { cn } from "@/lib/utils";

/**
 * A file tab's body (plan 20261001-terminal-file-tab): one workspace file, read-only, with line
 * numbers and the changes view's shiki theme; text is selectable and copyable.
 *
 * It follows the file on disk while it can matter: a conditional read (the last revision) every
 * POLL_INTERVAL_MS while the tab is on screen, the window has focus and the device is online — the
 * daemon's `online` flag, never inferred from a failed or slow read — and once immediately whenever
 * that becomes true (re-activated, window focused, reconnected). A not-modified answer changes
 * nothing on screen; an update keeps the scroll position.
 *
 * Rows have a fixed height and never wrap, so large files are windowed in-repo: up to
 * FULL_RENDER_MAX_LINES every row is in the DOM (in content-visibility blocks, so a selection can
 * span the whole file); beyond it only the rows near the viewport are. Highlighting runs only below
 * the size limits the changes view uses; above them the text is plain.
 */

const ROW_HEIGHT_PX = 20; // `leading-5`, 12 px code (`text-sm`) as in the changes view
const POLL_INTERVAL_MS = 1500;
const HIGHLIGHT_MAX_CHARS = 400_000;
const FULL_RENDER_MAX_LINES = 5000;
const ROW_BLOCK = 120;
const OVERSCAN_ROWS = 40;
/** git's binary heuristic: a NUL among the first 8000 characters. */
const BINARY_SNIFF_CHARS = 8000;
const OUTDATED_MESSAGE = "这台设备的 daemon 版本过旧，不支持查看文件。更新 daemon 后重试。";

type FileViewProps = {
  runtime: FileRuntime;
  client: CofluxClient;
  tabId: string;
  /** Its group's active tab in the selected workspace, changes overlay closed. */
  onScreen: boolean;
};

/**
 * The read-only file body, shared by the file tab and the files view (plan
 * 20261002-workspace-files-view). It is driven by the file itself, never by a tab: the tab passes
 * its remembered snapshot and focus registration, the files view passes neither and so never
 * creates, prunes or persists a file-tab record.
 */
export type FileBodyProps = {
  client: CofluxClient;
  workspaceId: string;
  path: string;
  /** The 1-based line to land on and highlight. */
  line?: number;
  /** Bumped each time the file is opened again: the body jumps to `line` even when it did not change. */
  reveal: number;
  /** On screen: it polls the disk only then. */
  onScreen: boolean;
  /** What the body showed when it last unmounted (a file tab's memory). */
  snapshot?: FileViewSnapshot;
  /** Called on unmount with what is on screen, to be handed back as `snapshot`. */
  onUnmount?: (snapshot: FileViewSnapshot) => void;
  /** Registers keyboard focus into the body; returns the unregister function. */
  registerFocus?: (handlers: { focus: () => void }) => () => void;
  /** Controls placed in the header before 刷新. */
  headerExtra?: ReactNode;
};

/** Whether the window has focus. Focus moving into a built-in browser's <webview> blurs the page but not the window. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      // The blur fires before activeElement settles on the guest.
      window.setTimeout(() => setFocused(document.hasFocus() || document.activeElement?.tagName === "WEBVIEW"), 0);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  // A final newline ends the last line; it does not start an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isBinary(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_CHARS).includes("\0");
}

/** The next view state for a read result; null = nothing to change on screen. */
function nextState(current: FileViewState, result: FileReadResult): FileViewState | null {
  switch (result.kind) {
    case "notModified":
      return null;
    case "ok":
      return isBinary(result.content) ? { kind: "binary", revision: result.revision } : { kind: "text", content: result.content, revision: result.revision };
    case "tooLarge":
      return { kind: "tooLarge" };
    case "missing":
      return { kind: "missing" };
    case "notFile":
      return { kind: "notFile" };
    case "daemonOutdated":
      return { kind: "outdated" };
    case "failed":
      // A passing failure does not take away content already on screen.
      return current.kind === "text" || current.kind === "binary" ? null : { kind: "failed", error: result.error };
  }
}

export function FileView({ runtime, client, tabId, onScreen }: FileViewProps) {
  const record = useStore(runtime.tabs, (state) => state.tabs[tabId]);
  const reveal = useStore(runtime.tabs, (state) => state.reveals[tabId] ?? 0);
  // A remount (another tab was active, the tab moved group) starts from what was last shown.
  const [snapshot] = useState(() => runtime.snapshotOf(tabId));
  const remember = useCallback((next: FileViewSnapshot) => runtime.remember(tabId, next), [runtime, tabId]);
  const registerFocus = useCallback((handlers: { focus: () => void }) => runtime.register(tabId, handlers), [runtime, tabId]);
  return (
    <FileBody
      client={client}
      workspaceId={record?.workspaceId ?? ""}
      path={record?.path ?? ""}
      line={record?.line}
      reveal={reveal}
      onScreen={onScreen}
      snapshot={snapshot}
      onUnmount={remember}
      registerFocus={registerFocus}
    />
  );
}

export function FileBody({ client, workspaceId, path, line, reveal, onScreen, snapshot, onUnmount, registerFocus, headerExtra }: FileBodyProps) {
  const online = useStore(client.store, (state) => {
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    return workspace ? (state.daemons.find((item) => item.daemonId === workspace.daemonId)?.online ?? false) : false;
  });
  const windowFocused = useWindowFocused();

  const [view, setView] = useState<FileViewState>(() => snapshot?.state ?? { kind: "loading" });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [highlight, setHighlight] = useState<number | null>(() => (snapshot && (snapshot.reveal === reveal || line === undefined) ? snapshot.highlight : null));
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const [refreshing, setRefreshing] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(snapshot?.scrollTop ?? 0);
  // Where to put the viewport once text is rendered: a line to centre, or a scroll offset to restore.
  // Opened again while unmounted: a newer reveal with a line jumps; one without keeps the old place.
  const jumpOnMount = !(snapshot && snapshot.reveal === reveal) && line !== undefined;
  const pendingJumpRef = useRef<number | null>(jumpOnMount ? (line ?? null) : null);
  const pendingRestoreRef = useRef<number | null>(snapshot && !jumpOnMount ? snapshot.scrollTop : null);
  const handledRevealRef = useRef(reveal);
  // Bumped to place the viewport again (a jump requested while text is already on screen).
  const [viewportVersion, setViewportVersion] = useState(0);

  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  useEffect(
    () => () =>
      onUnmountRef.current?.({ state: viewRef.current, scrollTop: scrollTopRef.current, reveal: handledRevealRef.current, highlight: highlightRef.current }),
    [],
  );

  // Keyboard focus: the code when it is shown, else the view itself (a message state).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => registerFocus?.({ focus: () => (scrollRef.current ?? rootRef.current)?.focus({ preventScroll: true }) }), [registerFocus]);

  // Opened again (from a terminal, or revealed in the files view): jump to its line (even when the
  // line did not change).
  useEffect(() => {
    if (reveal === handledRevealRef.current) return;
    handledRevealRef.current = reveal;
    if (line !== undefined) {
      pendingJumpRef.current = line;
      setViewportVersion((version) => version + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const inFlightRef = useRef(false);
  const read = useCallback(
    async (force: boolean) => {
      if (!workspaceId || !path || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const current = viewRef.current;
        const known = !force && (current.kind === "text" || current.kind === "binary") ? current.revision : undefined;
        const result = await client.readWorkspaceFile(workspaceId, path, known);
        if (disposedRef.current) return;
        const next = nextState(viewRef.current, result);
        if (next) {
          viewRef.current = next;
          setView(next);
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [client, workspaceId, path],
  );
  const readRef = useRef(read);
  readRef.current = read;

  // Live follow. An outdated worker would resend the whole file every tick (it ignores the
  // revision), so that state only re-reads on re-activation, focus, reconnect or 刷新.
  const polling = Boolean(workspaceId && path) && onScreen && windowFocused && online && view.kind !== "outdated";
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: number | undefined;
    const loop = async () => {
      await readRef.current(false);
      if (!cancelled) timer = window.setTimeout(loop, POLL_INTERVAL_MS);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [polling]);
  // An outdated tab that comes back on screen (or online, or into focus) still asks once.
  useEffect(() => {
    if (view.kind === "outdated" && onScreen && windowFocused && online) void readRef.current(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, windowFocused, online]);

  async function refresh() {
    setRefreshing(true);
    try {
      await read(true);
    } finally {
      if (!disposedRef.current) setRefreshing(false);
    }
  }

  const content = view.kind === "text" ? view.content : "";
  const lines = useMemo(() => (view.kind === "text" ? splitLines(view.content) : []), [view]);
  const windowed = lines.length > FULL_RENDER_MAX_LINES;

  // Highlighting, off the render path. While new tokens are computed, a line keeps its old tokens
  // when its text did not change, so an agent's edit does not flash the whole file plain.
  const [tokens, setTokens] = useState<HighlightToken[][] | null>(null);
  const lang = resolveLang(path);
  useEffect(() => {
    if (!lang || windowed || content.length === 0 || content.length > HIGHLIGHT_MAX_CHARS) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    highlightLines(lines.join("\n"), lang).then(
      (result) => {
        if (!cancelled) setTokens(result);
      },
      () => {
        if (!cancelled) setTokens(null);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lang, windowed]);

  // Windowing: the rows near the viewport, from the scroll offset and the viewport's height.
  const [viewport, setViewport] = useState({ top: scrollTopRef.current, height: 0 });
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setViewport({ top: node.scrollTop, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [view.kind]);

  // Place the viewport once text is on screen: centre a requested line, else restore the offset.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || view.kind !== "text") return;
    const line = pendingJumpRef.current;
    if (line !== null) {
      pendingJumpRef.current = null;
      pendingRestoreRef.current = null;
      const target = Math.min(Math.max(line, 1), Math.max(lines.length, 1));
      node.scrollTop = Math.max(0, (target - 1) * ROW_HEIGHT_PX - (node.clientHeight - ROW_HEIGHT_PX) / 2);
      setHighlight(target);
    } else if (pendingRestoreRef.current !== null) {
      node.scrollTop = pendingRestoreRef.current;
      pendingRestoreRef.current = null;
    }
    scrollTopRef.current = node.scrollTop;
    setViewport({ top: node.scrollTop, height: node.clientHeight });
  }, [view.kind, lines, viewportVersion]);

  const gutterWidth = `calc(${String(Math.max(lines.length, 1)).length}ch + 1.5rem)`;

  function renderRow(index: number) {
    const text = lines[index] ?? "";
    const lineTokens = tokens?.[index];
    const matching = lineTokens && lineTokens.map((token) => token.content).join("") === text ? lineTokens : null;
    const highlighted = highlight === index + 1;
    return (
      <div
        key={index}
        className="relative flex"
        style={{ height: ROW_HEIGHT_PX, backgroundColor: highlighted ? HIGHLIGHT_ROW_BACKGROUND : undefined }}
      >
        <span
          className={cn(
            "sticky left-0 shrink-0 select-none bg-terminal pr-3 text-right tabular-nums",
            highlighted ? "text-foreground" : "text-muted-foreground/60",
          )}
          style={{ width: gutterWidth }}
        >
          {highlighted ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: HIGHLIGHT_MARKER }} /> : null}
          {index + 1}
        </span>
        <span className="whitespace-pre pr-4">
          {text.length === 0
            ? " "
            : matching
              ? matching.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))
              : text}
        </span>
      </div>
    );
  }

  function renderRows(): ReactNode {
    if (windowed) {
      const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT_PX) - OVERSCAN_ROWS);
      const last = Math.min(lines.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT_PX) + OVERSCAN_ROWS);
      const rows: ReactNode[] = [];
      for (let index = first; index < last; index++) rows.push(renderRow(index));
      return (
        <>
          <div style={{ height: first * ROW_HEIGHT_PX }} />
          {rows}
          <div style={{ height: (lines.length - last) * ROW_HEIGHT_PX }} />
        </>
      );
    }
    const blocks: ReactNode[] = [];
    for (let start = 0; start < lines.length; start += ROW_BLOCK) {
      const end = Math.min(lines.length, start + ROW_BLOCK);
      const rows: ReactNode[] = [];
      for (let index = start; index < end; index++) rows.push(renderRow(index));
      blocks.push(
        <div key={start} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${(end - start) * ROW_HEIGHT_PX}px` }}>
          {rows}
        </div>,
      );
    }
    return blocks;
  }

  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const directory = slash >= 0 ? path.slice(0, slash) : "";
  const hasContent = view.kind === "text";

  let body: ReactNode = null;
  if (!online && !hasContent) {
    body = <FileMessage icon={<Unplug className="size-6 text-muted-foreground" />} text="设备离线" />;
  } else if (view.kind === "loading") {
    body = <LoaderCircle className="size-5 animate-spin text-muted-foreground" />;
  } else if (view.kind === "tooLarge") {
    body = <FileMessage icon={<FileWarning className="size-6 text-muted-foreground" />} text="文件过大，无法预览" />;
  } else if (view.kind === "binary") {
    body = <FileMessage icon={<Binary className="size-6 text-muted-foreground" />} text="二进制文件，不预览" />;
  } else if (view.kind === "missing") {
    body = <FileMessage icon={<FileX className="size-6 text-muted-foreground" />} text="文件已不存在" />;
  } else if (view.kind === "notFile") {
    body = <FileMessage icon={<FileX className="size-6 text-muted-foreground" />} text="不是文件，无法预览" />;
  } else if (view.kind === "outdated") {
    body = <FileMessage icon={<CircleAlert className="size-6 text-warning" />} text={OUTDATED_MESSAGE} />;
  } else if (view.kind === "failed") {
    body = <FileMessage icon={<CircleAlert className="size-6 text-destructive" />} text={view.error} />;
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="absolute inset-0 flex flex-col bg-terminal outline-none">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pl-3 pr-1.5 text-base">
        <FileTypeIcon path={path} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 max-w-full shrink-0 truncate">{name}</span>
          {directory ? <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{directory}</span> : null}
        </div>
        {headerExtra}
        <HeaderButton label="刷新" disabled={refreshing || !online} onClick={() => void refresh()}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </HeaderButton>
      </div>
      {hasContent && !online ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 py-1.5 text-sm text-muted-foreground">
          <Unplug className="size-3.5 shrink-0" />
          <span className="truncate">设备离线，显示的是最后读到的内容</span>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {body ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">{body}</div>
        ) : (
          <div
            ref={scrollRef}
            tabIndex={-1}
            className="absolute inset-0 overflow-auto font-mono text-sm leading-5 outline-none"
            onScroll={(event) => {
              const node = event.currentTarget;
              scrollTopRef.current = node.scrollTop;
              if (windowed) setViewport({ top: node.scrollTop, height: node.clientHeight });
            }}
          >
            <div className="w-max min-w-full">{renderRows()}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function FileMessage({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      {icon}
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
