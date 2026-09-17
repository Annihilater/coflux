/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { startDerpAdmission } from "./derp-admission.js";

// The admission listener is the one route that answers a caller outside this machine's trust
// boundary (stock `derper` on a relay host, through a TLS-terminating proxy), and `derper` runs it
// fail-closed: whatever this returns decides whether a device may use the relay at all. What has to
// hold is that the path is the credential — no token, no answer — and that a wrong path is
// indistinguishable from an unregistered key.

const REGISTERED = `nodekey:${"a".repeat(64)}`;
const TOKEN = "t".repeat(48);

async function withServer(token: string, run: (base: string) => Promise<void>): Promise<void> {
  const server = startDerpAdmission((key) => key === REGISTERED, 0, token);
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const verify = (url: string, body: unknown) =>
  fetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("带正确密钥的路径才回答，注册过的公钥被放行", async () => {
  await withServer(TOKEN, async (base) => {
    const response = await verify(`${base}/derp-verify/${TOKEN}`, { NodePublic: REGISTERED });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { Allow: true });

    const unknown = await verify(`${base}/derp-verify/${TOKEN}`, { NodePublic: `nodekey:${"b".repeat(64)}` });
    assert.deepEqual(await unknown.json(), { Allow: false }, "没注册的公钥不放行");
  });
});

test("密钥不对、路径不对、方法不对一律拒绝，且答复与「没注册」无法区分", async () => {
  await withServer(TOKEN, async (base) => {
    for (const path of [`/derp-verify/${"x".repeat(48)}`, `/derp-verify/${TOKEN}extra`, `/derp-verify/`, "/verify", "/"]) {
      const response = await verify(`${base}${path}`, { NodePublic: REGISTERED });
      assert.equal(response.status, 403, `${path} 必须拒绝`);
      assert.deepEqual(await response.json(), { Allow: false }, `${path} 的答复不能泄露它错在哪`);
    }
    // 配了密钥就没有未鉴权入口：GET 同样不行。
    const get = await fetch(`${base}/derp-verify/${TOKEN}`);
    assert.equal(get.status, 403);
  });
});

test("没配密钥时保持回环下的旧契约：POST /verify", async () => {
  await withServer("", async (base) => {
    const response = await verify(`${base}/verify`, { NodePublic: REGISTERED });
    assert.deepEqual(await response.json(), { Allow: true });
    const prefixed = await verify(`${base}/derp-verify/${TOKEN}`, { NodePublic: REGISTERED });
    assert.equal(prefixed.status, 403, "没配密钥时带密钥的路径不存在");
  });
});

test("畸形与超大请求体不放行", async () => {
  await withServer(TOKEN, async (base) => {
    const malformed = await verify(`${base}/derp-verify/${TOKEN}`, "not json");
    assert.deepEqual(await malformed.json(), { Allow: false });
    // 超过 1KB 的请求体在读取途中就被掐断：调用方要么拿到 403，要么连接直接断——两种都不是放行。
    const oversized = await verify(`${base}/derp-verify/${TOKEN}`, { NodePublic: REGISTERED, pad: "p".repeat(2048) })
      .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
      .catch(() => ({ status: 0, body: null }));
    assert.notEqual(oversized.status, 200, "超大请求体不能拿到 200");
    assert.notDeepEqual(oversized.body, { Allow: true }, "超大请求体绝不能放行");
  });
});

test("密钥太短直接拒绝启动，避免弱口令悄悄上公网", () => {
  assert.throws(() => startDerpAdmission(() => true, 0, "short"), /at least 32/);
});
