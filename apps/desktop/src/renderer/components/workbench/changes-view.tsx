import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, FileDiff, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import type { ChangedFile, CofluxClient } from "@coflux/client";
import { ChangesDiffPane, type ChangeFileData, type DiffPaneState } from "@/components/workbench/changes-diff-pane";
import { ChangesFileTree } from "@/components/workbench/changes-file-tree";
import { shouldRefreshChanges, type ChangesRefreshObservation } from "@/components/workbench/changes-refresh";
import { ancestorKeys, buildChangesTree, pickSelection, treeFileOrder } from "@/components/workbench/changes-tree";
import type { DiffMode } from "@/components/workbench/parse-diff";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import { usePaneWidth } from "@/components/workbench/use-pane-width";

type ChangesViewProps = {
  workspaceId: string;
  /** 变更 tab 是否处于激活态：仅激活时才拉取/重拉（plan 025 决策，非激活不拉取）。 */
  active: boolean;
  client: CofluxClient;
  defaultBranch: string;
  additions: number;
  deletions: number;
};

/* Plan 20260929-changes-file-tree: a file tree beside one file's diff. The list comes from one
 * device RPC; only the selected file's content is fetched, against the base the list returned. */

const TREE_WIDTH_KEY = "coflux_changes_tree_width";
const DIFF_MODE_KEY = "coflux_changes_diff_mode";

/** Large-diff guard, from the list entry, before anything is fetched: a file whose larger side or
 * changed-line count crosses either threshold waits for 「仍然加载」. */
const LARGE_FILE_BYTES = 1024 * 1024;
const LARGE_CHANGED_LINES = 3000;
/** The worker refuses sides above 6 MB (crates/worker/src/changes.rs `MAX_SIDE_BYTES`). */
const MAX_FILE_BYTES = 6 * 1024 * 1024;

type ListState = { base: string; files: ChangedFile[]; order: string[] };
type ListError = { message: string; daemonOutdated: boolean };
/** The last content request's outcome, tagged with what it was for. */
type ContentState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ready"; data: ChangeFileData };

function readDiffMode(): DiffMode {
  try {
    return localStorage.getItem(DIFF_MODE_KEY) === "inline" ? "inline" : "split";
  } catch {
    return "split";
  }
}

function persistDiffMode(mode: DiffMode) {
  try {
    localStorage.setItem(DIFF_MODE_KEY, mode);
  } catch {
    // Without localStorage the choice still holds for this session.
  }
}

function isRenameOnly(file: ChangedFile): boolean {
  return file.status === "renamed" && !file.binary && file.additions === 0 && file.deletions === 0;
}

function isLarge(file: ChangedFile): boolean {
  return file.size > LARGE_FILE_BYTES || file.additions + file.deletions > LARGE_CHANGED_LINES;
}

/** Whether the right pane shows fetched content for this file at all. */
function wantsContent(file: ChangedFile, forced: ReadonlySet<string>): boolean {
  if (file.binary || isRenameOnly(file) || file.size > MAX_FILE_BYTES) return false;
  return !isLarge(file) || forced.has(file.path);
}

function contentKey(base: string, file: ChangedFile): string {
  return `${base}\0${file.oldPath ?? ""}\0${file.path}`;
}

function daemonOutdatedMessage(): string {
  return "这台设备的 daemon 版本过旧，不支持查看变更。更新 daemon 后重试。";
}

export function ChangesView({ workspaceId, active, client, defaultBranch, additions, deletions }: ChangesViewProps) {
  const [list, setList] = useState<ListState | null>(null);
  const [listError, setListError] = useState<ListError | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [manualRevision, setManualRevision] = useState(0);
  // This component stays mounted per workspace (hidden, not unmounted), so the selection, the
  // folded folders and the forced large files survive closing and reopening the overlay.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [forced, setForced] = useState<ReadonlySet<string>>(() => new Set());
  const [content, setContent] = useState<ContentState | null>(null);
  /** Bumped after every list load and on retry: the current file is refetched even if unchanged. */
  const [contentRevision, setContentRevision] = useState(0);
  const [mode, setMode] = useState<DiffMode>(readDiffMode);
  const treeWidth = usePaneWidth({ storageKey: TREE_WIDTH_KEY, defaultWidth: 300, min: 180, max: 640 });

  const lastObservationRef = useRef<ChangesRefreshObservation | null>(null);
  const generationRef = useRef(0);
  /** Set synchronously while a list request is in flight, so the content effect of the same commit
   * does not fetch against the base that is about to be replaced. */
  const listInFlightRef = useRef(false);
  // A list load resolves after at least one commit, so these are current when it reads them.
  const selectedRef = useRef<string | null>(null);
  const listRef = useRef<ListState | null>(null);
  useEffect(() => {
    selectedRef.current = selectedPath;
    listRef.current = list;
  }, [selectedPath, list]);

  const tree = useMemo(() => buildChangesTree(list?.files ?? []), [list]);
  const selectedFile = useMemo(
    () => (list && selectedPath ? (list.files.find((file) => file.path === selectedPath) ?? null) : null),
    [list, selectedPath],
  );
  const totals = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const file of list?.files ?? []) {
      added += file.additions;
      deleted += file.deletions;
    }
    return { added, deleted };
  }, [list]);

  /** `opening`: the overlay was just opened. A vanished selection then falls back to the first file;
   * during a refresh while open it moves to its neighbour in tree order instead. */
  async function loadList(opening: boolean) {
    const generation = ++generationRef.current;
    listInFlightRef.current = true;
    setListLoading(true);
    try {
      const result = await client.listWorkspaceChanges(workspaceId);
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        setListError({ message: result.error, daemonOutdated: result.daemonOutdated });
        return;
      }
      const nextTree = buildChangesTree(result.files);
      const order = treeFileOrder(nextTree);
      const previousOrder = opening ? null : (listRef.current?.order ?? null);
      const nextSelected = pickSelection(previousOrder, selectedRef.current, order);
      setListError(null);
      setList({ base: result.base, files: result.files, order });
      setSelectedPath(nextSelected);
      if (nextSelected) {
        // Reveal a selection that sits in a folded folder.
        const ancestors = ancestorKeys(nextTree, nextSelected);
        setCollapsed((current) => (ancestors.some((key) => current.has(key)) ? new Set([...current].filter((key) => !ancestors.includes(key))) : current));
      }
      setContentRevision((revision) => revision + 1);
    } finally {
      if (generation === generationRef.current) {
        listInFlightRef.current = false;
        setListLoading(false);
      }
    }
  }

  useEffect(() => {
    const observation = { active, workspaceId, defaultBranch, additions, deletions, manualRevision };
    const previous = lastObservationRef.current;
    const shouldRefresh = shouldRefreshChanges(previous, observation);
    lastObservationRef.current = observation;
    if (!shouldRefresh) return;
    void loadList(!previous?.active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId, defaultBranch, additions, deletions, manualRevision]);

  const wantedKey = active && list && selectedFile && wantsContent(selectedFile, forced) ? contentKey(list.base, selectedFile) : null;

  // Only the selected file is fetched, and only while the view is active: a background workspace
  // never fetches. A refresh of the same file keeps its current content on screen until the new
  // one arrives, so the pane keeps its scroll position.
  useEffect(() => {
    if (!wantedKey || !list || !selectedFile || listInFlightRef.current) return;
    let cancelled = false;
    const key = wantedKey;
    setContent((current) => (current?.key === key && current.status === "ready" ? current : { key, status: "loading" }));
    void client.readWorkspaceChangeFile(workspaceId, list.base, selectedFile.path, selectedFile.oldPath).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const { ok: _ok, ...data } = result;
        setContent({ key, status: "ready", data });
      } else {
        setContent({ key, status: "error", message: result.daemonOutdated ? daemonOutdatedMessage() : result.error });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, contentRevision]);

  function requestRefresh() {
    setManualRevision((revision) => revision + 1);
  }

  function setExpanded(key: string, expanded: boolean) {
    setCollapsed((current) => {
      if (expanded === !current.has(key)) return current;
      const next = new Set(current);
      if (expanded) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function changeMode(next: DiffMode) {
    setMode(next);
    persistDiffMode(next);
  }

  function paneState(file: ChangedFile): DiffPaneState {
    if (file.binary) return { kind: "binary" };
    if (isRenameOnly(file)) return { kind: "rename-only", from: file.oldPath ?? "" };
    if (file.size > MAX_FILE_BYTES) return { kind: "large", canLoad: false };
    if (isLarge(file) && !forced.has(file.path)) return { kind: "large", canLoad: true };
    const key = list ? contentKey(list.base, file) : null;
    if (!content || content.key !== key) return { kind: "loading" };
    if (content.status === "ready") return { kind: "ready", data: content.data };
    if (content.status === "error") return { kind: "error", message: content.message };
    return { kind: "loading" };
  }

  if (listError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <AlertCircle className={listError.daemonOutdated ? "size-6 text-warning" : "size-6 text-destructive"} />
        <p className="max-w-sm text-sm text-muted-foreground">
          {listError.daemonOutdated ? daemonOutdatedMessage() : listError.message}
        </p>
        <Button label="重试" variant="secondary" size="sm" isLoading={listLoading} onClick={requestRefresh} />
      </div>
    );
  }

  if (list === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (list.files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <FileDiff className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">这个工作区还没有变更</p>
        <Button label="刷新" variant="ghost" size="sm" isLoading={listLoading} onClick={requestRefresh} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex shrink-0 flex-col border-r border-border bg-background" style={{ width: treeWidth.width }}>
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border pl-3 pr-1.5 text-sm text-muted-foreground">
          <span className="whitespace-nowrap">{list.files.length} 个文件</span>
          <span className="min-w-0 truncate font-mono tabular-nums">
            <span className="text-success">+{totals.added}</span> <span className="text-destructive">−{totals.deleted}</span>
          </span>
          <IconButton
            className="ml-auto"
            label="刷新变更"
            tooltip="刷新变更"
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            isLoading={listLoading}
            onClick={requestRefresh}
          />
        </div>
        <div className="min-h-0 flex-1">
          <ChangesFileTree
            nodes={tree}
            collapsed={collapsed}
            onSetExpanded={setExpanded}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            active={active}
          />
        </div>
        <SidebarResizeHandle control={treeWidth} />
      </div>
      <div className="min-w-0 flex-1">
        {selectedFile ? (
          <ChangesDiffPane
            file={selectedFile}
            state={paneState(selectedFile)}
            mode={mode}
            onModeChange={changeMode}
            onRetry={() => setContentRevision((revision) => revision + 1)}
            onForceLoad={() => setForced((current) => new Set(current).add(selectedFile.path))}
          />
        ) : null}
      </div>
    </div>
  );
}
