import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";

import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ChangedFile, ChangedFileStatus } from "@coflux/client";
import { FileTypeIcon, FolderIcon } from "@/components/workbench/changes-file-icon";
import { filterHighlights, flattenTree, stepFile, type FolderFold, type TreeNode, type TreeRow } from "@/components/workbench/changes-tree";
import { cn } from "@/lib/utils";

type ChangesFileTreeProps = {
  nodes: TreeNode[];
  /** Which folders are open (see FolderFold). */
  collapsed: FolderFold;
  onSetExpanded: (key: string, expanded: boolean) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Takes the keyboard when the view opens, if nothing else holds it. */
  active: boolean;
  /** The right-click menu of a file row (plan 20261001-changes-review-polish); `change` is unset
   * for an unchanged file of the whole-workspace tree. */
  fileMenuItems: (path: string, change: ChangedFile | undefined) => ContextMenuOption[];
  /** The tree's accessible name. */
  label?: string;
  /** Pending code comments per file path, shown as a badge (plan 20261001-changes-review-comments). */
  commentCounts?: ReadonlyMap<string, number>;
  /** The filter's terms, highlighted in row labels. */
  terms?: readonly string[];
  /** Lets the filter box hand the keyboard to the tree. */
  handle?: Ref<ChangesTreeHandle>;
};

export type ChangesTreeHandle = {
  /** Focuses the tree on the selected file if it is visible, else selects the first visible file. */
  enter: () => void;
};

export const STATUS_LETTER: Record<ChangedFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export const STATUS_TONE: Record<ChangedFileStatus, string> = {
  added: "text-success",
  untracked: "text-success",
  modified: "text-warning",
  renamed: "text-warning",
  deleted: "text-destructive",
};

/**
 * An editable element the user can see. A terminal's input textarea never counts: the overlay
 * covers the terminals, and a covered element still passes `checkVisibility()`.
 */
export function isVisibleTypingTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest("[data-terminal-host]")) return false;
  const editable =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(element.type)) ||
    element.isContentEditable;
  if (!editable) return false;
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : element.offsetParent !== null;
}

const NO_TERMS: readonly string[] = [];

const INDENT_PX = 12;
const BASE_PADDING_PX = 8;
/** Half the chevron's width: indent guides run under the chevron of the folder they belong to. */
const GUIDE_OFFSET_PX = 7;

/**
 * The changes tree. It is one focusable element (role="tree"); rows are not focusable, the
 * focused row is tracked here. ↑/↓ select the previous/next file, ←/→ collapse/expand a folder or
 * move between a folder and its children. Esc is never handled here: it belongs to the workbench,
 * which closes the overlay.
 *
 * Rows read like VS Code's SCM tree (plan 20261001-changes-review-polish): file-type and folder
 * icons from the vendored Catppuccin set, a thin indent guide per level, and a file menu on
 * right-click. One ContextMenu serves every row: a row's own handler records which file was
 * right-clicked before the event reaches the menu; folder rows stop it so no menu opens.
 *
 * The files view (plan 20261002-workspace-files-view) renders the whole workspace with it: unchanged
 * files are plain rows, ignored entries are dimmed, a folder with changes inside carries a dot, and a
 * folder listed on demand shows a note row while it loads or when it failed.
 */
export function ChangesFileTree({
  nodes,
  collapsed,
  onSetExpanded,
  selectedPath,
  onSelect,
  active,
  fileMenuItems,
  label = "变更文件",
  commentCounts,
  terms = NO_TERMS,
  handle,
}: ChangesFileTreeProps) {
  const rows = useMemo(() => flattenTree(nodes, collapsed), [nodes, collapsed]);
  const [focusedKey, setFocusedKey] = useState<string | null>(selectedPath);
  const [hasFocus, setHasFocus] = useState(false);
  const [menuFile, setMenuFile] = useState<{ path: string; change: ChangedFile | undefined } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // The focus cursor follows a selection made elsewhere (restore on open, neighbour after refresh, F7).
  // Adjusted during render when `selectedPath` changes, instead of in an effect.
  const [followedPath, setFollowedPath] = useState(selectedPath);
  if (selectedPath !== followedPath) {
    setFollowedPath(selectedPath);
    if (selectedPath) setFocusedKey(selectedPath);
  }

  useEffect(() => {
    if (!focusedKey) return;
    const container = containerRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(focusedKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedKey, rows]);

  // Opening the overlay hands the keyboard to the tree — including when it was opened from the
  // dock's 「文件」 button, which holds focus at that moment — unless the user is typing into
  // something still on screen.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (isVisibleTypingTarget(document.activeElement)) return;
      containerRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Closing it must not leave focus on a hidden element, or the terminal would not take it back.
  useEffect(() => {
    if (active) return;
    const container = containerRef.current;
    if (container && document.activeElement instanceof HTMLElement && container.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }, [active]);

  useImperativeHandle(handle, () => ({
    enter() {
      containerRef.current?.focus({ preventScroll: true });
      if (selectedPath && rows.some((row) => row.key === selectedPath)) {
        setFocusedKey(selectedPath);
        return;
      }
      const first = rows.find((row) => row.kind === "file");
      if (first) focusRow(first);
    },
  }));

  function focusRow(row: TreeRow) {
    setFocusedKey(row.key);
    if (row.kind === "file") onSelect(row.key);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const current = focusedKey ?? selectedPath;
    const index = current === null ? -1 : rows.findIndex((row) => row.key === current);
    const row = index >= 0 ? rows[index] : undefined;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const next = stepFile(rows, index >= 0 ? current : null, event.key === "ArrowDown" ? 1 : -1);
        if (next) {
          setFocusedKey(next);
          onSelect(next);
        }
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (!row) return;
        if (row.kind === "dir" && row.expanded) {
          onSetExpanded(row.key, false);
          return;
        }
        if (row.parentKey) setFocusedKey(row.parentKey);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (!row || row.kind !== "dir") return;
        if (!row.expanded) {
          onSetExpanded(row.key, true);
          return;
        }
        const child = rows[index + 1];
        if (child && child.parentKey === row.key && child.kind !== "note") focusRow(child);
        return;
      }
      case "Enter":
      case " ": {
        if (!row || row.kind !== "dir") return;
        event.preventDefault();
        onSetExpanded(row.key, !row.expanded);
        return;
      }
      default:
        return;
    }
  }

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      className="h-full overflow-y-auto py-1 text-base outline-none"
      onKeyDown={onKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={() => setHasFocus(false)}
    >
      <ContextMenu label="文件操作" size="sm" items={menuFile ? fileMenuItems(menuFile.path, menuFile.change) : []}>
        {rows.map((row) => {
          if (row.kind === "note") {
            return (
              <div
                key={`note:${row.key}`}
                role="treeitem"
                aria-level={row.depth + 1}
                className="relative flex h-6 cursor-default select-none items-center gap-1.5 pr-2"
                style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PX }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <IndentGuides depth={row.depth} />
                <span className="-mr-0.5 size-3.5 shrink-0" />
                <span className={cn("min-w-0 flex-1 truncate text-sm", row.error ? "text-destructive" : "text-muted-foreground")}>{row.text}</span>
              </div>
            );
          }
          const selected = row.kind === "file" && row.key === selectedPath;
          const focused = hasFocus && row.key === focusedKey;
          return (
            <div
              key={`${row.kind}:${row.key}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={row.kind === "file" ? selected : undefined}
              aria-expanded={row.kind === "dir" ? row.expanded : undefined}
              data-row-key={row.key}
              className={cn(
                "relative flex h-6 cursor-default select-none items-center gap-1.5 pr-2",
                selected ? (hasFocus ? "bg-accent" : "bg-accent/60") : "hover:bg-accent/40",
                focused && !selected && "ring-1 ring-inset ring-ring",
              )}
              style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PX }}
              onClick={() => {
                containerRef.current?.focus({ preventScroll: true });
                if (row.kind === "dir") {
                  setFocusedKey(row.key);
                  onSetExpanded(row.key, !row.expanded);
                } else {
                  focusRow(row);
                }
              }}
              onContextMenu={(event) => {
                if (row.kind === "dir") {
                  // No folder menu: keep the event from the ContextMenu around the rows.
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                containerRef.current?.focus({ preventScroll: true });
                setFocusedKey(row.key);
                setMenuFile({ path: row.key, change: row.file });
              }}
            >
              <IndentGuides depth={row.depth} />
              {row.kind === "dir" ? (
                <>
                  {row.expanded ? (
                    <ChevronDown className="-mr-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="-mr-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <FolderIcon name={row.name} open={row.expanded} className={row.ignored ? "opacity-50" : undefined} />
                  <span className={cn("min-w-0 flex-1 truncate", row.ignored && "text-muted-foreground opacity-70")}>
                    <Highlighted text={row.name} terms={terms} />
                  </span>
                  {row.dot ? (
                    <span aria-label="包含变更" className={cn("flex size-3 shrink-0 items-center justify-center", STATUS_TONE[row.dot])}>
                      <span className="size-1.5 rounded-full bg-current" />
                    </span>
                  ) : null}
                </>
              ) : row.file ? (
                <FileRow name={row.name} file={row.file} comments={commentCounts?.get(row.file.path) ?? 0} terms={terms} />
              ) : (
                <PlainFileRow name={row.name} path={row.key} ignored={Boolean(row.ignored)} terms={terms} />
              )}
            </div>
          );
        })}
      </ContextMenu>
    </div>
  );
}

/** One thin vertical line per ancestor level, like VS Code's tree indent guides. */
function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-border"
          style={{ left: BASE_PADDING_PX + level * INDENT_PX + GUIDE_OFFSET_PX }}
        />
      ))}
    </>
  );
}

function FileRow({ name, file, comments, terms }: { name: string; file: ChangedFile; comments: number; terms: readonly string[] }) {
  return (
    <>
      {/* Aligns file icons with their folder's icon, past the folder chevron. */}
      <span className="-mr-0.5 size-3.5 shrink-0" />
      <FileTypeIcon path={file.path} />
      <span className={cn("min-w-0 flex-1 truncate", STATUS_TONE[file.status], file.status === "deleted" && "line-through")}>
        <Highlighted text={name} terms={terms} />
      </span>
      {comments > 0 ? (
        <span
          aria-label={`${comments} 条待处理评论`}
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--color-accent) px-1 text-xs font-semibold leading-none tabular-nums text-(--color-on-accent)"
        >
          {comments}
        </span>
      ) : null}
      {!file.binary && (file.additions > 0 || file.deletions > 0) ? (
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums">
          {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}
          {file.additions > 0 && file.deletions > 0 ? " " : null}
          {file.deletions > 0 ? <span className="text-destructive">−{file.deletions}</span> : null}
        </span>
      ) : null}
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs", STATUS_TONE[file.status])}>
        {STATUS_LETTER[file.status]}
      </span>
    </>
  );
}

/** An unchanged file of the whole-workspace tree; an ignored one is dimmed. */
function PlainFileRow({ name, path, ignored, terms }: { name: string; path: string; ignored: boolean; terms: readonly string[] }) {
  return (
    <>
      <span className="-mr-0.5 size-3.5 shrink-0" />
      <FileTypeIcon path={path} className={ignored ? "opacity-50" : undefined} />
      <span className={cn("min-w-0 flex-1 truncate", ignored && "text-muted-foreground opacity-70")}>
        <Highlighted text={name} terms={terms} />
      </span>
    </>
  );
}

/** A row label with the filter's matches in bold and underlined: legible on any status tone and on
 * the selected row's background. */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  const ranges = terms.length > 0 ? filterHighlights(text, terms) : [];
  if (ranges.length === 0) return <>{text}</>;
  const pieces = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) pieces.push(text.slice(at, range.start));
    pieces.push(
      <span key={range.start} className="font-semibold underline underline-offset-2">
        {text.slice(range.start, range.end)}
      </span>,
    );
    at = range.end;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return <>{pieces}</>;
}

/**
 * The filter box above the tree. ↓ / Enter move into the tree; Esc clears a non-empty filter and
 * owns the key only then (`data-owns-escape`), so an empty box still lets Esc close the overlay.
 */
export function ChangesFilterInput({
  value,
  onChange,
  onEnterTree,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnterTree: () => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border pl-2.5 pr-1.5 text-sm">
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="筛选文件"
        aria-label="按文件名筛选"
        spellCheck={false}
        autoComplete="off"
        data-owns-escape={value ? "" : undefined}
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            onEnterTree();
          } else if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <Tooltip content="清除筛选 Esc" placement="below">
          <button
            type="button"
            aria-label="清除筛选"
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onChange("")}
          >
            <X className="size-3" />
          </button>
        </Tooltip>
      ) : (
        <kbd className="shrink-0 font-sans text-xs text-muted-foreground">⌘F</kbd>
      )}
    </div>
  );
}
