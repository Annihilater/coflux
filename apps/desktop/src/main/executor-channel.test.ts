import assert from "node:assert/strict";
import { test } from "node:test";

import { createExecutorChannelLedger } from "./executor-channel";

/**
 * The reconnect case is the reason this file exists. It is worth automating because the break is
 * silent from inside the app — everything keeps running and the settings page still says "ready" —
 * and only shows up on the other side, as `coflux executor run` reporting that Coflux.app is not
 * running while it plainly is.
 */
test("同一个 daemon 断开后重连仍会重新 register，epoch 递增", () => {
  const ledger = createExecutorChannelLedger();

  assert.equal(ledger.announce("daemon-1", 7), "register");
  assert.equal(ledger.epoch(), 1);

  assert.equal(ledger.announce("", 0), "dropped");
  // A drop does not register and does not consume an epoch.
  assert.equal(ledger.epoch(), 1);

  // Same daemon, new connection: the case the old "daemonId unchanged → return" dropped on the floor.
  assert.equal(ledger.announce("daemon-1", 8), "register");
  assert.equal(ledger.epoch(), 2);
});

test("同一条连接被重复宣告时不重复 register", () => {
  const ledger = createExecutorChannelLedger();
  assert.equal(ledger.announce("daemon-1", 3), "register");
  assert.equal(ledger.announce("daemon-1", 3), "ignore");
  assert.equal(ledger.announce("daemon-1", 3), "ignore");
  assert.equal(ledger.epoch(), 1);
});

test("通道还没起来（generation 为 0）就不算有通道", () => {
  const ledger = createExecutorChannelLedger();
  assert.equal(ledger.announce("daemon-1", 0), "ignore");
  assert.equal(ledger.announce("", 0), "ignore");
  assert.equal(ledger.epoch(), 0);
  // 配置变化也不该在没有通道时发帧——没人接。
  assert.equal(ledger.refresh(), "ignore");
});

test("换了另一台 daemon 也重新 register", () => {
  const ledger = createExecutorChannelLedger();
  ledger.announce("daemon-1", 1);
  assert.equal(ledger.announce("daemon-2", 1), "register");
  assert.equal(ledger.epoch(), 2);
});

test("配置变化在通道活着时重新 register，与通道 epoch 共用同一个递增序列", () => {
  const ledger = createExecutorChannelLedger();
  ledger.announce("daemon-1", 5);
  assert.equal(ledger.refresh(), "register");
  assert.equal(ledger.epoch(), 2);
  // 之后的重连继续往上走，不会倒退——daemon 靠它判断迟到的旧帧。
  assert.equal(ledger.announce("daemon-1", 6), "register");
  assert.equal(ledger.epoch(), 3);
});
