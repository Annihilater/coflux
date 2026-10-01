import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { AlertCircle, Check, FileDiff, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useToast } from "@astryxdesign/core/Toast";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { ChangedFile, ChangesOption, CofluxClient } from "@coflux/client";
import { desktop } from "@/config";
import { ChangesDiffPane, type ChangeFileData, type CurrentChange, type DiffPaneState } from "@/components/workbench/changes-diff-pane";
import { ChangesFileTree, isVisibleTypingTarget } from "@/components/workbench/changes-file-tree";
import { stepChange, type ChangeNavKind } from "@/components/workbench/changes-navigation";
import { setChangesPreference, useChangesPreferences, type ChangesScope } from "@/components/workbench/changes-preferences";
import { shouldRefreshChanges, type ChangesRefreshObservation } from "@/components/workbench/changes-refresh";
import { ancestorKeys, buildChangesTree, pickSelection, treeFileOrder } from "@/components/workbench/changes-tree";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import { useDesktopDaemonState } from "@/components/workbench/use-desktop-daemon";
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
 * device RPC; only the selected file's content is fetched, against the base the list returned.
 *
 * Plan 20261001-changes-review-polish adds the comparison scope (「分支全部改动」 / 「未提交」),
 * 忽略空白, F7 / ⇧F7 stepping across files, word emphasis (in the diff pane) and a file menu. What
 * the view newly needs — the workspace's device and path, this machine's own daemon — it reads
 * itself, so its contract with the workbench is unchanged. */

const TREE_WIDTH_KEY = "coflux_changes_tree_width";

/** Large-diff guard, from the list entry, before anything is fetched: a file whose larger side or
 * changed-line count crosses either threshold waits for 「仍然加载」. */
const LARGE_FILE_BYTES = 1024 * 1024;
const LARGE_CHANGED_LINES = 3000;
/** The worker refuses sides above 6 MB (crates/worker/src/changes.rs `MAX_SIDE_BYTES`). */
const MAX_FILE_BYTES = 6 * 1024 * 1024;

const SCOPE_LABEL: Record<ChangesScope, string> = {
  branch: "分支全部改动",
  uncommitted: "未提交",
};

const F7_SKIP_FOCUS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog';

/** `uncommitted`: which scope this list answers, so a list of the other scope is never shown. */
type ListState = { base: string; files: ChangedFile[]; order: string[]; uncommitted: boolean };
type ListError = { message: string; daemonOutdated: boolean; outdatedOption?: ChangesOption };
/** The last content request's outcome, tagged with what it was for. */
type ContentState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string; outdated: boolean }
  | { key: string; status: "ready"; data: ChangeFileData; ignoreWhitespace: boolean };
/** F7 / ⇧F7 position: the current change of `path`, or a landing still waiting for its content. */
type Cursor = { path: string; index: number | null; pending: "first" | "last" | null; seq: number };

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

/** The whitespace flag is part of the key: toggling it must not keep showing cached content. */
function contentKey(base: string, file: ChangedFile, ignoreWhitespace: boolean): string {
  return `${base}\0${file.oldPath ?? ""}\0${file.path}\0${ignoreWhitespace ? "w" : ""}`;
}

function daemonOutdatedMessage(): string {
  return "这台设备的 daemon 版本过旧，不支持查看变更。更新 daemon 后重试。";
}

function joinWorkspacePath(root: string, path: string): string {
  return root.endsWith("/") ? `${root}${path}` : `${root}/${path}`;
}

export function ChangesView({ workspaceId, active, client, defaultBranch, additions, deletions }: ChangesViewProps) {
  const { mode, scope, ignoreWhitespace } = useChangesPreferences();
  const uncommitted = scope === "uncommitted";
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
  const [cursor, setCursor] = useState<Cursor | null>(null);
  /** How many change blocks the diff pane shows for the content with this key. */
  const [blockCount, setBlockCount] = useState<{ key: string; count: number } | null>(null);
  const treeWidth = usePaneWidth({ storageKey: TREE_WIDTH_KEY, defaultWidth: 300, min: 180, max: 640 });
  const showToast = useToast();

  const workspacePath = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId)?.path ?? "");
  const workspaceDaemonId = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId)?.daemonId ?? "");
  const daemonState = useDesktopDaemonState(desktop);
  /** The workspace lives on this machine's own device: Finder and the default app can reach it. */
  const local = Boolean(workspaceDaemonId && daemonState?.daemonId && workspaceDaemonId === daemonState.daemonId);

  const lastObservationRef = useRef<ChangesRefreshObservation | null>(null);
  const generationRef = useRef(0);
  const seqRef = useRef(0);
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

  /** The list for the scope on screen; a list of the other scope reads as "still loading". */
  const shownList = list && list.uncommitted === uncommitted ? list : null;
  const tree = useMemo(() => buildChangesTree(shownList?.files ?? []), [shownList]);
  const fileByPath = useMemo(() => new Map((shownList?.files ?? []).map((file) => [file.path, file])), [shownList]);
  const selectedFile = selectedPath ? (fileByPath.get(selectedPath) ?? null) : null;
  const totals = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const file of shownList?.files ?? []) {
      added += file.additions;
      deleted += file.deletions;
    }
    return { added, deleted };
  }, [shownList]);

  /** `opening`: the overlay was just opened. A vanished selection then falls back to the first file;
   * during a refresh while open it moves to its neighbour in tree order instead. */
  async function loadList(opening: boolean, scopeUncommitted: boolean) {
    const generation = ++generationRef.current;
    listInFlightRef.current = true;
    setListLoading(true);
    try {
      const result = await client.listWorkspaceChanges(workspaceId, { uncommitted: scopeUncommitted });
      if (generation !== generationRef.current) return;
      if (!result.ok) {
        setListError({ message: result.error, daemonOutdated: result.daemonOutdated, outdatedOption: result.outdatedOption });
        return;
      }
      const nextTree = buildChangesTree(result.files);
      const order = treeFileOrder(nextTree);
      const previous = listRef.current;
      const previousOrder = opening || previous?.uncommitted !== scopeUncommitted ? null : (previous?.order ?? null);
      const nextSelected = pickSelection(previousOrder, selectedRef.current, order);
      setListError(null);
      setList({ base: result.base, files: result.files, order, uncommitted: scopeUncommitted });
      setSelectedPath(nextSelected);
      if (nextSelected) revealInTree(nextTree, nextSelected);
      setContentRevision((revision) => revision + 1);
    } finally {
      if (generation === generationRef.current) {
        listInFlightRef.current = false;
        setListLoading(false);
      }
    }
  }

  /** Unfolds the folders around a selection that sits in a folded one. */
  function revealInTree(nodes: ReturnType<typeof buildChangesTree>, path: string) {
    const ancestors = ancestorKeys(nodes, path);
    setCollapsed((current) => (ancestors.some((key) => current.has(key)) ? new Set([...current].filter((key) => !ancestors.includes(key))) : current));
  }

  useEffect(() => {
    const observation = { active, workspaceId, defaultBranch, additions, deletions, manualRevision, uncommitted };
    const previous = lastObservationRef.current;
    const shouldRefresh = shouldRefreshChanges(previous, observation);
    lastObservationRef.current = observation;
    if (!shouldRefresh) return;
    // A scope switch drops the other scope's error; its list is hidden by `shownList` until replaced.
    if (previous && previous.uncommitted !== uncommitted) setListError(null);
    void loadList(!previous?.active, uncommitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId, defaultBranch, additions, deletions, manualRevision, uncommitted]);

  const wantedKey =
    active && shownList && selectedFile && wantsContent(selectedFile, forced) ? contentKey(shownList.base, selectedFile, ignoreWhitespace) : null;

  // Only the selected file is fetched, and only while the view is active: a background workspace
  // never fetches. A refresh of the same file keeps its current content on screen until the new
  // one arrives, so the pane keeps its scroll position.
  useEffect(() => {
    if (!wantedKey || !shownList || !selectedFile || listInFlightRef.current) return;
    let cancelled = false;
    const key = wantedKey;
    const whitespace = ignoreWhitespace;
    setContent((current) => (current?.key === key && current.status === "ready" ? current : { key, status: "loading" }));
    void client
      .readWorkspaceChangeFile(workspaceId, shownList.base, selectedFile.path, selectedFile.oldPath, { ignoreWhitespace: whitespace })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          const { ok: _ok, ...data } = result;
          setContent({ key, status: "ready", data, ignoreWhitespace: whitespace });
        } else {
          const outdatedOption = Boolean(result.outdatedOption);
          setContent({
            key,
            status: "error",
            message: result.daemonOutdated && !outdatedOption ? daemonOutdatedMessage() : result.error,
            outdated: result.daemonOutdated,
          });
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

  function paneState(file: ChangedFile): DiffPaneState {
    if (file.binary) return { kind: "binary" };
    if (isRenameOnly(file)) return { kind: "rename-only", from: file.oldPath ?? "" };
    if (file.size > MAX_FILE_BYTES) return { kind: "large", canLoad: false };
    if (isLarge(file) && !forced.has(file.path)) return { kind: "large", canLoad: true };
    const key = shownList ? contentKey(shownList.base, file, ignoreWhitespace) : null;
    if (!content || content.key !== key) return { kind: "loading" };
    if (content.status === "ready") return { kind: "ready", data: content.data, ignoreWhitespace: content.ignoreWhitespace };
    if (content.status === "error") return { kind: "error", message: content.message, outdated: content.outdated };
    return { kind: "loading" };
  }

  /* ----- F7 / ⇧F7 ----- */

  const selectedState = selectedFile ? paneState(selectedFile) : null;
  const readyKey = selectedState?.kind === "ready" && content?.status === "ready" ? content.key : null;
  /** Change blocks of the selected file, or null while its content is not on screen. */
  const selectedCount = readyKey !== null && blockCount?.key === readyKey ? blockCount.count : null;
  const cursorHere = cursor && selectedPath !== null && cursor.path === selectedPath ? cursor : null;

  function navKind(path: string): ChangeNavKind {
    const file = fileByPath.get(path);
    if (!file || file.binary || isRenameOnly(file) || file.size > MAX_FILE_BYTES) return "skip";
    if (isLarge(file) && !forced.has(file.path)) return "stop";
    return "content";
  }

  function step(delta: 1 | -1) {
    if (!shownList) return;
    const index = cursorHere && cursorHere.pending === null ? cursorHere.index : null;
    const result = stepChange(shownList.order, selectedFile?.path ?? null, index, selectedCount, delta, navKind);
    if (result.kind === "none") return;
    seqRef.current += 1;
    if (result.kind === "change") {
      setCursor({ path: selectedPath!, index: result.index, pending: null, seq: seqRef.current });
      return;
    }
    setSelectedPath(result.path);
    revealInTree(tree, result.path);
    setCursor({ path: result.path, index: null, pending: result.land, seq: seqRef.current });
  }

  // A landing waits for the file's content: then it goes to the first or last change. A file with
  // nothing to step through (仅空白变化, 内容未变) stays selected and the next press moves past it.
  useEffect(() => {
    if (!cursorHere || cursorHere.pending === null || selectedCount === null) return;
    seqRef.current += 1;
    setCursor({
      path: cursorHere.path,
      index: selectedCount === 0 ? null : cursorHere.pending === "first" ? 0 : selectedCount - 1,
      pending: null,
      seq: seqRef.current,
    });
  }, [cursorHere, selectedCount]);

  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });

  // F7 works with the focus in the tree or the diff — and with a covered terminal still holding it
  // — but never while typing, or while a menu, dialog or the palette has the focus (the same skip
  // as the workbench's Esc listener). Capture phase, so a terminal never receives the key.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "F7" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const focused = document.activeElement;
      if (isVisibleTypingTarget(focused)) return;
      if (focused instanceof Element && focused.closest(F7_SKIP_FOCUS)) return;
      event.preventDefault();
      event.stopPropagation();
      stepRef.current(event.shiftKey ? -1 : 1);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active]);

  /* ----- File menu ----- */

  function fileMenuItems(file: ChangedFile): DropdownMenuOption[] {
    const absolute = workspacePath ? joinWorkspacePath(workspacePath, file.path) : "";
    const items: DropdownMenuOption[] = [
      { label: "复制路径", isDisabled: !absolute, onClick: () => desktop.writeClipboard(absolute) },
      { label: "复制相对路径", onClick: () => desktop.writeClipboard(file.path) },
    ];
    if (local && workspacePath) {
      const gone = file.status === "deleted";
      const report = (result: { ok: true } | { ok: false; error: string }) => {
        if (!result.ok) showToast({ body: result.error, type: "error" });
      };
      items.push(
        { type: "divider" },
        { label: "在 Finder 中显示", isDisabled: gone, onClick: () => void desktop.revealWorkspaceFile(workspacePath, file.path).then(report) },
        { label: "用默认应用打开", isDisabled: gone, onClick: () => void desktop.openWorkspaceFile(workspacePath, file.path).then(report) },
      );
    }
    return items;
  }

  /* ----- Render ----- */

  const scopeMenu = <ScopeMenu scope={scope} onChange={(next) => setChangesPreference("scope", next)} />;
  const refreshButton = (
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
  );

  if (listError || shownList === null || shownList.files.length === 0) {
    let body: ReactNode;
    if (listError) {
      const outdated = listError.daemonOutdated;
      body = (
        <>
          <AlertCircle className={outdated ? "size-6 text-warning" : "size-6 text-destructive"} />
          <p className="max-w-sm text-sm text-muted-foreground">
            {outdated && !listError.outdatedOption ? daemonOutdatedMessage() : listError.message}
          </p>
          <Button label="重试" variant="secondary" size="sm" isLoading={listLoading} onClick={requestRefresh} />
        </>
      );
    } else if (shownList === null) {
      body = <LoaderCircle className="size-5 animate-spin text-muted-foreground" />;
    } else {
      body = (
        <>
          <FileDiff className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{uncommitted ? "没有未提交的变更" : "这个工作区还没有变更"}</p>
        </>
      );
    }
    // The scope selector stays reachable in every list state: an empty 「未提交」 or a daemon too
    // old for it must not leave the user without the way back.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border pl-1.5 pr-1.5 text-sm text-muted-foreground">
          {scopeMenu}
          {refreshButton}
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">{body}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex shrink-0 flex-col border-r border-border bg-background" style={{ width: treeWidth.width }}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-1.5 pr-1.5 text-sm text-muted-foreground">
          {scopeMenu}
          <span className="shrink-0 whitespace-nowrap">{shownList.files.length} 个文件</span>
          <span className="min-w-0 truncate font-mono tabular-nums">
            <span className="text-success">+{totals.added}</span> <span className="text-destructive">−{totals.deleted}</span>
          </span>
          {refreshButton}
        </div>
        <div className="min-h-0 flex-1">
          <ChangesFileTree
            nodes={tree}
            collapsed={collapsed}
            onSetExpanded={setExpanded}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            active={active}
            fileMenuItems={fileMenuItems}
          />
        </div>
        <SidebarResizeHandle control={treeWidth} />
      </div>
      <div className="min-w-0 flex-1">
        {selectedFile && selectedState ? (
          <ChangesDiffPane
            file={selectedFile}
            state={selectedState}
            mode={mode}
            onModeChange={(next) => setChangesPreference("mode", next)}
            ignoreWhitespace={ignoreWhitespace}
            onIgnoreWhitespaceChange={(next) => setChangesPreference("ignoreWhitespace", next)}
            onRetry={() => setContentRevision((revision) => revision + 1)}
            onForceLoad={() => setForced((current) => new Set(current).add(selectedFile.path))}
            onStep={step}
            currentChange={cursorHere && cursorHere.index !== null ? ({ index: cursorHere.index, seq: cursorHere.seq } satisfies CurrentChange) : null}
            onChangeCount={(count) => {
              if (readyKey !== null) setBlockCount((current) => (current?.key === readyKey && current.count === count ? current : { key: readyKey, count }));
            }}
            menuItems={fileMenuItems(selectedFile)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** 「分支全部改动 ▾」: a DropdownMenu trigger, so its tooltip is a sibling (docs/design-guidelines.md). */
function ScopeMenu({ scope, onChange }: { scope: ChangesScope; onChange: (scope: ChangesScope) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const option = (value: ChangesScope, description: string): DropdownMenuOption => ({
    label: SCOPE_LABEL[value],
    description,
    icon: value === scope ? <Check className="size-3.5" /> : <span className="size-3.5" />,
    onClick: () => onChange(value),
  });
  return (
    <>
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={setOpen}
        placement="below"
        alignment="start"
        menuWidth={220}
        items={[option("branch", "默认分支的分叉点到工作区，含未跟踪文件"), option("uncommitted", "HEAD 到工作区，含未跟踪文件")]}
        button={{
          ref: anchorRef,
          label: SCOPE_LABEL[scope],
          variant: "ghost",
          size: "sm",
          style: { color: "var(--secondary-foreground)", height: 24, paddingInline: 6, gap: 4, flexShrink: 0 },
        }}
      />
      <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content="比较范围" />
    </>
  );
}
