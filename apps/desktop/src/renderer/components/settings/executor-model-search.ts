import type { DesktopExecutorModelOption } from "@/desktop-bridge";

/**
 * Model search for the Executor settings section.
 *
 * Searching across providers is the primary way in, not a convenience: openrouter alone ships 366
 * models and vercel-ai-gateway 237, so a plain dropdown is unusable. Typing `sonnet` has to reach
 * `anthropic/claude-sonnet-5` without first picking Anthropic.
 *
 * Pure and separate from the component so the ranking can be asserted directly.
 */

/** The Typeahead item shape: a stable id, a label, and the option itself as auxiliary data. */
export type ExecutorModelChoice = {
  id: string;
  label: string;
  auxiliaryData: DesktopExecutorModelOption;
};

/**
 * Rank matches, stably and simply: a hit on the model id outranks one on its display name, which
 * outranks one on the provider. Ties keep catalogue order. Every term has to match somewhere, so
 * `claude 5` narrows rather than widens.
 *
 * `preferredProvider` only breaks ties. It does **not** filter: the point of the search is that the
 * user need not have picked the right provider first.
 */
export function searchModelOptions(
  models: readonly DesktopExecutorModelOption[],
  query: string,
  preferredProvider = "",
  limit = 40,
): ExecutorModelChoice[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  const scored: { option: DesktopExecutorModelOption; score: number; index: number }[] = [];
  models.forEach((option, index) => {
    let score = preferredProvider && option.provider === preferredProvider ? 1 : 0;
    if (terms.length > 0) {
      const id = option.id.toLowerCase();
      const name = option.name.toLowerCase();
      const provider = `${option.provider} ${option.providerName}`.toLowerCase();
      for (const term of terms) {
        if (id.includes(term)) score += 40;
        else if (name.includes(term)) score += 20;
        else if (provider.includes(term)) score += 10;
        else return;
      }
    }
    scored.push({ option, score, index });
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, limit).map((entry) => ({
    id: `${entry.option.provider}/${entry.option.id}`,
    label: `${entry.option.name}`,
    auxiliaryData: entry.option,
  }));
}

/**
 * The one-line specification under a model.
 *
 * A custom endpoint's models are hand-typed, and the context window / price pi requires for them are
 * values this app invented to satisfy `registerProvider`. Showing those as a specification would be
 * presenting a made-up number as a fact, so they read 「未知」 instead.
 */
export function describeModelSpec(option: DesktopExecutorModelOption): string {
  const parts: string[] = [];
  parts.push(option.contextWindow === null ? "上下文 未知" : `上下文 ${formatTokens(option.contextWindow)}`);
  parts.push(
    option.cost === null
      ? "价格 未知"
      : option.cost.input === 0 && option.cost.output === 0
        ? "免费 / 自托管"
        : `入 $${formatPrice(option.cost.input)} · 出 $${formatPrice(option.cost.output)} / 百万 token`,
  );
  return parts.join(" · ");
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatPrice(price: number): string {
  if (price === 0) return "0";
  return price >= 1 ? price.toFixed(2) : price.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
