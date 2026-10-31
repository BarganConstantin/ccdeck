// The languages the deck ships, and the ones that are planned.
//
// ADDING A LANGUAGE = a <code>.ts file in each areas/<area>/ folder + one entry
// in LANGUAGES below (docs/translating.md). The catalog is found by code, so
// nothing else changes: the Settings select, the detection and the completeness
// test all read this list.
//
// `name` is the language's own name, never translated: a reader who cannot
// read the current language must still find theirs. `beta` marks a catalog
// that has not been reviewed by a native speaker yet; the select shows it as
// "(beta)". `dir` is the text direction written to <html dir>; every shipped
// language is "ltr" and "rtl" is reserved for ar/fa/he. No RTL layout exists
// yet, so an rtl entry would only flip the attribute.
import { catalogFor, type Catalog } from "./catalogs";

export type Direction = "ltr" | "rtl";

export interface Language {
  /** BCP 47 tag, as written to <html lang>. */
  code: string;
  /** The language's own name. */
  name: string;
  dir: Direction;
  beta?: boolean;
  catalog: Catalog;
}

/** English first: it is the source of truth and the fallback. */
export const LANGUAGES: readonly Language[] = [
  { code: "en", name: "English", dir: "ltr", catalog: catalogFor("en") },
  { code: "zh-TW", name: "繁體中文", dir: "ltr", catalog: catalogFor("zh-TW") },
  { code: "zh-CN", name: "简体中文", dir: "ltr", catalog: catalogFor("zh-CN") },
  { code: "de", name: "Deutsch", dir: "ltr", catalog: catalogFor("de") },
  { code: "ja", name: "日本語", dir: "ltr", catalog: catalogFor("ja") },
  { code: "ko", name: "한국어", dir: "ltr", beta: true, catalog: catalogFor("ko") },
  { code: "fr", name: "Français", dir: "ltr", beta: true, catalog: catalogFor("fr") },
  { code: "es", name: "Español", dir: "ltr", beta: true, catalog: catalogFor("es") },
  { code: "pt-BR", name: "Português (Brasil)", dir: "ltr", beta: true, catalog: catalogFor("pt-BR") },
  { code: "ro", name: "Română", dir: "ltr", beta: true, catalog: catalogFor("ro") },
];

export const DEFAULT_LANGUAGE = "en";

/** Languages asked for and not shipped yet. To ship one: write its catalog,
 *  move its line into LANGUAGES with the catalog attached. Kept here so the
 *  native names are agreed once, and so the detection test can prove each of
 *  them would be found. */
export const PLANNED_LANGUAGES: ReadonlyArray<Omit<Language, "catalog">> = [
  { code: "it", name: "Italiano", dir: "ltr" },
  { code: "pl", name: "Polski", dir: "ltr" },
  { code: "vi", name: "Tiếng Việt", dir: "ltr" },
  { code: "id", name: "Bahasa Indonesia", dir: "ltr" },
  { code: "th", name: "ไทย", dir: "ltr" },
  { code: "cs", name: "Čeština", dir: "ltr" },
  { code: "ru", name: "Русский", dir: "ltr" },
  { code: "tr", name: "Türkçe", dir: "ltr" },
];

/** The select's text for a language: its own name, plus "(beta)" while its
 *  catalog is a draft. */
export function languageLabel(language: Pick<Language, "name" | "beta">): string {
  return language.beta ? `${language.name} (beta)` : language.name;
}
