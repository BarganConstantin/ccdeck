// Numbers and durations in the language on show: the parts of a line that are
// not words, which a catalog cannot hold because they are computed.
import type { TFunction } from "./index";
import { currentLanguage } from "./index";

/** A decimal in the language's own separator: 2.9 reads "2,9" in German. */
export function formatNumber(value: number, maximumFractionDigits = 1, lang = currentLanguage()): string {
  try { return new Intl.NumberFormat(lang, { maximumFractionDigits }).format(value); } catch { return String(value); }
}

/** A span of seconds as the two largest units that are not zero, "2d 4h",
 *  "1h 5m", "12m" in English; the unit words come from the "time.*" keys so
 *  each language writes them its own way. Under a minute reads as 0 minutes,
 *  as the English one always has. */
export function durationLabel(t: TFunction, seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return t("common.time.dh", { d, h });
  return h > 0 ? t("common.time.hm", { h, m }) : t("common.time.m", { m });
}
