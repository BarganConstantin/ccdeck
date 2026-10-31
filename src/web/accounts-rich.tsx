// A translated sentence with a few marked words: "<b>+</b>" draws <strong>,
// "<c>cswap auto</c>" draws <code>. The marks travel inside the catalog text,
// so a language moves the emphasis to wherever its grammar puts the word.
import { Fragment, type ReactNode } from "react";
import type { TFunction } from "./i18n";

const MARK = /<(b|c)>(.*?)<\/\1>/g;

export function richParts(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(MARK)) {
    if (m.index > last) out.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    out.push(m[1] === "b" ? <strong key={i++}>{m[2]}</strong> : <code key={i++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return out;
}

export function Rich({ text }: { text: string }) {
  return <>{richParts(text)}</>;
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

/** t() for a sentence that carries nodes: `nodes(t, "key", { name: <b>…</b> })`. */
export function tNodes(t: TFunction, key: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const keep = Object.fromEntries(Object.keys(nodes).map(k => [k, `{${k}}`]));
  return fillNodes(t(key, keep), nodes);
}
