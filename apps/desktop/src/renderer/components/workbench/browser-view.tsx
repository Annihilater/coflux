import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Camera,
  Cookie,
  Copy,
  Crop,
  Ellipsis,
  ExternalLink,
  Globe,
  History,
  LoaderCircle,
  MessageSquareText,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  SquareCode,
  Star,
  Trash2,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useToast } from "@astryxdesign/core/Toast";
import type { AnnotationFailure, CofluxClient } from "@coflux/client";
import { AnnotationImageKind, AnnotationPutSchema, create, type Annotation } from "@coflux/protocol";

import { BROWSER_DEVTOOLS_PARTITION } from "../../../shared/browser-partitions";
import {
  displayUrl,
  hostLabel,
  isLoopbackUrl,
  isWebUrl,
  localPortUrl,
  loopbackPortOf,
  resolveAddressInput,
} from "@/components/workbench/browser-address";
import {
  clearHistory,
  isBookmarked,
  rankSuggestions,
  recordVisit,
  removeBookmark,
  setBookmarksBarVisible,
  toggleBookmark,
  updateHistoryTitle,
  type BrowserSuggestion,
  type HistoryEntry,
} from "@/components/workbench/browser-library";
import type { BrowserRuntime } from "@/components/workbench/browser-runtime";
import {
  agentTerminals,
  annotationsMarkdown,
  dataUrlToImage,
  HAND_OFF_INSTRUCTION,
  pageKey,
  pendingCount,
  pinsForPage,
} from "@/components/workbench/browser-annotations";
import { annotationsModelFor, useWorkspaceAnnotations } from "@/components/workbench/browser-annotations-model";
import {
  AnnotateToggle,
  AnnotationCard,
  AnnotationsPanel,
  prepareReferenceImage,
  type AnnotationDraft,
  type PanelNotice,
} from "@/components/workbench/browser-annotations-ui";
import { entityHandle } from "@/components/workbench/entity-handle";
import { listForwardedPorts, type ForwardedPort } from "@/components/workbench/port-menu";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { desktop } from "@/config";
import type {
  DesktopAnnotatorBox,
  DesktopAnnotatorPick,
  DesktopAnnotatorState,
  DesktopAnnotatorViewport,
  DesktopBrowserCertificate,
  DesktopBrowserEvent,
  DesktopBrowserMode,
  DesktopBrowserPrepared,
  DesktopBrowserTunnelFailure,
} from "@/desktop-bridge";
import { cn } from "@/lib/utils";

/**
 * Built-in browser tabs (plan 20260924-desktop-browser-tab), aligned with Cursor's in-editor browser
 * minus select-element / agent control.
 *
 * The layer mirrors the terminal pane layer (terminal-panes.tsx): it covers the whole main area,
 * sits after the workspace containers, is pointer-events-none as a whole, and holds one view per
 * browser tab, keyed by tab id and placed on its group's body rectangle. A view is never
 * re-parented or re-keyed — moving a `<webview>` to another parent reloads its page — so moving a
 * tab between groups only changes the rectangle. A tab that is not on screen stays mounted and is
 * hidden with `visibility: hidden` at its last rectangle, never `display: none` (a webview must keep
 * its internal `display: flex`), so its page keeps running — HMR sockets included — until the tab is
 * closed.
 *
 * The `<webview>` elements are created imperatively inside a host node React renders no children
 * into, in the order the main process requires: prepare the workspace's partition → insert the
 * element with that partition and `src="about:blank"` → once attached, navigate through main.
 */

export type BrowserViewEntry = {
  tabId: string;
  workspaceId: string;
  /** The device the workspace lives on; main compares it with this Mac's to decide what `localhost` is. */
  daemonId: string;
  /** Its group's active tab in the selected workspace, changes overlay closed. */
  visible: boolean;
  /** The focused group's active tab. */
  focused: boolean;
  /** Its group's body rectangle (percentages of the main area). */
  frame: CSSProperties;
};

type BrowserViewsProps = {
  runtime: BrowserRuntime;
  client: CofluxClient;
  entries: readonly BrowserViewEntry[];
  /** A pointer went down anywhere in a view: its group becomes the focused one. */
  onPointerFocus: (tabId: string) => void;
  /** A bookmark's 在新标签页中打开: a new browser tab beside this one. */
  onOpenTab: (workspaceId: string, url: string, besideTabId: string) => void;
};

/** The subset of Electron's `<webview>` element this file uses (no Electron types in the renderer). */
type WebviewElement = HTMLElement & { getWebContentsId: () => number };

type Failure =
  | { kind: "refused"; url: string }
  | { kind: "network"; url: string; code: number; description: string }
  /** A remote workspace's loopback load failed in the device tunnel (plan 20260924-remote-localhost-tunnel). */
  | { kind: "tunnel"; url: string; reason: DesktopBrowserTunnelFailure }
  | { kind: "certificate"; url: string; host: string; certificate: DesktopBrowserCertificate | null }
  | { kind: "crashed"; url: string };

/** Chromium net error codes the error pages distinguish. */
const NET_ERR_ABORTED = -3;
const NET_ERR_BLOCKED_BY_CLIENT = -20;
const NET_ERR_CONNECTION_REFUSED = -102;

function isCertificateError(code: number): boolean {
  return code <= -200 && code > -300;
}

/** The page for a failed load main has nothing more specific about. */
function loadFailure(url: string, code: number, description: string): Failure {
  if (code === NET_ERR_CONNECTION_REFUSED) return { kind: "refused", url };
  return { kind: "network", url, code, description };
}

function createWebview(partition: string, options: { allowPopups: boolean }): WebviewElement {
  const element = document.createElement("webview") as WebviewElement;
  // Attributes before insertion: the guest attaches when the element enters the document, and the
  // main-process gate only admits a prepared partition on about:blank.
  element.setAttribute("partition", partition);
  element.setAttribute("src", "about:blank");
  // Without it no handler ever sees a popup; main's handler denies every one and opens a tab instead.
  if (options.allowPopups) element.setAttribute("allowpopups", "");
  element.style.position = "absolute";
  element.style.inset = "0";
  element.style.width = "100%";
  element.style.height = "100%";
  return element;
}

export function BrowserViews({ runtime, client, entries, onPointerFocus, onOpenTab }: BrowserViewsProps) {
  const showToast = useToast();
  useEffect(
    () =>
      runtime.onDownload((event) => {
        if (event.state === "completed") showToast({ body: `已下载到「下载」文件夹：${event.filename}`, type: "info" });
        else if (event.state === "interrupted") showToast({ body: `下载失败：${event.filename}`, type: "error" });
      }),
    [runtime, showToast],
  );
  return (
    <div className="pointer-events-none absolute inset-0">
      {entries.map((entry) => (
        <BrowserView key={entry.tabId} entry={entry} runtime={runtime} client={client} onPointerFocus={onPointerFocus} onOpenTab={onOpenTab} />
      ))}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
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
        )}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function BrowserView({
  entry,
  runtime,
  client,
  onPointerFocus,
  onOpenTab,
}: {
  entry: BrowserViewEntry;
  runtime: BrowserRuntime;
  client: CofluxClient;
  onPointerFocus: (tabId: string) => void;
  onOpenTab: (workspaceId: string, url: string, besideTabId: string) => void;
}) {
  const { tabId, workspaceId, daemonId, visible } = entry;
  const showToast = useToast();
  const tab = useStore(runtime.tabs, (state) => state.tabs[tabId]);
  const library = useStore(runtime.library, (state) => state.library);
  const tasks = useStore(client.store, (state) => state.tasks);
  const ports = useStore(client.store, (state) => state.ports);

  const [prepared, setPrepared] = useState<DesktopBrowserPrepared | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [mode, setMode] = useState<DesktopBrowserMode | null>(() => runtime.modeOf(workspaceId));
  const [guestId, setGuestId] = useState<number | null>(null);
  const [history, setHistory] = useState({ canGoBack: false, canGoForward: false, zoomFactor: 1 });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [editing, setEditing] = useState(false);
  const [addressText, setAddressText] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [trusting, setTrusting] = useState(false);
  // Browser annotations (plan 20260929-browser-annotations).
  const [annotating, setAnnotating] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [anchorBox, setAnchorBox] = useState<{ rect: DesktopAnnotatorBox | null; viewport: DesktopAnnotatorViewport } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ url: string; ids: ReadonlySet<string> }>({ url: "", ids: new Set() });
  const [annotatorAvailable, setAnnotatorAvailable] = useState(true);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);
  const workspaces = useStore(client.store, (state) => state.workspaces);
  const annotationSummary = useStore(client.store, (state) => state.annotationSummaries[workspaceId]);
  const daemonOnline = useStore(client.store, (state) => state.daemons.find((daemon) => daemon.daemonId === daemonId)?.online ?? false);

  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const devtoolsHostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const moreAnchorRef = useRef<HTMLButtonElement | null>(null);
  const guestIdRef = useRef<number | null>(null);
  /** A URL asked for before the guest attached; loaded as soon as it does. */
  const pendingUrlRef = useRef<string | null>(null);
  const selectionStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** The user asked for this tab's focus before its guest attached. */
  const wantFocusRef = useRef(false);

  const url = tab?.url ?? "";
  const title = tab?.title ?? "";
  const loading = tab?.loading ?? false;
  const bookmarked = isWebUrl(url) && isBookmarked(library, url);
  const blank = url === "" && failure === null;

  // ---- browser annotations (plan 20260929-browser-annotations) ----
  const annotationsModel = annotationsModelFor(client);
  const annotationsEntry = useWorkspaceAnnotations(client, workspaceId, visible && (isWebUrl(url) || panelOpen));
  const annotations = annotationsEntry.annotations;
  const annotationNotice: PanelNotice =
    annotationsEntry.status === "unsupported" ? "unsupported" : annotationsEntry.status === "unreachable" ? (daemonOnline ? "unreachable" : "offline") : null;
  const annotationsReadOnly = annotationNotice !== null;
  const annotateDisabledReason =
    annotationNotice === "unsupported"
      ? "该设备 coflux 版本过旧，更新后才能使用浏览器批注"
      : annotationsReadOnly
        ? "连不上这个工作区所在的设备，暂时不能添加批注"
        : !isWebUrl(url) || failure
          ? "打开网页后才能批注"
          : !annotatorAvailable
            ? "这个页面暂时无法批注，稍后重试"
            : null;
  const pagePins = isWebUrl(url) && !failure && annotations ? pinsForPage(annotations, url) : [];
  const annotatorAnchor: DesktopAnnotatorState["anchor"] = draft?.pick
    ? { kind: "pick", token: draft.pick.token }
    : draft?.annotationId
      ? { kind: "pin", id: draft.annotationId, scroll: true }
      : selectedId
        ? { kind: "pin", id: selectedId, scroll: true }
        : null;
  const annotatorState: DesktopAnnotatorState = {
    mode: annotating && draft === null && annotateDisabledReason === null,
    pins: pagePins,
    anchor: annotatorAnchor,
  };
  const annotatorKey = JSON.stringify(annotatorState);
  const pageMissing = missing.url && pageKey(missing.url) === pageKey(url) ? missing.ids : new Set<string>();

  function annotationFailureText(result: AnnotationFailure, action: string): string {
    if (result.reason === "unsupported") return "该设备 coflux 版本过旧，不支持浏览器批注";
    if (result.reason === "unreachable") return `${action}失败：连不上这个工作区所在的设备`;
    return `${action}失败：${result.error}`;
  }

  function onAnnotatorPick(pick: DesktopAnnotatorPick) {
    const shot = pick.screenshot ? dataUrlToImage(pick.screenshot) : null;
    setSelectedId(null);
    setAnchorBox({ rect: pick.rect, viewport: pick.viewport });
    setDraft({
      key: crypto.randomUUID(),
      annotationId: null,
      number: null,
      pick,
      comment: "",
      images: shot && pick.screenshot ? [{ key: crypto.randomUUID(), dataUrl: pick.screenshot, mimeType: shot.mimeType, data: shot.data, kind: "screenshot" }] : [],
      existing: [],
      removed: [],
      saving: false,
      error: null,
    });
  }

  function editAnnotation(annotation: Annotation) {
    if (pageKey(annotation.pageUrl) !== pageKey(liveRef.current.url)) navigate(annotation.pageUrl);
    setAnchorBox(null);
    setSelectedId(annotation.annotationId);
    setDraft({
      key: crypto.randomUUID(),
      annotationId: annotation.annotationId,
      number: annotation.number,
      pick: null,
      comment: annotation.comment,
      images: [],
      existing: annotation.images,
      removed: [],
      saving: false,
      error: null,
    });
  }

  function selectAnnotation(annotation: Annotation) {
    setAnchorBox(null);
    setSelectedId(annotation.annotationId);
    if (pageKey(annotation.pageUrl) !== pageKey(liveRef.current.url)) navigate(annotation.pageUrl);
  }

  async function addDraftImages(blobs: Blob[]) {
    const prepared = (await Promise.all(blobs.map((blob) => prepareReferenceImage(blob).catch(() => null)))).filter((image): image is NonNullable<typeof image> => image !== null);
    if (prepared.length === 0) {
      showToast({ body: "无法读取这张图片", type: "error" });
      return;
    }
    setDraft((current) => (current ? { ...current, images: [...current.images, ...prepared], error: null } : current));
  }

  async function saveDraft() {
    const current = draft;
    if (!current || current.saving || !current.comment.trim()) return;
    setDraft({ ...current, saving: true, error: null });
    const pick = current.pick;
    const put = create(AnnotationPutSchema, {
      annotation: current.annotationId
        ? { annotationId: current.annotationId, comment: current.comment.trim() }
        : {
            comment: current.comment.trim(),
            pageUrl: pick?.url ?? liveRef.current.url,
            pageTitle: pick?.title ?? liveRef.current.title,
            element: pick ? { ...pick.element } : undefined,
            source: pick?.source ? { ...pick.source } : undefined,
          },
      addImages: current.images.map((image) => ({
        kind: image.kind === "screenshot" ? AnnotationImageKind.SCREENSHOT : AnnotationImageKind.REFERENCE,
        mimeType: image.mimeType,
        data: image.data,
      })),
      removeImageIds: current.removed,
    });
    const result = await annotationsModel.change(workspaceId, { kind: "put", put });
    if (result.ok) {
      setDraft((latest) => (latest?.key === current.key ? null : latest));
      setSelectedId(null);
      return;
    }
    // The card keeps its input: saving again retries.
    setDraft((latest) => (latest?.key === current.key ? { ...latest, saving: false, error: annotationFailureText(result, "保存") } : latest));
  }

  function cancelDraft() {
    setDraft(null);
    setSelectedId(null);
  }

  async function deleteAnnotation(annotation: Annotation) {
    const result = await annotationsModel.change(workspaceId, { kind: "delete", annotationIds: [annotation.annotationId] });
    if (!result.ok) showToast({ body: annotationFailureText(result, "删除"), type: "error" });
    else if (selectedId === annotation.annotationId) setSelectedId(null);
  }

  async function reopenAnnotation(annotation: Annotation, comment: string): Promise<boolean> {
    const result = await annotationsModel.change(workspaceId, { kind: "reopen", annotationId: annotation.annotationId, comment });
    if (!result.ok) showToast({ body: annotationFailureText(result, "重新打开"), type: "error" });
    return result.ok;
  }

  async function clearResolved() {
    const result = await annotationsModel.change(workspaceId, { kind: "clear-resolved" });
    if (!result.ok) showToast({ body: annotationFailureText(result, "清除"), type: "error" });
  }

  function copyAnnotationsMarkdown() {
    if (!annotations || annotations.length === 0) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const label = `${workspace?.name ? `${workspace.name} ` : ""}(${entityHandle("workspace", workspaceId)})`;
    desktop.writeClipboard(annotationsMarkdown(annotations, label));
    showToast({ body: "已把批注复制为 markdown", type: "info" });
  }

  async function handOff(taskId: string) {
    const terminal = agentTerminals(tasks, sessionAgents, workspaceId).find((item) => item.taskId === taskId);
    const result = await client.handOffAnnotations(workspaceId, taskId, HAND_OFF_INSTRUCTION);
    if (result.ok) {
      showToast({ body: `已交给「${terminal?.title || "终端"}」里的 ${terminal?.agent ?? "agent"}`, type: "info" });
      return;
    }
    if (result.held) showToast({ body: "这个终端正被另一台设备使用，没有输入。在那台设备上操作，或换一个终端。", type: "error" });
    else showToast({ body: annotationFailureText(result, "交给 agent "), type: "error" });
  }

  function toggleAnnotating() {
    const next = !annotating;
    setAnnotating(next);
    if (next) setPanelOpen(true);
  }

  function cardStyle(): CSSProperties {
    const region = pageSize;
    const cardWidth = 320;
    const estimatedHeight = 230;
    const box = anchorBox;
    if (region.width <= 0 || !box?.rect || box.viewport.width <= 0) return { right: 12, top: 12 };
    const scale = region.width / box.viewport.width;
    const left = Math.max(8, Math.min(region.width - cardWidth - 8, box.rect.x * scale));
    const below = (box.rect.y + box.rect.height) * scale + 8;
    const above = box.rect.y * scale - estimatedHeight - 8;
    const top = below + estimatedHeight <= region.height ? below : above >= 8 ? above : Math.max(8, region.height - estimatedHeight - 8);
    return { left, top };
  }

  // Handlers registered once per mount read the current values through this mirror.
  const liveRef = useRef({ url, title, mode, failure, visible, editing });
  useEffect(() => {
    liveRef.current = { url, title, mode, failure, visible, editing };
  });

  function currentMode(): DesktopBrowserMode | null {
    return runtime.modeOf(workspaceId) ?? liveRef.current.mode;
  }

  /** Loads a URL the address bar, a bookmark, a port or a retry resolved — always through main. */
  function navigate(target: string) {
    setFailure(null);
    setEditing(false);
    setHighlight(-1);
    const nextUrl = target === "about:blank" ? "" : target;
    runtime.updateTab(tabId, nextUrl === liveRef.current.url ? { url: nextUrl } : { url: nextUrl, title: "", favicon: null });
    const guest = guestIdRef.current;
    if (guest === null) {
      pendingUrlRef.current = target;
      return;
    }
    desktop.browserNavigate(guest, target);
  }

  function focusAddress() {
    const input = addressRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }

  function focusPage() {
    const live = liveRef.current;
    if (live.url === "" || live.failure) {
      focusAddress();
      return;
    }
    const element = webviewRef.current;
    if (!element || guestIdRef.current === null) {
      // Asked before the guest attached (a tab that was just opened or restored): focus it on attach.
      wantFocusRef.current = true;
      return;
    }
    element.focus();
  }

  function retry() {
    const target = failure?.url ?? url;
    if (target) navigate(target);
  }

  function reload() {
    if (failure) {
      retry();
      return;
    }
    const guest = guestIdRef.current;
    if (guest !== null && url) desktop.browserCommand(guest, "reload");
  }

  function toggleDevTools() {
    if (guestIdRef.current === null) return;
    setDevtoolsOpen((open) => !open);
  }

  // Keeps the latest closures reachable from handlers registered once.
  const actionsRef = useRef({ navigate, focusAddress, focusPage, reload, toggleDevTools, retry, onAnnotatorPick });
  useEffect(() => {
    actionsRef.current = { navigate, focusAddress, focusPage, reload, toggleDevTools, retry, onAnnotatorPick };
  });

  // The page's annotate mode, pins and anchor, pushed to main whenever they change (main re-applies
  // them after every navigation of the guest).
  useEffect(() => {
    if (guestId === null) return;
    desktop.browserAnnotatorSync(guestId, JSON.parse(annotatorKey) as DesktopAnnotatorState);
  }, [guestId, annotatorKey]);

  // The page area's size, for placing the comment card over the element (page CSS pixels scale onto it).
  useEffect(() => {
    const region = pageRef.current;
    if (!region) return;
    const observer = new ResizeObserver(() => {
      const box = region.getBoundingClientRect();
      setPageSize((current) => (current.width === box.width && current.height === box.height ? current : { width: box.width, height: box.height }));
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  // A tab that leaves the screen leaves annotate mode (a card being written stays).
  useEffect(() => {
    if (!visible) setAnnotating(false);
  }, [visible]);

  // 1. Prepare the workspace's partition (main decides local vs remote from the local daemon id).
  useEffect(() => {
    let cancelled = false;
    runtime.prepare(workspaceId, daemonId).then(
      (result) => {
        if (cancelled) return;
        setPrepared(result);
        setMode(runtime.modeOf(workspaceId) ?? result.mode);
      },
      (error: unknown) => {
        if (!cancelled) setPrepareError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runtime, workspaceId, daemonId]);

  // 2. Insert the webview only once the partition is prepared, then 3. navigate once it attached.
  useEffect(() => {
    const host = webviewHostRef.current;
    if (!prepared || !host) return;
    const element = createWebview(prepared.partition, { allowPopups: true });
    webviewRef.current = element;
    let attached = false;

    const on = (name: string, handler: (event: Event) => void) => element.addEventListener(name, handler);
    on("dom-ready", () => {
      if (attached) return;
      attached = true;
      let id: number;
      try {
        id = element.getWebContentsId();
      } catch {
        return;
      }
      guestIdRef.current = id;
      runtime.bindGuest(tabId, id);
      setGuestId(id);
      const initial = pendingUrlRef.current ?? runtime.tabs.getState().tabs[tabId]?.url ?? "";
      pendingUrlRef.current = null;
      if (initial) actionsRef.current.navigate(initial);
      if (wantFocusRef.current) {
        wantFocusRef.current = false;
        if (liveRef.current.visible) actionsRef.current.focusPage();
      }
    });
    on("did-start-loading", () => runtime.updateTab(tabId, { loading: true }));
    on("did-stop-loading", () => runtime.updateTab(tabId, { loading: false }));
    on("did-navigate", (event) => {
      const next = (event as Event & { url: string }).url;
      // The initial about:blank the guest attaches on is not a page of this tab.
      if (!next || next === "about:blank") return;
      setFailure(null);
      runtime.updateTab(tabId, next === liveRef.current.url ? { url: next } : { url: next, title: "", favicon: null });
      runtime.updateLibrary((current) => recordVisit(current, { url: next, title: "" }, Date.now()));
    });
    on("did-navigate-in-page", (event) => {
      const detail = event as Event & { url: string; isMainFrame: boolean };
      if (!detail.isMainFrame || !detail.url || detail.url === "about:blank") return;
      runtime.updateTab(tabId, { url: detail.url });
      runtime.updateLibrary((current) => recordVisit(current, { url: detail.url, title: liveRef.current.title }, Date.now()));
    });
    on("page-title-updated", (event) => {
      const next = (event as Event & { title: string }).title ?? "";
      const pageUrl = liveRef.current.url;
      runtime.updateTab(tabId, { title: next });
      if (pageUrl) runtime.updateLibrary((current) => updateHistoryTitle(current, pageUrl, next));
    });
    on("did-fail-load", (event) => {
      const detail = event as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      if (!detail.isMainFrame || detail.errorCode === NET_ERR_ABORTED) return;
      const failedUrl = detail.validatedURL || liveRef.current.url;
      if (!failedUrl || failedUrl === "about:blank") return;
      runtime.updateTab(tabId, { url: failedUrl, loading: false });
      if (isCertificateError(detail.errorCode)) {
        const host = hostLabel(failedUrl).replace(/:\d+$/, "").toLowerCase();
        setFailure({ kind: "certificate", url: failedUrl, host, certificate: null });
        const guest = guestIdRef.current;
        if (guest !== null) {
          void desktop.browserCertificate(guest, host).then((certificate) =>
            setFailure((current) => (current?.kind === "certificate" && current.url === failedUrl ? { ...current, certificate } : current)),
          );
        }
        return;
      }
      const fallback = loadFailure(failedUrl, detail.errorCode, detail.errorDescription);
      const guest = guestIdRef.current;
      if (currentMode() === "remote" && isLoopbackUrl(failedUrl) && guest !== null) {
        // The device tunnel failed in main, which remembers why. Asked here rather than pushed from
        // there: a push and this event travel different paths, and the generic page would win races.
        const settle = (reason: DesktopBrowserTunnelFailure | null) => {
          if (runtime.tabs.getState().tabs[tabId]?.url !== failedUrl) return;
          if (reason) setFailure({ kind: "tunnel", url: failedUrl, reason });
          // Refused before reaching the tunnel (main's fallback block): the device is not reachable.
          else if (detail.errorCode === NET_ERR_BLOCKED_BY_CLIENT) setFailure({ kind: "tunnel", url: failedUrl, reason: "offline" });
          else setFailure(fallback);
        };
        void desktop.browserTunnelFailure(guest, failedUrl).then(settle, () => settle(null));
        return;
      }
      setFailure(fallback);
    });
    on("render-process-gone", () => {
      runtime.updateTab(tabId, { loading: false });
      setFailure({ kind: "crashed", url: liveRef.current.url });
    });

    host.appendChild(element);
    return () => {
      element.remove();
      webviewRef.current = null;
      guestIdRef.current = null;
      runtime.unbindGuest(tabId);
      setGuestId(null);
    };
  }, [prepared, runtime, tabId]);

  // Main-process events about this tab, and the hooks the Workbench drives it through.
  useEffect(
    () =>
      runtime.register(tabId, {
        onEvent: (event: DesktopBrowserEvent) => {
          switch (event.kind) {
            case "key":
              if (event.action === "focus-address") actionsRef.current.focusAddress();
              else actionsRef.current.toggleDevTools();
              return;
            case "favicon":
              if (event.pageUrl === liveRef.current.url || !event.pageUrl) runtime.updateTab(tabId, { favicon: event.dataUrl });
              return;
            case "history":
              setHistory({ canGoBack: event.canGoBack, canGoForward: event.canGoForward, zoomFactor: event.zoomFactor });
              return;
            case "devtools-closed":
              setDevtoolsOpen(false);
              return;
            case "mode":
              setMode(event.mode);
              // `localhost` changed meaning: a loopback page that failed for the old one may load now.
              if (liveRef.current.failure?.kind === "tunnel") actionsRef.current.retry();
              return;
            case "annotator-pick":
              actionsRef.current.onAnnotatorPick(event.pick);
              return;
            case "annotator-anchor":
              setAnchorBox({ rect: event.rect, viewport: event.viewport });
              return;
            case "annotator-pin-click":
              setSelectedId(event.annotationId);
              setPanelOpen(true);
              return;
            case "annotator-pins":
              setMissing({ url: event.url, ids: new Set(event.missing) });
              return;
            case "annotator-exit":
              setAnnotating(false);
              return;
            case "annotator-status":
              setAnnotatorAvailable(event.available);
              return;
            default:
              return;
          }
        },
        focus: () => actionsRef.current.focusPage(),
        reload: () => actionsRef.current.reload(),
      }),
    [runtime, tabId],
  );

  // Docked DevTools: a second webview as the DevTools host, still on its initial about:blank when
  // main points the page's DevTools at it. Closing tears the host down; the next open gets a new one.
  useEffect(() => {
    const host = devtoolsHostRef.current;
    const page = guestId;
    if (!devtoolsOpen || !host || page === null) return;
    const element = createWebview(BROWSER_DEVTOOLS_PARTITION, { allowPopups: false });
    let opened = false;
    element.addEventListener("dom-ready", () => {
      if (opened) return;
      opened = true;
      let hostId: number;
      try {
        hostId = element.getWebContentsId();
      } catch {
        setDevtoolsOpen(false);
        return;
      }
      void desktop.browserOpenDevTools(page, hostId).then((ok) => {
        if (!ok) setDevtoolsOpen(false);
      });
    });
    host.appendChild(element);
    return () => {
      desktop.browserCloseDevTools(page);
      element.remove();
    };
  }, [devtoolsOpen, guestId]);

  // 框选截图: Escape leaves the frozen frame without capturing.
  useEffect(() => {
    if (!frozenFrame) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelRegion();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenFrame]);

  // A tab that leaves the screen drops an unfinished region capture.
  useEffect(() => {
    if (!visible && frozenFrame) cancelRegion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // A blank new tab starts in its address bar.
  useEffect(() => {
    if (blank && entry.focused && visible) focusAddress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancelRegion() {
    const guest = guestIdRef.current;
    if (guest !== null) desktop.browserReleaseFreeze(guest);
    setFrozenFrame(null);
    setSelection(null);
    selectionStartRef.current = null;
  }

  async function captureVisible() {
    const guest = guestIdRef.current;
    if (guest === null) return;
    const ok = await desktop.browserCaptureVisible(guest).catch(() => false);
    showToast(ok ? { body: "已把可见区域的截图复制到剪贴板", type: "info" } : { body: "截图失败", type: "error" });
  }

  async function startRegionCapture() {
    const guest = guestIdRef.current;
    if (guest === null) return;
    const frame = await desktop.browserFreeze(guest).catch(() => null);
    if (!frame) {
      showToast({ body: "截图失败", type: "error" });
      return;
    }
    setSelection(null);
    setFrozenFrame(frame);
  }

  function regionPoint(event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function finishRegion(event: ReactPointerEvent<HTMLDivElement>) {
    const start = selectionStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    selectionStartRef.current = null;
    const end = regionPoint(event);
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    const box = event.currentTarget.getBoundingClientRect();
    // A click, not a drag: keep the frozen frame and let the user drag again.
    if (rect.width * box.width < 4 || rect.height * box.height < 4) {
      setSelection(null);
      return;
    }
    const guest = guestIdRef.current;
    setFrozenFrame(null);
    setSelection(null);
    if (guest === null) return;
    void desktop.browserCaptureRegion(guest, rect).then(
      (ok) => showToast(ok ? { body: "已把框选区域的截图复制到剪贴板", type: "info" } : { body: "截图失败", type: "error" }),
      () => showToast({ body: "截图失败", type: "error" }),
    );
  }

  function copyUrl() {
    if (!url) return;
    desktop.writeClipboard(url);
    showToast({ body: "已复制网址", type: "info" });
  }

  function clearData(target: "cookies" | "cache" | "certificates") {
    const labels = { cookies: "Cookies", cache: "缓存", certificates: "已信任的证书" } as const;
    void desktop.browserClearData(workspaceId, target).then(
      (ok) => showToast(ok ? { body: `已清除这个工作区的${labels[target]}`, type: "info" } : { body: `清除${labels[target]}失败`, type: "error" }),
      () => showToast({ body: `清除${labels[target]}失败`, type: "error" }),
    );
  }

  function zoomCommand(command: "zoom-in" | "zoom-out" | "zoom-reset") {
    const guest = guestIdRef.current;
    if (guest !== null) desktop.browserCommand(guest, command);
  }

  async function trustAndRetry(current: Extract<Failure, { kind: "certificate" }>) {
    const guest = guestIdRef.current;
    if (guest === null) return;
    setTrusting(true);
    const ok = await desktop.browserTrustCertificate(guest, current.host).catch(() => false);
    setTrusting(false);
    if (!ok) {
      showToast({ body: "信任证书失败，请重试加载后再试", type: "error" });
      return;
    }
    navigate(current.url);
  }

  // Address bar suggestions: only while the user is editing what is there.
  const suggestions: BrowserSuggestion[] = editing && addressText.trim() && addressText !== displayUrl(url) ? rankSuggestions(library, addressText, Date.now(), 8) : [];

  function submitAddress() {
    const picked = highlight >= 0 ? suggestions[highlight] : undefined;
    if (picked) {
      navigate(picked.url);
    } else {
      const resolved = resolveAddressInput(addressText);
      if (!resolved) return;
      navigate(resolved.url);
    }
    // The page takes the caret once there is one to take.
    requestAnimationFrame(() => webviewRef.current?.focus());
  }

  function onAddressKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // Enter and Escape belong to the input method while it is composing (Chinese input above all).
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((index) => (index + 1 >= suggestions.length ? 0 : index + 1));
      return;
    }
    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setHighlight((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitAddress();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      setHighlight(-1);
      setAddressText(displayUrl(url));
      if (url && !failure) webviewRef.current?.focus();
    }
  }

  // ⌘L and ⌥⌘I while the caret is in the tab's own chrome (inside the page, main forwards them).
  function onViewKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && annotating && draft === null && !event.nativeEvent.isComposing) {
      event.preventDefault();
      setAnnotating(false);
      return;
    }
    if (!event.metaKey || event.ctrlKey) return;
    if (event.code === "KeyL" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      focusAddress();
      return;
    }
    if (event.code === "KeyI" && event.altKey && !event.shiftKey) {
      event.preventDefault();
      toggleDevTools();
    }
  }

  const workspacePorts = listForwardedPorts(tasks, ports, workspaceId);
  const zoomPercent = Math.round(history.zoomFactor * 100);
  const addressValue = editing ? addressText : displayUrl(url);
  const isRemote = mode === "remote";

  return (
    <div
      className={cn("absolute isolate flex flex-col bg-terminal", visible ? "pointer-events-auto" : "invisible")}
      style={entry.frame}
      aria-hidden={!visible}
      onPointerDownCapture={() => onPointerFocus(tabId)}
      onKeyDownCapture={onViewKeyDown}
    >
      {/* Toolbar: ← → ⟳, the address bar with ☆ and suggestions, Console, ⋯ (Cursor 3.20's layout). */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <ToolbarButton label="返回" disabled={!history.canGoBack || guestId === null} onClick={() => guestId !== null && desktop.browserCommand(guestId, "back")}>
          <ArrowLeft className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="前进" disabled={!history.canGoForward || guestId === null} onClick={() => guestId !== null && desktop.browserCommand(guestId, "forward")}>
          <ArrowRight className="size-3.5" />
        </ToolbarButton>
        {loading ? (
          <ToolbarButton label="停止加载" onClick={() => guestId !== null && desktop.browserCommand(guestId, "stop")}>
            <X className="size-3.5" />
          </ToolbarButton>
        ) : (
          <ToolbarButton label={`重新加载 ${SHORTCUT_MODIFIER_PREFIX}R`} disabled={!url} onClick={reload}>
            <RotateCw className="size-3.5" />
          </ToolbarButton>
        )}
        <div className="relative mx-1 min-w-0 flex-1">
          <input
            ref={addressRef}
            value={addressValue}
            placeholder="输入网址或搜索"
            aria-label="地址栏"
            spellCheck={false}
            autoComplete="off"
            className="h-6 w-full rounded-md bg-muted/60 pl-2.5 pr-7 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:bg-background"
            onFocus={(event) => {
              setAddressText(displayUrl(url));
              setEditing(true);
              setHighlight(-1);
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
            onBlur={() => {
              setEditing(false);
              setHighlight(-1);
            }}
            onChange={(event) => {
              setAddressText(event.target.value);
              setEditing(true);
              setHighlight(-1);
            }}
            onKeyDown={onAddressKeyDown}
          />
          {isWebUrl(url) ? (
            <Tooltip content={bookmarked ? "移除书签" : "加入书签"} placement="below">
              <button
                type="button"
                aria-label={bookmarked ? "移除书签" : "加入书签"}
                aria-pressed={bookmarked}
                className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => runtime.updateLibrary((current) => toggleBookmark(current, { url, title }, Date.now()))}
              >
                <Star className={cn("size-3.5", bookmarked && "fill-warning text-warning")} />
              </button>
            </Tooltip>
          ) : null}
          {suggestions.length > 0 ? (
            <div role="listbox" aria-label="地址建议" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.url}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left text-xs",
                    index === highlight ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/60",
                  )}
                  // Keep the caret in the address bar: a blur would close the list before the click lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => {
                    navigate(suggestion.url);
                    requestAnimationFrame(() => webviewRef.current?.focus());
                  }}
                >
                  {suggestion.source === "bookmark" ? <Star className="size-3 shrink-0 fill-warning text-warning" /> : <History className="size-3 shrink-0 opacity-60" />}
                  <span className="min-w-0 max-w-[50%] shrink truncate text-foreground">{suggestion.title || hostLabel(suggestion.url)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{displayUrl(suggestion.url)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <AnnotateToggle
          active={annotating && annotateDisabledReason === null}
          count={pendingCount(annotationSummary, annotations)}
          disabledReason={guestId === null ? "打开网页后才能批注" : annotateDisabledReason}
          onToggle={toggleAnnotating}
        />
        <ToolbarButton label="控制台 ⌥⌘I" pressed={devtoolsOpen} disabled={guestId === null} onClick={toggleDevTools}>
          <SquareCode className="size-3.5" />
        </ToolbarButton>
        <DropdownMenu
          isMenuOpen={menuOpen}
          onOpenChange={setMenuOpen}
          menuWidth={240}
          hasChevron={false}
          placement="below"
          alignment="end"
          button={{
            ref: moreAnchorRef,
            label: "更多",
            icon: <Ellipsis className="size-3.5" />,
            isIconOnly: true,
            variant: "ghost",
            size: "sm",
            style: { color: "var(--muted-foreground)", height: 24, width: 24, minWidth: 24, paddingInline: 0 },
          }}
        >
          <DropdownMenuItem icon={<Camera className="size-3.5" />} label="截取可见区域" isDisabled={!url || guestId === null} onClick={() => void captureVisible()} />
          <DropdownMenuItem icon={<Crop className="size-3.5" />} label="框选截图" isDisabled={!url || guestId === null} onClick={() => void startRegionCapture()} />
          <DropdownMenuDivider />
          <DropdownMenuItem icon={<Copy className="size-3.5" />} label="复制当前网址" isDisabled={!url} onClick={copyUrl} />
          <DropdownMenuItem icon={<MessageSquareText className="size-3.5" />} label={panelOpen ? "隐藏批注列表" : "显示批注列表"} onClick={() => setPanelOpen((open) => !open)} />
          <DropdownMenuItem
            icon={<ExternalLink className="size-3.5" />}
            label="在系统浏览器中打开"
            isDisabled={!isWebUrl(url)}
            onClick={() => window.open(url, "_blank", "noopener")}
          />
          <DropdownMenuItem
            icon={<RefreshCw className="size-3.5" />}
            label="硬刷新（清除缓存）"
            isDisabled={!url || guestId === null}
            onClick={() => guestId !== null && desktop.browserCommand(guestId, "hard-reload")}
          />
          <DropdownMenuDivider />
          {/* Zoom row: − 100% +, the percentage following the page's actual zoom. */}
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
            <span className="text-secondary-foreground">缩放</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label="缩小"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => zoomCommand("zoom-out")}
              >
                <Minus className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="恢复 100%"
                className="min-w-12 rounded-md px-1 text-center text-xs tabular-nums text-foreground hover:bg-accent"
                onClick={() => zoomCommand("zoom-reset")}
              >
                {zoomPercent}%
              </button>
              <button
                type="button"
                aria-label="放大"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => zoomCommand("zoom-in")}
              >
                <Plus className="size-3.5" />
              </button>
            </span>
          </div>
          <DropdownMenuDivider />
          <DropdownMenuCheckboxItem
            label="显示书签栏"
            value={library.bookmarksBarVisible}
            onChange={(checked) => runtime.updateLibrary((current) => setBookmarksBarVisible(current, checked))}
          />
          <DropdownMenuDivider />
          <DropdownMenuItem
            icon={<History className="size-3.5" />}
            label="清除浏览历史"
            onClick={() => {
              runtime.updateLibrary(clearHistory);
              showToast({ body: "已清除浏览历史", type: "info" });
            }}
          />
          <DropdownMenuItem icon={<Cookie className="size-3.5" />} label="清除 Cookies" onClick={() => clearData("cookies")} />
          <DropdownMenuItem icon={<Trash2 className="size-3.5" />} label="清除缓存" onClick={() => clearData("cache")} />
          <DropdownMenuItem icon={<ShieldAlert className="size-3.5" />} label="清除已信任的证书" onClick={() => clearData("certificates")} />
        </DropdownMenu>
        {/* Sibling tooltip after the menu, never button.tooltip (docs/design-guidelines.md). */}
        <Tooltip anchorRef={moreAnchorRef} isOpen={menuOpen ? false : undefined} content="更多" />
      </div>

      {library.bookmarksBarVisible ? (
        <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {library.bookmarks.length === 0 ? (
            <span className="px-1 text-2xs text-muted-foreground">点地址栏里的 ☆ 把当前页面加入书签</span>
          ) : (
            library.bookmarks.map((bookmark) => (
              <div key={bookmark.url} className="shrink-0">
                <ContextMenu
                  label={`书签「${bookmark.title || hostLabel(bookmark.url)}」操作`}
                  size="sm"
                  items={[
                    { label: "在新标签页中打开", onClick: () => onOpenTab(workspaceId, bookmark.url, tabId) },
                    { label: "复制网址", onClick: () => desktop.writeClipboard(bookmark.url) },
                    { type: "divider" },
                    { label: "删除书签", onClick: () => runtime.updateLibrary((current) => removeBookmark(current, bookmark.url)) },
                  ]}
                >
                  <button
                    type="button"
                    className="flex h-5 max-w-40 items-center gap-1 rounded px-1.5 text-2xs text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => navigate(bookmark.url)}
                  >
                    <Star className="size-2.5 shrink-0 opacity-60" />
                    <span className="truncate">{bookmark.title || hostLabel(bookmark.url)}</span>
                  </button>
                </ContextMenu>
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* Page area. The webview host has no React children, so React never touches the element
          inserted into it; the overlays are its later siblings and draw over the page. */}
      <div className="flex min-h-0 flex-1">
      <div ref={pageRef} className="relative min-w-0 flex-1">
        <div ref={webviewHostRef} className="absolute inset-0" />

        {blank ? (
          // A blank new tab: the address bar is focused; the workspace's forwarded ports and recent pages are one click away.
          <NewTabPage ports={workspacePorts} recent={library.history.slice(0, NEW_TAB_RECENT_COUNT)} isRemote={isRemote} onOpen={navigate} />
        ) : null}

        {failure ? <FailurePage failure={failure} trusting={trusting} onRetry={retry} onTrust={trustAndRetry} /> : null}

        {prepareError && !prepared ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-terminal px-6">
            <p className="max-w-sm text-center text-sm leading-5 text-destructive">无法准备浏览器：{prepareError}</p>
          </div>
        ) : null}

        {frozenFrame ? (
          // 框选截图: the page's frame frozen under a crosshair; drag a rectangle, Esc cancels.
          <div
            className="absolute inset-0 z-20 cursor-crosshair select-none touch-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              const point = regionPoint(event);
              selectionStartRef.current = { pointerId: event.pointerId, ...point };
              setSelection({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = selectionStartRef.current;
              if (!start || start.pointerId !== event.pointerId) return;
              const point = regionPoint(event);
              setSelection({ x0: start.x, y0: start.y, x1: point.x, y1: point.y });
            }}
            onPointerUp={finishRegion}
            onPointerCancel={() => {
              selectionStartRef.current = null;
              setSelection(null);
            }}
          >
            <img src={frozenFrame} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />
            <div className="pointer-events-none absolute inset-0 bg-black/30" />
            {selection ? (
              <div
                className="pointer-events-none absolute border border-primary bg-primary/10"
                style={{
                  left: `${Math.min(selection.x0, selection.x1) * 100}%`,
                  top: `${Math.min(selection.y0, selection.y1) * 100}%`,
                  width: `${Math.abs(selection.x1 - selection.x0) * 100}%`,
                  height: `${Math.abs(selection.y1 - selection.y0) * 100}%`,
                }}
              />
            ) : null}
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow">
              拖动框选区域，截图会复制到剪贴板 · Esc 取消
            </div>
          </div>
        ) : null}

        {annotating && draft === null && annotateDisabledReason === null ? (
          <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow">
            点击元素添加批注 · Esc 退出批注模式
          </div>
        ) : null}

        {draft ? (
          <AnnotationCard
            draft={draft}
            style={cardStyle()}
            readOnly={annotationsReadOnly}
            imageUrl={(annotationId, imageId) => annotationsModel.imageUrl(workspaceId, annotationId, imageId)}
            onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
            onAddImages={(blobs) => void addDraftImages(blobs)}
            onSave={() => void saveDraft()}
            onCancel={cancelDraft}
          />
        ) : null}
      </div>

      {panelOpen ? (
        <AnnotationsPanel
          entry={annotationsEntry}
          currentUrl={isWebUrl(url) ? url : ""}
          missing={pageMissing}
          notice={annotationNotice}
          selectedId={selectedId}
          agents={agentTerminals(tasks, sessionAgents, workspaceId)}
          imageUrl={(annotationId, imageId) => annotationsModel.imageUrl(workspaceId, annotationId, imageId)}
          onClose={() => {
            setPanelOpen(false);
            setSelectedId(null);
          }}
          onRetry={() => void annotationsModel.refresh(workspaceId)}
          onSelect={selectAnnotation}
          onEdit={editAnnotation}
          onConfirm={deleteAnnotation}
          onReopen={reopenAnnotation}
          onClearResolved={clearResolved}
          onCopyMarkdown={copyAnnotationsMarkdown}
          onHandOff={(taskId) => void handOff(taskId)}
        />
      ) : null}
      </div>

      {devtoolsOpen ? (
        // Docked DevTools, below the page (Cursor's default). Its own host node, a later sibling of
        // the page area: opening and closing it never moves the page's webview.
        <div className="relative h-[40%] min-h-24 shrink-0 border-t border-border bg-background">
          <div ref={devtoolsHostRef} className="absolute inset-0" />
          <Tooltip content="关闭控制台 ⌥⌘I" placement="start">
            <button
              type="button"
              aria-label="关闭控制台"
              className="absolute right-1 top-1 z-10 flex size-5 items-center justify-center rounded bg-background/80 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setDevtoolsOpen(false)}
            >
              <X className="size-3" />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

const NEW_TAB_RECENT_COUNT = 5;

/**
 * A blank tab's page. Quiet by design (Cursor's new tab is empty): the tab strip already says what it
 * is and the focused address bar says what to type, so it only lists what is one click away.
 */
function NewTabPage({
  ports,
  recent,
  isRemote,
  onOpen,
}: {
  ports: readonly ForwardedPort[];
  recent: readonly HistoryEntry[];
  isRemote: boolean;
  onOpen: (url: string) => void;
}) {
  const remoteNote = isRemote ? "这个工作区在另一台设备上，localhost 指向那台设备。" : null;

  if (ports.length === 0 && recent.length === 0) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-terminal px-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <Globe className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
          <p className="mt-3 text-sm text-muted-foreground">输入网址、端口号或搜索内容</p>
          {remoteNote ? <p className="mt-1 text-xs text-muted-foreground/70">{remoteNote}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-terminal px-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 pb-10 pt-[12vh]">
        {ports.length > 0 ? (
          <NewTabSection label="转发中的端口">
            {ports.map((preview) => (
              <NewTabRow
                key={preview.url}
                icon={<AppWindow className="size-3.5" />}
                primary={<span className="tabular-nums">localhost:{preview.port}</span>}
                secondary={preview.titles.join("、")}
                onClick={() => onOpen(localPortUrl(preview.port))}
              />
            ))}
          </NewTabSection>
        ) : null}
        {recent.length > 0 ? (
          <NewTabSection label="最近访问">
            {recent.map((entry) => (
              <NewTabRow
                key={entry.url}
                icon={<History className="size-3.5" />}
                primary={entry.title || displayUrl(entry.url)}
                secondary={entry.title ? hostLabel(entry.url) : ""}
                onClick={() => onOpen(entry.url)}
              />
            ))}
          </NewTabSection>
        ) : null}
        {remoteNote ? <p className="px-2 text-xs text-muted-foreground/70">{remoteNote}</p> : null}
      </div>
    </div>
  );
}

function NewTabSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="mb-1 px-2 text-2xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

function NewTabRow({ icon, primary, secondary, onClick }: { icon: ReactNode; primary: ReactNode; secondary: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="group flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <span className="flex shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">{icon}</span>
      <span className="min-w-0 truncate text-sm text-foreground">{primary}</span>
      {secondary ? <span className="ml-auto min-w-0 max-w-[55%] shrink-0 truncate pl-3 text-xs text-muted-foreground">{secondary}</span> : null}
    </button>
  );
}

function FailurePage({
  failure,
  trusting,
  onRetry,
  onTrust,
}: {
  failure: Failure;
  trusting: boolean;
  onRetry: () => void;
  onTrust: (failure: Extract<Failure, { kind: "certificate" }>) => void;
}) {
  const host = hostLabel(failure.url);
  let icon = <WifiOff className="size-5" />;
  let heading = "无法打开此页面";
  let body = "";
  if (failure.kind === "refused") {
    const port = loopbackPortOf(failure.url);
    heading = `无法连接到 ${host}`;
    body = port !== null ? `这个工作区所在设备的 ${port} 端口上没有程序在监听。启动开发服务器后重试。` : "对方拒绝了连接。";
  } else if (failure.kind === "network") {
    body = `${failure.description || "网络错误"}（${failure.code}）`;
  } else if (failure.kind === "tunnel") {
    const port = loopbackPortOf(failure.url);
    if (failure.reason === "refused") {
      heading = `设备上的 localhost:${port ?? ""} 没有服务在监听`;
      body = "在这个工作区的终端里启动开发服务器后重试。";
    } else if (failure.reason === "unsupported") {
      icon = <Unplug className="size-5" />;
      heading = "该设备的 coflux 版本过旧";
      body = "更新后才能在内置浏览器中访问它的 localhost。";
    } else {
      icon = <Unplug className="size-5" />;
      heading = "设备离线或无法连接";
      body = "这个工作区所在的设备现在连不上。确认它在线后重试。";
    }
  } else if (failure.kind === "certificate") {
    icon = <ShieldAlert className="size-5" />;
    heading = "此站点的证书不受信任";
    body = `${failure.host} 出示的证书没有通过验证${failure.certificate?.error ? `（${failure.certificate.error}）` : ""}。只在确认这是你自己的开发服务器时才信任它；信任只对这个工作区生效。`;
  } else if (failure.kind === "crashed") {
    heading = "页面已崩溃";
    body = "重新加载即可恢复。";
  }
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-terminal px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border text-muted-foreground">{icon}</div>
        <h2 className="text-base font-medium text-foreground">{heading}</h2>
        <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{body}</p>
        {failure.kind === "certificate" && failure.certificate ? (
          <dl className="mt-3 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-left text-2xs text-muted-foreground">
            <dt>颁发给</dt>
            <dd className="truncate text-foreground">{failure.certificate.subject || "—"}</dd>
            <dt>颁发者</dt>
            <dd className="truncate text-foreground">{failure.certificate.issuer || "—"}</dd>
            <dt>指纹</dt>
            <dd className="break-all font-mono text-foreground">{failure.certificate.fingerprint}</dd>
          </dl>
        ) : null}
        <p className="mt-2 max-w-full truncate font-mono text-2xs text-muted-foreground">{failure.url}</p>
        <div className="mt-5 flex items-center gap-2">
          {failure.kind === "certificate" ? (
            <Button
              label="信任证书"
              variant="primary"
              size="sm"
              isLoading={trusting}
              isDisabled={!failure.certificate}
              onClick={() => onTrust(failure)}
            />
          ) : null}
          <Button label="重试" variant={failure.kind === "certificate" ? "secondary" : "primary"} size="sm" icon={<RotateCw />} onClick={onRetry} />
        </div>
      </div>
    </div>
  );
}

/** The tab strip chip's leading glyph: spinner while loading, the page's favicon, else a globe. */
export function BrowserTabGlyph({ favicon, loading, className }: { favicon: string | null; loading: boolean; className?: string }) {
  if (loading) return <LoaderCircle className={cn("size-3 shrink-0 animate-spin text-muted-foreground", className)} />;
  if (favicon) return <img src={favicon} alt="" draggable={false} className={cn("size-3 shrink-0 rounded-[2px] object-contain", className)} />;
  return <Globe className={cn("size-3 shrink-0", className)} />;
}
