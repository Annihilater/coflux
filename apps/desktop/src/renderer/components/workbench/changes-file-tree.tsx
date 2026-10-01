import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import type { ChangedFile, ChangedFileStatus } from "@coflux/client";
import { FileTypeIcon, FolderIcon } from "@/components/workbench/changes-file-icon";
import { flattenTree, stepFile, type TreeNode, type TreeRow } from "@/components/workbench/changes-tree";
import { cn } from "@/lib/utils";

type ChangesFileTreeProps = {
  nodes: TreeNode[];
  collapsed: ReadonlySet<string>;
  onSetExpanded: (key: string, expanded: boolean) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Takes the keyboard when the view opens, if nothing else holds it. */
  active: boolean;
  /** The right-click menu of a file row (plan 20261001-changes-review-polish). */
  fileMenuItems: (file: ChangedFile) => ContextMenuOption[];
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
 */
export function ChangesFileTree({ nodes, collapsed, onSetExpanded, selectedPath, onSelect, active, fileMenuItems }: ChangesFileTreeProps) {
  const rows = useMemo(() => flattenTree(nodes, collapsed), [nodes, collapsed]);
  const [focusedKey, setFocusedKey] = useState<string | null>(selectedPath);
  const [hasFocus, setHasFocus] = useState(false);
  const [menuFile, setMenuFile] = useState<ChangedFile | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // The focus cursor follows a selection made elsewhere (restore on open, neighbour after refresh, F7).
  useEffect(() => {
    if (selectedPath) setFocusedKey(selectedPath);
  }, [selectedPath]);

  useEffect(() => {
    if (!focusedKey) return;
    const container = containerRef.current;
    const row = container?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(focusedKey)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedKey, rows]);

  // Opening the overlay hands the keyboard to the tree — including when it was opened from the
  // dock's 「变更」 button, which holds focus at that moment — unless the user is typing into
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
        if (child && child.parentKey === row.key) focusRow(child);
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
      aria-label="变更文件"
      tabIndex={0}
      className="h-full overflow-y-auto py-1 text-base outline-none"
      onKeyDown={onKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={() => setHasFocus(false)}
    >
      <ContextMenu label="文件操作" size="sm" items={menuFile ? fileMenuItems(menuFile) : []}>
        {rows.map((row) => {
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
                setMenuFile(row.file);
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
                  <FolderIcon name={row.name} open={row.expanded} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.name}</span>
                </>
              ) : (
                <FileRow name={row.name} file={row.file} />
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

function FileRow({ name, file }: { name: string; file: ChangedFile }) {
  return (
    <>
      {/* Aligns file icons with their folder's icon, past the folder chevron. */}
      <span className="-mr-0.5 size-3.5 shrink-0" />
      <FileTypeIcon path={file.path} />
      <span className={cn("min-w-0 flex-1 truncate", STATUS_TONE[file.status], file.status === "deleted" && "line-through")}>
        {name}
      </span>
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
