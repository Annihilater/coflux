import { app, Notification } from "electron";

import type { DesktopNotification } from "../shared/desktop-bridge";

/**
 * Native notifications and Dock badges. The renderer derives attention events and counts;
 * the main-process caller checks actual window focus and visibility before showing explicit
 * inbox notifications. Electron 42+ uses UNUserNotification on macOS, which requires a signed
 * build. Verify native delivery with a signed package; there is no HTML5 Notification fallback.
 */
export function showWorkspaceNotification(notification: DesktopNotification, onClick: (notification: DesktopNotification) => void): void {
  if (!Notification.isSupported()) return;
  const native = new Notification({ title: notification.title, body: notification.body });
  native.on("click", () => {
    retained.delete(native);
    onClick(notification);
  });
  native.on("close", () => retained.delete(native));
  retain(native);
  native.show();
}

/**
 * Shown notifications stay strongly referenced until the user acts on them. Collecting the JS
 * wrapper only detaches the native delegate: macOS keeps the notification clickable and still
 * activates the app, but the `click` event never reaches us — the app comes forward and lands
 * nowhere. `close` is not guaranteed (on macOS it rarely fires for a banner that slides into
 * Notification Center), so the set is capped; an evicted notification only brings the app forward.
 * The cap is generous on purpose: every eviction is a dead click.
 */
const RETAINED_MAX = 256;
const retained = new Set<Notification>();

function retain(native: Notification): void {
  retained.add(native);
  // A Set iterates in insertion order, so the first entry is the oldest.
  while (retained.size > RETAINED_MAX) {
    const oldest = retained.values().next().value;
    if (!oldest) break;
    retained.delete(oldest);
  }
}

/**
 * Dock badge text. The badge is shared: the renderer owns the attention count, and a parallel dev
 * preview (plan 20260916-desktop-preview-parallel) also wants its instance label there. Composition
 * is fixed so neither can erase the other — no label keeps today's behaviour byte-for-byte, a label
 * alone survives a count of zero, and a label plus a count shows both.
 */
export function composeDockBadge(label: string, count: number): string {
  if (!label) return count > 0 ? String(count) : "";
  return count > 0 ? `${label} ${count}` : label;
}

/** Long labels make the badge unreadable; the window title carries the full one. */
export const BADGE_LABEL_MAX = 10;

let badgeLabel = "";
let badgeCount = 0;

function applyDockBadge(): void {
  app.dock?.setBadge(composeDockBadge(badgeLabel, badgeCount));
}

/** Dev-only instance label, applied once at startup. Absent in every packaged run. */
export function setDockBadgeLabel(label: string): void {
  badgeLabel = label.slice(0, BADGE_LABEL_MAX);
  applyDockBadge();
}

/** Combined waiting-workspace and unread-inbox count; zero clears the count. No-op without a Dock. */
export function setDockBadge(count: number): void {
  badgeCount = count;
  applyDockBadge();
}
