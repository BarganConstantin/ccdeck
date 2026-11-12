// Numbers and durations in the language on show: the parts of a line that are
// not words, which a catalog cannot hold because they are computed.
import type { TFunction } from "./index";
import { currentLanguage } from "./index";

/** A whole percent as the language writes it: 110 reads "110 %" in German. */
export function formatPercent(percent: number, lang = currentLanguage()): string {
  try { return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(percent / 100); } catch { return `${percent}%`; }
}

/** A decimal in the language's own separator: 2.9 reads "2,9" in German. */
export function formatNumber(value: number, maximumFractionDigits = 1, lang = currentLanguage()): string {
  try { return new Intl.NumberFormat(lang, { maximumFractionDigits }).format(value); } catch { return String(value); }
}

/** A time of day on the language's own clock, "14:32" or "2:32 PM", and with
 *  its seconds when the minute alone does not tell two times apart. */
export function clockTime(ms: number, seconds = false, lang = currentLanguage()): string {
  const opts: Intl.DateTimeFormatOptions = seconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  try { return new Date(ms).toLocaleTimeString(lang, opts); } catch { return new Date(ms).toLocaleTimeString(undefined, opts); }
}

/** A span of seconds as the two largest units that are not zero, "2d 4h",
 *  "1h 05m", "12m" in English; the unit words come from the "time.*" keys so
 *  each language writes them its own way. The minutes take two digits once an
 *  hour leads them, as V4 draws every countdown ("Resets in 2h 09m"). Under a
 *  minute reads as 0 minutes, as the English one always has. */
export function durationLabel(t: TFunction, seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return t("common.time.dh", { d, h });
  return h > 0 ? t("common.time.hm", { h, m: String(m).padStart(2, "0") }) : t("common.time.m", { m });
}
