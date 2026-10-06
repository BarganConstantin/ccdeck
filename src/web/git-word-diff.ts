// The words that changed inside a changed line. A removed line and the added
// line that replaced it are compared word by word, and only the words that
// differ are marked, so `Secure;` stands out in a cookie line that is
// otherwise the same — Fork's token diff, Sublime Merge's character diff.
//
// A line that was rewritten rather than edited gets no marks: when the two
// share too little, marking almost everything says less than the line's own
// tint. And the comparison is a longest-common-subsequence over tokens, which
// is quadratic, so it is capped: long lines and long runs are left unmarked
// rather than paid for.
import type { DiffLine } from "./git-diff-parse";

/** `[start, end)` character offsets into a line's text. */
export type Range = [number, number];

/** Lines longer than this are not compared. */
const MAX_CHARS = 800;
/** Token pairs the comparison may visit: 160 tokens a side, at most. */
const MAX_CELLS = 160 * 160;
/** How much two lines must share, as a share of the longer one's characters,
 *  before marking the difference says anything. */
const MIN_SHARED = 0.35;

/** Words (a letter's combining marks with it), runs of white space, an emoji
 *  whole (its modifiers, variation selectors and joined parts), a flag's two
 *  letters, and every other character on its own: a changed emoji or syllable
 *  is marked whole, never as one code point of it. */
export function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}\p{M}_$]+|\s+|\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0F]|\u200D\p{Extended_Pictographic}\uFE0F?)*|\p{Regional_Indicator}{2}|[^\p{L}\p{N}_$\s]/gu) ?? [];
}

/**
 * The changed ranges of `a` (the removed line) and `b` (the added one), or
 * null when the two are too different, or too long, to compare. Identical
 * lines answer two empty lists.
 */
export function wordDiff(a: string, b: string): { a: Range[]; b: Range[] } | null {
  if (a === b) return { a: [], b: [] };
  if (a.length > MAX_CHARS || b.length > MAX_CHARS) return null;
  const ta = tokenize(a), tb = tokenize(b);
  const n = ta.length, m = tb.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return null;
  // lcs[i][j]: the common subsequence of ta[i..] and tb[j..], in characters,
  // so a shared long word outweighs a shared comma.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ta[i] === tb[j]
        ? lcs[(i + 1) * w + j + 1] + ta[i].length
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const shared = lcs[0];
  if (shared / Math.max(a.length, b.length) < MIN_SHARED) return null;
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ta[i] === tb[j]) { keepA[i++] = true; keepB[j++] = true; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
}

/** The changed tokens as character ranges, neighbours merged — across a
 *  single run of white space too, so two changed words read as one mark. */
function ranges(tokens: string[], kept: boolean[]): Range[] {
  const out: Range[] = [];
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    const start = at;
    at += tokens[i].length;
    if (kept[i]) continue;
    const last = out[out.length - 1];
    if (last && last[1] === start) last[1] = at;
    else if (last && i >= 2 && !kept[i - 2] && /^\s+$/.test(tokens[i - 1]) && last[1] === start - tokens[i - 1].length) last[1] = at;
    else out.push([start, at]);
  }
  // A mark starts and ends on a visible character: which of two equal spaces
  // the comparison kept is an accident, and white space changed on its own is
  // not worth a mark.
  const text = tokens.join("");
  const trimmed: Range[] = [];
  for (let [s, e] of out) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) trimmed.push([s, e]);
  }
  return trimmed;
}

/**
 * The word marks for a hunk's lines, by line index. Each run of removed lines
 * followed by a run of added lines is a block; its removed and added lines
 * are paired in order, and the extra lines of the longer run stay unmarked.
 */
export function hunkWordMarks(lines: readonly DiffLine[]): Map<number, Range[]> {
  const out = new Map<number, Range[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].kind === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i].kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = wordDiff(lines[delStart + k].text, lines[addStart + k].text);
      if (!d) continue;
      if (d.a.length) out.set(delStart + k, d.a);
      if (d.b.length) out.set(addStart + k, d.b);
    }
  }
  return out;
}
