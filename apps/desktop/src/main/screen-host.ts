/**
 * Remote screen tabs (plan 20260929-remote-desktop): the main-process side.
 *
 * A screen session uses two device lanes on the native transport — control (open/close/resize,
 * input, cursor, clipboard, state) and video (frames one way, credit and keyframe requests the
 * other) — so input never queues behind video. Main opens and owns both, under an identity of this
 * app run's own like the browser tab's loopback tunnel, and bridges their bytes to the renderer
 * over a `MessageChannelMain` port: frames cross as transferred buffers, never structured clones
 * through `webContents.send` and its per-frame ack loop. The renderer encodes and decodes the
 * DeviceEnvelopes itself; main never looks inside a frame.
 *
 * Also here, because only main can do it: reading the local clipboard (polled while a session asks,
 * Electron has no change event; the hash of the last value seen or written prevents echo loops),
 * writing it when the remote's changed, and switching the window's menu accelerators off while a
 * picture has keyboard focus (`setIgnoreMenuShortcuts`, probed on Electron 44.3.0 to cover
 * `role: quit`) — one state IPC from the renderer, not per key.
 *
 * Lanes close with every central disconnect (`pauseLanes`) and with ⌘R's transport reset; the
 * renderer learns it on the port and asks for a `reopen` when the device is reachable again. The
 * session itself lives on the remote helper across all of it.
 */
import { randomUUID, createHash } from "node:crypto";
import { clipboard, ClipboardItem, ipcMain, MessageChannelMain, type IpcMainEvent, type IpcMainInvokeEvent, type MessagePortMain } from "electron";

import { DeviceScope } from "@coflux/protocol";
import type { DesktopScreenLane, DesktopScreenLaneKind, DesktopScreenPortMessage, DesktopScreenPortRequest } from "../shared/desktop-bridge";
import { IPC } from "../shared/ipc";
import { isTrustedRendererUrl } from "./ipc-trust";
import type { TrustedSenders } from "./ipc";
import type { OwnedLaneHandlers } from "./tailcat-transport";

export type ScreenLaneOpener = {
  online(): boolean;
  open(request: { requestId: string; daemonId: string; clientInstanceId: string; generation: string; scope: number }, handlers: OwnedLaneHandlers): Promise<{ channelId: string }>;
  send(channelId: string, frame: Uint8Array): boolean;
  close(channelId: string): void;
};

export type ScreenHostOptions = {
  transport: ScreenLaneOpener | null;
  /** The window whose page holds the tabs: where ports go and whose menu shortcuts are toggled. */
  window: () => { postPort(sessionId: string, port: MessagePortMain): void; setIgnoreMenuShortcuts(ignore: boolean): void; setFullScreen(on: boolean): void; isFullScreen(): boolean } | null;
  log: (message: string, detail?: unknown) => void;
};

/** Largest frame accepted from or sent to the renderer: one device frame. */
const MAX_FRAME = 30 * 1024 * 1024;
/** Clipboard polling period while a session watches the local clipboard. */
const CLIPBOARD_POLL_MS = 500;
/** Largest clipboard payload synced either way. */
const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 16;

type Session = {
  sessionId: string;
  daemonId: string;
  port: MessagePortMain;
  lanes: { control?: string; video?: string };
  opening: boolean;
  watchClipboard: boolean;
  closed: boolean;
};

export function createScreenHost(options: ScreenHostOptions) {
  const clientInstanceId = `desktop-screen-${randomUUID()}`;
  let generation = 0;
  const sessions = new Map<string, Session>();
  let clipboardTimer: ReturnType<typeof setInterval> | undefined;
  let clipboardHash = "";
  let clipboardPolling = false;
  let focused = false;

  // `MessagePortMain.postMessage` structured-clones the message (its transfer list is for ports
  // only): one memcpy of the frame in main, then the IPC hop — no per-frame ack loop and no JSON.
  function post(session: Session, message: DesktopScreenPortMessage) {
    if (session.closed) return;
    try {
      session.port.postMessage(message);
    } catch (error) {
      options.log("screen port post failed", error);
    }
  }

  function closeLanes(session: Session) {
    const transport = options.transport;
    for (const kind of ["control", "video"] as const) {
      const id = session.lanes[kind];
      if (!id) continue;
      session.lanes[kind] = undefined;
      transport?.close(id);
    }
  }

  async function openLanes(session: Session) {
    const transport = options.transport;
    if (!transport || session.opening || session.closed) return;
    if (!transport.online()) {
      post(session, { type: "lanes-failed", message: "offline" });
      return;
    }
    session.opening = true;
    closeLanes(session);
    const lane = async (kind: DesktopScreenLaneKind): Promise<DesktopScreenLane> => {
      const request = { requestId: `screen-${kind}-${randomUUID()}`, daemonId: session.daemonId, clientInstanceId, generation: String(++generation), scope: DeviceScope.RPC };
      // The handle is the request id (the transport's lane id), registered before the open so the
      // first frame after the handshake is attributed; a failed open is cleared by closeLanes.
      session.lanes[kind] = request.requestId;
      const opened = await transport.open(request, {
        frame: (bytes) => {
          if (session.closed || session.lanes[kind] !== request.requestId) return;
          const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          post(session, { type: "frame", lane: kind, data });
        },
        closed: () => {
          if (session.closed || session.lanes[kind] !== request.requestId) return;
          session.lanes[kind] = undefined;
          post(session, { type: "closed", lane: kind });
        },
      });
      return { channelId: opened.channelId, clientInstanceId, generation: request.generation };
    };
    try {
      const control = await lane("control");
      if (session.closed) return;
      const video = await lane("video");
      if (session.closed) return;
      post(session, { type: "lanes", control, video });
    } catch (error) {
      closeLanes(session);
      post(session, { type: "lanes-failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      session.opening = false;
      if (session.closed) closeLanes(session);
    }
  }

  // Electron 44's clipboard is the async W3C-style API (readText / read / write with ClipboardItem).
  async function readLocalClipboard(): Promise<{ text?: string; png?: ArrayBuffer; hash: string } | null> {
    const text = await clipboard.readText();
    if (text) {
      if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) return null;
      return { text, hash: createHash("sha256").update("t:").update(text).digest("hex") };
    }
    for (const item of await clipboard.read()) {
      if (!item.types.includes("image/png")) continue;
      const blob = (await item.getType("image/png")) as Blob;
      const png = await blob.arrayBuffer();
      if (png.byteLength === 0 || png.byteLength > MAX_CLIPBOARD_BYTES) return null;
      return { png, hash: createHash("sha256").update("p:").update(Buffer.from(png)).digest("hex") };
    }
    return null;
  }

  async function pollClipboard() {
    const watchers = [...sessions.values()].filter((session) => session.watchClipboard && !session.closed);
    if (watchers.length === 0) {
      clearInterval(clipboardTimer);
      clipboardTimer = undefined;
      return;
    }
    if (clipboardPolling) return;
    clipboardPolling = true;
    let current: Awaited<ReturnType<typeof readLocalClipboard>>;
    try {
      current = await readLocalClipboard();
    } catch (error) {
      options.log("clipboard read failed", error);
      return;
    } finally {
      clipboardPolling = false;
    }
    if (!current || current.hash === clipboardHash) return;
    clipboardHash = current.hash;
    for (const session of watchers) {
      if (session.closed || !session.watchClipboard) continue;
      if (current.text !== undefined) post(session, { type: "clipboard", text: current.text });
      else if (current.png) post(session, { type: "clipboard", png: current.png });
    }
  }

  function setClipboardWatch(session: Session, on: boolean) {
    session.watchClipboard = on;
    if (on) {
      // Start from the current value: what is on the clipboard now was not copied for the remote.
      void readLocalClipboard().then((current) => { clipboardHash = current?.hash ?? ""; }).catch(() => { clipboardHash = ""; });
      if (!clipboardTimer) clipboardTimer = setInterval(() => void pollClipboard(), CLIPBOARD_POLL_MS);
    } else if (![...sessions.values()].some((item) => item.watchClipboard)) {
      clearInterval(clipboardTimer);
      clipboardTimer = undefined;
    }
  }

  async function applyRemoteClipboard(request: { text?: string; png?: ArrayBuffer }) {
    if (typeof request.text === "string") {
      if (Buffer.byteLength(request.text, "utf8") > MAX_CLIPBOARD_BYTES) return;
      clipboardHash = createHash("sha256").update("t:").update(request.text).digest("hex");
      await clipboard.writeText(request.text);
      return;
    }
    if (request.png instanceof ArrayBuffer && request.png.byteLength > 0 && request.png.byteLength <= MAX_CLIPBOARD_BYTES) {
      clipboardHash = createHash("sha256").update("p:").update(Buffer.from(request.png)).digest("hex");
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(request.png)], { type: "image/png" }) })]);
    }
  }

  function handleRequest(session: Session, raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const request = raw as DesktopScreenPortRequest;
    switch (request.type) {
      case "send": {
        const transport = options.transport;
        const id = request.lane === "control" || request.lane === "video" ? session.lanes[request.lane] : undefined;
        if (!transport || !id || !(request.data instanceof ArrayBuffer) || request.data.byteLength === 0 || request.data.byteLength > MAX_FRAME) return;
        if (!transport.send(id, new Uint8Array(request.data))) {
          // Backlog over budget or lane gone: the lane is finished, the renderer reopens.
          session.lanes[request.lane] = undefined;
          transport.close(id);
          post(session, { type: "closed", lane: request.lane });
        }
        return;
      }
      case "reopen":
        void openLanes(session);
        return;
      case "clipboard-set":
        applyRemoteClipboard(request).catch((error) => options.log("clipboard write failed", error));
        return;
      case "clipboard-watch":
        setClipboardWatch(session, request.on === true);
        return;
      default:
        return;
    }
  }

  function close(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.closed = true;
    closeLanes(session);
    setClipboardWatch(session, false);
    try { session.port.close(); } catch { /* already gone */ }
  }

  function open(sessionId: string, daemonId: string): boolean {
    const window = options.window();
    if (!options.transport || !window) return false;
    close(sessionId);
    if (sessions.size >= MAX_SESSIONS) return false;
    const channel = new MessageChannelMain();
    const session: Session = { sessionId, daemonId, port: channel.port1, lanes: {}, opening: false, watchClipboard: false, closed: false };
    sessions.set(sessionId, session);
    channel.port1.on("message", (event) => handleRequest(session, event.data));
    channel.port1.on("close", () => { if (sessions.get(sessionId) === session) close(sessionId); });
    channel.port1.start();
    window.postPort(sessionId, channel.port2);
    void openLanes(session);
    return true;
  }

  function setFocus(next: boolean) {
    focused = next;
    options.window()?.setIgnoreMenuShortcuts(next);
  }

  function setImmersive(on: boolean) {
    const window = options.window();
    if (!window || window.isFullScreen() === on) return;
    window.setFullScreen(on);
  }

  /** The renderer was rebuilt (⌘R, crash): every session of the old page is gone with it. Idempotent. */
  function reset() {
    for (const sessionId of [...sessions.keys()]) close(sessionId);
    if (focused) setFocus(false);
  }

  function registerIpc(trusted: TrustedSenders) {
    const allowed = (event: IpcMainEvent | IpcMainInvokeEvent) => isTrustedRendererUrl(event.senderFrame?.url, trusted);
    const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
    ipcMain.handle(IPC.screenOpen, (event, raw: unknown) => {
      if (!allowed(event) || !raw || typeof raw !== "object") return false;
      const value = raw as { sessionId?: unknown; daemonId?: unknown };
      if (!id(value.sessionId) || !id(value.daemonId)) return false;
      return open(value.sessionId, value.daemonId);
    });
    ipcMain.on(IPC.screenClose, (event, raw: unknown) => {
      if (!allowed(event) || !raw || typeof raw !== "object") return;
      const value = raw as { sessionId?: unknown };
      if (id(value.sessionId)) close(value.sessionId);
    });
    ipcMain.on(IPC.screenFocus, (event, value: unknown) => { if (allowed(event) && typeof value === "boolean") setFocus(value); });
    ipcMain.on(IPC.screenImmersive, (event, value: unknown) => { if (allowed(event) && typeof value === "boolean") setImmersive(value); });
  }

  return { registerIpc, reset, dispose: reset, sessionCount: () => sessions.size };
}

export type ScreenHost = ReturnType<typeof createScreenHost>;
