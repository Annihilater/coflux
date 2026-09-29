import { AnnotationImageKind, AnnotationStatus, TaskStatus, type Annotation, type Task } from "@coflux/protocol";
import type { SessionAgentState } from "@coflux/client";

import type { DesktopAnnotatorPin } from "@/desktop-bridge";

/**
 * Pure helpers of browser annotations (plan 20260929-browser-annotations), renderer side: which
 * page an annotation belongs to, the pins a page shows, the agent terminals 「交给 agent」 offers, the
 * instruction it types, and 「复制为 markdown」.
 */

/** The instruction 「交给 agent」 types into an agent's terminal (one line; Enter follows). */
export const HAND_OFF_INSTRUCTION =
  "处理 coflux 浏览器批注：运行 coflux annotations list 查看，每条改完后用 coflux annotations resolve <id> --note \"改了什么\" 标记";

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

/** The pins the page at `url` shows: every annotation of that page, resolved ones as checks. */
export function pinsForPage(annotations: readonly Annotation[], url: string): DesktopAnnotatorPin[] {
  const key = pageKey(url);
  return annotations
    .filter((annotation) => pageKey(annotation.pageUrl) === key)
    .map((annotation) => ({
      id: annotation.annotationId,
      number: annotation.number,
      resolved: isResolved(annotation),
      selector: annotation.element?.selector ?? "",
      domPath: annotation.element?.domPath ?? "",
      tag: annotation.element?.tag ?? "",
      text: annotation.element?.text ?? "",
      elementId: annotation.element?.elementId ?? "",
      classes: annotation.element?.classes ?? [],
    }));
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

/** Counts shown on the toolbar button: the live summary when there is one, else the loaded list. */
export function pendingCount(summary: { pending: number } | undefined, annotations: readonly Annotation[] | null): number {
  if (summary) return summary.pending;
  return annotations ? annotations.filter((annotation) => !isResolved(annotation)).length : 0;
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
      const source = annotation.source;
      if (source && source.components.length > 0) {
        lines.push(`- Components (innermost first${source.framework ? `, ${source.framework}` : ""}): ${source.components.join(" < ")}`);
      }
      if (source?.file) lines.push(`- Source: ${code(`${source.file}${source.line ? `:${source.line}${source.column ? `:${source.column}` : ""}` : ""}`)}`);
      const element = annotation.element;
      if (element?.tag) {
        const id = element.elementId ? ` id="${element.elementId}"` : "";
        const classes = element.classes.length > 0 ? ` class="${element.classes.join(" ")}"` : "";
        const text = oneLine(element.text);
        lines.push(`- Element: ${code(`<${element.tag}${id}${classes}>`)}${text ? ` with text "${text}"` : ""}`);
      }
      if (element?.selector) lines.push(`- Selector: ${code(element.selector)}`);
      if (element?.domPath) lines.push(`- DOM path: ${code(element.domPath)}`);
      const styles = element ? Object.entries(element.styles).map(([key, value]) => `${key}: ${value}`) : [];
      if (styles.length > 0) lines.push(`- Computed styles: ${code(styles.join("; "))}`);
      for (const image of annotation.images) {
        const label = image.kind === AnnotationImageKind.SCREENSHOT ? "Screenshot of the current state" : "Reference image from the user";
        lines.push(`- ${label}: ${image.path}`);
      }
    }
  }
  return lines.join("\n");
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
