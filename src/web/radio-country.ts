// A country as the reader's language writes it. The station catalogue names
// countries in English; the two-letter code lets the browser say it in the
// language on show (Intl.DisplayNames), and a code it does not know keeps the
// catalogue's own name.
import { currentLanguage } from "./i18n";

const cache = new Map<string, Intl.DisplayNames | null>();

export function countryName(code: string | undefined, fallback: string, lang: string = currentLanguage()): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return fallback;
  let names = cache.get(lang);
  if (names === undefined) {
    try { names = new Intl.DisplayNames([lang], { type: "region" }); } catch { names = null; }
    cache.set(lang, names);
  }
  try { return names?.of(code.toUpperCase()) || fallback; } catch { return fallback; }
}

export const stationCountry = (radio: { country: string; countryCode: string }, lang?: string): string =>
  countryName(radio.countryCode, radio.country, lang);
