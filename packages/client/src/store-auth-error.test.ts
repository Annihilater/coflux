/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, encodeServerToClient, ServerToClientSchema, type ServerToClientPayload } from "@coflux/protocol";

// `authError` is the single branch the server uses for every refused authentication: an expired
// session token, a rate-limited address, an obsolete bundle, and wrong credentials all arrive here.
// These tests pin that the reason the server sent is what the user reads, because the previous
// hard-coded sentence ("wrong username or password") named the cause wrong in every case but one.
// Same minimal fakes as the other store tests: the store needs window timers and a WebSocket, and
// the device router must not reach for IndexedDB.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket, "还没有创建 WebSocket");
    return socket;
  }
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(payload: ServerToClientPayload): void {
    const bytes = encodeServerToClient(create(ServerToClientSchema, { payload }));
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient } = await import("./store");

function newClient(token: string) {
  const stored = { token };
  const client = createCofluxClient({
    serverUrl: "ws://127.0.0.1:1/client",
    tokenStorage: {
      read: () => stored.token,
      write: (value) => {
        stored.token = value;
      },
      clear: () => {
        stored.token = "";
      },
    },
    buildId: "dev",
    deviceTransport: { enableLocalTransport: false, identityDatabaseName: "test", origin: "https://desktop.coflux.dev" },
  });
  return { client, stored };
}

test("认证被拒时展示服务端给出的原因，而不是一律说密码错", () => {
  const { client, stored } = newClient("stale-token");
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ case: "authError", value: { message: "会话已过期，请重新登录" } });

    const state = client.store.getState();
    assert.equal(state.authState, "auth-failed");
    assert.equal(state.loginError, "会话已过期，请重新登录");
    assert.equal(stored.token, "", "失效的 token 仍要清掉，否则每次重连都再撞一次");
  } finally {
    client.disconnect();
  }
});

test("服务端没给原因时用兜底文案，不落到空白横幅", () => {
  const { client } = newClient("stale-token");
  try {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({ case: "authError", value: { message: "   " } });

    assert.equal(client.store.getState().loginError, "登录失败：请重新登录");
  } finally {
    client.disconnect();
  }
});
