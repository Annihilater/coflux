/**
 * The changes view's diff model (plan 20260929-changes-file-tree).
 *
 * The worker sends one file's two sides whole plus git's `-U0` patch between them. Only the hunk
 * headers of that patch are read: they say which line ranges changed, and everything between them
 * is equal by construction, so each side can be rendered — and highlighted — as a whole file, and
 * any folded stretch can be revealed from the lines already here.
 */

/** A `@@ -a,b +c,d @@` header; counts default to 1 when git omits them. */
export type HunkRange = { oldStart: number; oldCount: number; newStart: number; newCount: number };

export type DiffSegment =
  | { kind: "equal"; oldStart: number; newStart: number; length: number }
  | { kind: "change"; oldStart: number; oldCount: number; newStart: number; newCount: number };

export type DiffMode = "split" | "inline";

/** Lines of context kept around every change; longer unchanged stretches fold into a gap row. */
export const CONTEXT_LINES = 3;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Hunk ranges of a unified patch, in order. Everything but the `@@` headers is ignored. */
export function parseHunkRanges(patch: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("@@ ")) continue;
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) continue;
    ranges.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return ranges;
}

/**
 * A file's lines the way git counts them: a final line without a trailing newline is still a line,
 * a trailing newline does not open another one. A CR before the newline is display noise and dropped.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Walks the hunks over both sides and returns alternating equal/change segments covering every
 * line. `-U0` headers name an empty range by the line *before* it, hence the `count === 0` case.
 * Inputs that disagree (a race between the list and the content) are clamped rather than trusted:
 * a surplus on one side becomes part of the change instead of misaligning everything after it.
 */
export function buildSegments(oldTotal: number, newTotal: number, hunks: HunkRange[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let oldAt = 0;
  let newAt = 0;

  const pushEqualThenChange = (oldUntil: number, newUntil: number, oldEnd: number, newEnd: number) => {
    const equal = Math.max(0, Math.min(oldUntil - oldAt, newUntil - newAt));
    if (equal > 0) segments.push({ kind: "equal", oldStart: oldAt, newStart: newAt, length: equal });
    const oldStart = oldAt + equal;
    const newStart = newAt + equal;
    const oldCount = Math.max(0, oldEnd - oldStart);
    const newCount = Math.max(0, newEnd - newStart);
    if (oldCount > 0 || newCount > 0) segments.push({ kind: "change", oldStart, oldCount, newStart, newCount });
    oldAt = Math.max(oldAt, oldEnd);
    newAt = Math.max(newAt, newEnd);
  };

  for (const hunk of hunks) {
    const oldStart = clamp(hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1, oldAt, oldTotal);
    const newStart = clamp(hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1, newAt, newTotal);
    const oldEnd = Math.min(oldTotal, oldStart + hunk.oldCount);
    const newEnd = Math.min(newTotal, newStart + hunk.newCount);
    pushEqualThenChange(oldStart, newStart, oldEnd, newEnd);
  }
  pushEqualThenChange(oldTotal, newTotal, oldTotal, newTotal);
  return segments;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function hasChanges(segments: DiffSegment[]): boolean {
  return segments.some((segment) => segment.kind === "change");
}

export type GapRow = { kind: "gap"; id: string; hidden: number };
/** Side-by-side: one row per line pair; a missing side is empty filler. */
export type SplitRow = {
  kind: "split";
  left: { line: number; changed: boolean } | null;
  right: { line: number; changed: boolean } | null;
};
/** Inline: deletions, then additions, then context, each with the line numbers it has. */
export type InlineRow = { kind: "inline"; type: "context" | "del" | "add"; oldLine: number | null; newLine: number | null };
export type DiffRow = GapRow | SplitRow | InlineRow;

/** A stable id for an equal stretch, so its expanded state survives re-rendering. */
export function gapId(segment: { oldStart: number; newStart: number }): string {
  return `${segment.oldStart}:${segment.newStart}`;
}

/**
 * Display rows for one file. Every equal stretch keeps `context` lines next to a change (none at
 * the file's edges) and folds the rest into one gap row, unless its id is in `expanded`.
 * Line numbers in rows are 0-based indexes into the side's lines.
 */
export function buildDiffRows(
  segments: DiffSegment[],
  mode: DiffMode,
  expanded: ReadonlySet<string>,
  context = CONTEXT_LINES,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const pushEqual = (oldLine: number, newLine: number) => {
    if (mode === "split") rows.push({ kind: "split", left: { line: oldLine, changed: false }, right: { line: newLine, changed: false } });
    else rows.push({ kind: "inline", type: "context", oldLine, newLine });
  };

  segments.forEach((segment, index) => {
    if (segment.kind === "change") {
      if (mode === "split") {
        const pairs = Math.max(segment.oldCount, segment.newCount);
        for (let offset = 0; offset < pairs; offset += 1) {
          rows.push({
            kind: "split",
            left: offset < segment.oldCount ? { line: segment.oldStart + offset, changed: true } : null,
            right: offset < segment.newCount ? { line: segment.newStart + offset, changed: true } : null,
          });
        }
      } else {
        for (let offset = 0; offset < segment.oldCount; offset += 1) {
          rows.push({ kind: "inline", type: "del", oldLine: segment.oldStart + offset, newLine: null });
        }
        for (let offset = 0; offset < segment.newCount; offset += 1) {
          rows.push({ kind: "inline", type: "add", oldLine: null, newLine: segment.newStart + offset });
        }
      }
      return;
    }

    const id = gapId(segment);
    const head = index === 0 ? 0 : context;
    const tail = index === segments.length - 1 ? 0 : context;
    const hidden = segment.length - head - tail;
    if (hidden <= 0 || expanded.has(id)) {
      for (let offset = 0; offset < segment.length; offset += 1) pushEqual(segment.oldStart + offset, segment.newStart + offset);
      return;
    }
    for (let offset = 0; offset < head; offset += 1) pushEqual(segment.oldStart + offset, segment.newStart + offset);
    rows.push({ kind: "gap", id, hidden });
    for (let offset = segment.length - tail; offset < segment.length; offset += 1) {
      pushEqual(segment.oldStart + offset, segment.newStart + offset);
    }
  });
  return rows;
}
