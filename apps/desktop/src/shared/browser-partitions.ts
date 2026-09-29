/**
 * Session partitions of the built-in browser (plan 20260924-desktop-browser-tab). Shared by the main
 * process (which prepares them and gates every `<webview>` on them) and the renderer (which only
 * uses the names main hands back, plus the DevTools host's fixed one).
 */

import type { DesktopBrowserScope } from "./desktop-bridge";

/**
 * Browser state — cookies, storage, cache, trusted certificates, permissions — belongs to a browser
 * scope (plan 20260929-browser-scope-partitions), one persistent partition each, surviving restarts:
 * every worktree of a project shares the project's partition; the device view's directory workspace
 * has its device's. The two namespaces never overlap each other or the legacy prefix below, so no
 * project id can name a device partition (or the reverse) and every old partition is recognisable
 * by prefix alone.
 */
export const BROWSER_PROJECT_PARTITION_PREFIX = "persist:coflux-web-project-";
export const BROWSER_DEVICE_PARTITION_PREFIX = "persist:coflux-web-device-";

/**
 * The per-workspace partitions of the first release. Their data is deleted at startup and their
 * names are refused everywhere; nothing creates them any more.
 */
export const LEGACY_BROWSER_PARTITION_PREFIX = "persist:coflux-browser-";

/**
 * The docked DevTools host: an in-memory partition of its own, recognised by name as the one guest
 * kind that may load `devtools://`. It is not `persist:`-prefixed, so no scope id can produce it. It
 * does start like a legacy partition's on-disk name, which the startup cleanup excludes explicitly.
 */
export const BROWSER_DEVTOOLS_PARTITION = "coflux-browser-devtools";

/**
 * A workspace's browser scope. A directory workspace (the device view's carrier, `isDirWorkspace` in
 * @coflux/client) has no project: `projectId` is proto3's empty string, never undefined, so this is
 * the same truthiness test and never a presence test.
 */
export function browserScopeOfWorkspace(workspace: { projectId: string; daemonId: string }): DesktopBrowserScope {
  return workspace.projectId ? { kind: "project", id: workspace.projectId } : { kind: "device", id: workspace.daemonId };
}

/** A scope as a map key: kinds are namespaced, so a project and a device never share one. */
export function browserScopeKey(scope: DesktopBrowserScope): string {
  return `${scope.kind}:${scope.id}`;
}
