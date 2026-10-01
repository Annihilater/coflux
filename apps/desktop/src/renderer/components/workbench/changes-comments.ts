import { AnnotationCodeSide, AnnotationStatus, type Annotation, type AnnotationCodeAnchor } from "@coflux/protocol";
import type { ChangedFile } from "@coflux/client";

/**
 * Code comments in the changes view (plan 20261001-changes-review-comments), pure side: which file
 * and side a comment belongs to, where its lines are in the current content, the excerpt stored
 * with a new one, and the tree's per-file counts.
 *
 * A code comment is an annotation with a code anchor; the worker stores it like a browser
 * annotation and never rewrites the anchor. Its line range is a hint: the lines are re-found by
 * their stored text, nearest to the hint, so a comment follows its code as the file changes.
 */

/** A diff side as the diff pane names it: `old` is the comparison base, `new` the working tree. */
export type CommentSide = "old" | "new";

/** 0-based, inclusive line indexes into one side's lines. */
export type LineRange = { start: number; end: number };

/** The excerpt kept with a comment is cut at a line boundary below the worker's own cap. */
export const EXCERPT_MAX_CHARS = 6000;
export const EXCERPT_MAX_LINES = 200;

export function anchorSide(anchor: AnnotationCodeAnchor): CommentSide {
  return anchor.side === AnnotationCodeSide.BASE ? "old" : "new";
}

export function wireSide(side: CommentSide): AnnotationCodeSide {
  return side === "old" ? AnnotationCodeSide.BASE : AnnotationCodeSide.WORKING_TREE;
}

/** The path a changed file has on `side`: a rename's old path on the base side. */
export function sidePath(file: ChangedFile, side: CommentSide): string {
  return side === "old" ? (file.oldPath ?? file.path) : file.path;
}

/** Whether a code comment is on `file` (on either of its sides). */
export function commentIsOnFile(annotation: Annotation, file: ChangedFile): boolean {
  const anchor = annotation.code;
  if (!anchor) return false;
  return anchor.path === sidePath(file, anchorSide(anchor));
}

export function isPendingComment(annotation: Annotation): boolean {
  return annotation.status !== AnnotationStatus.RESOLVED;
}

/**
 * The comments of each listed file (keyed by the file's working-tree path), and the ones on no file
 * of the list (another scope, a reverted file), for 「其他批注」. Each list is in number order.
 */
export function groupCommentsByFile(
  comments: readonly Annotation[],
  files: readonly ChangedFile[],
): { byPath: Map<string, Annotation[]>; others: Annotation[] } {
  const working = new Map<string, ChangedFile>();
  const base = new Map<string, ChangedFile>();
  for (const file of files) {
    working.set(file.path, file);
    base.set(file.oldPath ?? file.path, file);
  }
  const byPath = new Map<string, Annotation[]>();
  const others: Annotation[] = [];
  for (const annotation of [...comments].sort((a, b) => a.number - b.number)) {
    const anchor = annotation.code;
    if (!anchor) continue;
    const file = anchorSide(anchor) === "old" ? base.get(anchor.path) : working.get(anchor.path);
    if (!file) {
      others.push(annotation);
      continue;
    }
    const list = byPath.get(file.path);
    if (list) list.push(annotation);
    else byPath.set(file.path, [annotation]);
  }
  return { byPath, others };
}

/** Pending comments per file, for the tree's badges. Files without any are absent. */
export function pendingCommentCounts(byPath: ReadonlyMap<string, readonly Annotation[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [path, list] of byPath) {
    const pending = list.filter(isPendingComment).length;
    if (pending > 0) counts.set(path, pending);
  }
  return counts;
}

/** The commented lines' text stored with a new comment: whole lines, within the caps (at least the
 * first line, cut only when it alone is over the character cap). */
export function buildExcerpt(lines: readonly string[], range: LineRange): string {
  const kept: string[] = [];
  let chars = 0;
  for (let line = range.start; line <= range.end && line < lines.length; line += 1) {
    const text = lines[line] ?? "";
    if (kept.length >= EXCERPT_MAX_LINES) break;
    if (kept.length === 0) {
      const first = text.slice(0, EXCERPT_MAX_CHARS);
      kept.push(first);
      chars = first.length;
      continue;
    }
    if (chars + 1 + text.length > EXCERPT_MAX_CHARS) break;
    kept.push(text);
    chars += 1 + text.length;
  }
  return kept.join("\n");
}

/** Indentation and trailing whitespace do not count when re-finding lines. */
function normalized(line: string | undefined): string {
  return (line ?? "").trim();
}

/**
 * Where a comment's lines are in `lines` (the anchor side's current content): the stored range when
 * its text is still there, else the occurrence of the stored text nearest to it, else null (the
 * lines are gone — shown as 「原位置已变化」). The located range keeps the stored span.
 */
export function locateAnchor(lines: readonly string[], anchor: AnnotationCodeAnchor): LineRange | null {
  if (anchor.startLine < 1 || anchor.endLine < anchor.startLine) return null;
  const span = anchor.endLine - anchor.startLine;
  const hint = anchor.startLine - 1;
  const range = (start: number): LineRange => ({ start, end: Math.min(lines.length - 1, start + span) });
  if (!anchor.excerpt) {
    // Nothing to match against: the stored range, while it still fits.
    return anchor.endLine <= lines.length ? range(hint) : null;
  }
  const wanted = anchor.excerpt.split("\n").map(normalized);
  const matchesAt = (at: number) => {
    if (at < 0 || at + wanted.length > lines.length) return false;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (normalized(lines[at + offset]) !== wanted[offset]) return false;
    }
    return true;
  };
  if (matchesAt(hint)) return range(hint);
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = 0; at + wanted.length <= lines.length; at += 1) {
    if (normalized(lines[at]) !== wanted[0] || !matchesAt(at)) continue;
    const distance = Math.abs(at - hint);
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
  }
  return best >= 0 ? range(best) : null;
}

/** `src/a.ts:3-5`, with 「基准」 for a base-side comment: the location 「其他批注」 shows. */
export function commentLocation(annotation: Annotation): string {
  const anchor = annotation.code;
  if (!anchor) return "";
  const lines = anchor.endLine > anchor.startLine ? `${anchor.startLine}-${anchor.endLine}` : `${anchor.startLine}`;
  return `${anchor.path}:${lines}${anchorSide(anchor) === "old" ? "（基准）" : ""}`;
}
