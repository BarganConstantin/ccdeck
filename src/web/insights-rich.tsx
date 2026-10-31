import { Fragment } from "react/jsx-runtime";
import type { ReactNode } from "react";

/** A translated sentence with parts that are not text (bold numbers, <code>):
 *  `rich(t(key), { calls: <strong>3</strong> })` puts each node where
 *  the language wants its {calls} placeholder. A {name} with no node is kept
 *  as written; fill text values through t()'s own vars first. */
export function rich(template: string, parts: Record<string, ReactNode>): ReactNode {
  const pieces = template.split(/(\{\w+\})/g);
  return pieces.map((piece, at) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={at}>{name && name in parts ? parts[name] : piece}</Fragment>;
  });
}
