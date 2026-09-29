import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leaveRuntime, ptydStatus, runtimeSupportsLeave, stopPtyd, stopRuntime, type RuntimeStatus } from "./desktop-runtime";

const original: RuntimeStatus = { ok: true, protocol: 1, instanceId: "old", runtimeId: "runtime", version: "test", sessions: [] };

async function fixture(handle: (request: { op: string }, socket: Socket, close: () => void) => void) {
  const home = mkdtempSync(join(tmpdir(), "coflux-stop-race-"));
  const server = createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      input += chunk;
      if (input.includes("\n")) handle(JSON.parse(input), socket, () => server.close());
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, "runtime.sock"), resolve));
  return { home, async dispose() {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  } };
}

for (const lostResponse of ["stop", "status"]) {
  test(`停止期间 ${lostResponse} 响应遇到 EOF，确认原实例消失后完成退出`, async () => {
    const requests: string[] = [];
    const f = await fixture((request, socket, close) => {
      requests.push(request.op);
      if (request.op === lostResponse) { socket.end(); close(); }
      else socket.end('{"ok":true}\n');
    });
    try {
      await stopRuntime(f.home, original);
      assert.equal(requests.filter(op => op === "stop").length, 1);
      if (lostResponse === "status") assert.deepEqual(requests, ["stop", "status"]);
    } finally { await f.dispose(); }
  });
}

test("leave：让在跑的 supervisor 走 leave-sessions 退出，直到同一实例消失；旧 supervisor 不支持 leave", async () => {
  const requests: string[] = [];
  const f = await fixture((request, socket, close) => {
    requests.push(request.op);
    if (request.op === "leave") { socket.end('{"ok":true}\n'); close(); }
    else socket.end(JSON.stringify(original) + "\n");
  });
  try {
    await leaveRuntime(f.home, original);
    assert.deepEqual(requests, ["leave"], "leave 与 stop 不共用路径：这里从未发过 stop");
  } finally { await f.dispose(); }
  assert.equal(runtimeSupportsLeave(original), false, "没有 custody 字段 = 早于 ptyd 的 supervisor");
  assert.equal(runtimeSupportsLeave({ ...original, custody: "ptyd" }), true);
});

/** ptyd 的 record 分帧：`[u32 总长][u32 header_len][header JSON][raw]`，连上先发 hello。 */
function ptydRecord(header: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const record = Buffer.alloc(8 + json.length);
  record.writeUInt32BE(4 + json.length, 0);
  record.writeUInt32BE(json.length, 4);
  json.copy(record, 8);
  return record;
}

async function ptydFixture(handle: (request: Record<string, unknown>, reply: (header: Record<string, unknown>) => void, close: () => void) => void) {
  const home = mkdtempSync(join(tmpdir(), "coflux-ptyd-status-"));
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.write(ptydRecord({ kind: "hello", protocol_version: 1, ops: ["status", "shutdown"], identity: "abc", instance_id: "inst-1", pid: 42 }));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const headerLength = payload.readUInt32BE(0);
        handle(JSON.parse(payload.subarray(4, 4 + headerLength).toString()), header => socket.write(ptydRecord(header)), () => server.close());
      }
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, "ptyd.sock"), resolve));
  return { home, async dispose() {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  } };
}

test("ptyd 状态：按 record 分帧读 hello 与 status，把 session 列表与身份带回；socket 不在 = 没在跑", async () => {
  const seen: Record<string, unknown>[] = [];
  const f = await ptydFixture((request, reply) => {
    seen.push(request);
    reply({ kind: "status", id: request.id, protocol_version: 1, identity: "abc", instance_id: "inst-1", pid: 42,
      sessions: [{ session_id: "s1", pid: 7, exited: false }, { session_id: "s2", pid: 8, exited: true }] });
  });
  try {
    const status = await ptydStatus(f.home);
    assert.deepEqual(seen, [{ id: 1, op: "status" }]);
    assert.equal(status?.identity, "abc");
    assert.equal(status?.instanceId, "inst-1");
    assert.deepEqual(status?.sessions, [{ id: "s1", pid: 7, exited: false }, { id: "s2", pid: 8, exited: true }]);
  } finally { await f.dispose(); }
  const empty = mkdtempSync(join(tmpdir(), "coflux-ptyd-none-"));
  try { assert.equal(await ptydStatus(empty), null); } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("停止 ptyd：带 instance id 发 shutdown，等同一实例消失", async () => {
  const ops: string[] = [];
  const f = await ptydFixture((request, reply, close) => {
    ops.push(String(request.op));
    if (request.op === "shutdown") { assert.equal(request.instance_id, "inst-1"); reply({ kind: "ok", id: request.id }); close(); }
    else reply({ kind: "status", id: request.id, protocol_version: 1, identity: "abc", instance_id: "inst-1", pid: 42, sessions: [] });
  });
  try {
    await stopPtyd(f.home, { protocolVersion: 1, identity: "abc", instanceId: "inst-1", pid: 42, sessions: [] });
    assert.equal(ops.filter(op => op === "shutdown").length, 1);
  } finally { await f.dispose(); }
});

test("停止响应丢失后出现新实例，保留新实例并拒绝继续退出", async () => {
  let stops = 0;
  const f = await fixture((request, socket) => {
    if (request.op === "stop") { stops++; socket.end(); }
    else socket.end(JSON.stringify({ ...original, instanceId: "new" }) + "\n");
  });
  try {
    await assert.rejects(stopRuntime(f.home, original), /新运行实例/);
    assert.equal(stops, 1);
  } finally { await f.dispose(); }
});
