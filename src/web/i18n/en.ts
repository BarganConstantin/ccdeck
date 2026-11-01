// English: the source of truth. Every other catalog is measured against it
// (i18n.test.ts), and any key a language lacks falls back to it.
//
// The strings live in areas/<area>/en.ts, one folder per UI area; see
// catalogs.ts and docs/translating.md. This file is the merged result.
//
// Keys are stable ids, never the English sentence, so a copy edit does not
// orphan the translations, and they start with their area ("usage.title").
// {name} marks a value filled in at run time and must appear, spelled the same,
// in every translation of that key. A key may have plural forms,
// "<key>.one" / "<key>.other" (and few/many/... where a language needs them),
// picked by the `count` value; see translate.ts.
//
// Not translated, on purpose: product names (ccdeck, Claude Code, Codex,
// Claude, Sonnet, Opus), model names, command and file names, numbers and the
// formats of times and units.
import { catalogFor, type Catalog } from "./catalogs";

export type { Catalog } from "./catalogs";

/** A key of the English catalog. Typed as a string: the catalog is found by
 *  folder at build time, so a misspelt key is caught by the t()-key test
 *  rather than by the compiler. */
export type MessageKey = string;

/** A translation: some or all of English's keys, and no others. */
export type Translation = Catalog;

export const en: Catalog = catalogFor("en");
