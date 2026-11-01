// The Local network components read their words from the catalog, so a test
// that pins what the markup SAYS (a heading, a title, a label) reads the source
// through this: every `t("lan.key")` call becomes the English text it stands
// for, written the way the JSX used to be, and the test goes on asserting the
// meaning rather than the key. A call with values becomes a template literal
// (`{name}` -> `${met.name}`); a plural reads as its `.other` form.
import { en } from "../i18n/en";

const text = (key: string): string | undefined =>
  typeof en[key] === "string" ? en[key] : typeof en[`${key}.other`] === "string" ? en[`${key}.other`] : undefined;

export function english(src: string): string {
  return src
    .replace(/\b(?:t|tNow)\("(lan\.[\w.]+)", \{ ([^{}]*) \}\)/g, (whole, key: string, vars: string) => {
      const words = text(key);
      if (words === undefined) return whole;
      const expr = new Map<string, string>();
      for (const part of vars.split(/,\s*(?=\w+(?::|,|$))/)) {
        const m = /^(\w+)(?::\s*(.+))?$/.exec(part.trim());
        if (m) expr.set(m[1], m[2] ?? m[1]);
      }
      return `\`${words.replace(/\{(\w+)\}/g, (w, name: string) => (expr.has(name) ? `\${${expr.get(name)}}` : w))}\``;
    })
    .replace(/\b(?:t|tNow)\("(lan\.[\w.]+)"\)/g, (whole, key: string) => {
      const words = text(key);
      return words === undefined ? whole : JSON.stringify(words);
    })
    .replace(/\$\{("(?:[^"\\]|\\.)*")\}/g, (_, lit: string) => JSON.parse(lit) as string)
    .replace(/([\w-]+)=\{("(?:[^"\\]|\\.)*")\}/g, (_, attr: string, lit: string) => `${attr}=${lit}`)
    .replace(/(^|[>\s])\{"((?:[^"\\]|\\.)*)"\}/gm, (_, lead: string, words: string) => `${lead}${JSON.parse(`"${words}"`)}`)
    .replace(/(^|[>\s])\{(`(?:[^`\\]|\\.)*`)\}/gm, (_, lead: string, lit: string) => `${lead}${lit.slice(1, -1)}`);
}
