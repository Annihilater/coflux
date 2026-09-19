import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  createExecutorSecrets,
  ExecutorSecretsUnavailableError,
  ExecutorSecretsUndecryptableError,
  parseExecutorSecretKeys,
} from "./executor-secrets.js";
import { decryptCredentials, mergeExecutorSettings, type ExecutorSettingsRecord } from "./executor-settings.js";

/**
 * Key rotation, and the two refusals around it.
 *
 * Worth automating because none of it shows up while using the product: rotate the server key, and
 * a working configuration either keeps working (key-id scheme) or silently reads as "never
 * configured" — and the second one is indistinguishable from the user's own memory being wrong.
 */

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

function secrets(spec: string) {
  return createExecutorSecrets(parseExecutorSecretKeys(spec));
}

test("密文自带 key-id；换了当前密钥之后旧密文仍解得开", () => {
  const before = secrets(`k1:${keyA}`);
  const ciphertext = before.encrypt(JSON.stringify({ anthropic: { type: "api_key", key: "sk-old" } }));
  assert.match(ciphertext, /^v1\.k1\./);

  // 轮换：新密钥排第一，旧的留在后面。整表重加密是不需要的。
  const after = secrets(`k2:${keyB},k1:${keyA}`);
  assert.equal(JSON.parse(after.decrypt(ciphertext)).anthropic.key, "sk-old");
  // 新写入一律用当前那把。
  assert.match(after.encrypt("x"), /^v1\.k2\./);
});

test("旧密钥被从配置里拿掉之后，解密失败是一条可读错误而不是空配置", () => {
  const before = secrets(`k1:${keyA}`);
  const ciphertext = before.encrypt(JSON.stringify({ anthropic: { type: "api_key", key: "sk-old" } }));
  const after = secrets(`k2:${keyB}`);
  assert.throws(() => after.decrypt(ciphertext), ExecutorSecretsUndecryptableError);

  const decrypted = decryptCredentials(after, ciphertext);
  assert.deepEqual(decrypted.map, {});
  assert.match(decrypted.error, /重新填写 API key/);
});

test("密文被改过一个字节就解不开（GCM 认证），不会返回半截明文", () => {
  const store = secrets(`k1:${keyA}`);
  const ciphertext = store.encrypt("hello");
  const parts = ciphertext.split(".");
  const body = Buffer.from(parts[4]!, "base64url");
  body[0] = body[0]! ^ 0xff;
  parts[4] = body.toString("base64url");
  assert.throws(() => store.decrypt(parts.join(".")), ExecutorSecretsUndecryptableError);
});

test("没配密钥时写凭据被拒绝，绝不降级成明文落库", () => {
  const none = secrets("");
  assert.equal(none.available(), false);
  assert.throws(() => none.encrypt("sk-1"), ExecutorSecretsUnavailableError);
  assert.throws(
    () => mergeExecutorSettings(undefined, { provider: "anthropic", modelId: "x", credentials: { anthropic: "sk-1" } }, none, 1),
    ExecutorSecretsUnavailableError,
  );
  // 不碰凭据的保存照常可以进行：没有密钥并不该让整个配置面瘫掉。
  const merged = mergeExecutorSettings(undefined, { provider: "anthropic", modelId: "x" }, none, 1);
  assert.equal(merged.record.credentialsCiphertext, "");
});

test("格式非法的密钥整条拒绝，不静默跳过——跳过一把旧密钥等于那批行永久读不出来", () => {
  assert.throws(() => parseExecutorSecretKeys("k1"), /keyId/);
  assert.throws(() => parseExecutorSecretKeys(`k1:${keyA},k1:${keyB}`), /重复/);
  assert.throws(() => parseExecutorSecretKeys("k1:short"), /32 字节/);
  assert.throws(() => parseExecutorSecretKeys(`k 1:${keyA}`), /只能是字母/);
});

test("凭据是只写的：patch 里没提到的 provider 保持原样，空串才清除", () => {
  const store = secrets(`k1:${keyA}`);
  const first = mergeExecutorSettings(
    undefined,
    { provider: "anthropic", modelId: "claude-x", credentials: { anthropic: "sk-a", "my-relay": "sk-r" } },
    store,
    1,
  );
  const previous: ExecutorSettingsRecord = { accountId: "a", deviceId: null, ...first.record };

  // 只换模型：两把 key 都还在，而且密文原样保留（没必要重新加密）。
  const untouched = mergeExecutorSettings(previous, { modelId: "claude-y" }, store, 2);
  assert.deepEqual(untouched.record.credentialProviderIds, ["anthropic", "my-relay"]);
  assert.equal(untouched.record.credentialsCiphertext, previous.credentialsCiphertext);
  assert.equal(untouched.record.revision, previous.revision + 1);

  // 空串清掉一把，另一把不受影响。
  const cleared = mergeExecutorSettings(previous, { credentials: { anthropic: "" } }, store, 3);
  assert.deepEqual(cleared.record.credentialProviderIds, ["my-relay"]);
  assert.equal(JSON.parse(store.decrypt(cleared.record.credentialsCiphertext))["my-relay"].key, "sk-r");
});

test("删掉一个自定义端点，它的凭据跟着走", () => {
  const store = secrets(`k1:${keyA}`);
  const relay = { id: "my-relay", name: "Relay", baseUrl: "https://r/v1", api: "openai-completions" as const, models: [], authHeader: false, keyless: false };
  const first = mergeExecutorSettings(
    undefined,
    { provider: "my-relay", modelId: "gpt-x", customProviders: [relay], credentials: { "my-relay": "sk-r" } },
    store,
    1,
  );
  const previous: ExecutorSettingsRecord = { accountId: "a", deviceId: null, ...first.record };
  const removed = mergeExecutorSettings(previous, { customProviders: [] }, store, 2);
  assert.deepEqual(removed.record.credentialProviderIds, []);
  assert.equal(removed.record.credentialsCiphertext, "");
});
