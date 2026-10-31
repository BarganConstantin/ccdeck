// A translated sentence with one piece of markup inside it: the catalog holds
// "Run {cmd}, then open a new terminal." and the component puts its <code> where
// the token stands, so a language can move the token where its grammar wants it.
import { Fragment, type ReactNode } from "react";

export function slot(template: string, token: string, node: ReactNode): ReactNode {
  const mark = `{${token}}`;
  const at = template.indexOf(mark);
  if (at < 0) return template;
  return <Fragment>{template.slice(0, at)}{node}{template.slice(at + mark.length)}</Fragment>;
}
