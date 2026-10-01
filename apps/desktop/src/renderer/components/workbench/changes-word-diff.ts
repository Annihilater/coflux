/**
 * Word-level emphasis inside a changed line pair (plan 20261001-changes-review-polish).
 *
 * Git aligns the lines; this only says which words of an old/new pair differ, so the view can tint
 * them stronger than the line. Lines are split into identifier runs, whitespace runs and single
 * punctuation characters, the common prefix and suffix are dropped, and the middle is compared with
 * a longest-common-subsequence table. A pair that is too long or too dissimilar gets no emphasis,
 * so a rewritten line keeps its plain line tint instead of turning into confetti.
 */

import type { WhitespaceMode } from "@coflux/client";

/** Character range `[start, end)` within one line. */
export type WordRange = { start: number; end: number };
export type WordEmphasis = { old: WordRange[]; new: WordRange[] };

/** Longer lines are not compared at all. */
const MAX_LINE_CHARS = 2000;
/** Upper bound of the LCS table between the differing middles (rows × columns). */
const MAX_TABLE_CELLS = 40_000;
/** Below this share of unchanged non-whitespace characters, the pair counts as a rewrite. */
const MIN_SIMILARITY = 0.4;

const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]/gu;

type Token = { text: string; start: number; end: number; space: boolean };

export function tokenizeWords(line: string): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    tokens.push({ text: match[0], start, end: start + match[0].length, space: /^\s/.test(match[0]) });
  }
  return tokens;
}

/**
 * The changed ranges of each side, or null when the pair should get no word emphasis. The
 * whitespace mode mirrors git's flag: from `ignoreAtEol` on, trailing whitespace is never
 * emphasised; from `ignoreChange` on, runs of different width compare equal; with `ignoreAll`,
 * unmatched whitespace is never emphasised anywhere.
 */
export function wordEmphasis(oldLine: string, newLine: string, whitespace: WhitespaceMode): WordEmphasis | null {
  if (oldLine.length > MAX_LINE_CHARS || newLine.length > MAX_LINE_CHARS) return null;
  const left = tokenizeWords(oldLine);
  const right = tokenizeWords(newLine);
  const runsEqual = whitespace === "ignoreChange" || whitespace === "ignoreAll";
  const key = (token: Token) => (runsEqual && token.space ? " " : token.text);

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && key(left[prefix]!) === key(right[prefix]!)) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    key(left[left.length - 1 - suffix]!) === key(right[right.length - 1 - suffix]!)
  ) {
    suffix += 1;
  }
  const leftMiddle = left.slice(prefix, left.length - suffix);
  const rightMiddle = right.slice(prefix, right.length - suffix);
  if (leftMiddle.length * rightMiddle.length > MAX_TABLE_CELLS) return null;

  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  for (let index = 0; index < prefix; index += 1) {
    leftMatched[index] = true;
    rightMatched[index] = true;
  }
  for (let index = 0; index < suffix; index += 1) {
    leftMatched[left.length - 1 - index] = true;
    rightMatched[right.length - 1 - index] = true;
  }
  matchMiddle(leftMiddle.map(key), rightMiddle.map(key), (leftIndex, rightIndex) => {
    leftMatched[prefix + leftIndex] = true;
    rightMatched[prefix + rightIndex] = true;
  });

  // Similarity over non-whitespace characters only: indentation must not make a rewrite look similar.
  let total = 0;
  let kept = 0;
  left.forEach((token, index) => {
    if (token.space) return;
    total += token.text.length;
    if (leftMatched[index]) kept += token.text.length;
  });
  right.forEach((token, index) => {
    if (token.space) return;
    total += token.text.length;
    if (rightMatched[index]) kept += token.text.length;
  });
  if (total > 0 && kept / total < MIN_SIMILARITY) return null;

  return {
    old: changedRanges(left, leftMatched, whitespace),
    new: changedRanges(right, rightMatched, whitespace),
  };
}

/** Marks one longest common subsequence of `a` and `b`. */
function matchMiddle(a: string[], b: string[], mark: (aIndex: number, bIndex: number) => void) {
  if (a.length === 0 || b.length === 0) return;
  const columns = b.length + 1;
  // lengths[i][j] = LCS of a[i..] and b[j..], flattened.
  const lengths = new Uint16Array((a.length + 1) * columns);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * columns + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * columns + j + 1]! + 1
          : Math.max(lengths[(i + 1) * columns + j]!, lengths[i * columns + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      mark(i, j);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * columns + j]! >= lengths[i * columns + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
}

/** Unmatched tokens as merged ranges; whitespace is skipped when the mode does not count it. */
function changedRanges(tokens: Token[], matched: boolean[], whitespace: WhitespaceMode): WordRange[] {
  const ranges: WordRange[] = [];
  tokens.forEach((token, index) => {
    if (matched[index]) return;
    if (token.space && (whitespace === "ignoreAll" || (whitespace !== "show" && index === tokens.length - 1))) return;
    const last = ranges[ranges.length - 1];
    if (last && last.end === token.start) last.end = token.end;
    else ranges.push({ start: token.start, end: token.end });
  });
  return ranges;
}

export type EmphasisPiece = { content: string; color?: string; emphasis: boolean };

/**
 * Splits highlighted tokens at the emphasis boundaries, so a word tint can sit on top of the
 * syntax colours without replacing them. Tokens must concatenate to the line the ranges refer to.
 */
export function overlayEmphasis(tokens: readonly { content: string; color?: string }[], ranges: readonly WordRange[]): EmphasisPiece[] {
  const pieces: EmphasisPiece[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const token of tokens) {
    const tokenEnd = offset + token.content.length;
    let at = offset;
    while (at < tokenEnd) {
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= at) rangeIndex += 1;
      const range = ranges[rangeIndex];
      let end: number;
      let emphasis: boolean;
      if (range && range.start <= at) {
        end = Math.min(tokenEnd, range.end);
        emphasis = true;
      } else {
        end = Math.min(tokenEnd, range ? range.start : tokenEnd);
        emphasis = false;
      }
      pieces.push({ content: token.content.slice(at - offset, end - offset), color: token.color, emphasis });
      at = end;
    }
    offset = tokenEnd;
  }
  return pieces;
}
