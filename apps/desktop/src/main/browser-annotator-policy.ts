import type {
  DesktopAnnotatorAnchor,
  DesktopAnnotatorBox,
  DesktopAnnotatorElement,
  DesktopAnnotatorPin,
  DesktopAnnotatorSource,
  DesktopAnnotatorState,
  DesktopAnnotatorViewport,
  DesktopBrowserRect,
} from "../shared/desktop-bridge";

/**
 * Pure rules of browser annotations (plan 20260929-browser-annotations), main-process side: what
 * the renderer may ask of a page guest, what a page message may carry, and where an element's
 * screenshot is cut from the captured page. Everything crossing into main is re-validated here:
 * renderer payloads because every IPC payload is, page messages because the element data comes
 * from the page's own DOM.
 */

const MAX_PINS = 500;
const MAX_TOKEN = 32;
const MAX_ID = 128;
const MAX_SELECTOR = 2000;
const MAX_DOM_PATH = 4000;
const MAX_TEXT = 500;
const MAX_SHORT = 200;
const MAX_VALUE = 500;
const MAX_LIST = 24;
const MAX_MAP = 40;
const MAX_URL = 4000;
/** A page message larger than this is not one of ours. */
export const MAX_PAGE_MESSAGE_BYTES = 256 * 1024;
/** Padding around an element's screenshot, in CSS pixels. */
export const SCREENSHOT_PADDING = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function list(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, max))
    .filter((item) => item.length > 0)
    .slice(0, MAX_LIST);
}

function map(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_MAP) break;
    const name = text(key, 64);
    const content = text(raw, MAX_VALUE);
    if (!name || !content) continue;
    out[name] = content;
    count += 1;
  }
  return out;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isId(value: unknown, max = MAX_ID): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

export function sanitizeLocator(value: unknown): Omit<DesktopAnnotatorPin, "id" | "number" | "resolved"> | null {
  if (!isRecord(value)) return null;
  return {
    selector: text(value.selector, MAX_SELECTOR),
    domPath: text(value.domPath, MAX_DOM_PATH),
    tag: text(value.tag, 64).toLowerCase(),
    text: text(value.text, MAX_TEXT),
    elementId: text(value.elementId, MAX_SHORT),
    classes: list(value.classes, MAX_SHORT),
  };
}

function sanitizeAnchor(value: unknown): DesktopAnnotatorAnchor {
  if (!isRecord(value)) return null;
  if (value.kind === "pick" && isId(value.token, MAX_TOKEN)) return { kind: "pick", token: value.token };
  if (value.kind === "pin" && isId(value.id)) return { kind: "pin", id: value.id, scroll: value.scroll === true };
  return null;
}

/** `browserAnnotatorSync` from the renderer. */
export function sanitizeAnnotatorSync(payload: unknown): { guestId: number; state: DesktopAnnotatorState } | null {
  if (!isRecord(payload) || !isRecord(payload.state)) return null;
  const guestId = payload.guestId;
  if (typeof guestId !== "number" || !Number.isInteger(guestId) || guestId <= 0) return null;
  const raw = payload.state;
  const pins: DesktopAnnotatorPin[] = [];
  if (Array.isArray(raw.pins)) {
    for (const entry of raw.pins.slice(0, MAX_PINS)) {
      if (!isRecord(entry) || !isId(entry.id)) continue;
      const locator = sanitizeLocator(entry);
      const number = finite(entry.number);
      if (!locator || number === null) continue;
      pins.push({ ...locator, id: entry.id, number: Math.max(0, Math.floor(number)), resolved: entry.resolved === true });
    }
  }
  return { guestId, state: { mode: raw.mode === true, pins, anchor: sanitizeAnchor(raw.anchor) } };
}

/** Whether a state needs the page instrumented at all. */
export function annotatorStateNeedsPage(state: DesktopAnnotatorState): boolean {
  return state.mode || state.pins.length > 0 || state.anchor !== null;
}

export function sanitizeBox(value: unknown): DesktopAnnotatorBox | null {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

export function sanitizeViewport(value: unknown): DesktopAnnotatorViewport | null {
  if (!isRecord(value)) return null;
  const width = finite(value.width);
  const height = finite(value.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function sanitizeElement(value: unknown): DesktopAnnotatorElement | null {
  const locator = sanitizeLocator(value);
  if (!locator || !isRecord(value)) return null;
  return {
    ...locator,
    attributes: map(value.attributes),
    styles: map(value.styles),
    width: Math.max(0, finite(value.width) ?? 0),
    height: Math.max(0, finite(value.height) ?? 0),
  };
}

/** What the page's main world said about the element's framework; null when nothing usable. */
export function sanitizeSourceIdentity(value: unknown): DesktopAnnotatorSource | null {
  if (!isRecord(value)) return null;
  const framework = text(value.framework, 32).toLowerCase();
  const components = list(value.components, MAX_SHORT);
  const file = text(value.file, 1000);
  const line = Math.max(0, Math.floor(finite(value.line) ?? 0));
  const column = Math.max(0, Math.floor(finite(value.column) ?? 0));
  if (!framework && components.length === 0 && !file) return null;
  return { framework, components, file, line: file ? line : 0, column: file ? column : 0 };
}

export type PageMessage =
  | { type: "ready"; url: string }
  | { type: "pick"; token: string; url: string; title: string; rect: DesktopAnnotatorBox; viewport: DesktopAnnotatorViewport; element: DesktopAnnotatorElement }
  | { type: "anchor"; rect: DesktopAnnotatorBox | null; viewport: DesktopAnnotatorViewport }
  | { type: "pin-click"; id: string }
  | { type: "pins"; url: string; missing: string[] }
  | { type: "exit" };

/** One message the isolated-world script sent through its binding. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_PAGE_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "ready":
      return { type: "ready", url: text(value.url, MAX_URL) };
    case "pick": {
      const rect = sanitizeBox(value.rect);
      const viewport = sanitizeViewport(value.viewport);
      const element = sanitizeElement(value.element);
      if (!isId(value.token, MAX_TOKEN) || !rect || !viewport || !element) return null;
      return { type: "pick", token: value.token, url: text(value.url, MAX_URL), title: text(value.title, MAX_SHORT), rect, viewport, element };
    }
    case "anchor": {
      const viewport = sanitizeViewport(value.viewport);
      if (!viewport) return null;
      return { type: "anchor", rect: sanitizeBox(value.rect), viewport };
    }
    case "pin-click":
      return isId(value.id) ? { type: "pin-click", id: value.id } : null;
    case "pins":
      return {
        type: "pins",
        url: text(value.url, MAX_URL),
        missing: Array.isArray(value.missing) ? value.missing.filter((id): id is string => isId(id)).slice(0, MAX_PINS) : [],
      };
    case "exit":
      return { type: "exit" };
    default:
      return null;
  }
}

/**
 * The element's rectangle, padded and clipped to the viewport, as fractions of the viewport — the
 * shape `cropRectInPixels` turns into pixels of the captured page (which handles the device pixel
 * ratio and the zoom). Null when nothing of the element is visible.
 */
export function elementCropFraction(rect: DesktopAnnotatorBox, viewport: DesktopAnnotatorViewport, padding = SCREENSHOT_PADDING): DesktopBrowserRect | null {
  const left = Math.max(0, rect.x - padding);
  const top = Math.max(0, rect.y - padding);
  const right = Math.min(viewport.width, rect.x + rect.width + padding);
  const bottom = Math.min(viewport.height, rect.y + rect.height + padding);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    width: (right - left) / viewport.width,
    height: (bottom - top) / viewport.height,
  };
}
