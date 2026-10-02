import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { AlertCircle, Check, FileDiff, FolderTree, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { useToast } from "@astryxdesign/core/Toast";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { AnnotationFailure, ChangedFile, ChangesOption, CofluxClient, FileIndexEntry, WhitespaceMode } from "@coflux/client";
import { AnnotationPutSchema, create, FsEntryKind, type Annotation, type AnnotationCodeSide } from "@coflux/protocol";
import { desktop } from "@/config";
import { cn } from "@/lib/utils";
import { agentTerminals, codeAnnotations, HAND_OFF_INSTRUCTION } from "@/components/workbench/browser-annotations";
import { annotationsModelFor, useWorkspaceAnnotations } from "@/components/workbench/browser-annotations-model";
import { useAnnotationUndo } from "@/components/workbench/browser-annotations-ui";
import {
  groupCommentsByFile,
  isPendingComment,
  pendingCommentCounts,
  sidePath,
  wireSide,
  type CommentSide,
  type LineRange,
} from "@/components/workbench/changes-comments";
import { OtherCommentsSection, type CodeCommentsController } from "@/components/workbench/changes-comments-ui";
import {
  ChangesDiffPane,
  FileMoreMenu,
  HeaderButton,
  type ChangeFileData,
  type CurrentChange,
  type DiffPaneState,
} from "@/components/workbench/changes-diff-pane";
import { ChangesFileTree, ChangesFilterInput, isVisibleTypingTarget, type ChangesTreeHandle } from "@/components/workbench/changes-file-tree";
import { stepChange, type ChangeNavKind } from "@/components/workbench/changes-navigation";
import { setChangesPreference, useChangesPreferences, type ChangesScope } from "@/components/workbench/changes-preferences";
import { shouldRefreshChanges, type ChangesRefreshObservation } from "@/components/workbench/changes-refresh";
import {
  ancestorKeys,
  buildChangesTree,
  filterTerms,
  flattenTree,
  matchesFilter,
  pickSelection,
  treeFileOrder,
  type TreeNode,
} from "@/components/workbench/changes-tree";
import { FileBody } from "@/components/workbench/file-view";
import {
  buildFilesTree,
  filterFilesTree,
  folderPrefixes,
  selfAndAncestors,
  treeHasFile,
  type FolderListing,
  type ListedEntry,
} from "@/components/workbench/files-tree";
import { SidebarResizeHandle } from "@/components/workbench/sidebar-resize-handle";
import { useDesktopDaemonState } from "@/components/workbench/use-desktop-daemon";
import { usePaneWidth } from "@/components/workbench/use-pane-width";

/** A file to reveal in the view (⌘+click on a terminal path); `seq` is new for every reveal, so
 * revealing the same file again jumps again. */
export type FileReveal = { path: string; line?: number; seq: number };

type ChangesViewProps = {
  workspaceId: string;
  /** 变更 tab 是否处于激活态：仅激活时才拉取/重拉（plan 025 决策，非激活不拉取）。 */
  active: boolean;
  client: CofluxClient;
  defaultBranch: string;
  additions: number;
  deletions: number;
  /** A directory workspace: the same tree without change decorations, 「仅变更」, the scope menu or dimming. */
  isDirWorkspace: boolean;
  /** The latest reveal the workbench asked for; the view decides how to show it. */
  reveal: FileReveal | null;
  /** 「在标签页中打开」: the file tab, the secondary route. */
  onOpenFileTab: (path: string, line?: number) => void;
};

/* Plan 20260929-changes-file-tree: a file tree beside one file's diff. The list comes from one
 * device RPC; only the selected file's content is fetched, against the base the list returned.
 *
 * Plan 20261001-changes-review-polish adds the comparison scope (「分支全部改动」 / 「未提交」),
 * the whitespace mode, F7 / ⇧F7 stepping across files, word emphasis (in the diff pane) and a file menu. What
 * the view newly needs — the workspace's device and path, this machine's own daemon — it reads
 * itself, so its contract with the workbench is unchanged.
 *
 * Plan 20261002-workspace-files-view turns it into the 「文件」 view: the tree lists the whole
 * workspace from the device's file index (fetched when the view opens and on 刷新), with the change
 * list overlaid by path on its own rhythm; folders the index does not descend into are listed on
 * demand. 「仅变更」 brings back the review tree. An unchanged file shows its content through the
 * file tab's body; a changed one its diff, switchable to the content. The workbench's contract grows
 * by the reveal request only. */

const TREE_WIDTH_KEY = "coflux_changes_tree_width";

/** Large-diff guard, from the list entry, before anything is fetched: a file whose larger side or
 * changed-line count crosses either threshold waits for 「仍然加载」. */
const LARGE_FILE_BYTES = 1024 * 1024;
const LARGE_CHANGED_LINES = 3000;
/** The worker refuses sides above 6 MB (crates/worker/src/changes.rs `MAX_SIDE_BYTES`). */
const MAX_FILE_BYTES = 6 * 1024 * 1024;
/** Most files a filter of the whole workspace renders: the tree renders every row. */
const FILTER_RESULT_CAP = 2000;

const SCOPE_LABEL: Record<ChangesScope, string> = {
  branch: "分支全部改动",
  uncommitted: "未提交",
};

const NO_FOLDERS: ReadonlySet<string> = new Set();
const NO_PATHS: readonly string[] = [];
const F7_SKIP_FOCUS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog';

const INDEX_OUTDATED_MESSAGE = "这台设备的 daemon 版本过旧，更新后才能浏览全部文件。";

/** `uncommitted`: which scope this list answers, so a list of the other scope is never shown. */
type ListState = { base: string; files: ChangedFile[]; order: string[]; uncommitted: boolean };
type ListError = { message: string; daemonOutdated: boolean; outdatedOption?: ChangesOption };
/** The last content request's outcome, tagged with what it was for. */
type ContentState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string; outdated: boolean }
  | { key: string; status: "ready"; data: ChangeFileData; whitespace: WhitespaceMode };
/** F7 / ⇧F7 position: the current change of `path`, or a landing still waiting for its content. */
type Cursor = { path: string; index: number | null; pending: "first" | "last" | null; seq: number };
/** The workspace's file index as last fetched. */
type IndexState =
  | { kind: "none" }
  | { kind: "ok"; entries: FileIndexEntry[] }
  /** Too large for one answer: every folder is listed on demand. */
  | { kind: "truncated" }
  /** The device's worker predates the index: only the review tree is available. */
  | { kind: "outdated" }
  | { kind: "error"; message: string };
/** One folder listed on demand; `gen` is the index fetch it belongs to (older ones are listed again). */
type ListingRecord = { gen: number; loading: boolean; entries?: ListedEntry[]; error?: string };

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
function contentKey(base: string, file: ChangedFile, whitespace: WhitespaceMode): string {
  return `${base}\0${file.oldPath ?? ""}\0${file.path}\0${whitespace}`;
}

function daemonOutdatedMessage(): string {
  return "这台设备的 daemon 版本过旧，不支持查看变更。更新 daemon 后重试。";
}

function joinWorkspacePath(root: string, path: string): string {
  return root.endsWith("/") ? `${root}${path}` : `${root}/${path}`;
}

/* Plan 20261001-changes-review-comments: comments on diff lines are workspace annotations with a
 * code anchor, read and written through the same annotations model as the browser panel (which
 * shows only page annotations). The view reads the model, the tasks and the agents itself. */

const NO_COMMENTS: readonly Annotation[] = [];

/** What a comment save sends: a new comment with its anchor, or an edit of the text only. */
type CommentPut = {
  annotationId?: string;
  comment: string;
  code?: { path: string; side: AnnotationCodeSide; startLine: number; endLine: number; excerpt: string; baseCommit: string };
};

const COMMENTS_OUTDATED_MESSAGE = "这台设备的 coflux 版本过旧，更新后才能在变更里写评论。";

function commentFailureText(result: AnnotationFailure, action: string): string {
  if (result.reason === "unsupported") return "该设备 coflux 版本过旧，不支持代码评论";
  if (result.reason === "unreachable") return `${action}失败：连不上这个工作区所在的设备`;
  return `${action}失败：${result.error}`;
}

export function ChangesView({
  workspaceId,
  active,
  client,
  defaultBranch,
  additions,
  deletions,
  isDirWorkspace,
  reveal,
  onOpenFileTab,
}: ChangesViewProps) {
  const { mode, scope, whitespace, onlyChanges } = useChangesPreferences();
  const uncommitted = scope === "uncommitted";
  const [list, setList] = useState<ListState | null>(null);
  const [listError, setListError] = useState<ListError | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [manualRevision, setManualRevision] = useState(0);
  // This component stays mounted per workspace (hidden, not unmounted), so the selection, the
  // folded folders and the forced large files survive closing and reopening the overlay.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  /** Folders folded while filtering, for the terms in `key` only: new terms start fully expanded,
   * and clearing the filter brings back `collapsed` untouched. */
  const [filterFolded, setFilterFolded] = useState<{ key: string; folded: ReadonlySet<string> }>(() => ({ key: "", folded: new Set() }));
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const treeHandleRef = useRef<ChangesTreeHandle | null>(null);
  const [forced, setForced] = useState<ReadonlySet<string>>(() => new Set());
  const [content, setContent] = useState<ContentState | null>(null);
  /** Bumped after every list load and on retry: the current file is refetched even if unchanged. */
  const [contentRevision, setContentRevision] = useState(0);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  /** How many change blocks the diff pane shows for the content with this key. */
  const [blockCount, setBlockCount] = useState<{ key: string; count: number } | null>(null);
  const treeWidth = usePaneWidth({ storageKey: TREE_WIDTH_KEY, defaultWidth: 300, min: 180, max: 640 });
  const showToast = useToast();

  /* ----- The whole workspace (plan 20261002-workspace-files-view) ----- */
  const [index, setIndex] = useState<IndexState>({ kind: "none" });
  const [indexLoading, setIndexLoading] = useState(false);
  /** Open folders of the whole-workspace tree, by full path; it starts folded. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, ListingRecord>>(() => new Map());
  const [listingGen, setListingGen] = useState(0);
  /** Files revealed from a terminal that neither the index nor a listing had. */
  const [extraPaths, setExtraPaths] = useState<readonly string[]>(NO_PATHS);
  /** A changed file shows its diff unless 「文件」 was chosen for it. */
  const [paneView, setPaneView] = useState<{ path: string; view: "diff" | "file" } | null>(null);
  /** Where a revealed file lands: a line of an unchanged file's content, or of a changed file's new side. */
  const [fileReveal, setFileReveal] = useState<FileReveal | null>(null);
  const [diffReveal, setDiffReveal] = useState<{ path: string; line: number; seq: number } | null>(null);
  /** The changed folders are opened once, on the first list; after that the fold state is the user's. */
  const seededRef = useRef(false);

  const workspacePath = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId)?.path ?? "");
  const workspaceDaemonId = useStore(client.store, (state) => state.workspaces.find((item) => item.id === workspaceId)?.daemonId ?? "");
  const daemonState = useDesktopDaemonState(desktop);
  /** The workspace lives on this machine's own device: Finder and the default app can reach it. */
  const local = Boolean(workspaceDaemonId && daemonState?.daemonId && workspaceDaemonId === daemonState.daemonId);

  /* ----- Code comments (plan 20261001-changes-review-comments) ----- */
  const annotationsModel = annotationsModelFor(client);
  const annotationsEntry = useWorkspaceAnnotations(client, workspaceId, active && !isDirWorkspace);
  const tasks = useStore(client.store, (state) => state.tasks);
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  const offerUndo = useAnnotationUndo(annotationsModel, workspaceId, commentFailureText);
  const loadedAnnotations = annotationsEntry.annotations;
  const codeComments = useMemo(() => (loadedAnnotations ? codeAnnotations(loadedAnnotations) : []), [loadedAnnotations]);
  /** Unreachable, refused or too old: comments show without actions. */
  const commentsReadOnly = annotationsEntry.status !== "ok";
  /** The device's coflux predates code comments (or annotations altogether). */
  const commentsOutdated = annotationsEntry.status === "unsupported" || annotationsEntry.codeComments === false;
  const canWriteComments = annotationsEntry.codeComments === true && !commentsReadOnly;

  const indexOutdated = index.kind === "outdated";
  /** The review tree: chosen, or the only one an old worker allows. Never in a directory workspace. */
  const changedOnly = !isDirWorkspace && (onlyChanges || indexOutdated);

  const lastObservationRef = useRef<ChangesRefreshObservation | null>(null);
  const generationRef = useRef(0);
  const seqRef = useRef(0);
  /** Set synchronously while a list request is in flight, so the content effect of the same commit
   * does not fetch against the base that is about to be replaced. */
  const listInFlightRef = useRef(false);
  // A list load resolves after at least one commit, so these are current when it reads them.
  const selectedRef = useRef<string | null>(null);
  const listRef = useRef<ListState | null>(null);
  const changedOnlyRef = useRef(changedOnly);
  useEffect(() => {
    selectedRef.current = selectedPath;
    listRef.current = list;
    changedOnlyRef.current = changedOnly;
  }, [selectedPath, list, changedOnly]);

  /** The list for the scope on screen; a list of the other scope reads as "still loading". */
  const shownList = isDirWorkspace ? null : list && list.uncommitted === uncommitted ? list : null;
  const changes = shownList?.files ?? [];
  const tree = useMemo(() => buildChangesTree(shownList?.files ?? []), [shownList]);
  const fileByPath = useMemo(() => new Map((shownList?.files ?? []).map((file) => [file.path, file])), [shownList]);

  const listingView = useMemo(() => {
    const view = new Map<string, FolderListing>();
    for (const [path, record] of listings) {
      view.set(path, record.entries ? { entries: record.entries } : record.error !== undefined ? { error: record.error } : { loading: true });
    }
    return view;
  }, [listings]);
  const filesTree = useMemo(() => {
    if (changedOnly || (index.kind !== "ok" && index.kind !== "truncated")) return null;
    return buildFilesTree({
      index: index.kind === "ok" ? index.entries : null,
      listings: listingView,
      changes: shownList?.files ?? [],
      extra: extraPaths,
      dimIgnored: !isDirWorkspace,
    });
  }, [changedOnly, index, listingView, shownList, extraPaths, isDirWorkspace]);

  /* ----- Filter ----- */
  const terms = useMemo(() => filterTerms(filter), [filter]);
  const termsKey = terms.join(" ");
  const filtering = terms.length > 0;
  const filteredFiles = useMemo(
    () => (filtering ? (shownList?.files ?? []).filter((file) => matchesFilter(file, terms)) : (shownList?.files ?? [])),
    [filtering, shownList, terms],
  );
  const filteredTree = useMemo(() => (filtering ? buildChangesTree(filteredFiles) : tree), [filtering, filteredFiles, tree]);
  const filteredWhole = useMemo(
    () => (filtering && filesTree ? filterFilesTree(filesTree.searchable, terms, FILTER_RESULT_CAP) : null),
    [filtering, filesTree, terms],
  );
  /** The nodes the tree shows right now. */
  const shownNodes: TreeNode[] = changedOnly ? filteredTree : filtering ? (filteredWhole?.nodes ?? []) : (filesTree?.nodes ?? []);
  /** The files F7 walks: changed files only, the filtered ones while filtering. */
  const navOrder = useMemo(() => {
    if (changedOnly) return filtering ? treeFileOrder(filteredTree) : (shownList?.order ?? []);
    if (filtering) return treeFileOrder(filteredWhole?.nodes ?? []).filter((path) => fileByPath.has(path));
    return shownList?.order ?? [];
  }, [changedOnly, filtering, filteredTree, filteredWhole, shownList, fileByPath]);
  const filterCollapsed = filterFolded.key === termsKey ? filterFolded.folded : NO_FOLDERS;
  const wholeFold = useMemo(() => ({ expanded }), [expanded]);

  const selectedFile = selectedPath ? (fileByPath.get(selectedPath) ?? null) : null;
  const groupedComments = useMemo(() => groupCommentsByFile(codeComments, shownList?.files ?? []), [codeComments, shownList]);
  const commentCounts = useMemo(() => pendingCommentCounts(groupedComments.byPath), [groupedComments]);
  const totals = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const file of changedOnly ? filteredFiles : (shownList?.files ?? [])) {
      added += file.additions;
      deleted += file.deletions;
    }
    return { added, deleted };
  }, [changedOnly, filteredFiles, shownList]);

  /** `opening`: the overlay was just opened. A vanished selection then falls back to the first file;
   * during a refresh while open it moves to its neighbour in tree order instead. Started only by the
   * refresh effect below, as an effect event: it reads the workspace and client of that render. */
  const loadList = useEffectEvent(async (opening: boolean, scopeUncommitted: boolean) => {
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
      const current = selectedRef.current;
      // The whole-workspace tree keeps any file selected; the review tree only a changed one.
      const nextSelected = changedOnlyRef.current || current === null ? pickSelection(previousOrder, current, order) : current;
      setListError(null);
      setList({ base: result.base, files: result.files, order, uncommitted: scopeUncommitted });
      setSelectedPath(nextSelected);
      if (!seededRef.current) {
        seededRef.current = true;
        const folders = new Set<string>();
        for (const file of result.files) for (const folder of folderPrefixes(file.path)) folders.add(folder);
        if (folders.size > 0) setExpanded((existing) => new Set([...existing, ...folders]));
      }
      // The whole-workspace folders open only for a selection that moved: a refresh keeps the user's folds.
      if (nextSelected) revealInTree(nextTree, nextSelected, nextSelected !== current);
      setContentRevision((revision) => revision + 1);
    } finally {
      if (generation === generationRef.current) {
        listInFlightRef.current = false;
        setListLoading(false);
      }
    }
  });

  /** Unfolds the folders around a selection that sits in a folded one: in the review tree (given)
   * and, with `whole`, in the whole-workspace tree. */
  function revealInTree(nodes: TreeNode[], path: string, whole = true) {
    const ancestors = ancestorKeys(nodes, path);
    setCollapsed((current) => (ancestors.some((key) => current.has(key)) ? new Set([...current].filter((key) => !ancestors.includes(key))) : current));
    if (!whole) return;
    const folders = folderPrefixes(path);
    setExpanded((current) => (folders.every((folder) => current.has(folder)) ? current : new Set([...current, ...folders])));
  }

  useEffect(() => {
    // A directory workspace has no change list.
    if (isDirWorkspace) return;
    const observation = { active, workspaceId, defaultBranch, additions, deletions, manualRevision, uncommitted };
    const previous = lastObservationRef.current;
    const shouldRefresh = shouldRefreshChanges(previous, observation);
    lastObservationRef.current = observation;
    if (!shouldRefresh) return;
    // A scope switch drops the other scope's error; its list is hidden by `shownList` until replaced.
    if (previous && previous.uncommitted !== uncommitted) setListError(null);
    void loadList(!previous?.active, uncommitted);
  }, [isDirWorkspace, active, workspaceId, defaultBranch, additions, deletions, manualRevision, uncommitted]);

  /* ----- The index and the folders listed on demand ----- */

  // The index is fetched when the view opens and on 刷新 only — never on a `+/−` tick — and only
  // while the whole-workspace tree is wanted.
  const [openSeq, setOpenSeq] = useState(0);
  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active && !wasActiveRef.current) setOpenSeq((value) => value + 1);
    wasActiveRef.current = active;
  }, [active]);
  const indexGenerationRef = useRef(0);
  const loadIndex = useEffectEvent(async () => {
    const generation = ++indexGenerationRef.current;
    setIndexLoading(true);
    // Folders listed for the previous index are listed again as they come into view.
    setListingGen((value) => value + 1);
    const result = await client.indexWorkspaceFiles(workspaceId);
    if (generation !== indexGenerationRef.current) return;
    setIndexLoading(false);
    if (result.kind === "ok") setIndex({ kind: "ok", entries: result.entries });
    else if (result.kind === "truncated") setIndex({ kind: "truncated" });
    else if (result.kind === "daemonOutdated") setIndex({ kind: "outdated" });
    else setIndex({ kind: "error", message: result.error });
  });
  const wantsIndex = active && (isDirWorkspace || !onlyChanges);
  const indexKey = `${openSeq}:${manualRevision}`;
  const fetchedIndexKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!wantsIndex || openSeq === 0 || fetchedIndexKeyRef.current === indexKey) return;
    fetchedIndexKeyRef.current = indexKey;
    void loadIndex();
  }, [wantsIndex, openSeq, indexKey]);

  const listingInFlightRef = useRef(new Set<string>());
  const loadListing = useEffectEvent(async (path: string, gen: number) => {
    const flightKey = `${gen}\0${path}`;
    if (listingInFlightRef.current.has(flightKey)) return;
    listingInFlightRef.current.add(flightKey);
    setListings((current) => new Map(current).set(path, { ...current.get(path), gen, loading: true }));
    try {
      const result = await client.listWorkspaceDirectory(workspaceId, path);
      setListings((current) => {
        const existing = current.get(path);
        if (existing && existing.gen > gen) return current;
        const next: ListingRecord = result.ok
          ? { gen, loading: false, entries: result.entries.map((entry) => ({ name: entry.name, dir: entry.kind === FsEntryKind.DIR })) }
          : { gen, loading: false, entries: existing?.entries, error: result.error || "读取文件夹失败" };
        return new Map(current).set(path, next);
      });
    } finally {
      listingInFlightRef.current.delete(flightKey);
    }
  });
  /** Lazy folders open on screen (and the root of a truncated index): these are listed. */
  const wantedListings = useMemo(() => {
    if (!filesTree || filtering) return NO_PATHS;
    const wanted: string[] = index.kind === "truncated" ? [""] : [];
    for (const row of flattenTree(filesTree.nodes, wholeFold)) {
      if (row.kind === "dir" && row.lazy && row.expanded) wanted.push(row.key);
    }
    return wanted;
  }, [filesTree, filtering, index.kind, wholeFold]);
  useEffect(() => {
    if (!active) return;
    for (const path of wantedListings) {
      const record = listings.get(path);
      if (record && (record.loading || record.gen >= listingGen)) continue;
      void loadListing(path, listingGen);
    }
  }, [active, wantedListings, listings, listingGen]);

  /** 「仅变更」 switched; entering the review tree with an unchanged file selected moves the
   * selection to the first changed one. */
  function setOnlyChanges(next: boolean) {
    setChangesPreference("onlyChanges", next);
    if (next && selectedPath !== null && !fileByPath.has(selectedPath)) {
      setFileReveal(null);
      setSelectedPath(shownList?.order[0] ?? null);
    }
  }

  /* ----- The right pane ----- */

  /** Content of a changed file was asked for instead of its diff (never for a deletion). */
  const showsFileOfChange = Boolean(
    selectedFile && selectedFile.status !== "deleted" && paneView?.path === selectedFile.path && paneView.view === "file",
  );
  const paneKind: "diff" | "file" | "none" = selectedFile ? (showsFileOfChange ? "file" : "diff") : selectedPath ? "file" : "none";

  const wantedKey =
    active && paneKind === "diff" && shownList && selectedFile && wantsContent(selectedFile, forced)
      ? contentKey(shownList.base, selectedFile, whitespace)
      : null;

  // Only the selected file is fetched, and only while the view is active: a background workspace
  // never fetches. A refresh of the same file keeps its current content on screen until the new
  // one arrives, so the pane keeps its scroll position.
  // The fetch reads the list, file and options of the render it runs in; it runs when the wanted key
  // changes or the content revision is bumped (after a list load, or a retry).
  const fetchContent = useEffectEvent((key: string): (() => void) | undefined => {
    if (!shownList || !selectedFile || listInFlightRef.current) return;
    let cancelled = false;
    setContent((current) => (current?.key === key && current.status === "ready" ? current : { key, status: "loading" }));
    void client
      .readWorkspaceChangeFile(workspaceId, shownList.base, selectedFile.path, selectedFile.oldPath, { whitespace })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          const { ok: _ok, ...data } = result;
          setContent({ key, status: "ready", data, whitespace });
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
  });
  useEffect(() => {
    if (!wantedKey) return;
    return fetchContent(wantedKey);
  }, [wantedKey, contentRevision]);

  function requestRefresh() {
    setManualRevision((revision) => revision + 1);
  }

  /** A file chosen in the tree: a pending landing for another file is dropped. */
  function selectFile(path: string) {
    if (path !== selectedPath) {
      setFileReveal(null);
      setDiffReveal(null);
    }
    setSelectedPath(path);
  }

  function setFolderExpanded(key: string, open: boolean) {
    if (filtering) {
      const folded = new Set(filterCollapsed);
      if (open) folded.delete(key);
      else folded.add(key);
      setFilterFolded({ key: termsKey, folded });
      return;
    }
    if (!changedOnly) {
      setExpanded((current) => {
        if (open === current.has(key)) return current;
        const next = new Set(current);
        // A compacted row stands for its whole chain of folders: opening it opens them all.
        if (open) for (const folder of selfAndAncestors(key)) next.add(folder);
        else next.delete(key);
        return next;
      });
      return;
    }
    setCollapsed((current) => {
      if (open === !current.has(key)) return current;
      const next = new Set(current);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function paneState(file: ChangedFile): DiffPaneState {
    if (file.binary) return { kind: "binary" };
    if (isRenameOnly(file)) return { kind: "rename-only", from: file.oldPath ?? "" };
    if (file.size > MAX_FILE_BYTES) return { kind: "large", canLoad: false };
    if (isLarge(file) && !forced.has(file.path)) return { kind: "large", canLoad: true };
    const key = shownList ? contentKey(shownList.base, file, whitespace) : null;
    if (!content || content.key !== key) return { kind: "loading" };
    if (content.status === "ready") return { kind: "ready", data: content.data, whitespace: content.whitespace };
    if (content.status === "error") return { kind: "error", message: content.message, outdated: content.outdated };
    return { kind: "loading" };
  }

  /* ----- F7 / ⇧F7 ----- */

  const selectedState = selectedFile && paneKind === "diff" ? paneState(selectedFile) : null;
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

  /** Unfolds the folders around `path` in the tree on screen. */
  function revealShown(path: string) {
    if (filtering) {
      const ancestors = ancestorKeys(shownNodes, path);
      if (ancestors.some((key) => filterCollapsed.has(key))) {
        setFilterFolded({ key: termsKey, folded: new Set([...filterCollapsed].filter((key) => !ancestors.includes(key))) });
      }
    } else {
      revealInTree(tree, path);
    }
  }

  function step(delta: 1 | -1) {
    if (!shownList) return;
    const index = cursorHere && cursorHere.pending === null ? cursorHere.index : null;
    const result = stepChange(navOrder, selectedFile?.path ?? null, index, selectedCount, delta, navKind);
    if (result.kind === "none") return;
    seqRef.current += 1;
    if (result.kind === "change") {
      setCursor({ path: selectedPath!, index: result.index, pending: null, seq: seqRef.current });
      return;
    }
    selectFile(result.path);
    revealShown(result.path);
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

  // ⌘F focuses the filter — also with a file's content on screen: it filters the tree, it does not
  // search the file. No terminal holds ⌘F while the overlay is open: the workbench focuses no
  // terminal pane then.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== "KeyF" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
      const input = filterInputRef.current;
      if (!input) return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest(F7_SKIP_FOCUS)) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      input.select();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active]);

  /* ----- Reveal (⌘+click on a terminal path) ----- */

  // A request is pending while its `seq` is not the handled one. It is applied once the view is open
  // and the change list of the scope on screen is there (it decides diff or content); a directory
  // workspace has none to wait for.
  const handledRevealSeqRef = useRef<number | null>(null);
  const applyReveal = useEffectEvent((target: FileReveal) => {
    const { path } = target;
    const change = fileByPath.get(path);
    // An unchanged file lives only in the whole-workspace tree. A worker too old for the index has
    // none: the file opens in a tab, as before this view existed.
    if (!change && indexOutdated && !isDirWorkspace) {
      onOpenFileTab(path, target.line);
      return;
    }
    if (!change && onlyChanges && !isDirWorkspace) setChangesPreference("onlyChanges", false);
    // A filter that hides the file is cleared; one that shows it keeps its folders open.
    if (filtering) {
      const filteredNodes = changedOnly && change ? filteredTree : changedOnly ? [] : (filteredWhole?.nodes ?? []);
      if (treeHasFile(filteredNodes, path)) {
        const ancestors = ancestorKeys(filteredNodes, path);
        if (ancestors.some((key) => filterCollapsed.has(key))) {
          setFilterFolded({ key: termsKey, folded: new Set([...filterCollapsed].filter((key) => !ancestors.includes(key))) });
        }
      } else {
        setFilter("");
      }
    }
    // The terminal already confirmed the file exists; a file the index does not know is added.
    if (!change) setExtraPaths((current) => (current.includes(path) ? current : [...current, path]));
    // Its folders open, lazy ones listed level by level as each comes into view.
    revealInTree(tree, path);
    setSelectedPath(path);
    setCursor(null);
    if (change) {
      setPaneView({ path, view: "diff" });
      setFileReveal(null);
      if (target.line !== undefined && change.status !== "deleted") {
        setDiffReveal({ path, line: target.line, seq: target.seq });
      } else {
        setDiffReveal(null);
        seqRef.current += 1;
        setCursor({ path, index: null, pending: "first", seq: seqRef.current });
      }
    } else {
      setDiffReveal(null);
      setFileReveal(target);
    }
  });
  const revealReady = active && (isDirWorkspace || shownList !== null || listError !== null);
  useEffect(() => {
    if (!reveal || !revealReady || handledRevealSeqRef.current === reveal.seq) return;
    handledRevealSeqRef.current = reveal.seq;
    applyReveal(reveal);
  }, [reveal, revealReady]);

  /* ----- File menu ----- */

  function fileMenuItems(path: string, change: ChangedFile | undefined): DropdownMenuOption[] {
    const absolute = workspacePath ? joinWorkspacePath(workspacePath, path) : "";
    const gone = change?.status === "deleted";
    const items: DropdownMenuOption[] = [
      { label: "在标签页中打开", isDisabled: gone, onClick: () => onOpenFileTab(path) },
      { type: "divider" },
      { label: "复制路径", isDisabled: !absolute, onClick: () => desktop.writeClipboard(absolute) },
      { label: "复制相对路径", onClick: () => desktop.writeClipboard(path) },
    ];
    if (local && workspacePath) {
      const report = (result: { ok: true } | { ok: false; error: string }) => {
        if (!result.ok) showToast({ body: result.error, type: "error" });
      };
      items.push(
        { type: "divider" },
        { label: "在 Finder 中显示", isDisabled: gone, onClick: () => void desktop.revealWorkspaceFile(workspacePath, path).then(report) },
        { label: "用默认应用打开", isDisabled: gone, onClick: () => void desktop.openWorkspaceFile(workspacePath, path).then(report) },
      );
    }
    return items;
  }

  /* ----- Code comments ----- */

  async function saveComment(annotation: CommentPut): Promise<string | null> {
    const result = await annotationsModel.change(workspaceId, { kind: "put", put: create(AnnotationPutSchema, { annotation }) });
    return result.ok ? null : commentFailureText(result, "保存");
  }

  function createComment(file: ChangedFile, base: string, side: CommentSide, range: LineRange, excerpt: string, comment: string) {
    return saveComment({
      comment,
      code: {
        path: sidePath(file, side),
        side: wireSide(side),
        startLine: range.start + 1,
        endLine: range.end + 1,
        excerpt,
        baseCommit: side === "old" ? base : "",
      },
    });
  }

  /** Only the text changes: an edit without an anchor keeps the stored one. */
  function editComment(annotation: Annotation, comment: string) {
    return saveComment({ annotationId: annotation.annotationId, comment });
  }

  /** Deletes a pending comment, or confirms a resolved one; both can be undone for a while. */
  async function removeComment(annotation: Annotation, confirming: boolean) {
    const result = await annotationsModel.change(workspaceId, { kind: "delete", annotationIds: [annotation.annotationId] });
    if (!result.ok) {
      showToast({ body: commentFailureText(result, confirming ? "确认" : "删除"), type: "error" });
      return;
    }
    offerUndo(confirming ? `已确认评论 #${annotation.number}` : `已删除评论 #${annotation.number}`, result.removedIds);
  }

  async function reopenComment(annotation: Annotation, comment: string): Promise<boolean> {
    const result = await annotationsModel.change(workspaceId, { kind: "reopen", annotationId: annotation.annotationId, comment });
    if (!result.ok) showToast({ body: commentFailureText(result, "重新打开"), type: "error" });
    return result.ok;
  }

  /** 「交给 agent」: the same instruction and path as the browser panel's. */
  async function handOff(taskId: string) {
    const terminal = agentTerminals(tasks, sessionAgents, workspaceId).find((item) => item.taskId === taskId);
    const result = await client.handOffAnnotations(workspaceId, taskId, HAND_OFF_INSTRUCTION);
    if (result.ok) {
      showToast({ body: `已交给「${terminal?.title || "终端"}」里的 ${terminal?.agent ?? "agent"}`, type: "info" });
      return;
    }
    if (result.held) showToast({ body: "这个终端正被另一台设备使用，没有输入。在那台设备上操作，或换一个终端。", type: "error" });
    else showToast({ body: commentFailureText(result, "交给 agent "), type: "error" });
  }

  function commentsFor(file: ChangedFile): CodeCommentsController {
    const base = shownList?.base ?? "";
    return {
      annotations: groupedComments.byPath.get(file.path) ?? NO_COMMENTS,
      canWrite: canWriteComments,
      hint: commentsOutdated ? COMMENTS_OUTDATED_MESSAGE : null,
      readOnly: commentsReadOnly,
      create: (side, range, excerpt, comment) => createComment(file, base, side, range, excerpt, comment),
      edit: editComment,
      remove: (annotation, confirming) => void removeComment(annotation, confirming),
      reopen: reopenComment,
    };
  }

  const handOffControl = annotationsEntry.codeComments
    ? {
        agents: agentTerminals(tasks, sessionAgents, workspaceId),
        disabled: commentsReadOnly || !codeComments.some(isPendingComment),
        onHandOff: (taskId: string) => void handOff(taskId),
      }
    : null;

  /** 「其他批注」: `readOnly` while there is no list to act against (device offline, list failed). */
  const otherComments = (comments: readonly Annotation[], readOnly: boolean) => (
    <OtherCommentsSection
      comments={comments}
      readOnly={readOnly}
      onDelete={(annotation) => void removeComment(annotation, false)}
      onConfirm={(annotation) => void removeComment(annotation, true)}
      className="max-h-[45%] shrink-0"
    />
  );

  /* ----- Render ----- */

  const scopeMenu = isDirWorkspace ? null : <ScopeMenu scope={scope} onChange={(next) => setChangesPreference("scope", next)} />;
  const onlyChangesToggle = isDirWorkspace ? null : (
    <OnlyChangesToggle on={changedOnly} locked={indexOutdated} onChange={setOnlyChanges} />
  );
  const loading = listLoading || (!changedOnly && indexLoading);
  const refreshButton = (
    <HeaderButton className="ml-auto" label={isDirWorkspace ? "刷新" : "刷新文件和变更"} disabled={loading} onClick={requestRefresh}>
      <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
    </HeaderButton>
  );
  /** An old worker leaves only the review tree; this says why 「仅变更」 cannot be left. */
  const outdatedHint = indexOutdated && !isDirWorkspace ? <TreeHint>{INDEX_OUTDATED_MESSAGE}</TreeHint> : null;

  /** A whole-pane state: the header keeps the scope menu and 「仅变更」 reachable. */
  const statePane = (body: ReactNode, footer: ReactNode = null) => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border pl-1.5 pr-1.5 text-sm text-muted-foreground">
        {scopeMenu}
        {onlyChangesToggle}
        {refreshButton}
      </div>
      {outdatedHint}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">{body}</div>
      {footer}
    </div>
  );
  const errorBody = (message: string, outdated: boolean) => (
    <>
      <AlertCircle className={outdated ? "size-6 text-warning" : "size-6 text-destructive"} />
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      {outdated ? null : <Button label="重试" variant="secondary" size="sm" isLoading={loading} onClick={requestRefresh} />}
    </>
  );
  const spinner = <LoaderCircle className="size-5 animate-spin text-muted-foreground" />;

  if (changedOnly) {
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
        body = spinner;
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
      // No tree and no diff: every code comment, read-only when the list could not be read.
      return statePane(body, listError || shownList !== null ? otherComments(codeComments, listError !== null || commentsReadOnly) : null);
    }
  } else if (isDirWorkspace) {
    if (index.kind === "outdated") return statePane(errorBody(INDEX_OUTDATED_MESSAGE, true));
    if (index.kind === "error") return statePane(errorBody(index.message, false));
    if (!filesTree) return statePane(spinner);
    if (filesTree.empty) return statePane(<EmptyWorkspace />);
  } else {
    // A worker that predates the changes RPCs predates the index too: its message is the list's.
    if (listError?.daemonOutdated && !listError.outdatedOption) {
      return statePane(errorBody(daemonOutdatedMessage(), true), otherComments(codeComments, true));
    }
    if (index.kind === "error") return statePane(errorBody(index.message, false));
    if (!filesTree) return statePane(spinner);
    if (filesTree.empty && changes.length === 0 && shownList !== null) return statePane(<EmptyWorkspace />, otherComments(codeComments, commentsReadOnly));
  }

  const fileCount = changedOnly ? (
    <span className="shrink-0 whitespace-nowrap">
      {filtering ? `${filteredFiles.length} / ${shownList?.files.length ?? 0}` : (shownList?.files.length ?? 0)} 个文件
    </span>
  ) : null;
  const totalsLabel =
    !isDirWorkspace && (changedOnly || totals.added > 0 || totals.deleted > 0) ? (
      <span className="min-w-0 truncate font-mono tabular-nums">
        <span className="text-success">+{totals.added}</span> <span className="text-destructive">−{totals.deleted}</span>
      </span>
    ) : null;

  let treeBody: ReactNode;
  if (filtering && (changedOnly ? filteredFiles.length === 0 : (filteredWhole?.shown ?? 0) === 0)) {
    treeBody = <p className="px-3 py-4 text-center text-sm text-muted-foreground">没有匹配的文件</p>;
  } else {
    treeBody = (
      <ChangesFileTree
        nodes={shownNodes}
        collapsed={filtering ? filterCollapsed : changedOnly ? collapsed : wholeFold}
        onSetExpanded={setFolderExpanded}
        selectedPath={selectedPath}
        onSelect={selectFile}
        active={active}
        fileMenuItems={fileMenuItems}
        label={changedOnly ? "变更文件" : "文件"}
        commentCounts={commentCounts}
        terms={terms}
        handle={treeHandleRef}
      />
    );
  }

  const switchControl =
    selectedFile && selectedFile.status !== "deleted" ? (
      <DiffFileSwitch
        value={showsFileOfChange ? "file" : "diff"}
        onChange={(view) => {
          setPaneView({ path: selectedFile.path, view });
          if (view === "file") setFileReveal(null);
        }}
      />
    ) : null;

  let pane: ReactNode = null;
  if (paneKind === "diff" && selectedFile && selectedState) {
    pane = (
      <ChangesDiffPane
        file={selectedFile}
        state={selectedState}
        mode={mode}
        onModeChange={(next) => setChangesPreference("mode", next)}
        whitespace={whitespace}
        onWhitespaceChange={(next) => setChangesPreference("whitespace", next)}
        onRetry={() => setContentRevision((revision) => revision + 1)}
        onForceLoad={() => setForced((current) => new Set(current).add(selectedFile.path))}
        onStep={step}
        currentChange={cursorHere && cursorHere.index !== null ? ({ index: cursorHere.index, seq: cursorHere.seq } satisfies CurrentChange) : null}
        onChangeCount={(count) => {
          if (readyKey !== null) setBlockCount((current) => (current?.key === readyKey && current.count === count ? current : { key: readyKey, count }));
        }}
        menuItems={fileMenuItems(selectedFile.path, selectedFile)}
        comments={commentsFor(selectedFile)}
        handOff={handOffControl}
        headerExtra={switchControl}
        revealLine={diffReveal && diffReveal.path === selectedFile.path ? { line: diffReveal.line, seq: diffReveal.seq } : null}
        onRevealed={(seq) => setDiffReveal((current) => (current?.seq === seq ? null : current))}
      />
    );
  } else if (paneKind === "file" && selectedPath) {
    const landing = fileReveal && fileReveal.path === selectedPath ? fileReveal : null;
    pane = (
      <div className="relative h-full">
        <FileBody
          key={selectedPath}
          client={client}
          workspaceId={workspaceId}
          path={selectedPath}
          line={landing?.line}
          reveal={landing?.seq ?? 0}
          onScreen={active}
          headerExtra={
            <div className="flex shrink-0 items-center gap-0.5">
              {switchControl}
              <FileMoreMenu items={fileMenuItems(selectedPath, selectedFile ?? undefined)} />
            </div>
          }
        />
      </div>
    );
  } else {
    pane = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FolderTree className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">选择一个文件查看内容</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex shrink-0 flex-col border-r border-border bg-background" style={{ width: treeWidth.width }}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-1.5 pr-1.5 text-sm text-muted-foreground">
          {scopeMenu}
          {onlyChangesToggle}
          {fileCount}
          {totalsLabel}
          {refreshButton}
        </div>
        {outdatedHint}
        {!changedOnly && listError ? <TreeHint tone="error">{`读取变更失败：${listError.message}`}</TreeHint> : null}
        <ChangesFilterInput value={filter} onChange={setFilter} onEnterTree={() => treeHandleRef.current?.enter()} inputRef={filterInputRef} />
        {filtering && !changedOnly && index.kind === "truncated" ? <TreeHint>文件太多，筛选只覆盖已展开的目录</TreeHint> : null}
        {filtering && filteredWhole && filteredWhole.matched > filteredWhole.shown ? (
          <TreeHint>{`匹配的文件过多，只显示前 ${filteredWhole.shown} 个`}</TreeHint>
        ) : null}
        <div className="min-h-0 flex-1">{treeBody}</div>
        {isDirWorkspace ? null : otherComments(groupedComments.others, commentsReadOnly)}
        <SidebarResizeHandle control={treeWidth} />
      </div>
      <div className="min-w-0 flex-1">{pane}</div>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <>
      <FolderTree className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">这个工作区是空的</p>
    </>
  );
}

/** A one-line note above the tree. */
function TreeHint({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div className={cn("shrink-0 border-b border-border px-2.5 py-1.5 text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </div>
  );
}

/** 「仅变更」: the review tree instead of the whole workspace. Locked on when the device's worker
 * predates the index. */
function OnlyChangesToggle({ on, locked, onChange }: { on: boolean; locked: boolean; onChange: (on: boolean) => void }) {
  const label = locked ? "这台设备的 daemon 版本过旧，只能查看变更" : on ? "显示工作区的全部文件" : "只显示有变更的文件";
  return (
    <Tooltip content={label} placement="below">
      <button
        type="button"
        aria-pressed={on}
        aria-disabled={locked || undefined}
        className={cn(
          "flex h-6 shrink-0 items-center whitespace-nowrap rounded-md px-1.5 text-sm transition-colors",
          locked
            ? "cursor-default bg-accent/50 text-muted-foreground opacity-60"
            : on
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={locked ? undefined : () => onChange(!on)}
      >
        仅变更
      </button>
    </Tooltip>
  );
}

/** 「差异 / 文件」: a changed file's diff, or its full current content. */
function DiffFileSwitch({ value, onChange }: { value: "diff" | "file"; onChange: (value: "diff" | "file") => void }) {
  const option = (option: "diff" | "file", label: string) => (
    <button
      type="button"
      aria-pressed={value === option}
      className={cn(
        "flex h-5 items-center rounded-sm px-1.5 text-sm transition-colors",
        value === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => onChange(option)}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="显示差异或文件" className="mr-1 flex shrink-0 items-center gap-0.5 rounded-md border border-border p-px">
      {option("diff", "差异")}
      {option("file", "文件")}
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
