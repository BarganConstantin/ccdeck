// Characters that change how code or a file name reads without being seen:
// the bidirectional controls a "Trojan Source" change hides behind (text that
// is stored in one order and drawn in another), and the invisible ones (a
// zero-width space that makes two names differ, tag characters that carry
// text nobody sees). An agent can write any of them, so the git view draws
// each as its code point instead, the way GitHub, GitLab and VS Code flag
// them, and says the diff holds some.
//
// Not counted: the zero-width joiner and non-joiner, which emoji and several
// scripts need, and the tag characters inside a flag emoji.

/** One hidden character, matched one at a time. */
const HIDDEN = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2028\u2029\u2060\u2066-\u2069\uFEFF]|(?<!\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0000}-\u{E007F}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

const NAMES: Record<number, string> = {
  0x061c: "arabic letter mark",
  0x200b: "zero-width space",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2028: "line separator",
  0x2029: "paragraph separator",
  0x2060: "word joiner",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
  0xfeff: "zero-width no-break space",
};

/** `U+202E`. */
export function codePoint(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** What a hidden character is called, for a title: "U+202E right-to-left override". */
export function hiddenName(ch: string): string {
  const cp = ch.codePointAt(0)!;
  return `${codePoint(ch)} ${NAMES[cp] ?? (cp >= 0xe0000 ? "tag character" : "hidden character")}`;
}

export function hasHidden(text: string): boolean {
  return HIDDEN.test(text);
}

/** `text` cut into plain runs and hidden characters, in order. */
export function splitHidden(text: string): Array<{ text: string; hidden: boolean }> {
  const out: Array<{ text: string; hidden: boolean }> = [];
  let at = 0;
  for (const m of text.matchAll(HIDDEN_ALL)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), hidden: false });
    out.push({ text: m[0], hidden: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hidden: false });
  return out;
}

/** The marker a hidden character is drawn as inside plain text: `⟨U+202E⟩`. */
export const markerOf = (ch: string) => `⟨${codePoint(ch)}⟩`;
/** A marker, as one unit a cut never splits. */
export const MARKER = /⟨U\+[0-9A-F]{4,6}⟩/;

/** A path as it is drawn: every hidden character as its marker, so a name
 *  whose right-to-left override turns `fdp.exe` around cannot pass for a `.pdf`. */
export function shownPath(path: string): string {
  return hasHidden(path) ? path.replace(HIDDEN_ALL, markerOf) : path;
}

/** The distinct hidden characters in some lines, in order of appearance. */
export function hiddenIn(lines: Iterable<string>, max = 4): string[] {
  const seen = new Set<string>();
  for (const l of lines) {
    if (!hasHidden(l)) continue;
    for (const m of l.matchAll(HIDDEN_ALL)) {
      seen.add(codePoint(m[0]));
      if (seen.size > max) return [...seen];
    }
  }
  return [...seen];
}
