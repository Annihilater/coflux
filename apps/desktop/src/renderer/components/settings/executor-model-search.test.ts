import assert from "node:assert/strict";
import { test } from "node:test";

import { describeModelSpec, searchModelOptions } from "./executor-model-search";
import type { DesktopExecutorModelOption } from "../../../shared/desktop-bridge";

const models: DesktopExecutorModelOption[] = [
  { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, cost: { input: 3, output: 15 } },
  { provider: "anthropic", providerName: "Anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000, cost: { input: 15, output: 75 } },
  { provider: "openrouter", providerName: "OpenRouter", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5 (OpenRouter)", contextWindow: 200_000, cost: { input: 3.3, output: 16 } },
  { provider: "my-relay", providerName: "My relay", id: "gpt-x", name: "GPT X", contextWindow: null, cost: null },
  { provider: "ollama", providerName: "Ollama", id: "llama3", name: "llama3", contextWindow: null, cost: { input: 0, output: 0 } },
];

test("跨 provider 搜：输 sonnet 直接找到 anthropic 的那条，不必先选家", () => {
  const results = searchModelOptions(models, "sonnet");
  assert.equal(results.length >= 2, true);
  assert.equal(results[0]!.auxiliaryData.id.includes("sonnet"), true);
  assert.equal(results.some((entry) => entry.auxiliaryData.provider === "openrouter"), true);
});

test("每个词都要命中，所以多个词是收窄而不是放宽", () => {
  assert.equal(searchModelOptions(models, "claude opus").length, 1);
  assert.equal(searchModelOptions(models, "claude nothing").length, 0);
});

test("已选中的 provider 只用来打破并列，不做过滤", () => {
  const results = searchModelOptions(models, "sonnet", "openrouter");
  assert.equal(results[0]!.auxiliaryData.provider, "openrouter");
  // 别家的照样在结果里——搜索的意义就在于不必先选对 provider。
  assert.equal(results.some((entry) => entry.auxiliaryData.provider === "anthropic"), true);
});

test("空查询给出可浏览的首页，而不是空", () => {
  assert.equal(searchModelOptions(models, "").length, models.length);
});

/** 自定义端点的模型是手填的，pi 要求的规格是我们自己编的占位值。把它们当规格展示就是把编造的数字
 * 说成事实，所以一律显示「未知」。 */
test("自定义模型的规格显示未知，不把占位值当真", () => {
  const custom = models.find((model) => model.provider === "my-relay")!;
  assert.match(describeModelSpec(custom), /上下文 未知/);
  assert.match(describeModelSpec(custom), /价格 未知/);
});

test("内置模型显示真实的上下文窗口与价格", () => {
  const builtin = models.find((model) => model.id === "claude-sonnet-5" && model.provider === "anthropic")!;
  const text = describeModelSpec(builtin);
  assert.match(text, /上下文 200K/);
  assert.match(text, /入 \$3\.00/);
  assert.match(text, /出 \$15\.00/);
});

test("价格全零读作免费 / 自托管，而不是 $0", () => {
  const local = models.find((model) => model.provider === "ollama")!;
  assert.match(describeModelSpec(local), /免费 \/ 自托管/);
});
