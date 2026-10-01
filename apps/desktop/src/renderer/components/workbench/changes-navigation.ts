/**
 * F7 / ⇧F7 stepping through changes (plan 20261001-changes-review-polish): change by change inside
 * the selected file, then on to the neighbouring file in tree order.
 *
 * - `skip`: nothing to step through (binary, rename-only, over the hard size limit) — passed over.
 * - `stop`: a large file waiting for 「仍然加载」 — selected, and the next press moves past it.
 * - `content`: selected, landing on its first (F7) or last (⇧F7) change once its content is there.
 */
export type ChangeNavKind = "skip" | "stop" | "content";

/** Where a press goes from the current file. */
export type ChangeStep =
  | { kind: "change"; index: number }
  | { kind: "file"; path: string; land: "first" | "last" | null }
  | { kind: "none" };

/**
 * `index` is the current change of the selected file (null when none is current yet) and `count`
 * how many changes it has, or null when its content is not on screen (loading, failed, a large file
 * not loaded, nothing to show). With no current change, F7 goes to the first one and ⇧F7 leaves for
 * the previous file.
 */
export function stepChange(
  order: readonly string[],
  selected: string | null,
  index: number | null,
  count: number | null,
  delta: 1 | -1,
  kindOf: (path: string) => ChangeNavKind,
): ChangeStep {
  if (selected !== null && count !== null && count > 0) {
    const next = index === null ? (delta === 1 ? 0 : -1) : Math.min(index, count - 1) + delta;
    if (next >= 0 && next < count) return { kind: "change", index: next };
  }
  const path = neighbourFile(order, selected, delta, kindOf);
  if (path === null) return { kind: "none" };
  const kind = kindOf(path);
  return { kind: "file", path, land: kind === "content" ? (delta === 1 ? "first" : "last") : null };
}

/** The nearest file `delta` away in tree order that has something to step through. */
export function neighbourFile(
  order: readonly string[],
  from: string | null,
  delta: 1 | -1,
  kindOf: (path: string) => ChangeNavKind,
): string | null {
  const at = from === null ? -1 : order.indexOf(from);
  let index = at < 0 ? (delta === 1 ? 0 : order.length - 1) : at + delta;
  for (; index >= 0 && index < order.length; index += delta) {
    const path = order[index]!;
    if (kindOf(path) !== "skip") return path;
  }
  return null;
}
