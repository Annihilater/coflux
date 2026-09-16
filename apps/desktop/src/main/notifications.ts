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
  native.on("click", () => onClick(notification));
  native.show();
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
