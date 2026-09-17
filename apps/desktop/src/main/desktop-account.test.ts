import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDesktopAccount, accountControl, type AccountControlStage, type AccountControlTimeouts } from "./desktop-account";

/** Every stage gets room to finish on localhost; the one under test is the only tight deadline. */
function budgets(stalled: AccountControlStage): AccountControlTimeouts {
  const roomy: AccountControlTimeouts = { connect: 5000, snapshot: 5000, cleanup: 5000, logout: 5000 };
  roomy[stalled] = 50;
  return roomy;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "coflux-account-"));
  let stored = "";
  let writable = true;
  const store = { read: () => stored, write: (value: string) => { if (!writable) return false; stored = value; return true; }, clear: () => { stored = ""; return true; } };
  return { home, store, failWrites: () => { writable = false; }, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

test("账号保存失败不在内存中完成切换，未确认归属不删除旧安装凭据", async () => {
  const f = fixture();
  try {
    const path = join(f.home, "credentials.json");
    writeFileSync(path, JSON.stringify({ daemonId: "local", deviceToken: "device-secret" }));
    const account = createDesktopAccount(f.home, "ws://unused", f.store, async () => ({ accountId: "owner", daemonIds: ["local"] }));
    f.failWrites();
    await assert.rejects(account.connect("session"), /无法安全保存/);
    assert.equal(account.accountId(), null);
    assert.throws(() => account.logout("session"), /无法安全保存/);
    assert.equal(account.hasPending(), false);
    assert.match(readFileSync(path, "utf8"), /device-secret/);
  } finally { f.dispose(); }
});

test("旧安装归属其他账号时拒绝接入；退出当前客户端不清除旧设备", async () => {
  const f = fixture();
  try {
    const path = join(f.home, "credentials.json");
    writeFileSync(path, JSON.stringify({ daemonId: "other" }));
    const account = createDesktopAccount(f.home, "ws://unused", f.store, async () => ({ accountId: "new", daemonIds: [] }));
    await assert.rejects(account.connect("session"), /其他账号/);
    account.logout("session");
    assert.match(readFileSync(path, "utf8"), /other/);
  } finally { f.dispose(); }
});

test("离线退出保留持久清理记录，重启后重试只删除本机终端并撤销旧 token", async () => {
  const f = fixture();
  try {
    let online = true;
    const calls: unknown[] = [];
    const control: typeof accountControl = async (_url, token, cleanup) => {
      if (!online) throw new Error("offline");
      if (cleanup) calls.push({ token, ...cleanup });
      return { accountId: "owner", daemonIds: ["local"] };
    };
    const account = createDesktopAccount(f.home, "ws://unused", f.store, control);
    await account.connect("old-session");
    writeFileSync(join(f.home, "credentials.json"), JSON.stringify({ daemonId: "local" }));
    online = false;
    account.logout("old-session");
    await assert.rejects(account.drain(), /offline/);
    const restored = createDesktopAccount(f.home, "ws://unused", f.store, control);
    assert.equal(restored.hasPending(), true);
    online = true;
    await Promise.all([restored.drain(), restored.drain()]);
    assert.deepEqual(calls, [{ token: "old-session", accountId: "owner", daemonId: "local", revoke: true }]);
    assert.equal(restored.hasPending(), false);
  } finally { f.dispose(); }
});


test("account control rejects obsolete server versions before subscription or cleanup", async () => {
  const { WebSocketServer } = await import("ws");
  const { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema } = await import("@coflux/protocol");
  for (const version of [0, 1, 2, 3]) {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const received: string[] = [];
    server.on("connection", socket => {
      socket.on("message", bytes => {
        const message = decodeClientToServer(new Uint8Array(bytes as Buffer));
        if (!message?.payload.case) return;
        received.push(message.payload.case);
        if (message.payload.case === "clientAuth") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "authOk", value: { accountId: "owner", controlProtocolVersion: version } } })));
        if (message.payload.case === "clientSubscribe") socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "stateSnapshot", value: {} } })));
      });
    });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      const result = accountControl(`ws://127.0.0.1:${address.port}`, "session");
      if (version < 2) {
        await assert.rejects(result, /服务器需要升级/);
        assert.deepEqual(received, ["clientAuth"]);
      } else {
        assert.equal((await result).accountId, "owner");
        assert.deepEqual(received, ["clientAuth", "clientSubscribe"]);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});

test("a stalled handshake blames the connection, not an account cleanup that never ran", async () => {
  // A ws server would complete the handshake and open the socket, which is exactly what must not
  // happen here: a bare TCP listener accepts the connection and then says nothing at all.
  const accepted: Socket[] = [];
  const server = createServer(socket => { accepted.push(socket); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", () => resolve()); });
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    await assert.rejects(
      accountControl(`ws://127.0.0.1:${address.port}`, "session", undefined, budgets("connect")),
      /连接账号服务器超时，请检查网络后重试/,
    );
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("each later stage times out with its own message, and only cleanup claims a retry record", async () => {
  const { WebSocketServer } = await import("ws");
  const { create, decodeClientToServer, encodeServerToClient, ServerToClientSchema, CONTROL_PROTOCOL_VERSION } = await import("@coflux/protocol");
  const expected = {
    snapshot: "读取账号信息超时，请重试",
    cleanup: "本机终端清理超时，已保留待重试记录",
    logout: "退出登录确认超时，已保留待重试记录",
  };
  for (const stalled of ["snapshot", "cleanup", "logout"] as const) {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    // Answers everything up to the stalled stage, then goes silent while holding the socket open.
    server.on("connection", socket => {
      socket.on("message", bytes => {
        const payload = decodeClientToServer(new Uint8Array(bytes as Buffer))?.payload;
        if (payload?.case === "clientAuth") {
          socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "authOk", value: { accountId: "owner", controlProtocolVersion: CONTROL_PROTOCOL_VERSION } } })));
        } else if (payload?.case === "clientSubscribe" && stalled !== "snapshot") {
          socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "stateSnapshot", value: { tasks: [{ id: "t-1", daemonId: "local" }] } } })));
        } else if (payload?.case === "taskRemove" && stalled !== "cleanup") {
          socket.send(encodeServerToClient(create(ServerToClientSchema, { payload: { case: "taskRemoved", value: { taskId: payload.value.taskId } } })));
        }
        // clientLogout is never answered: the 4001 close is what would settle it.
      });
    });
    try {
      const address = server.address(); assert(address && typeof address !== "string");
      await assert.rejects(
        accountControl(`ws://127.0.0.1:${address.port}`, "session", { daemonId: "local", accountId: "owner", revoke: true }, budgets(stalled)),
        // Exact equality on the message, through a validation function: a RegExp here would be
        // matched against `String(error)` — `Error: <message>` — so the stage each message belongs
        // to could only be pinned down loosely.
        (error: unknown) => {
          assert.equal((error as Error).message, expected[stalled], `stage ${stalled}`);
          return true;
        },
      );
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
