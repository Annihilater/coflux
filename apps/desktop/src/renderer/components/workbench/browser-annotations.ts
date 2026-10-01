import { AnnotationImageKind, AnnotationStatus, TaskStatus, type Annotation, type AnnotationTarget, type Task } from "@coflux/protocol";
import type { SessionAgentState } from "@coflux/client";

import type { DesktopAnnotatorLocator, DesktopAnnotatorPin } from "@/desktop-bridge";

/**
 * Pure helpers of browser annotations (plans 20260929-browser-annotations,
 * 20260929-annotation-polish), renderer side: which page an annotation belongs to, the pins a page
 * shows, how an annotation's elements are named (card titles, panel meta lines), where a card goes,
 * the agent terminals 「交给 agent」 offers, the instruction it types, and 「复制为 markdown」.
 */

/** The instruction 「交给 agent」 types into an agent's terminal (one line; Enter follows). Shared
 * by the browser panel and the changes view (plan 20261001-changes-review-comments): `coflux
 * annotations list` returns both kinds, so one hand-off covers everything pending. */
export const HAND_OFF_INSTRUCTION =
  "处理 coflux 批注（浏览器批注和代码评论）：运行 coflux annotations list 查看，每条改完后用 coflux annotations resolve <id> --note \"改了什么\" 标记";

/** A code comment from the changes view (plan 20261001-changes-review-comments): an annotation
 * with a code anchor instead of page targets. Each surface shows only its own kind. */
export function isCodeAnnotation(annotation: Annotation): boolean {
  return annotation.code !== undefined;
}

/** The annotations the browser panel, its pins and its count show: page annotations only. */
export function pageAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return annotations.filter((annotation) => !isCodeAnnotation(annotation));
}

/** The annotations the changes view shows: code comments only. */
export function codeAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return annotations.filter(isCodeAnnotation);
}

/** A page's identity for grouping and pins: origin + path, without query or hash. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return url;
  }
}

export function isResolved(annotation: Annotation): boolean {
  return annotation.status === AnnotationStatus.RESOLVED;
}

export type AnnotationPageGroup = { key: string; url: string; title: string; annotations: Annotation[] };

/** Annotations grouped by page, pages in order of their first annotation, each group by number. */
export function groupByPage(annotations: readonly Annotation[]): AnnotationPageGroup[] {
  const groups = new Map<string, AnnotationPageGroup>();
  const sorted = [...annotations].sort((a, b) => a.number - b.number);
  for (const annotation of sorted) {
    const key = pageKey(annotation.pageUrl);
    let group = groups.get(key);
    if (!group) {
      group = { key, url: annotation.pageUrl, title: annotation.pageTitle, annotations: [] };
      groups.set(key, group);
    }
    if (!group.title && annotation.pageTitle) group.title = annotation.pageTitle;
    group.annotations.push(annotation);
  }
  return [...groups.values()];
}

function locatorOf(target: AnnotationTarget): DesktopAnnotatorLocator {
  const element = target.element;
  return {
    selector: element?.selector ?? "",
    domPath: element?.domPath ?? "",
    tag: element?.tag ?? "",
    text: element?.text ?? "",
    elementId: element?.elementId ?? "",
    classes: element?.classes ?? [],
  };
}

/** The pins the page at `url` shows: every annotation of that page, resolved ones as checks. */
export function pinsForPage(annotations: readonly Annotation[], url: string): DesktopAnnotatorPin[] {
  const key = pageKey(url);
  return annotations
    .filter((annotation) => pageKey(annotation.pageUrl) === key && annotation.targets.length > 0)
    .map((annotation) => ({
      id: annotation.annotationId,
      number: annotation.number,
      resolved: isResolved(annotation),
      targets: annotation.targets.map(locatorOf),
      region: annotation.region ? { x: annotation.region.x, y: annotation.region.y, width: annotation.region.width, height: annotation.region.height } : null,
    }));
}

/** An element as the UI names it: a stored target or a fresh pick's. */
export type TargetLike = {
  element?: { tag: string; classes: readonly string[] } | undefined;
  source?: { components: readonly string[] } | null | undefined;
};

/** `tag.class`, the fallback name of an element without source identity. */
export function tagLabel(target: TargetLike): string {
  const element = target.element;
  if (!element?.tag) return "元素";
  const firstClass = element.classes.find((name) => name.length > 0 && name.length <= 40);
  return firstClass ? `${element.tag}.${firstClass}` : element.tag;
}

/** An element's short name: its innermost component, else `tag.class`. */
export function targetLabel(target: TargetLike): string {
  return target.source?.components[0] || tagLabel(target);
}

/** An element's component chain, innermost first (`Button ‹ Header ‹ App`), else `tag.class`. */
export function componentChain(target: TargetLike, depth = 3): string {
  const components = target.source?.components ?? [];
  return components.length > 0 ? components.slice(0, depth).join(" ‹ ") : tagLabel(target);
}

/**
 * A card's title: the component chain of one element, 「3 个元素 · Button、Card、Nav」 for a
 * selection, 「区域 · Header」 for a region (named after the element containing it).
 */
export function annotationTitle(targets: readonly TargetLike[], isRegion: boolean): string {
  const first = targets[0];
  if (!first) return "批注";
  if (isRegion) return `区域 · ${targetLabel(first)}`;
  if (targets.length > 1) {
    const names = targets.slice(0, 3).map(targetLabel).join("、");
    return `${targets.length} 个元素 · ${names}${targets.length > 3 ? "…" : ""}`;
  }
  return componentChain(first);
}

/** A panel row's meta line: the component, 「n 个元素」 or 「区域」. */
export function annotationMeta(annotation: Annotation): string {
  if (annotation.region) return "区域";
  if (annotation.targets.length > 1) return `${annotation.targets.length} 个元素`;
  const first = annotation.targets[0];
  return first ? componentChain(first, 2) : "";
}

export type CardBox = { x: number; y: number; width: number; height: number };

/**
 * Where a card goes in the page area (its top-left corner, in the area's pixels), from its real
 * size: below the anchor when it fits, else above, else on the roomier side — and always inside the
 * area. Without an anchor (the element is not on the page) it sits in the top-right corner.
 */
export function cardPlacement(
  anchor: CardBox | null,
  card: { width: number; height: number },
  area: { width: number; height: number },
  gap = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(gap, area.width - card.width - gap);
  const maxTop = Math.max(gap, area.height - card.height - gap);
  const clamp = (value: number, max: number) => Math.min(Math.max(value, gap), max);
  if (!anchor) return { left: maxLeft, top: gap };
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - card.height;
  let top: number;
  if (below + card.height <= area.height - gap) top = below;
  else if (above >= gap) top = above;
  else top = area.height - below >= anchor.y ? below : above;
  return { left: clamp(anchor.x, maxLeft), top: clamp(top, maxTop) };
}

/**
 * The toolbar's count segment: pending, or ✓ with the resolved count, or nothing at all. Counted
 * from the loaded `annotations` (the caller passes only its own kind); the center's summary, which
 * counts every kind, is only the fallback before the first load.
 */
export function annotationCount(
  summary: { pending: number; resolved: number } | undefined,
  annotations: readonly Annotation[] | null,
): { kind: "pending" | "resolved"; count: number } | null {
  const pending = annotations ? annotations.filter((annotation) => !isResolved(annotation)).length : (summary?.pending ?? 0);
  const resolved = annotations ? annotations.filter(isResolved).length : (summary?.resolved ?? 0);
  if (pending > 0) return { kind: "pending", count: pending };
  if (resolved > 0) return { kind: "resolved", count: resolved };
  return null;
}

export type AgentTerminal = { taskId: string; title: string; agent: string };

/** The workspace's running terminals with an agent in them, for 「交给 agent ▾」. */
export function agentTerminals(tasks: readonly Task[], sessionAgents: Readonly<Record<string, SessionAgentState>>, workspaceId: string): AgentTerminal[] {
  const out: AgentTerminal[] = [];
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.status !== TaskStatus.RUNNING || !task.sessionId) continue;
    const agent = sessionAgents[task.sessionId];
    if (!agent?.agent) continue;
    out.push({ taskId: task.id, title: task.title, agent: agent.agent });
  }
  return out;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function code(value: string): string {
  return value.includes("`") ? `\`\`${value}\`\`` : `\`${value}\``;
}

/** 「复制为 markdown」: the workspace's annotations as the agent-facing markdown, pages grouped. */
export function annotationsMarkdown(annotations: readonly Annotation[], workspaceLabel: string): string {
  const lines: string[] = [`# Browser annotations · ${workspaceLabel}`];
  for (const group of groupByPage(annotations)) {
    lines.push("", `## ${group.title ? `${oneLine(group.title)} — ` : ""}${group.url}`);
    for (const annotation of group.annotations) {
      lines.push("", `### #${annotation.number} · ${code(annotation.annotationId)}${isResolved(annotation) ? " (resolved)" : ""}`, "");
      for (const line of annotation.comment.trim().split("\n")) lines.push(`> ${line}`);
      lines.push("");
      for (const followUp of annotation.followUps) {
        if (followUp.previousNote) lines.push(`- Resolved earlier with: "${oneLine(followUp.previousNote)}"`);
        lines.push(`- Reopened: "${oneLine(followUp.comment)}"`);
      }
      if (isResolved(annotation) && annotation.resolutionNote) lines.push(`- Agent's note: "${oneLine(annotation.resolutionNote)}"`);
      for (const image of annotation.images) {
        const label = image.kind === AnnotationImageKind.SCREENSHOT ? "Screenshot of the current state" : "Reference image from the user";
        lines.push(`- ${label}: ${image.path}`);
      }
      targetsMarkdown(annotation, lines);
    }
  }
  return lines.join("\n");
}

function sourceLines(target: AnnotationTarget, lines: string[]) {
  const source = target.source;
  if (source && source.components.length > 0) {
    lines.push(`- Components (innermost first${source.framework ? `, ${source.framework}` : ""}): ${source.components.join(" < ")}`);
  }
  if (source?.file) lines.push(`- Source: ${code(`${source.file}${source.line ? `:${source.line}${source.column ? `:${source.column}` : ""}` : ""}`)}`);
}

function openingTag(target: AnnotationTarget): string | null {
  const element = target.element;
  if (!element?.tag) return null;
  const id = element.elementId ? ` id="${element.elementId}"` : "";
  const classes = element.classes.length > 0 ? ` class="${element.classes.join(" ")}"` : "";
  return `<${element.tag}${id}${classes}>`;
}

function targetLines(target: AnnotationTarget, lines: string[]) {
  sourceLines(target, lines);
  const element = target.element;
  const opening = openingTag(target);
  if (opening) {
    const text = oneLine(element?.text ?? "");
    lines.push(`- Element: ${code(opening)}${text ? ` with text "${text}"` : ""}`);
  }
  if (element?.selector) lines.push(`- Selector: ${code(element.selector)}`);
  if (element?.domPath) lines.push(`- DOM path: ${code(element.domPath)}`);
  const styles = element ? Object.entries(element.styles).map(([key, value]) => `${key}: ${value}`) : [];
  if (styles.length > 0) lines.push(`- Computed styles: ${code(styles.join("; "))}`);
}

function formatPx(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The elements an annotation points at, in the same shape as `coflux annotations list`. */
function targetsMarkdown(annotation: Annotation, lines: string[]) {
  const targets = annotation.targets;
  const region = annotation.region;
  if (region) {
    lines.push(
      `- Region: the user dragged a ${formatPx(region.width)}×${formatPx(region.height)} px area on the page, ${formatPx(region.x)} px right and ${formatPx(region.y)} px down from the top-left corner of the container below. The comment is about that area.`,
    );
    if (targets[0]) {
      lines.push("", "#### Container (the innermost element holding the region)", "");
      targetLines(targets[0], lines);
    }
    if (targets.length > 1) {
      lines.push("", "#### Inside the region", "");
      for (const target of targets.slice(1)) {
        const parts: string[] = [];
        const components = target.source?.components ?? [];
        if (components.length > 0) parts.push(components.join(" < "));
        const opening = openingTag(target);
        if (opening) parts.push(code(opening));
        if (target.element?.selector) parts.push(`selector ${code(target.element.selector)}`);
        lines.push(`- ${parts.join(" · ")}`);
      }
    }
    return;
  }
  if (targets.length > 1) {
    lines.push(`- Elements: ${targets.length} (the user selected them together; the comment applies to all of them)`);
    targets.forEach((target, index) => {
      lines.push("", `#### Element ${index + 1} of ${targets.length}`, "");
      targetLines(target, lines);
    });
    return;
  }
  if (targets[0]) targetLines(targets[0], lines);
}
/** A `data:` URL's bytes and type; null when it is not a base64 image. */
export function dataUrlToImage(dataUrl: string): { mimeType: string; data: Uint8Array } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(match[2]!);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    return { mimeType: match[1]!.toLowerCase(), data };
  } catch {
    return null;
  }
}
