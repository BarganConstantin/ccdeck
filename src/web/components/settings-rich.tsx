// A translated sentence with a few live parts in it (a path in <code>, a bold
// clause, a link): the catalog holds "In {path}, with every address …" and the
// component hands the node for each placeholder, so a language can put it
// where its grammar wants it.
import { Fragment, type ReactNode } from "react";

export function richText(template: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const parts = template.split(/\{(\w+)\}/g);
  return parts.map((part, at) => (at % 2 === 1 && part in nodes
    ? <Fragment key={at}>{nodes[part]}</Fragment>
    : part === "" ? null : <Fragment key={at}>{at % 2 === 1 ? `{${part}}` : part}</Fragment>));
}
