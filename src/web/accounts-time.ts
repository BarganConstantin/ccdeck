// The small time and list phrases the accounts surfaces share, in the language
// on show: "3m ago", " · next in 2m", "A, B and C". shortAgoSec (relative-time.ts)
// stays English for the other areas; these read the accounts.* catalog.
import { currentLanguage, t as tNow, type TFunction } from "./i18n";

/** "just now" / "12m ago" / "3h ago" / "5d ago", from a time in milliseconds. */
export function agoLabel(ms: number, nowSec: number, t: TFunction = tNow): string {
  const s = Math.max(0, nowSec - Math.floor(ms / 1000));
  if (s < 60) return t("accounts.ago.now");
  if (s < 3600) return t("accounts.ago.minutes", { n: Math.floor(s / 60) });
  if (s < 86400) return t("accounts.ago.hours", { n: Math.floor(s / 3600) });
  return t("accounts.ago.days", { n: Math.floor(s / 86400) });
}

/** When the next read is planned, as the tail of a line: " · due", " · next in 45s". */
export function dueLabel(nextAt: number | null, nowSec: number, t: TFunction = tNow): string {
  if (!nextAt) return "";
  const s = Math.floor(nextAt / 1000) - nowSec;
  if (s <= 0) return t("accounts.due.now");
  if (s < 60) return t("accounts.due.seconds", { n: s });
  return t("accounts.due.minutes", { n: Math.round(s / 60) });
}

/** "A", "A and B", "A, B and C" — in the language's own way of joining. */
export function listNames(names: readonly string[]): string {
  try { return new Intl.ListFormat(currentLanguage(), { style: "long", type: "conjunction" }).format(names); } catch { return names.join(", "); }
}
