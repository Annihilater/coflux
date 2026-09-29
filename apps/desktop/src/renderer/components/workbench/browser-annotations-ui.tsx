import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot, Check, ChevronDown, CircleCheck, Copy, ImagePlus, LoaderCircle, MapPinOff, Pencil, RotateCcw, Trash2, Unplug, WifiOff, X } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { AnnotationImageKind, type Annotation, type AnnotationImage } from "@coflux/protocol";

import { groupByPage, isResolved, pageKey, type AgentTerminal } from "@/components/workbench/browser-annotations";
import type { WorkspaceAnnotations } from "@/components/workbench/browser-annotations-model";
import { displayUrl } from "@/components/workbench/browser-address";
import type { DesktopAnnotatorPick } from "@/desktop-bridge";
import { cn } from "@/lib/utils";

/**
 * Browser annotations UI (plan 20260929-browser-annotations): the comment card anchored to the
 * picked element, and the side panel listing the workspace's annotations. Both are renderer UI
 * drawn over / beside the `<webview>`; the page itself only shows highlights and pins.
 */

/** Pasted and attached images are compressed to this budget (the terminal paste path's value). */
const IMAGE_BUDGET_BYTES = 3.5 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;

export type DraftImage = { key: string; dataUrl: string; mimeType: string; data: Uint8Array; kind: "screenshot" | "reference" };

/** An annotation being written: a new one for a pick, or an edit of a stored one. */
export type AnnotationDraft = {
  key: string;
  annotationId: string | null;
  number: number | null;
  pick: DesktopAnnotatorPick | null;
  comment: string;
  images: DraftImage[];
  existing: AnnotationImage[];
  removed: string[];
  saving: boolean;
  error: string | null;
};

type ImageUrl = (annotationId: string, imageId: string) => Promise<string | null>;

function bytesToDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** An attached image as the worker stores it: kept when small enough and of a known type, else JPEG within the budget. */
export async function prepareReferenceImage(blob: Blob): Promise<DraftImage | null> {
  if (!blob.type.startsWith("image/")) return null;
  const keep = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type) && blob.size <= IMAGE_BUDGET_BYTES;
  let mimeType = blob.type;
  let data: Uint8Array;
  if (keep) {
    data = new Uint8Array(await blob.arrayBuffer());
  } else {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return null;
    let width = bitmap.width;
    let height = bitmap.height;
    let best: Blob | null = null;
    for (let round = 0; round < 5 && !(best && best.size <= IMAGE_BUDGET_BYTES); round += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (encoded && (!best || encoded.size < best.size)) best = encoded;
        if (best && best.size <= IMAGE_BUDGET_BYTES) break;
      }
      width /= 2;
      height /= 2;
    }
    if (!best) return null;
    mimeType = "image/jpeg";
    data = new Uint8Array(await best.arrayBuffer());
  }
  return { key: crypto.randomUUID(), dataUrl: bytesToDataUrl(data, mimeType), mimeType, data, kind: "reference" };
}

function StoredThumb({ annotationId, image, imageUrl, onRemove }: { annotationId: string; image: AnnotationImage; imageUrl: ImageUrl; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void imageUrl(annotationId, image.imageId).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [annotationId, image.imageId, imageUrl]);
  return <Thumb src={url} label={image.kind === AnnotationImageKind.SCREENSHOT ? "截图" : "参考图"} onRemove={onRemove} />;
}

function Thumb({ src, label, onRemove }: { src: string | null; label: string; onRemove?: () => void }) {
  return (
    <div className="group relative size-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      {src ? <img src={src} alt={label} draggable={false} className="size-full object-cover" /> : <LoaderCircle className="m-auto mt-4 size-4 animate-spin text-muted-foreground" />}
      <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 text-center text-[10px] leading-4 text-white">{label}</span>
      {onRemove ? (
        <Tooltip content="移除" placement="above">
          <button
            type="button"
            aria-label={`移除${label}`}
            className="absolute right-0.5 top-0.5 hidden size-4 items-center justify-center rounded-full bg-black/70 text-white group-hover:flex"
            onClick={onRemove}
          >
            <X className="size-2.5" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function AnnotationCard({
  draft,
  style,
  readOnly,
  imageUrl,
  onChange,
  onAddImages,
  onSave,
  onCancel,
}: {
  draft: AnnotationDraft;
  style: CSSProperties;
  readOnly: boolean;
  imageUrl: ImageUrl;
  onChange: (patch: Partial<AnnotationDraft>) => void;
  onAddImages: (blobs: Blob[]) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [draft.key]);

  const element = draft.pick?.element;
  const heading = draft.annotationId ? `编辑批注 #${draft.number ?? ""}` : element ? `<${element.tag}${element.elementId ? `#${element.elementId}` : ""}>` : "新批注";
  const references = draft.images.filter((image) => image.kind === "reference").length + draft.existing.filter((image) => image.kind === AnnotationImageKind.REFERENCE && !draft.removed.includes(image.imageId)).length;
  const canSave = !readOnly && !draft.saving && draft.comment.trim().length > 0;

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave();
    }
  }

  function onPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    onAddImages(files);
  }

  return (
    <div
      role="dialog"
      aria-label="批注"
      className="pointer-events-auto absolute z-30 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{heading}</span>
        {draft.pick?.source?.components[0] ? <span className="max-w-32 truncate text-2xs text-muted-foreground">{draft.pick.source.components[0]}</span> : null}
        <Tooltip content="取消 Esc" placement="above">
          <button type="button" aria-label="取消" className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onCancel}>
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <textarea
        ref={inputRef}
        value={draft.comment}
        rows={3}
        disabled={readOnly || draft.saving}
        placeholder="这里要怎么改？可以粘贴参考图"
        aria-label="批注内容"
        className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
        onChange={(event) => onChange({ comment: event.target.value, error: null })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {draft.annotationId
          ? draft.existing
              .filter((image) => !draft.removed.includes(image.imageId))
              .map((image) => (
                <StoredThumb
                  key={image.imageId}
                  annotationId={draft.annotationId!}
                  image={image}
                  imageUrl={imageUrl}
                  onRemove={readOnly ? undefined : () => onChange({ removed: [...draft.removed, image.imageId] })}
                />
              ))
          : null}
        {draft.images.map((image) => (
          <Thumb
            key={image.key}
            src={image.dataUrl}
            label={image.kind === "screenshot" ? "截图" : "参考图"}
            onRemove={readOnly ? undefined : () => onChange({ images: draft.images.filter((item) => item.key !== image.key) })}
          />
        ))}
        {!readOnly && references < MAX_REFERENCE_IMAGES ? (
          <Tooltip content="附加参考图（也可以直接粘贴）" placement="above">
            <button
              type="button"
              aria-label="附加参考图"
              className="flex size-14 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" />
            </button>
          </Tooltip>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) onAddImages(files);
          }}
        />
      </div>
      {draft.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {draft.error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">⌘↩ 保存 · 保存在这个工作区所在的设备上</span>
        <Button label="取消" variant="secondary" size="sm" isDisabled={draft.saving} onClick={onCancel} />
        <Button label={draft.error ? "重试" : "保存"} variant="primary" size="sm" isDisabled={!canSave} isLoading={draft.saving} onClick={onSave} />
      </div>
    </div>
  );
}

export type PanelNotice = "offline" | "unsupported" | "unreachable" | null;

export function AnnotationsPanel({
  entry,
  currentUrl,
  missing,
  notice,
  selectedId,
  agents,
  imageUrl,
  onClose,
  onRetry,
  onSelect,
  onEdit,
  onConfirm,
  onReopen,
  onClearResolved,
  onCopyMarkdown,
  onHandOff,
}: {
  entry: WorkspaceAnnotations;
  currentUrl: string;
  /** Annotations of the current page whose element the page does not have. */
  missing: ReadonlySet<string>;
  notice: PanelNotice;
  selectedId: string | null;
  agents: readonly AgentTerminal[];
  imageUrl: ImageUrl;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onConfirm: (annotation: Annotation) => Promise<void>;
  onReopen: (annotation: Annotation, comment: string) => Promise<boolean>;
  onClearResolved: () => Promise<void>;
  onCopyMarkdown: () => void;
  onHandOff: (taskId: string) => void;
}) {
  const [handOffOpen, setHandOffOpen] = useState(false);
  const handOffRef = useRef<HTMLButtonElement | null>(null);
  const annotations = entry.annotations ?? [];
  const pending = annotations.filter((annotation) => !isResolved(annotation));
  const resolved = annotations.filter(isResolved);
  const readOnly = notice !== null;
  const currentKey = currentUrl ? pageKey(currentUrl) : "";

  return (
    <aside aria-label="批注" className="flex w-72 shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          批注{pending.length > 0 ? ` · ${pending.length} 条待处理` : ""}
        </span>
        <DropdownMenu
          isMenuOpen={handOffOpen}
          onOpenChange={setHandOffOpen}
          menuWidth={240}
          hasChevron={false}
          placement="below"
          alignment="end"
          button={{
            ref: handOffRef,
            label: "交给 agent",
            icon: <ChevronDown className="size-3" />,
            variant: "ghost",
            size: "sm",
            isDisabled: readOnly || pending.length === 0,
          }}
        >
          {agents.length === 0 ? (
            <DropdownMenuItem label="这个工作区没有正在运行 agent 的终端" isDisabled onClick={() => undefined} />
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem
                key={agent.taskId}
                icon={<Bot className="size-3.5" />}
                label={`${agent.title || "终端"} · ${agent.agent}`}
                onClick={() => onHandOff(agent.taskId)}
              />
            ))
          )}
        </DropdownMenu>
        <Tooltip anchorRef={handOffRef} isOpen={handOffOpen ? false : undefined} content="把待处理的批注交给这个工作区里的 agent" />
        <Tooltip content="复制为 markdown" placement="below">
          <button
            type="button"
            aria-label="复制为 markdown"
            disabled={annotations.length === 0}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35"
            onClick={onCopyMarkdown}
          >
            <Copy className="size-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="关闭批注列表" placement="below">
          <button type="button" aria-label="关闭批注列表" className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </Tooltip>
      </div>

      {notice ? <Notice notice={notice} onRetry={onRetry} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entry.annotations === null && entry.loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : annotations.length === 0 && !notice ? (
          <p className="px-4 py-8 text-center text-xs leading-5 text-muted-foreground">
            还没有批注。打开批注模式（工具栏的 <Pencil className="inline size-3" />），然后点击页面上的元素写下要怎么改。
          </p>
        ) : null}

        {groupByPage(pending).map((group) => (
          <section key={group.key} className="border-b border-border py-1">
            <h3 className="truncate px-3 pb-0.5 pt-1.5 text-2xs font-medium text-muted-foreground">
              {group.title || displayUrl(group.url)}
              {group.key === currentKey ? " · 当前页面" : ""}
            </h3>
            {group.annotations.map((annotation) => (
              <PendingRow
                key={annotation.annotationId}
                annotation={annotation}
                selected={annotation.annotationId === selectedId}
                missing={group.key === currentKey && missing.has(annotation.annotationId)}
                readOnly={readOnly}
                onSelect={() => onSelect(annotation)}
                onEdit={() => onEdit(annotation)}
                onDelete={() => onConfirm(annotation)}
              />
            ))}
          </section>
        ))}

        {resolved.length > 0 ? (
          <section className="py-1">
            <div className="flex items-center gap-2 px-3 pb-0.5 pt-1.5">
              <h3 className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">已完成 · 等你确认</h3>
              {!readOnly ? (
                <button type="button" className="text-2xs text-muted-foreground hover:text-foreground" onClick={() => void onClearResolved()}>
                  清除全部已完成
                </button>
              ) : null}
            </div>
            {resolved
              .sort((a, b) => a.number - b.number)
              .map((annotation) => (
                <ResolvedRow
                  key={annotation.annotationId}
                  annotation={annotation}
                  selected={annotation.annotationId === selectedId}
                  readOnly={readOnly}
                  imageUrl={imageUrl}
                  onSelect={() => onSelect(annotation)}
                  onConfirm={() => onConfirm(annotation)}
                  onReopen={(comment) => onReopen(annotation, comment)}
                />
              ))}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function Notice({ notice, onRetry }: { notice: Exclude<PanelNotice, null>; onRetry: () => void }) {
  const content =
    notice === "unsupported"
      ? { icon: <Unplug className="size-3.5 shrink-0" />, text: "该设备 coflux 版本过旧，更新后才能使用浏览器批注。", retry: false }
      : notice === "offline"
        ? { icon: <WifiOff className="size-3.5 shrink-0" />, text: "设备离线：下面是上次加载的批注，只能查看。", retry: true }
        : { icon: <WifiOff className="size-3.5 shrink-0" />, text: "连不上这个工作区所在的设备，批注暂时只能查看。", retry: true };
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {content.icon}
      <span className="min-w-0 flex-1 leading-4">{content.text}</span>
      {content.retry ? (
        <button type="button" className="shrink-0 text-foreground hover:underline" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

function sourceLabel(annotation: Annotation): string {
  const source = annotation.source;
  if (!source) return "";
  if (source.components.length > 0) return source.components.slice(0, 2).join(" ‹ ");
  return source.file ? source.file.split("/").pop() ?? "" : "";
}

function PendingRow({
  annotation,
  selected,
  missing,
  readOnly,
  onSelect,
  onEdit,
  onDelete,
}: {
  annotation: Annotation;
  selected: boolean;
  missing: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const source = sourceLabel(annotation);
  return (
    <div
      className={cn("group flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/60", selected && "bg-accent")}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
    >
      <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-white">{annotation.number}</span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-foreground">{annotation.comment}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {missing ? (
            <span className="flex shrink-0 items-center gap-0.5 text-warning">
              <MapPinOff className="size-3" />
              元素未找到
            </span>
          ) : null}
          {source ? <span className="truncate font-mono">{source}</span> : <span className="truncate font-mono">{annotation.element?.tag ? `<${annotation.element.tag}>` : ""}</span>}
          {annotation.followUps.length > 0 ? <span className="shrink-0">· 已重新打开</span> : null}
        </div>
      </div>
      {!readOnly ? (
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <Tooltip content="编辑" placement="above">
            <button
              type="button"
              aria-label="编辑批注"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Pencil className="size-3" />
            </button>
          </Tooltip>
          <Tooltip content="删除" placement="above">
            <button
              type="button"
              aria-label="删除批注"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                void onDelete();
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}

function ResolvedRow({
  annotation,
  selected,
  readOnly,
  imageUrl,
  onSelect,
  onConfirm,
  onReopen,
}: {
  annotation: Annotation;
  selected: boolean;
  readOnly: boolean;
  imageUrl: ImageUrl;
  onSelect: () => void;
  onConfirm: () => Promise<void>;
  onReopen: (comment: string) => Promise<boolean>;
}) {
  const [reopening, setReopening] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenshots = annotation.images.filter((image) => image.kind === AnnotationImageKind.SCREENSHOT).slice(0, 1);

  async function submitReopen() {
    if (!comment.trim() || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onReopen(comment.trim());
    setBusy(false);
    if (ok) {
      setReopening(false);
      setComment("");
    } else setError("重新打开失败，可以重试");
  }

  return (
    <div className={cn("px-3 py-1.5 hover:bg-accent/40", selected && "bg-accent")}>
      <div className="flex cursor-pointer items-start gap-2" onClick={onSelect}>
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground line-through decoration-muted-foreground/40">{annotation.comment}</p>
          {annotation.resolutionNote ? (
            <p className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/60 px-1.5 py-1 text-xs text-foreground">
              <span className="text-2xs text-muted-foreground">Agent：</span>
              {annotation.resolutionNote}
            </p>
          ) : null}
        </div>
        {screenshots.map((image) => (
          <StoredThumb key={image.imageId} annotationId={annotation.annotationId} image={image} imageUrl={imageUrl} />
        ))}
      </div>
      {!readOnly ? (
        reopening ? (
          <div className="mt-1.5 pl-6">
            <textarea
              value={comment}
              rows={2}
              autoFocus
              placeholder="还有哪里不对？"
              aria-label="重新打开的补充说明"
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") setReopening(false);
                else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submitReopen();
              }}
            />
            {error ? <p className="text-2xs text-destructive">{error}</p> : null}
            <div className="mt-1 flex justify-end gap-1.5">
              <Button label="取消" variant="ghost" size="sm" onClick={() => setReopening(false)} />
              <Button label="重新打开" variant="primary" size="sm" isLoading={busy} isDisabled={!comment.trim()} onClick={() => void submitReopen()} />
            </div>
          </div>
        ) : (
          <div className="mt-1 flex justify-end gap-1 pl-6">
            <Button label="重新打开" variant="ghost" size="sm" icon={<RotateCcw className="size-3" />} onClick={() => setReopening(true)} />
            <Button label="确认" variant="secondary" size="sm" icon={<Check className="size-3" />} onClick={() => void onConfirm()} />
          </div>
        )
      ) : null}
    </div>
  );
}

/** The toolbar's 「✎ n」: toggles annotate mode; the count is the workspace's pending annotations. */
export function AnnotateToggle({
  active,
  count,
  disabledReason,
  onToggle,
}: {
  active: boolean;
  count: number;
  disabledReason: string | null;
  onToggle: () => void;
}) {
  const label = disabledReason ?? (active ? "退出批注模式 Esc" : "批注模式：点击页面元素添加批注");
  return (
    <Tooltip content={label} placement="below">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabledReason !== null}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs tabular-nums transition-colors disabled:opacity-35 disabled:hover:bg-transparent",
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={onToggle}
      >
        <Pencil className="size-3.5" />
        {count > 0 ? <span>{count}</span> : null}
      </button>
    </Tooltip>
  );
}
