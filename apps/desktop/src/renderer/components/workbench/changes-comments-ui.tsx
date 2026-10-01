import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot, Check, ChevronDown, ChevronRight, MapPinOff, Pencil, RotateCcw, Trash2, Unplug } from "lucide-react";

import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { Annotation } from "@coflux/protocol";

import { isResolved, type AgentTerminal } from "@/components/workbench/browser-annotations";
import { GrowingInput, IconButton, NumberBadge } from "@/components/workbench/browser-annotations-ui";
import { commentLocation, type CommentSide, type LineRange } from "@/components/workbench/changes-comments";
import { cn } from "@/lib/utils";

/**
 * Code comments UI in the changes view (plan 20261001-changes-review-comments): the composer opened
 * from a line's gutter, the card a saved comment renders as under its lines, the diff header's
 * 「交给 agent ▾」 and the tree's 「其他批注」 section. Built from the browser annotation pieces
 * (number badge, growing input, icon buttons); same statuses and actions as browser annotations.
 *
 * Type scale: comment text and inputs `text-base`; status, location and hints `text-sm`; the
 * number badge `text-xs`.
 */

/** What the diff pane needs to show and edit one file's code comments. */
export type CodeCommentsController = {
  /** The file's code comments, both sides, in number order. */
  annotations: readonly Annotation[];
  /** Whether the `[+]` gutter and the composer are offered. */
  canWrite: boolean;
  /** Shown where the composer would be offered when the device's coflux is too old; else null. */
  hint: string | null;
  /** The device cannot be reached: comments show without actions. */
  readOnly: boolean;
  /** Saves a new comment on `range` of `side` (`excerpt`: those lines' text); resolves to an error
   * message, or null when saved. */
  create: (side: CommentSide, range: LineRange, excerpt: string, comment: string) => Promise<string | null>;
  edit: (annotation: Annotation, comment: string) => Promise<string | null>;
  remove: (annotation: Annotation, confirming: boolean) => void;
  reopen: (annotation: Annotation, comment: string) => Promise<boolean>;
};

/** Not while an input method composes: its Enter and Esc belong to the candidate window. */
function composing(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * A comment input with 取消 and a submit button. It owns Esc (`data-owns-escape`): the workbench's
 * Esc listener then leaves the overlay open and Esc cancels only this input.
 */
export function CommentComposer({
  initial = "",
  placeholder,
  submitLabel,
  label,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  label: string;
  /** Resolves to an error message, or null when done (the caller then closes the composer). */
  onSubmit: (text: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const node = inputRef.current;
    node?.focus({ preventScroll: true });
    node?.setSelectionRange(node.value.length, node.value.length);
    return () => {
      mounted.current = false;
    };
  }, []);

  const canSubmit = !busy && text.trim().length > 0 && text.trim() !== initial.trim();

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const failure = await onSubmit(text.trim());
    if (!mounted.current) return;
    setBusy(false);
    if (failure) setError(failure);
  }

  return (
    <div
      data-owns-escape
      className="flex flex-col gap-1.5"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Esc anywhere in the composer (its input or its buttons) cancels it, and only it.
        if (event.key !== "Escape" || composing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <GrowingInput
        inputRef={inputRef}
        value={text}
        placeholder={placeholder}
        aria-label={label}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          // ⌘↩ saves; a plain ↩ is a new line (comments on code run to several lines).
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || composing(event)) return;
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Tooltip content="Esc" placement="above">
          <Button label="取消" variant="ghost" size="sm" onClick={onCancel} />
        </Tooltip>
        <Tooltip content="⌘↩" placement="above">
          <Button label={error ? "重试" : submitLabel} variant="primary" size="sm" isLoading={busy} isDisabled={!canSubmit} onClick={() => void submit()} />
        </Tooltip>
      </div>
    </div>
  );
}

/** The card a new comment is written in, under the last selected line. */
export function NewCommentCard({ range, onSubmit, onCancel }: { range: LineRange; onSubmit: (text: string) => Promise<string | null>; onCancel: () => void }) {
  const lines = range.end > range.start ? `第 ${range.start + 1}–${range.end + 1} 行` : `第 ${range.start + 1} 行`;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-ring bg-popover p-2 font-sans text-popover-foreground shadow-sm">
      <p className="text-sm text-muted-foreground">评论{lines}</p>
      <CommentComposer placeholder="这里要怎么改？" submitLabel="评论" label="评论内容" onSubmit={onSubmit} onCancel={onCancel} />
    </div>
  );
}

/**
 * A saved code comment: number, status and text; a pending one can be edited or deleted, a resolved
 * one shows the agent's note and offers 「重新打开」 with a follow-up and 「确认」.
 */
export function CodeCommentCard({
  annotation,
  location,
  moved,
  readOnly,
  canEdit = true,
  canReopen = true,
  onEdit,
  onDelete,
  onConfirm,
  onReopen,
}: {
  annotation: Annotation;
  /** Shown in the header (「其他批注」, where the card is not under its lines). */
  location?: string;
  /** The commented lines are no longer in the file. */
  moved?: boolean;
  readOnly: boolean;
  canEdit?: boolean;
  canReopen?: boolean;
  onEdit?: (text: string) => Promise<string | null>;
  onDelete: () => void;
  onConfirm: () => void;
  onReopen?: (text: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "reopen">("view");
  const resolved = isResolved(annotation);

  return (
    <div
      role="group"
      aria-label={`评论 #${annotation.number}`}
      className="group/card flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-popover p-2 font-sans text-popover-foreground shadow-sm"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <NumberBadge number={annotation.number} resolved={resolved} />
        <span className="shrink-0 text-sm text-muted-foreground">{resolved ? "已处理 · 等你确认" : "待处理"}</span>
        {annotation.followUps.length > 0 && !resolved ? <span className="shrink-0 text-sm text-muted-foreground">· 已重新打开</span> : null}
        {moved ? (
          <span className="flex shrink-0 items-center gap-0.5 text-sm text-warning">
            <MapPinOff className="size-3" />
            原位置已变化
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{location ?? ""}</span>
        {!readOnly && mode === "view" && !resolved ? (
          <span className="flex shrink-0 items-center">
            {canEdit && onEdit ? (
              <IconButton label="编辑" onClick={() => setMode("edit")}>
                <Pencil className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton label="删除" tone="danger" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </span>
        ) : null}
      </div>
      {mode === "edit" && onEdit ? (
        <CommentComposer
          initial={annotation.comment}
          placeholder="这里要怎么改？"
          submitLabel="保存"
          label="评论内容"
          onSubmit={async (text) => {
            const failure = await onEdit(text);
            if (!failure) setMode("view");
            return failure;
          }}
          onCancel={() => setMode("view")}
        />
      ) : (
        <p className={cn("whitespace-pre-wrap break-words text-base", resolved ? "text-muted-foreground" : "text-foreground")}>{annotation.comment}</p>
      )}
      {resolved ? (
        <div className="rounded-md bg-muted/60 px-2 py-1.5">
          <p className="text-sm text-muted-foreground">Agent 的说明</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-base text-foreground">{annotation.resolutionNote || "（没有留下说明）"}</p>
        </div>
      ) : null}
      {readOnly || !resolved ? null : mode === "reopen" && onReopen ? (
        <CommentComposer
          placeholder="还有哪里不对？"
          submitLabel="重新打开"
          label="重新打开的补充说明"
          onSubmit={async (text) => {
            const ok = await onReopen(text);
            if (ok) setMode("view");
            return ok ? null : "重新打开失败，可以重试";
          }}
          onCancel={() => setMode("view")}
        />
      ) : (
        <div className="flex justify-end gap-1.5">
          {canReopen && onReopen ? (
            <Button label="重新打开" variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setMode("reopen")} />
          ) : null}
          <Button label="确认" variant="secondary" size="sm" icon={<Check className="size-3.5" />} onClick={onConfirm} />
        </div>
      )}
    </div>
  );
}

/** The diff header's 「交给 agent ▾」: a DropdownMenu trigger, so its tooltip is a sibling. */
export function CommentsHandOffMenu({ agents, disabled, onHandOff }: { agents: readonly AgentTerminal[]; disabled: boolean; onHandOff: (taskId: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <DropdownMenu
        isMenuOpen={open}
        onOpenChange={setOpen}
        menuWidth={240}
        hasChevron={false}
        placement="below"
        alignment="end"
        button={{
          ref: anchorRef,
          label: "交给 agent",
          icon: <ChevronDown className="size-3" />,
          variant: "ghost",
          size: "sm",
          isDisabled: disabled,
          style: { color: "var(--muted-foreground)", height: 24, paddingInline: 6, gap: 4, flexShrink: 0 },
        }}
      >
        {agents.length === 0 ? (
          <DropdownMenuItem label="这个工作区没有正在运行 agent 的终端" isDisabled onClick={() => undefined} />
        ) : (
          agents.map((agent) => (
            <DropdownMenuItem key={agent.taskId} icon={<Bot className="size-3.5" />} label={`${agent.title || "终端"} · ${agent.agent}`} onClick={() => onHandOff(agent.taskId)} />
          ))
        )}
      </DropdownMenu>
      <Tooltip anchorRef={anchorRef} isOpen={open ? false : undefined} content="把待处理的批注交给这个工作区里的 agent" />
    </>
  );
}

/** The bar shown where the composer would be offered when the device's coflux predates code comments. */
export function CommentsOutdatedHint({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-sans text-sm text-muted-foreground">
      <Unplug className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

/**
 * 「其他批注」: code comments on files the current list does not show (another scope, a reverted
 * file), or every comment while there is no list. They can be read, confirmed or deleted.
 */
export function OtherCommentsSection({
  comments,
  readOnly,
  onDelete,
  onConfirm,
  className,
}: {
  comments: readonly Annotation[];
  readOnly: boolean;
  onDelete: (annotation: Annotation) => void;
  onConfirm: (annotation: Annotation) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  if (comments.length === 0) return null;
  return (
    <section aria-label="其他批注" className={cn("flex min-h-0 flex-col border-t border-border bg-background", className)}>
      <button
        type="button"
        aria-expanded={open}
        className="flex h-8 w-full shrink-0 items-center gap-1 px-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">其他批注 · {comments.length}</span>
      </button>
      {open ? (
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
          {comments.map((annotation) => (
            <CodeCommentCard
              key={annotation.annotationId}
              annotation={annotation}
              location={commentLocation(annotation)}
              readOnly={readOnly}
              canEdit={false}
              canReopen={false}
              onDelete={() => onDelete(annotation)}
              onConfirm={() => onConfirm(annotation)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
