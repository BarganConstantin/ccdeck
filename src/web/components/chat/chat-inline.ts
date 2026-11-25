// What Chat reads inside a line of the assistant's Markdown: code spans, bold,
// italics, strikethrough and links. inline-markdown.ts stays the release
// notes' own two marks; a transcript says more, so Chat has its own reader.
//
// A TOKEN TREE, NEVER HTML. ChatMarkdown builds React elements from these, so
// transcript text only ever reaches the page as text. A link keeps its address
// only when it is http, https or mailto (safeHref): anything else, a
// `javascript:` one included, stays the text it was written as, unlinked.
//
// BOUNDED. A delimiter with no partner stays text, and the search for a
// partner that failed once is not run again for a later one of the same kind,
// so a line of a thousand lone asterisks costs one pass, not a million.

export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; kids: ChatInline[] }
  | { kind: "italic"; kids: ChatInline[] }
  | { kind: "strike"; kids: ChatInline[] }
  | { kind: "link"; href: string; kids: ChatInline[] };

/** The address a link may take: http, https or mailto, absolute; null for any other. */
export function safeHref(raw: string): string | null {
  const text = raw.trim();
  if (!/^(?:https?:\/\/|mailto:)/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
/** How deep marks nest: past it, what is inside is read as text. */
const MAX_DEPTH = 6;
// A bare address: up to the first space or angle bracket.
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;
const ESCAPABLE = "\\`*_~[]()<>#|!-.+";

/** Where the code span opened at `at` (a run of `n` backticks) closes, or -1. */
function codeClose(src: string, at: number, n: number): number {
  let i = at + n;
  while (i < src.length) {
    const next = src.indexOf("`", i);
    if (next < 0) return -1;
    let run = 0;
    while (src[next + run] === "`") run++;
    if (run === n) return next;
    i = next + run;
  }
  return -1;
}

/** The run of backticks at `at`. */
function ticks(src: string, at: number): number {
  let n = 0;
  while (src[at + n] === "`") n++;
  return n;
}

/** An address's end, with the punctuation that closes the sentence round it left out. */
function bareEnd(src: string, at: number): number {
  const found = BARE_URL.exec(src.slice(at, at + 2048));
  if (!found) return at;
  let end = at + found[0].length;
  for (;;) {
    const last = src[end - 1];
    if (".,;:!?*_~".includes(last)) { end--; continue; }
    // A ")" closes the address only when the address opened one.
    if (last === ")") {
      const body = src.slice(at, end);
      if ((body.match(/\)/g)?.length ?? 0) > (body.match(/\(/g)?.length ?? 0)) { end--; continue; }
    }
    return end;
  }
}

/** The longest link words and address read: past them a "[" is just a bracket. */
const MAX_LABEL = 1000;
const MAX_ADDRESS = 2048;

/** `[words](address)` at `at`: where the words and the address are, and where it ends. */
function linkAt(src: string, at: number, end: number): { label: [number, number]; href: string; next: number } | null {
  let depth = 0;
  let i = at + 1;
  const labelEnd = Math.min(end, at + MAX_LABEL);
  for (; i < labelEnd; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      const n = ticks(src, i);
      const close = codeClose(src, i, n);
      if (close >= 0 && close < end) { i = close + n - 1; continue; }
    }
    if (c === "[") depth++;
    else if (c === "]") { if (depth === 0) break; depth--; }
    else if (c === "\n" && src[i + 1] === "\n") return null;
  }
  if (i >= labelEnd || src[i + 1] !== "(") return null;
  const open = i + 1;
  let close = open + 1;
  let parens = 0;
  const addressEnd = Math.min(end, open + MAX_ADDRESS);
  for (; close < addressEnd; close++) {
    const c = src[close];
    if (c === "(") parens++;
    else if (c === ")") { if (parens === 0) break; parens--; }
    else if (c === "\n") return null;
  }
  if (close >= addressEnd) return null;
  // `(address "title")`: the title is dropped; `<address>` loses its brackets.
  let target = src.slice(open + 1, close).trim().replace(/\s+"[^"]*"$/, "");
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  return { label: [at + 1, i], href: target, next: close + 1 };
}

type Mark = "bold" | "italic" | "strike";

/** The mark a delimiter opens at `at`, and its length, or null. */
function opener(src: string, at: number, end: number): { mark: Mark; delim: string } | null {
  const c = src[at];
  const before = src[at - 1] ?? " ";
  let delim = "";
  let mark: Mark;
  if (c === "~" && src[at + 1] === "~") { delim = "~~"; mark = "strike"; }
  // A run of three opens italics around bold: ***both*** reads <em><strong>.
  else if ((c === "*" || c === "_") && src[at + 1] === c && src[at + 2] !== c) { delim = c + c; mark = "bold"; }
  else if (c === "*" || c === "_") { delim = c; mark = "italic"; }
  else return null;
  const after = src[at + delim.length];
  // The delimiter hugs its text: never "* x *" or "2 * 3".
  if (at + delim.length >= end || after === undefined || SPACE.test(after)) return null;
  // An underscore inside a word is part of it: snake_case_name stays as it is.
  if (c === "_" && WORD.test(before)) return null;
  return { mark, delim };
}

/** Where `delim` closes the span opened before `from`, or -1. Code spans are skipped. */
function closer(src: string, from: number, end: number, delim: string): number {
  let i = from;
  while (i < end) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      const n = ticks(src, i);
      const close = codeClose(src, i, n);
      if (close >= 0 && close < end) { i = close + n; continue; }
      i += n;
      continue;
    }
    if (src.startsWith(delim, i) && i + delim.length <= end && !SPACE.test(src[i - 1] ?? " ")) {
      const after = src[i + delim.length];
      // "**" is not the close of "*", and a closing underscore ends a word.
      const doubled = delim.length === 1 && after === delim;
      const intraword = delim[0] === "_" && after !== undefined && WORD.test(after);
      if (!doubled && !intraword) return i;
      if (doubled) { i += 2; continue; }
    }
    i++;
  }
  return -1;
}

function parse(src: string, start: number, end: number, depth: number, inLink: boolean): ChatInline[] {
  const out: ChatInline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = ""; } };
  // The first position past which a delimiter has no partner, by delimiter.
  const hopeless = new Map<string, number>();
  let gt = -2;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === "\\" && i + 1 < end && ESCAPABLE.includes(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const n = ticks(src, i);
      const close = codeClose(src, i, n);
      if (close >= 0 && close < end && close > i + n) {
        flush();
        const inner = src.slice(i + n, close);
        // One space on each side of a span that needs it to hold a backtick is padding.
        out.push({ kind: "code", text: /^ .* $/s.test(inner) && inner.trim() ? inner.slice(1, -1) : inner });
        i = close + n;
        continue;
      }
      text += src.slice(i, i + n);
      i += n;
      continue;
    }
    if (!inLink && depth < MAX_DEPTH && c === "[") {
      const link = linkAt(src, i, end);
      const href = link ? safeHref(link.href) : null;
      // A link to anything but the web or mail stays as it was written.
      if (link && href) {
        flush();
        out.push({ kind: "link", href, kids: parse(src, link.label[0], link.label[1], depth + 1, true) });
        i = link.next;
        continue;
      }
    }
    if (!inLink && (c === "h" || c === "H") && !WORD.test(src[i - 1] ?? " ")) {
      const stop = Math.min(bareEnd(src, i), end);
      const href = stop > i ? safeHref(src.slice(i, stop)) : null;
      if (href) {
        flush();
        out.push({ kind: "link", href, kids: [{ kind: "text", text: src.slice(i, stop) }] });
        i = stop;
        continue;
      }
    }
    if (!inLink && c === "<") {
      // The next ">" is looked for once and kept, so a run of "<" stays one pass.
      if (gt !== -1 && gt <= i) gt = src.indexOf(">", i + 1);
      const close = gt;
      const href = close > i && close < end && close - i <= MAX_ADDRESS ? safeHref(src.slice(i + 1, close)) : null;
      if (href && !/\s/.test(src.slice(i + 1, close))) {
        flush();
        out.push({ kind: "link", href, kids: [{ kind: "text", text: src.slice(i + 1, close) }] });
        i = close + 1;
        continue;
      }
    }
    const open = depth < MAX_DEPTH ? opener(src, i, end) : null;
    if (open && (hopeless.get(open.delim) ?? Infinity) > i) {
      const from = i + open.delim.length;
      const close = closer(src, from, end, open.delim);
      if (close > from) {
        flush();
        out.push({ kind: open.mark, kids: parse(src, from, close, depth + 1, inLink) });
        i = close + open.delim.length;
        continue;
      }
      hopeless.set(open.delim, i);
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** One stretch of the assistant's Markdown as inline tokens. */
export function parseChatInline(src: string): ChatInline[] {
  return parse(src, 0, src.length, 0, false);
}

/** What the tokens say with every mark removed: the text a reader ends up with. */
export function chatPlain(nodes: readonly ChatInline[]): string {
  return nodes.map(n => (n.kind === "text" || n.kind === "code" ? n.text : chatPlain(n.kids))).join("");
}
