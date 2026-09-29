import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, FileDiff, LoaderCircle, UnfoldVertical } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { ChangedFile } from "@coflux/client";
import { highlightLines, resolveLang, type HighlightToken } from "@/components/workbench/diff-highlight";
import {
  buildDiffRows,
  buildSegments,
  hasChanges,
  parseHunkRanges,
  splitLines,
  type DiffMode,
  type DiffRow,
  type DiffSegment,
} from "@/components/workbench/parse-diff";
import { cn } from "@/lib/utils";

/** One file's content as the worker returned it. */
export type ChangeFileData = {
  oldExists: boolean;
  newExists: boolean;
  oldContent: string;
  newContent: string;
  patch: string;
  binary: boolean;
};

/** What the right pane shows for the selected file; decided by the view from the list entry first. */
export type DiffPaneState =
  | { kind: "binary" }
  | { kind: "rename-only"; from: string }
  | { kind: "large"; canLoad: boolean }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ChangeFileData };

type DiffPaneProps = {
  file: ChangedFile;
  state: DiffPaneState;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onRetry: () => void;
  onForceLoad: () => void;
};

/** Beyond this, a side is shown as plain text: tokenising it on the renderer thread would stall. */
const HIGHLIGHT_MAX_CHARS = 400_000;
/** Rows per `content-visibility` block: the browser skips layout and paint of off-screen blocks. */
const ROW_BLOCK = 120;
const ROW_HEIGHT_PX = 20;

export function ChangesDiffPane({ file, state, mode, onModeChange, onRetry, onForceLoad }: DiffPaneProps) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.path}
          {file.oldPath ? <span className="ml-1.5 text-muted-foreground">← {file.oldPath}</span> : null}
        </span>
        {!file.binary && (file.additions > 0 || file.deletions > 0) ? (
          <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">
            {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}{" "}
            {file.deletions > 0 ? <span className="text-destructive">−{file.deletions}</span> : null}
          </span>
        ) : null}
        <SegmentedControl
          className="shrink-0"
          size="sm"
          label="差异显示方式"
          value={mode}
          onChange={(value) => onModeChange(value === "inline" ? "inline" : "split")}
        >
          <SegmentedControlItem value="split" label="并排" />
          <SegmentedControlItem value="inline" label="内联" />
        </SegmentedControl>
      </div>
      <div className="relative min-h-0 flex-1">
        <PaneBody file={file} state={state} mode={mode} onRetry={onRetry} onForceLoad={onForceLoad} />
      </div>
    </div>
  );
}

function PaneBody({
  file,
  state,
  mode,
  onRetry,
  onForceLoad,
}: Omit<DiffPaneProps, "onModeChange">) {
  switch (state.kind) {
    case "loading":
      return (
        <Centered>
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </Centered>
      );
    case "error":
      return (
        <Centered>
          <AlertCircle className="size-6 text-destructive" />
          <p className="max-w-sm text-sm text-muted-foreground">{state.message}</p>
          <Button label="重试" variant="secondary" size="sm" onClick={onRetry} />
        </Centered>
      );
    case "binary":
      return <Note>二进制文件，不显示内容</Note>;
    case "rename-only":
      return <Note>重命名自 {state.from}，内容未变</Note>;
    case "large":
      return (
        <Centered>
          <FileDiff className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">变更较大</p>
          {state.canLoad ? (
            <Button label="仍然加载" variant="secondary" size="sm" onClick={onForceLoad} />
          ) : (
            <p className="text-xs text-muted-foreground">文件太大，不显示内容</p>
          )}
        </Centered>
      );
    case "ready":
      if (state.data.binary) return <Note>二进制文件，不显示内容</Note>;
      // Keyed by path: switching files starts at the top with every gap folded, while a refresh of
      // the same file keeps the scroll position and the expanded gaps.
      return <DiffBody key={file.path} file={file} data={state.data} mode={mode} />;
  }
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 text-center">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Centered>
      <FileDiff className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </Centered>
  );
}

type Sides = { oldLines: string[]; newLines: string[]; segments: DiffSegment[] };

/** Both sides as line arrays and the segments between them. The list's status wins over existence
 * flags: an added or untracked file has no old side, a deleted one no new side. */
function buildSides(file: ChangedFile, data: ChangeFileData): Sides {
  const hasOld = data.oldExists && file.status !== "added" && file.status !== "untracked";
  const hasNew = data.newExists && file.status !== "deleted";
  const oldLines = hasOld ? splitLines(data.oldContent) : [];
  const newLines = hasNew ? splitLines(data.newContent) : [];
  if (!hasOld || !hasNew) return { oldLines, newLines, segments: buildSegments(oldLines.length, newLines.length, []) };
  const hunks = parseHunkRanges(data.patch);
  if (hunks.length === 0 && data.oldContent !== data.newContent) {
    // The two sides differ but git reported no hunk (a race with the working tree): show a full
    // replacement rather than claiming nothing changed.
    return {
      oldLines,
      newLines,
      segments: [{ kind: "change", oldStart: 0, oldCount: oldLines.length, newStart: 0, newCount: newLines.length }],
    };
  }
  return { oldLines, newLines, segments: buildSegments(oldLines.length, newLines.length, hunks) };
}

function DiffBody({ file, data, mode }: { file: ChangedFile; data: ChangeFileData; mode: DiffMode }) {
  const sides = useMemo(() => buildSides(file, data), [file, data]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [tokens, setTokens] = useState<{ source: Sides; old: HighlightToken[][] | null; new: HighlightToken[][] | null } | null>(null);

  // Each side is highlighted as a whole file, so multi-line strings and comments keep their context.
  useEffect(() => {
    let cancelled = false;
    const highlight = (lines: string[], path: string) => {
      const code = lines.join("\n");
      if (lines.length === 0 || code.length > HIGHLIGHT_MAX_CHARS) return Promise.resolve(null);
      return highlightLines(code, resolveLang(path)).catch(() => null);
    };
    void Promise.all([highlight(sides.oldLines, file.oldPath ?? file.path), highlight(sides.newLines, file.path)]).then(
      ([oldTokens, newTokens]) => {
        if (!cancelled) setTokens({ source: sides, old: oldTokens, new: newTokens });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sides, file.path, file.oldPath]);

  const rows = useMemo(() => buildDiffRows(sides.segments, mode, expanded), [sides, mode, expanded]);
  const blocks = useMemo(() => {
    const result: DiffRow[][] = [];
    for (let start = 0; start < rows.length; start += ROW_BLOCK) result.push(rows.slice(start, start + ROW_BLOCK));
    return result;
  }, [rows]);

  if (!hasChanges(sides.segments)) return <Note>内容未变</Note>;

  const current = tokens?.source === sides ? tokens : null;
  const renderCode = (side: "old" | "new", line: number) => {
    const text = (side === "old" ? sides.oldLines : sides.newLines)[line] ?? "";
    const lineTokens = (side === "old" ? current?.old : current?.new)?.[line];
    return (
      <span className="whitespace-pre-wrap wrap-anywhere">
        {lineTokens && lineTokens.length > 0
          ? lineTokens.map((token, index) => (
              <span key={index} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </span>
            ))
          : text || " "}
      </span>
    );
  };

  function expand(id: string) {
    setExpanded((previous) => new Set(previous).add(id));
  }

  return (
    <div className="absolute inset-0 overflow-y-auto overflow-x-hidden font-mono text-xs leading-5">
      {blocks.map((block, blockIndex) => (
        <div
          key={blockIndex}
          style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${block.length * ROW_HEIGHT_PX}px` }}
        >
          {block.map((row, index) => {
            const key = blockIndex * ROW_BLOCK + index;
            if (row.kind === "gap") {
              return (
                <button
                  key={`gap-${row.id}`}
                  type="button"
                  className="flex w-full items-center gap-2 bg-muted/60 px-3 text-left text-2xs leading-5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  onClick={() => expand(row.id)}
                >
                  <UnfoldVertical className="size-3" />
                  展开 {row.hidden} 行
                </button>
              );
            }
            if (row.kind === "split") {
              return (
                <div key={key} className="flex">
                  <SplitHalf side="old" cell={row.left} renderCode={renderCode} />
                  <SplitHalf side="new" cell={row.right} renderCode={renderCode} />
                </div>
              );
            }
            return (
              <div
                key={key}
                className={cn("flex", row.type === "del" && "bg-destructive/10", row.type === "add" && "bg-success/10")}
              >
                <LineNumber value={row.oldLine} tone={row.type === "del" ? "del" : null} />
                <LineNumber value={row.newLine} tone={row.type === "add" ? "add" : null} />
                <span
                  className={cn(
                    "w-4 shrink-0 select-none text-center",
                    row.type === "add" && "text-success",
                    row.type === "del" && "text-destructive",
                  )}
                >
                  {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                </span>
                <span className="min-w-0 flex-1 pr-3">
                  {row.type === "del" ? renderCode("old", row.oldLine ?? 0) : renderCode("new", row.newLine ?? 0)}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SplitHalf({
  side,
  cell,
  renderCode,
}: {
  side: "old" | "new";
  cell: { line: number; changed: boolean } | null;
  renderCode: (side: "old" | "new", line: number) => ReactNode;
}) {
  const tone = cell?.changed ? (side === "old" ? "del" : "add") : null;
  return (
    <div
      className={cn(
        "flex w-1/2 min-w-0",
        side === "old" && "border-r border-border",
        !cell && "bg-muted/40",
        tone === "del" && "bg-destructive/10",
        tone === "add" && "bg-success/10",
      )}
    >
      {cell ? (
        <>
          <LineNumber value={cell.line} tone={tone} />
          <span className="min-w-0 flex-1 pl-2 pr-3">{renderCode(side, cell.line)}</span>
        </>
      ) : null}
    </div>
  );
}

function LineNumber({ value, tone }: { value: number | null; tone: "add" | "del" | null }) {
  return (
    <span
      className={cn(
        "w-12 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/60",
        tone === "add" && "text-success/80",
        tone === "del" && "text-destructive/80",
      )}
    >
      {value === null ? "" : value + 1}
    </span>
  );
}
