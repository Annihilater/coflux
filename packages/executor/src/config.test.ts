import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createExecutorConfigStore,
  deriveReadiness,
  EXECUTOR_SYSTEM_PROMPT,
  toExecutorView,
} from "./config.js";
import { EMPTY_EXECUTOR_CACHE, readExecutorSettingsCache, type ExecutorCachedSettings } from "./settings-cache.js";

function cache(overrides: Partial<ExecutorCachedSettings> = {}): ExecutorCachedSettings {
  return { ...EMPTY_EXECUTOR_CACHE, present: true, ...overrides };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "coflux-execcfg-"));
  return { dir, path: join(dir, "executor-settings.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("配置还没下发到本机时不是「没配过」，理由指向接入而不是去填模型", () => {
  const verdict = deriveReadiness(EMPTY_EXECUTOR_CACHE);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /还没收到账号里的 executor 配置/);
});

test("缺哪项理由就说哪项，且指向设置页而不是早已不存在的账号菜单入口", () => {
  const noModel = deriveReadiness(cache({ provider: "anthropic" }));
  assert.equal(noModel.ready, false);
  assert.match(noModel.reason, /provider 与模型/);
  assert.match(noModel.reason, /设置页/);

  const noKey = deriveReadiness(cache({ provider: "anthropic", modelId: "claude-x" }));
  assert.equal(noKey.ready, false);
  assert.match(noKey.reason, /anthropic 的 API key/);
  assert.match(noKey.reason, /设置页/);

  for (const reason of [noModel.reason, noKey.reason]) assert.doesNotMatch(reason, /账号菜单/);
});

test("配齐即 ready", () => {
  const verdict = deriveReadiness(cache({ provider: "anthropic", modelId: "claude-x", credentials: { anthropic: "sk-1" } }));
  assert.deepEqual(verdict, { ready: true, reason: "" });
});

test("keyless 端点不需要 key 也 ready", () => {
  const settings = cache({
    provider: "ollama",
    modelId: "llama3",
    customProviders: [{ id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", models: [{ id: "llama3", name: "llama3" }], authHeader: false, keyless: true }],
  });
  assert.equal(deriveReadiness(settings).ready, true);
});

/** 解密失败必须表现成一条可读错误，而不是 ready=false 的「你没配过」——后者会让用户重配一遍并
 * 以为自己记错了。 */
test("中心解不开旧密文时，理由照实说密钥变更，且不假装成未配置", () => {
  const settings = cache({ provider: "anthropic", modelId: "claude-x", credentialError: "服务端密钥已变更，请重新填写 API key" });
  const verdict = deriveReadiness(settings);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /服务端密钥已变更/);
  assert.doesNotMatch(verdict.reason, /还没收到/);
});

test("渲染层看得见的视图里没有凭据的任何形态", () => {
  const view = toExecutorView(cache({
    provider: "anthropic",
    modelId: "claude-x",
    credentials: { anthropic: "sk-super-secret", "my-relay": "sk-relay" },
  }));
  assert.equal(view.hasApiKey, true);
  assert.deepEqual(view.credentialProviders, ["anthropic", "my-relay"]);
  assert.equal(JSON.stringify(view).includes("sk-super-secret"), false);
  assert.equal(JSON.stringify(view).includes("sk-relay"), false);
});

test("secrets() 才给明文 key，并且带上自定义端点定义给 runner 自己注册", () => {
  const scratchDir = scratch();
  try {
    writeFileSync(
      scratchDir.path,
      JSON.stringify({
        revision: 3,
        provider: "my-relay",
        modelId: "gpt-x",
        customProviders: [{ id: "my-relay", name: "Relay", baseUrl: "https://relay/v1", api: "openai-completions", models: [{ id: "gpt-x", name: "GPT X" }], authHeader: true, keyless: false }],
        credentials: [{ providerId: "my-relay", type: "api_key", apiKey: "sk-relay" }],
        credentialError: "",
      }),
    );
    const store = createExecutorConfigStore({ cachePath: scratchDir.path, pollMs: 60_000 });
    try {
      const secrets = store.secrets();
      assert.equal(secrets.apiKey, "sk-relay");
      assert.equal(secrets.customProviders[0]?.baseUrl, "https://relay/v1");
      assert.equal(store.view().ready, true);
    } finally {
      store.dispose();
    }
  } finally {
    scratchDir.cleanup();
  }
});

test("缓存文件缺失或损坏都不抛，按「daemon 还没下发」处理", () => {
  const scratchDir = scratch();
  try {
    assert.deepEqual(readExecutorSettingsCache(scratchDir.path), EMPTY_EXECUTOR_CACHE);
    writeFileSync(scratchDir.path, "{ not json");
    const broken = readExecutorSettingsCache(scratchDir.path);
    // 文件在但读不懂：说它在、且不可用，而不是当成从没配过。
    assert.equal(broken.present, true);
    assert.equal(broken.provider, "");
    assert.match(broken.credentialError, /无法解析/);
  } finally {
    scratchDir.cleanup();
  }
});

test("oauth 形态的凭据这一版读不懂，被丢掉而不是当成 api_key", () => {
  const scratchDir = scratch();
  try {
    writeFileSync(
      scratchDir.path,
      JSON.stringify({ revision: 1, provider: "anthropic", modelId: "claude-x", customProviders: [], credentials: [{ providerId: "anthropic", type: "oauth", apiKey: "" }], credentialError: "" }),
    );
    const settings = readExecutorSettingsCache(scratchDir.path);
    assert.deepEqual(settings.credentials, {});
    assert.equal(deriveReadiness(settings).ready, false);
  } finally {
    scratchDir.cleanup();
  }
});

test("system prompt 把三条硬边界都写给了模型", () => {
  assert.match(EXECUTOR_SYSTEM_PROMPT, /only modify files inside the workspace/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /Git metadata is read-only/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /no network access/);
  assert.match(EXECUTOR_SYSTEM_PROMPT, /absolute paths/);
});
