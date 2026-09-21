import assert from "node:assert/strict";
import { test } from "node:test";

import { projectSavedSelection } from "./executor-endpoint-save";
import type { DesktopExecutorCatalog, DesktopExecutorCustomProvider } from "../../../shared/desktop-bridge";

const relay: DesktopExecutorCustomProvider = {
  id: "my-relay",
  name: "My relay",
  baseUrl: "https://relay.example/v1",
  api: "openai-completions",
  models: [
    { id: "gpt-x", name: "GPT X" },
    { id: "gpt-y", name: "GPT Y" },
  ],
  authHeader: false,
  keyless: false,
};

const ollama: DesktopExecutorCustomProvider = {
  id: "ollama",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  models: [{ id: "llama3", name: "llama3" }],
  authHeader: false,
  keyless: true,
};

const catalog: Pick<DesktopExecutorCatalog, "providers" | "models"> = {
  providers: [
    { id: "anthropic", name: "Anthropic", custom: false, keyless: false },
    { id: "my-relay", name: "My relay", custom: true, keyless: false },
    { id: "ollama", name: "Ollama", custom: true, keyless: true },
  ],
  models: [
    { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, cost: { input: 3, output: 15 } },
    { provider: "my-relay", providerName: "My relay", id: "gpt-x", name: "GPT X", contextWindow: null, cost: null },
    { provider: "my-relay", providerName: "My relay", id: "gpt-y", name: "GPT Y", contextWindow: null, cost: null },
    { provider: "ollama", providerName: "Ollama", id: "llama3", name: "llama3", contextWindow: null, cost: null },
  ],
};

/** 删掉正在用的那个端点，如果还照原样提交选择，中心那侧会以「provider 不存在」拒绝——于是唯一删不掉的
 * 端点就是你正在用的那个。清空之后账号回到「还没配」，这是合法状态。 */
test("删掉账号正在用的端点：两个字段一起清空", () => {
  const result = projectSavedSelection({
    saved: { provider: "my-relay", modelId: "gpt-x" },
    endpoints: [ollama],
    catalog,
  });
  assert.deepEqual(result, { provider: "", modelId: "" });
});

/** 只清 modelId 会留下「有 provider 没模型」，而那一形态仍然被拒绝——等于把一次拒绝换成另一次。 */
test("编辑端点把正在用的模型删了：清空的是两个字段，不是只清模型", () => {
  const edited: DesktopExecutorCustomProvider = { ...relay, models: [{ id: "gpt-y", name: "GPT Y" }] };
  const result = projectSavedSelection({
    saved: { provider: "my-relay", modelId: "gpt-x" },
    endpoints: [edited],
    catalog,
  });
  assert.deepEqual(result, { provider: "", modelId: "" });
});

test("端点还提供那个模型时，改它的 base URL 不动账号的选择", () => {
  const edited: DesktopExecutorCustomProvider = { ...relay, baseUrl: "https://relay.example/v2" };
  const result = projectSavedSelection({
    saved: { provider: "my-relay", modelId: "gpt-x" },
    endpoints: [edited],
    catalog,
  });
  assert.deepEqual(result, { provider: "my-relay", modelId: "gpt-x" });
});

test("改的是别的端点，选中的那个原样保留", () => {
  const result = projectSavedSelection({
    saved: { provider: "my-relay", modelId: "gpt-x" },
    endpoints: [relay, { ...ollama, baseUrl: "http://127.0.0.1:11435/v1" }],
    catalog,
  });
  assert.deepEqual(result, { provider: "my-relay", modelId: "gpt-x" });
});

test("选的是目录里还在的内置 provider：加端点碰不到它", () => {
  const result = projectSavedSelection({
    saved: { provider: "anthropic", modelId: "claude-sonnet-5" },
    endpoints: [relay, ollama],
    catalog,
  });
  assert.deepEqual(result, { provider: "anthropic", modelId: "claude-sonnet-5" });
});

/** pi 升级下架了一个内置 provider 或模型。不修，按解析不出来处理清掉——否则此后每一次端点保存都会
 * 被「provider 不存在」堵死。 */
test("选的 provider 端点列表与目录里都没有：清空", () => {
  const result = projectSavedSelection({
    saved: { provider: "retired-vendor", modelId: "whatever" },
    endpoints: [relay],
    catalog,
  });
  assert.deepEqual(result, { provider: "", modelId: "" });
});

test("内置 provider 还在但模型下架了：同样两个一起清", () => {
  const result = projectSavedSelection({
    saved: { provider: "anthropic", modelId: "claude-retired" },
    endpoints: [relay],
    catalog,
  });
  assert.deepEqual(result, { provider: "", modelId: "" });
});

test("账号本来就没配，提交的就是空选择", () => {
  assert.deepEqual(
    projectSavedSelection({ saved: { provider: "", modelId: "" }, endpoints: [relay], catalog }),
    { provider: "", modelId: "" },
  );
  // 存量里万一留下半截，也按「还没配」提交，不把它原样传下去再被拒。
  assert.deepEqual(
    projectSavedSelection({ saved: { provider: "my-relay", modelId: "" }, endpoints: [relay], catalog }),
    { provider: "", modelId: "" },
  );
});

/** 目录还没读回来时猜不出内置与「正被删掉的自定义端点」的区别。这时保留：猜错了主进程会带着原因拒绝，
 * 猜对了什么也没发生；反过来猜错就是把用户存着的选择无声丢掉。 */
test("目录还没读回来：端点列表没否定它就原样保留", () => {
  const result = projectSavedSelection({
    saved: { provider: "anthropic", modelId: "claude-sonnet-5" },
    endpoints: [relay],
    catalog: null,
  });
  assert.deepEqual(result, { provider: "anthropic", modelId: "claude-sonnet-5" });
});

test("目录还没读回来，但端点列表里那条已经不给这个模型了：照样清空", () => {
  const result = projectSavedSelection({
    saved: { provider: "my-relay", modelId: "gpt-x" },
    endpoints: [{ ...relay, models: [{ id: "gpt-y", name: "GPT Y" }] }],
    catalog: null,
  });
  assert.deepEqual(result, { provider: "", modelId: "" });
});
