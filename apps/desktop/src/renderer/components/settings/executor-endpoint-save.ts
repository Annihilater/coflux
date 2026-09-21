/**
 * What an endpoint save submits as its selection.
 *
 * The settings page has two save surfaces with deliberately different semantics. The model card
 * submits what the **form** holds — that is what its 「保存」 means. The endpoint paths (add, edit,
 * delete) submit what the **account** holds: adding an endpoint must not quietly rewrite a saved
 * provider/model because the dropdown above happens to be showing something else, and the key typed
 * into the model card but never submitted must not ride along with it.
 *
 * Submitting the saved pair verbatim is not enough, though. A save carries the endpoint list it
 * produces and is validated against the catalogue that list implies, so deleting the endpoint the
 * account currently selects would be refused with "provider 不存在" — the one endpoint you can
 * never remove is the one you are using. So the saved selection is *projected* onto what will still
 * resolve after this save, and cleared when it will not.
 *
 * **Both fields are cleared together, never one of them.** `validateExecutorSelection` treats an
 * empty pair as the legal "not configured yet" state but keeps refusing a provider with no model,
 * so clearing only the model would swap one refusal for another.
 *
 * Pure and outside the component on purpose: the desktop has no component test harness, so keeping
 * this inline would ship the most error-prone half of the fix with no automated gate at all.
 */

import type { DesktopExecutorCatalog, DesktopExecutorCustomProvider } from "@/desktop-bridge";

export type ExecutorSavedSelection = { provider: string; modelId: string };

export type ExecutorEndpointSaveContext = {
  /** The selection the **account** holds right now — not the model card's unsaved form state. */
  saved: ExecutorSavedSelection;
  /** The endpoint list this save will write. Authoritative for custom providers. */
  endpoints: readonly DesktopExecutorCustomProvider[];
  /**
   * The catalogue as the page last read it; null while it is still loading. It is the only source
   * for built-in providers and their models, and it is also how a *removed* custom endpoint is told
   * apart from a built-in one.
   */
  catalog: Pick<DesktopExecutorCatalog, "providers" | "models"> | null;
};

const CLEARED: ExecutorSavedSelection = { provider: "", modelId: "" };

/**
 * The selection an endpoint save should submit: the account's own, kept if it still resolves after
 * this save, cleared outright if it does not.
 */
export function projectSavedSelection(context: ExecutorEndpointSaveContext): ExecutorSavedSelection {
  const { provider, modelId } = context.saved;
  // Nothing configured yet, or a stored half-pair that could never resolve anyway. Either way the
  // legal shape to submit is the empty one.
  if (!provider || !modelId) return CLEARED;

  const endpoint = context.endpoints.find((entry) => entry.id === provider);
  if (endpoint) {
    // A custom endpoint this save writes: its own model list is what will exist afterwards, even
    // when this very save is the thing rewriting it.
    return endpoint.models.some((model) => model.id === modelId) ? { provider, modelId } : CLEARED;
  }

  // Not one of this save's endpoints. It is either built-in, or a custom endpoint this save
  // removes — only the catalogue can tell the two apart.
  if (!context.catalog) {
    // No catalogue in hand and the endpoint list does not contradict the selection. Dropping the
    // user's saved choice on a guess would be worse than the main process refusing the save with a
    // reason, which is what happens if the guess was wrong.
    return { provider, modelId };
  }
  const option = context.catalog.providers.find((entry) => entry.id === provider);
  // `custom: true` means the catalogue still carries an endpoint this save is deleting. A built-in
  // provider that is simply gone (retired across a pi upgrade) lands here too, and is cleared the
  // same way — the user re-picks rather than the endpoint save being wedged forever.
  if (!option || option.custom) return CLEARED;
  return context.catalog.models.some((model) => model.provider === provider && model.id === modelId)
    ? { provider, modelId }
    : CLEARED;
}
