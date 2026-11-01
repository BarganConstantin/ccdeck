// t(): the one lookup. A key in the chosen language, else the same key in
// English, else the key itself (so a typo is visible rather than blank).
//
// {name} placeholders are replaced from `vars`; one that has no value is left
// as written. PLURALS: when `vars.count` is a number, "<key>.<category>" is
// tried first, the category from Intl.PluralRules for that language
// (zero/one/two/few/many/other), then "<key>.other", then the plain key.
import type { Catalog, MessageKey } from "./en";
import { en } from "./en";

export type Vars = Readonly<Record<string, string | number>>;

export function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

function pluralCategory(lang: string, count: number): string {
  try { return new Intl.PluralRules(lang).select(count); } catch { return "other"; }
}

export function translate(lang: string, catalog: Catalog | undefined, key: MessageKey, vars?: Vars): string {
  const keys: string[] = [];
  if (typeof vars?.count === "number") keys.push(`${key}.${pluralCategory(lang, vars.count)}`, `${key}.other`);
  keys.push(key);
  for (const source of [catalog, en as Catalog]) {
    if (!source) continue;
    for (const k of keys) {
      const hit = source[k];
      if (typeof hit === "string") return fill(hit, vars);
    }
  }
  return fill(key, vars);
}
