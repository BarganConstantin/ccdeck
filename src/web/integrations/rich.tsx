// A catalog sentence with elements inside it (a link, a <code>, a <strong>):
// the sentence is written once in the catalog with {name} where the element
// goes, and the elements are handed in by name, so a language can put them
// wherever its grammar wants them. A name with no element is left as written.
import { Fragment, type ReactNode } from "react";

export function rich(template: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  const pieces = template.split(/\{(\w+)\}/);
  return pieces.map((piece, i) => (i % 2 === 0 ? piece : <Fragment key={i}>{piece in parts ? parts[piece] : `{${piece}}`}</Fragment>));
}
