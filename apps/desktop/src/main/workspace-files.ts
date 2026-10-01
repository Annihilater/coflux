import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import type { DesktopWorkspaceFileResult } from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import type { TrustedSenders } from "./ipc";
import { isTrustedRendererUrl } from "./ipc-trust";
import { openRefusal, resolveWorkspaceFile } from "./workspace-files-policy";

/** The two local file actions of the changes view; the checks live in workspace-files-policy.ts. */
export function registerWorkspaceFileIpc(trusted: TrustedSenders): void {
  const isTrusted = (event: IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);

  ipcMain.handle(IPC.workspaceFileReveal, (event, root: unknown, rel: unknown): DesktopWorkspaceFileResult => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    const file = resolveWorkspaceFile(root, rel);
    if (!file.ok) return file;
    shell.showItemInFolder(file.path);
    return { ok: true };
  });

  ipcMain.handle(IPC.workspaceFileOpen, async (event, root: unknown, rel: unknown): Promise<DesktopWorkspaceFileResult> => {
    if (!isTrusted(event)) throw new Error("untrusted sender");
    const file = resolveWorkspaceFile(root, rel);
    if (!file.ok) return file;
    const refusal = openRefusal(file);
    if (refusal) return { ok: false, error: refusal };
    // openPath resolves to an error message, or "" on success.
    const error = await shell.openPath(file.path);
    return error ? { ok: false, error } : { ok: true };
  });
}
