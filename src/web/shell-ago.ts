// Ages as the shell words them ("just now", "12m ago"), in the language on
// show. relative-time.ts has the English-only twin the other panels read; the
// update lines and the version chip say theirs through the catalog.
import { t } from "./i18n";

/** "just now" / "12m ago" / "3h ago" / "5d ago", from an age in milliseconds. */
export function agoWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("shell.ago.now");
  if (s < 3600) return t("shell.ago.m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("shell.ago.h", { n: Math.floor(s / 3600) });
  return t("shell.ago.d", { n: Math.floor(s / 86400) });
}

/** `12 sec ago`, `4 min ago`, `2 hr ago`: the update lines' wording, in full
 *  words rather than `12s` because it sits beside version numbers. */
export function agoSpelled(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 5) return t("shell.ago.now");
  if (secs < 60) return t("shell.ago.sec", { n: secs });
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("shell.ago.min", { n: mins });
  return t("shell.ago.hrSpelled", { n: Math.round(mins / 60) });
}
