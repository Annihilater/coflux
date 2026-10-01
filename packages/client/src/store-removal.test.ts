/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema, TaskStatus, type ServerToClientPayload } from "@coflux/protocol";

// Optimistic removal (plan 20261002-optimistic-removal): pins only the races a person cannot
// exercise by hand — an upsert arriving mid-removal, the uncorrelated wire `error`, the removed
// broadcast settling, and the snapshot rule. Same minimal fakes as store-offline.test.ts;
// enableLocalTransport=false keeps the DeviceRouter off IndexedDB.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    assert.ok(socket, "no WebSocket created yet");
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
  sentCases(): string[] {
    return this.sent.map((bytes) => decodeClientToServer(bytes)?.payload.case ?? "");
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
globals.WebSocket = FakeWebSocket;

const { createCofluxClient } = await import("./store");

const daemons = [{ daemonId: "d1", name: "本机", online: true }];
const projects = [
  { id: "p1", daemonId: "d1", name: "coflux", createdAt: 1 },
  { id: "p2", daemonId: "d1", name: "other", createdAt: 2 },
];
const workspaces = [
  { id: "ws1", daemonId: "d1", projectId: "p1", branch: "main", isMain: true, createdAt: 1 },
  { id: "ws2", daemonId: "d1", projectId: "p1", branch: "feature", isMain: false, createdAt: 2 },
  { id: "ws3", daemonId: "d1", projectId: "p2", branch: "main", isMain: true, createdAt: 3 },
];
const tasks = [
  { id: "t1", daemonId: "d1", projectId: "p1", workspaceId: "ws2", title: "终端", status: TaskStatus.EXITED, createdAt: 1 },
  { id: "t2", daemonId: "d1", projectId: "p1", workspaceId: "ws1", title: "终端", status: TaskStatus.EXITED, createdAt: 2 },
  { id: "t3", daemonId: "d1", projectId: "p2", workspaceId: "ws3", title: "终端", status: TaskStatus.EXITED, createdAt: 3 },
];

function snapshot(keep: { projects?: string[]; workspaces?: string[]; tasks?: string[] } = {}): ServerToClientPayload {
  const pick = <T extends { id: string }>(items: T[], ids?: string[]) => (ids ? items.filter((item) => ids.includes(item.id)) : items);
  return {
    case: "stateSnapshot",
    value: { daemons, projects: pick(projects, keep.projects), workspaces: pick(workspaces, keep.workspaces), tasks: pick(tasks, keep.tasks), ports: [] },
  };
}

function authOk(socket: FakeWebSocket): void {
  socket.receive({ case: "authOk", value: { accountId: "a1", controlProtocolVersion: 2 } });
}

function start() {
  let token = "tok";
  const client = createCofluxClient({
    serverUrl: "ws://127.0.0.1:1/client",
    tokenStorage: {
      read: () => token,
      write: (next) => {
        token = next;
      },
      clear: () => {
        token = "";
      },
    },
    buildId: "dev",
    deviceTransport: { enableLocalTransport: false, identityDatabaseName: "test", origin: "https://desktop.coflux.dev" },
  });
  const socket = FakeWebSocket.latest();
  socket.open();
  authOk(socket);
  socket.receive(snapshot());
  return { client, socket };
}

function ids(client: ReturnType<typeof start>["client"]) {
  const state = client.store.getState();
  return {
    projects: state.projects.map((item) => item.id),
    workspaces: state.workspaces.map((item) => item.id),
    tasks: state.tasks.map((item) => item.id),
  };
}

test("an upsert arriving mid-removal does not bring the entity back", () => {
  const { client, socket } = start();
  try {
    assert.equal(client.removeWorkspace("ws2"), true);
    assert.ok(socket.sentCases().includes("workspaceRemove"));
    assert.deepEqual(ids(client).workspaces, ["ws1", "ws3"], "the row is gone at once");
    assert.deepEqual(ids(client).tasks, ["t2", "t3"], "its terminals go with it");

    // The centre closes the workspace's sessions before removing it.
    socket.receive({ case: "taskUpdated", value: { task: { ...tasks[0], title: "closed" } } });
    socket.receive({ case: "workspaceCreated", value: { workspace: { ...workspaces[1], name: "renamed" } } });
    assert.deepEqual(ids(client).workspaces, ["ws1", "ws3"]);
    assert.deepEqual(ids(client).tasks, ["t2", "t3"]);
  } finally {
    client.disconnect();
  }
});

test("a wire error restores pending workspace and project removals, but not a pending terminal", async () => {
  const { client, socket } = start();
  try {
    await client.closeTask(client.store.getState().tasks.find((task) => task.id === "t2")!);
    assert.ok(socket.sentCases().includes("taskRemove"));
    assert.equal(client.removeWorkspace("ws2"), true);
    assert.equal(client.removeProject("p2"), true);
    assert.deepEqual(ids(client), { projects: ["p1"], workspaces: ["ws1"], tasks: [] });

    socket.receive({ case: "error", value: { message: "daemon 不在线" } });
    assert.deepEqual(ids(client), { projects: ["p1", "p2"], workspaces: ["ws1", "ws2", "ws3"], tasks: ["t1", "t3"] }, "back in place, cascaded terminals included");
    assert.equal(client.store.getState().lastError?.message, "daemon 不在线");
  } finally {
    client.disconnect();
  }
});

test("workspaceRemoved settles the removal: a later error restores nothing", () => {
  const { client, socket } = start();
  try {
    client.removeWorkspace("ws2");
    socket.receive({ case: "workspaceRemoved", value: { workspaceId: "ws2" } });
    socket.receive({ case: "error", value: { message: "something else failed" } });
    assert.deepEqual(ids(client).workspaces, ["ws1", "ws3"]);
    assert.deepEqual(ids(client).tasks, ["t2", "t3"]);
  } finally {
    client.disconnect();
  }
});

test("a stateSnapshot restores a pending entity it still contains and settles one it lacks", () => {
  const { client, socket } = start();
  try {
    client.removeWorkspace("ws2");
    client.removeProject("p2");
    // Reconnect: the requests above were sent before this subscribe, so the snapshot is the truth.
    authOk(socket);
    socket.receive(snapshot({ projects: ["p1"], workspaces: ["ws1", "ws2"], tasks: ["t1", "t2"] }));
    assert.deepEqual(ids(client), { projects: ["p1"], workspaces: ["ws1", "ws2"], tasks: ["t1", "t2"] });

    socket.receive({ case: "error", value: { message: "late failure" } });
    assert.deepEqual(ids(client).projects, ["p1"], "the settled project stays gone");
  } finally {
    client.disconnect();
  }
});
