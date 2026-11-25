// A translated sentence with a few marked words: "<b>+</b>" draws <strong>,
// "<c>cswap auto</c>" draws <code>. The marks travel inside the catalog text,
// so a language moves the emphasis to wherever its grammar puts the word.
import { Fragment, type ReactNode } from "react";
import type { TFunction } from "./i18n";

const MARK = /<(b|c)>(.*?)<\/\1>/g;

/** The catalog text with its marks drawn. With `nodes`, every "{name}" in it is
 *  then replaced by that node — inside a mark too — AFTER the marks are read,
 *  so a value is never read for marks itself: see tNodes. */
export function richParts(text: string, bold: "strong" | "b" = "strong", nodes?: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  const words = (part: string): ReactNode => (nodes ? <Fragment key={i++}>{fillNodes(part, nodes)}</Fragment> : part);
  for (const m of text.matchAll(MARK)) {
    if (m.index > last) out.push(words(text.slice(last, m.index)));
    const inner = nodes ? fillNodes(m[2], nodes) : m[2];
    out.push(m[1] === "c" ? <code key={i++}>{inner}</code> : bold === "b" ? <b key={i++}>{inner}</b> : <strong key={i++}>{inner}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(words(text.slice(last)));
  return out;
}

/** `bold` picks the element a <b> mark draws: <strong> by default, <b> where the
 *  surface always used the plain one. */
export function Rich({ text, bold = "strong" }: { text: string; bold?: "strong" | "b" }) {
  return <>{richParts(text, bold)}</>;
}

/** A translated sentence with components in it: "{name}" is replaced by the
 *  node of that name, wherever the language puts it. */
export function fillNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  template.split(/(\{\w+\})/).forEach((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && m[1] in nodes) out.push(<Fragment key={i}>{nodes[m[1]]}</Fragment>);
    else if (part) out.push(<Fragment key={i}>{part}</Fragment>);
  });
  return out;
}

/**
 * t() for a sentence that carries values and nodes, and may carry marks:
 * `tNodes(t, "key", { email: address, time: <span>…</span> })`.
 *
 * THE MARKS ARE READ WITH THE PLACEHOLDERS STILL IN THE TEXT, and only then are
 * the values put in. A catalog that says "signed in to <b>{email}</b>" draws the
 * address in bold, never the "<b>" itself, and an address is always text: one
 * with "<b>", "</b>" or "&" in it is shown exactly as it is, and cannot open,
 * close or move a mark. Filling first (t(key, { email })) and reading the marks
 * after is what let a value be taken for a mark.
 */
export function tNodes(t: TFunction, key: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const keep = Object.fromEntries(Object.keys(nodes).map(k => [k, `{${k}}`]));
  return richParts(t(key, keep), "strong", nodes);
}
