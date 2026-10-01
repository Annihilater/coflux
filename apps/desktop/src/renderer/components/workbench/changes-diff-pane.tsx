import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ChevronDown, ChevronUp, Columns2, Ellipsis, FileDiff, LoaderCircle, Plus, Rows2, Space, UnfoldVertical } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ChangedFile } from "@coflux/client";
import type { Annotation } from "@coflux/protocol";
import type { AgentTerminal } from "@/components/workbench/browser-annotations";
import { anchorSide, buildExcerpt, commentLocation, locateAnchor, type CommentSide, type LineRange } from "@/components/workbench/changes-comments";
import {
  CodeCommentCard,
  CommentsHandOffMenu,
  CommentsOutdatedHint,
  NewCommentCard,
  type CodeCommentsController,
} from "@/components/workbench/changes-comments-ui";
import { FileTypeIcon } from "@/components/workbench/changes-file-icon";
import { overlayEmphasis, wordEmphasis, type WordRange } from "@/components/workbench/changes-word-diff";
import { highlightLines, resolveLang, type HighlightToken } from "@/components/workbench/diff-highlight";
import {
  buildDiffRows,
  buildSegments,
  changeBlocks,
  CONTEXT_LINES,
  gapId,
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
  /** `outdated`: the daemon is too old for what was asked (shown as a hint, not a failure). */
  | { kind: "error"; message: string; outdated: boolean }
  /** `ignoreWhitespace`: the patch was produced with git's `-w`. */
  | { kind: "ready"; data: ChangeFileData; ignoreWhitespace: boolean };

/** The change F7 / ⇧F7 last moved to; `seq` changes on every move so the same index re-scrolls. */
export type CurrentChange = { index: number; seq: number };

type DiffPaneProps = {
  file: ChangedFile;
  state: DiffPaneState;
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespaceChange: (ignore: boolean) => void;
  onRetry: () => void;
  onForceLoad: () => void;
  /** Previous / next change, across files (the same as ⇧F7 / F7). */
  onStep: (delta: 1 | -1) => void;
  currentChange: CurrentChange | null;
  /** How many change blocks the shown content has; reported whenever the content changes. */
  onChangeCount: (count: number) => void;
  /** The header's 「⋯」 menu: the same file actions as the tree row's right-click menu. */
  menuItems: DropdownMenuOption[];
  /** The file's code comments (plan 20261001-changes-review-comments). */
  comments: CodeCommentsController;
  /** The header's 「交给 agent ▾」; null when the device's coflux has no code comments. */
  handOff: { agents: readonly AgentTerminal[]; disabled: boolean; onHandOff: (taskId: string) => void } | null;
};

/** Beyond this, a side is shown as plain text: tokenising it on the renderer thread would stall. */
const HIGHLIGHT_MAX_CHARS = 400_000;
/** Beyond this many changed line pairs, word emphasis is skipped: lines keep their plain tint. */
const WORD_EMPHASIS_MAX_PAIRS = 4000;
/** Rows per `content-visibility` block: the browser skips layout and paint of off-screen blocks. */
const ROW_BLOCK = 120;
// Must equal the rows' `leading-5`. Code renders at 12 px (`text-sm`), the terminal's content
// size: monospace looks larger than the UI sans at the same px, so it sits one step below body.
const ROW_HEIGHT_PX = 20;

export function ChangesDiffPane(props: DiffPaneProps) {
  const { file, state, mode, onModeChange, ignoreWhitespace, onIgnoreWhitespaceChange, onStep } = props;
  const slash = file.path.lastIndexOf("/");
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const directory = slash >= 0 ? file.path.slice(0, slash) : "";
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5 text-base">
        <FileTypeIcon path={file.path} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 max-w-full shrink-0 truncate">{name}</span>
          {directory ? <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{directory}</span> : null}
          {file.oldPath ? <span className="min-w-0 truncate text-sm text-muted-foreground">← {file.oldPath}</span> : null}
        </div>
        {!file.binary && (file.additions > 0 || file.deletions > 0) ? (
          <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">
            {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}{" "}
            {file.deletions > 0 ? <span className="text-destructive">−{file.deletions}</span> : null}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          {props.handOff ? <CommentsHandOffMenu agents={props.handOff.agents} disabled={props.handOff.disabled} onHandOff={props.handOff.onHandOff} /> : null}
          <HeaderButton label="上一个变更 ⇧F7" onClick={() => onStep(-1)}>
            <ChevronUp className="size-3.5" />
          </HeaderButton>
          <HeaderButton label="下一个变更 F7" onClick={() => onStep(1)}>
            <ChevronDown className="size-3.5" />
          </HeaderButton>
          <HeaderButton
            label={mode === "split" ? "并排显示，点击切换为内联" : "内联显示，点击切换为并排"}
            onClick={() => onModeChange(mode === "split" ? "inline" : "split")}
          >
            {mode === "split" ? <Columns2 className="size-3.5" /> : <Rows2 className="size-3.5" />}
          </HeaderButton>
          <HeaderButton
            label={ignoreWhitespace ? "忽略空白：开" : "忽略空白：关"}
            pressed={ignoreWhitespace}
            onClick={() => onIgnoreWhitespaceChange(!ignoreWhitespace)}
          >
            <Space className="size-3.5" />
          </HeaderButton>
          <FileMoreMenu items={props.menuItems} />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <PaneBody {...props} />
      </div>
    </div>
  );
}

/** The changes view's icon button: the same 24 px ghost square as the browser toolbar's. */
export function HeaderButton({
  label,
  pressed,
  disabled,
  className,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement="below">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35 disabled:hover:bg-transparent",
          pressed ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          className,
        )}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** 「⋯」: a DropdownMenu trigger, so its tooltip is a sibling (docs/design-guidelines.md). */
function FileMoreMenu({ items }: { items: DropdownMenuOption[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={setOpen}
        hasChevron={false}
        placement="below"
        alignment="end"
        menuWidth={200}
        items={items}
        button={{
          ref: anchorRef,
          label: "文件操作",
          icon: <Ellipsis className="size-3.5" />,
          isIconOnly: true,
          variant: "ghost",
          size: "sm",
          style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
        }}
      />
      <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content="更多" />
    </>
  );
}

function PaneBody({ file, state, mode, onRetry, onForceLoad, currentChange, onChangeCount, comments }: DiffPaneProps) {
  switch (state.kind) {
    case "loading":
      return (
        <Centered>
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </Centered>
      );
    case "error":
      return (
        <WithFileComments comments={comments}>
          <Centered>
            <AlertCircle className={state.outdated ? "size-6 text-warning" : "size-6 text-destructive"} />
            <p className="max-w-sm text-sm text-muted-foreground">{state.message}</p>
            <Button label="重试" variant="secondary" size="sm" onClick={onRetry} />
          </Centered>
        </WithFileComments>
      );
    case "binary":
      return (
        <WithFileComments comments={comments}>
          <Note>二进制文件，不显示内容</Note>
        </WithFileComments>
      );
    case "rename-only":
      return (
        <WithFileComments comments={comments}>
          <Note>重命名自 {state.from}，内容未变</Note>
        </WithFileComments>
      );
    case "large":
      return (
        <WithFileComments comments={comments}>
          <Centered>
            <FileDiff className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">变更较大</p>
            {state.canLoad ? (
              <Button label="仍然加载" variant="secondary" size="sm" onClick={onForceLoad} />
            ) : (
              <p className="text-sm text-muted-foreground">文件太大，不显示内容</p>
            )}
          </Centered>
        </WithFileComments>
      );
    case "ready":
      if (state.data.binary) {
        return (
          <WithFileComments comments={comments}>
            <Note>二进制文件，不显示内容</Note>
          </WithFileComments>
        );
      }
      // Keyed by path: switching files starts at the top with every gap folded, while a refresh of
      // the same file keeps the scroll position and the expanded gaps.
      return (
        <DiffBody
          key={file.path}
          file={file}
          data={state.data}
          ignoreWhitespace={state.ignoreWhitespace}
          mode={mode}
          currentChange={currentChange}
          onChangeCount={onChangeCount}
          comments={comments}
        />
      );
  }
}

/** A saved comment bound to the file's controller. */
function SavedComment({ annotation, comments, moved, location }: { annotation: Annotation; comments: CodeCommentsController; moved?: boolean; location?: string }) {
  return (
    <CodeCommentCard
      annotation={annotation}
      moved={moved}
      location={location}
      readOnly={comments.readOnly}
      onEdit={(text) => comments.edit(annotation, text)}
      onDelete={() => comments.remove(annotation, false)}
      onConfirm={() => comments.remove(annotation, true)}
      onReopen={(text) => comments.reopen(annotation, text)}
    />
  );
}

/** A state without lines to anchor to (binary, too large, an error, no change): the file's comments
 * are listed above it, each with its location. */
function WithFileComments({ comments, children }: { comments: CodeCommentsController; children: ReactNode }) {
  if (comments.annotations.length === 0) return <>{children}</>;
  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-muted/30 p-2">
        {comments.annotations.map((annotation) => (
          <SavedComment key={annotation.annotationId} annotation={annotation} comments={comments} location={commentLocation(annotation)} />
        ))}
      </div>
      <div className="min-h-40 flex-1">{children}</div>
    </div>
  );
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

/** `whitespaceOnly`: with whitespace ignored, the sides differ but git found no hunk. */
type Sides = { oldLines: string[]; newLines: string[]; segments: DiffSegment[]; whitespaceOnly: boolean };

/** Both sides as line arrays and the segments between them. The list's status wins over existence
 * flags: an added or untracked file has no old side, a deleted one no new side. */
function buildSides(file: ChangedFile, data: ChangeFileData, ignoreWhitespace: boolean): Sides {
  const hasOld = data.oldExists && file.status !== "added" && file.status !== "untracked";
  const hasNew = data.newExists && file.status !== "deleted";
  const oldLines = hasOld ? splitLines(data.oldContent) : [];
  const newLines = hasNew ? splitLines(data.newContent) : [];
  if (!hasOld || !hasNew) {
    return { oldLines, newLines, segments: buildSegments(oldLines.length, newLines.length, []), whitespaceOnly: false };
  }
  const hunks = parseHunkRanges(data.patch);
  if (hunks.length === 0 && data.oldContent !== data.newContent) {
    if (ignoreWhitespace) {
      // `-w` emptied the patch: every difference is whitespace. Not a race, so no fallback.
      return { oldLines, newLines, segments: buildSegments(oldLines.length, newLines.length, []), whitespaceOnly: true };
    }
    // The two sides differ but git reported no hunk (a race with the working tree): show a full
    // replacement rather than claiming nothing changed.
    return {
      oldLines,
      newLines,
      segments: [{ kind: "change", oldStart: 0, oldCount: oldLines.length, newStart: 0, newCount: newLines.length }],
      whitespaceOnly: false,
    };
  }
  return { oldLines, newLines, segments: buildSegments(oldLines.length, newLines.length, hunks), whitespaceOnly: false };
}

/** Word ranges per line of each side, for the line pairs of every change segment (the n-th old
 * line with the n-th new line), which is what both the split cells and inline mode pair up. */
function buildEmphasis(sides: Sides, ignoreWhitespace: boolean): { old: Map<number, WordRange[]>; new: Map<number, WordRange[]> } {
  const result = { old: new Map<number, WordRange[]>(), new: new Map<number, WordRange[]>() };
  let pairs = 0;
  for (const segment of sides.segments) {
    if (segment.kind === "change") pairs += Math.min(segment.oldCount, segment.newCount);
  }
  if (pairs > WORD_EMPHASIS_MAX_PAIRS) return result;
  for (const segment of sides.segments) {
    if (segment.kind !== "change") continue;
    const count = Math.min(segment.oldCount, segment.newCount);
    for (let offset = 0; offset < count; offset += 1) {
      const oldLine = segment.oldStart + offset;
      const newLine = segment.newStart + offset;
      const emphasis = wordEmphasis(sides.oldLines[oldLine] ?? "", sides.newLines[newLine] ?? "", ignoreWhitespace);
      if (!emphasis) continue;
      if (emphasis.old.length > 0) result.old.set(oldLine, emphasis.old);
      if (emphasis.new.length > 0) result.new.set(newLine, emphasis.new);
    }
  }
  return result;
}

/** A line of one side, as a key: `old:12`, `new:3` (0-based). */
function lineKey(side: CommentSide, line: number): string {
  return `${side}:${line}`;
}

/** The `[+]` gutter (plan 20261001-changes-review-comments): pressing a line number starts a
 * selection, moving over other line numbers of the same side extends it, releasing opens the
 * composer under its last line. */
type Gutter = {
  start: (side: CommentSide, line: number) => void;
  extend: (side: CommentSide, line: number) => void;
};

/** The line a row's gutter comments on: a deletion's base line, else the working-tree line. */
type GutterTarget = { side: CommentSide; line: number } | null;

function DiffBody({
  file,
  data,
  ignoreWhitespace,
  mode,
  currentChange,
  onChangeCount,
  comments,
}: {
  file: ChangedFile;
  data: ChangeFileData;
  ignoreWhitespace: boolean;
  mode: DiffMode;
  currentChange: CurrentChange | null;
  onChangeCount: (count: number) => void;
  comments: CodeCommentsController;
}) {
  const sides = useMemo(() => buildSides(file, data, ignoreWhitespace), [file, data, ignoreWhitespace]);
  const emphasis = useMemo(() => buildEmphasis(sides, ignoreWhitespace), [sides, ignoreWhitespace]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [tokens, setTokens] = useState<{ source: Sides; old: HighlightToken[][] | null; new: HighlightToken[][] | null } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** A gutter selection in progress, and the range a new comment is being written on. */
  const [drag, setDrag] = useState<{ side: CommentSide; from: number; to: number } | null>(null);
  const [draft, setDraft] = useState<{ side: CommentSide; range: LineRange } | null>(null);
  const dragRef = useRef(drag);
  useEffect(() => {
    dragRef.current = drag;
  });

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

  // Saved comments go under the line they end on, re-found by their text in the current content;
  // the ones whose lines are gone go on top, marked 「原位置已变化」.
  const placed = useMemo(() => {
    const byLine = new Map<string, Annotation[]>();
    const moved: Annotation[] = [];
    const ends: { side: CommentSide; line: number }[] = [];
    for (const annotation of comments.annotations) {
      const anchor = annotation.code;
      if (!anchor) continue;
      const side = anchorSide(anchor);
      const range = locateAnchor(side === "old" ? sides.oldLines : sides.newLines, anchor);
      if (!range) {
        moved.push(annotation);
        continue;
      }
      const key = lineKey(side, range.end);
      const list = byLine.get(key);
      if (list) list.push(annotation);
      else byLine.set(key, [annotation]);
      ends.push({ side, line: range.end });
    }
    return { byLine, moved, ends };
  }, [comments.annotations, sides]);

  // A folded stretch hiding a comment's (or the draft's) last line stays unfolded (the folded part
  // is what buildDiffRows hides: an equal stretch minus its context lines next to changes).
  const shownExpanded = useMemo(() => {
    const wanted = draft ? [...placed.ends, { side: draft.side, line: draft.range.end }] : placed.ends;
    if (wanted.length === 0) return expanded;
    const next = new Set(expanded);
    sides.segments.forEach((segment, index) => {
      if (segment.kind !== "equal") return;
      const head = index === 0 ? 0 : CONTEXT_LINES;
      const tail = index === sides.segments.length - 1 ? 0 : CONTEXT_LINES;
      for (const { side, line } of wanted) {
        const start = side === "old" ? segment.oldStart : segment.newStart;
        if (line >= start + head && line < start + segment.length - tail) next.add(gapId(segment));
      }
    });
    return next;
  }, [expanded, placed, draft, sides]);

  const rows = useMemo(() => buildDiffRows(sides.segments, mode, shownExpanded), [sides, mode, shownExpanded]);
  const blocks = useMemo(() => {
    const result: DiffRow[][] = [];
    for (let start = 0; start < rows.length; start += ROW_BLOCK) result.push(rows.slice(start, start + ROW_BLOCK));
    return result;
  }, [rows]);
  const changes = useMemo(() => changeBlocks(rows), [rows]);
  const changeCount = sides.whitespaceOnly ? 0 : changes.starts.length;

  // The view needs the count to step past the last change and to land on a file's first/last one.
  const onChangeCountRef = useRef(onChangeCount);
  useEffect(() => {
    onChangeCountRef.current = onChangeCount;
  });
  useEffect(() => {
    onChangeCountRef.current(changeCount);
  }, [changeCount, sides]);

  // Bring the current change into view whenever F7 / ⇧F7 moves to it (or re-selects it).
  const currentIndex = currentChange?.index ?? null;
  const currentSeq = currentChange?.seq ?? null;
  useEffect(() => {
    if (currentIndex === null || currentSeq === null) return;
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-change-start="${currentIndex}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [currentIndex, currentSeq, rows]);

  // Releasing anywhere ends a gutter selection and opens the composer for it.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    function onUp() {
      const current = dragRef.current;
      setDrag(null);
      if (current) setDraft({ side: current.side, range: { start: Math.min(current.from, current.to), end: Math.max(current.from, current.to) } });
    }
    function onCancel() {
      setDrag(null);
    }
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragging]);

  // Without the capability (or while the device is unreachable) there is no gutter and no composer.
  const canWrite = comments.canWrite;
  useEffect(() => {
    if (canWrite) return;
    // oxlint-disable-next-line react/set-state-in-effect -- an in-progress drag and an unsent draft are discarded when the write capability goes away; deriving them away instead would resurrect the draft when the device comes back
    setDrag(null);
    setDraft(null);
  }, [canWrite]);

  const top = (
    <>
      {comments.hint ? <CommentsOutdatedHint text={comments.hint} /> : null}
      {placed.moved.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-b border-border bg-muted/30 p-2">
          {placed.moved.map((annotation) => (
            <SavedComment key={annotation.annotationId} annotation={annotation} comments={comments} moved location={commentLocation(annotation)} />
          ))}
        </div>
      ) : null}
    </>
  );

  if (sides.whitespaceOnly || !hasChanges(sides.segments)) {
    const note = sides.whitespaceOnly ? "仅空白变化" : "内容未变";
    return (
      <WithFileComments comments={comments}>
        <Note>{note}</Note>
      </WithFileComments>
    );
  }

  const current = tokens?.source === sides ? tokens : null;
  const renderCode = (side: "old" | "new", line: number) => {
    const text = (side === "old" ? sides.oldLines : sides.newLines)[line] ?? "";
    const lineTokens = (side === "old" ? current?.old : current?.new)?.[line];
    const ranges = (side === "old" ? emphasis.old : emphasis.new).get(line);
    if (!text) return <span className="whitespace-pre-wrap wrap-anywhere"> </span>;
    const base: HighlightToken[] = lineTokens && lineTokens.length > 0 ? lineTokens : [{ content: text }];
    const pieces = ranges ? overlayEmphasis(base, ranges) : base.map((token) => ({ ...token, emphasis: false }));
    return (
      <span className="whitespace-pre-wrap wrap-anywhere">
        {pieces.map((piece, index) => (
          <span
            key={index}
            className={piece.emphasis ? (side === "old" ? "rounded-sm bg-destructive/30" : "rounded-sm bg-success/30") : undefined}
            style={piece.color ? { color: piece.color } : undefined}
          >
            {piece.content}
          </span>
        ))}
      </span>
    );
  };

  function expand(id: string) {
    setExpanded((previous) => new Set(previous).add(id));
  }

  const gutter: Gutter | null = canWrite
    ? {
        start: (side, line) => {
          setDraft(null);
          setDrag({ side, from: line, to: line });
        },
        extend: (side, line) => setDrag((value) => (value && value.side === side && value.to !== line ? { ...value, to: line } : value)),
      }
    : null;
  const selection = drag
    ? { side: drag.side, start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
    : draft
      ? { side: draft.side, start: draft.range.start, end: draft.range.end }
      : null;
  const isSelected = (target: GutterTarget) =>
    target !== null && selection !== null && selection.side === target.side && target.line >= selection.start && target.line <= selection.end;

  /** The cards under one line of one side: its saved comments, then the composer if the draft ends there. */
  const itemsFor = (side: CommentSide, line: number | null | undefined): ReactNode[] => {
    if (line === null || line === undefined) return [];
    const items: ReactNode[] = (placed.byLine.get(lineKey(side, line)) ?? []).map((annotation) => (
      <SavedComment key={annotation.annotationId} annotation={annotation} comments={comments} />
    ));
    if (draft && draft.side === side && draft.range.end === line) {
      const range = draft.range;
      items.push(
        <NewCommentCard
          key="draft"
          range={range}
          onCancel={() => setDraft(null)}
          onSubmit={async (text) => {
            const excerpt = buildExcerpt(side === "old" ? sides.oldLines : sides.newLines, range);
            const failure = await comments.create(side, range, excerpt, text);
            if (!failure) setDraft((value) => (value === draft ? null : value));
            return failure;
          }}
        />,
      );
    }
    return items;
  };

  return (
    <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden font-mono text-sm leading-5">
      {top}
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
                  className="flex w-full items-center gap-2 bg-muted/60 px-3 text-left text-sm leading-5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  onClick={() => expand(row.id)}
                >
                  <UnfoldVertical className="size-3" />
                  展开 {row.hidden} 行
                </button>
              );
            }
            const changeIndex = changes.blockOfRow[key] ?? -1;
            // The first row of each change block is what F7 scrolls to.
            const changeStart = changeIndex >= 0 && changes.starts[changeIndex] === key ? String(changeIndex) : undefined;
            const isCurrent = changeIndex >= 0 && changeIndex === currentIndex;
            if (row.kind === "split") {
              const leftTarget: GutterTarget = row.left ? { side: "old", line: row.left.line } : null;
              const rightTarget: GutterTarget = row.right ? { side: "new", line: row.right.line } : null;
              const leftItems = itemsFor("old", row.left?.line);
              const rightItems = itemsFor("new", row.right?.line);
              return (
                <Fragment key={key}>
                  <div className="relative flex" data-change-start={changeStart}>
                    {isCurrent ? <CurrentMarker /> : null}
                    <SplitHalf side="old" cell={row.left} renderCode={renderCode} gutter={gutter} target={leftTarget} selected={isSelected(leftTarget)} />
                    <SplitHalf side="new" cell={row.right} renderCode={renderCode} gutter={gutter} target={rightTarget} selected={isSelected(rightTarget)} />
                  </div>
                  {leftItems.length > 0 || rightItems.length > 0 ? (
                    <div className="flex border-y border-border bg-muted/30">
                      <div className="flex w-1/2 min-w-0 flex-col gap-1.5 border-r border-border p-2 empty:p-0">{leftItems}</div>
                      <div className="flex w-1/2 min-w-0 flex-col gap-1.5 p-2 empty:p-0">{rightItems}</div>
                    </div>
                  ) : null}
                </Fragment>
              );
            }
            const target: GutterTarget =
              row.type === "del" ? (row.oldLine !== null ? { side: "old", line: row.oldLine } : null) : row.newLine !== null ? { side: "new", line: row.newLine } : null;
            const items =
              row.type === "context"
                ? [...itemsFor("old", row.oldLine), ...itemsFor("new", row.newLine)]
                : row.type === "del"
                  ? itemsFor("old", row.oldLine)
                  : itemsFor("new", row.newLine);
            return (
              <Fragment key={key}>
                <div
                  className={cn("group/line relative flex", row.type === "del" && "bg-destructive/10", row.type === "add" && "bg-success/10")}
                  data-change-start={changeStart}
                >
                  {isCurrent ? <CurrentMarker /> : null}
                  {isSelected(target) ? <SelectedLine /> : null}
                  <LineNumber value={row.oldLine} tone={row.type === "del" ? "del" : null} gutter={gutter} target={target} plus />
                  <LineNumber value={row.newLine} tone={row.type === "add" ? "add" : null} gutter={gutter} target={target} />
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
                {items.length > 0 ? <div className="flex flex-col gap-1.5 border-y border-border bg-muted/30 py-2 pl-28 pr-3">{items}</div> : null}
              </Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The left-edge bar on the rows of the change F7 / ⇧F7 last moved to. */
function CurrentMarker() {
  return <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-0.5 bg-foreground/60" />;
}

/** The tint on lines selected for a new comment. */
function SelectedLine() {
  return <span aria-hidden className="pointer-events-none absolute inset-0 bg-(--color-accent)/15" />;
}

function SplitHalf({
  side,
  cell,
  renderCode,
  gutter,
  target,
  selected,
}: {
  side: "old" | "new";
  cell: { line: number; changed: boolean } | null;
  renderCode: (side: "old" | "new", line: number) => ReactNode;
  gutter: Gutter | null;
  target: GutterTarget;
  selected: boolean;
}) {
  const tone = cell?.changed ? (side === "old" ? "del" : "add") : null;
  return (
    <div
      className={cn(
        "group/line relative flex w-1/2 min-w-0",
        side === "old" && "border-r border-border",
        !cell && "bg-muted/40",
        tone === "del" && "bg-destructive/10",
        tone === "add" && "bg-success/10",
      )}
    >
      {selected ? <SelectedLine /> : null}
      {cell ? (
        <>
          <LineNumber value={cell.line} tone={tone} gutter={gutter} target={target} plus />
          <span className="min-w-0 flex-1 pl-2 pr-3">{renderCode(side, cell.line)}</span>
        </>
      ) : null}
    </div>
  );
}

/** A line number. With a gutter it is where a comment starts: `[+]` on hover (`plus`), press and
 * drag to select lines. */
function LineNumber({
  value,
  tone,
  gutter,
  target,
  plus,
}: {
  value: number | null;
  tone: "add" | "del" | null;
  gutter?: Gutter | null;
  target?: GutterTarget;
  plus?: boolean;
}) {
  const active = gutter && target ? { gutter, target } : null;
  return (
    <span
      className={cn(
        "relative w-12 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/60",
        tone === "add" && "text-success/80",
        tone === "del" && "text-destructive/80",
        active && "cursor-pointer",
      )}
      onPointerDown={
        active
          ? (event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              active.gutter.start(active.target.side, active.target.line);
            }
          : undefined
      }
      onPointerEnter={active ? () => active.gutter.extend(active.target.side, active.target.line) : undefined}
    >
      {active && plus ? (
        <span
          aria-hidden
          className="absolute left-1 top-0.5 hidden size-4 items-center justify-center rounded bg-(--color-accent) text-(--color-on-accent) group-hover/line:flex"
        >
          <Plus className="size-3" strokeWidth={3} />
        </span>
      ) : null}
      {value === null ? "" : value + 1}
    </span>
  );
}
