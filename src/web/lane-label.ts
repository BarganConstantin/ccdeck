// A quota lane's name as the deck's server sends it ("5h", "7d", "Sonnet (7d)"),
// in the language on show. The window shorthands stay; a model-scoped lane
// says its window in words ("Sonnet (7 Tage)").
import type { TFunction } from "./i18n";

/** A window's whole name, the title over its lane's short one ("5h" says
 *  "5-hour" on hover): the account's own two windows by their names — the week's as
 *  "Weekly", the word for it beside a model lane such as "Fable" that runs a
 *  week too (user feedback) — any other lane as laneLabel says it. Claude's
 *  and Codex's lanes share the two ids. */
export function windowName(lane: { id?: string; label: string }, t: TFunction): string {
  if (lane.id === "seven_day") return t("accounts.lane.weekly");
  return lane.id === "five_hour" ? t("accounts.win.five_hour") : laneLabel(lane.label, t);
}

export function laneLabel(label: string, t: TFunction): string {
  const scoped = /^(.+?) \((\d+)d\)$/.exec(label);
  return scoped ? t("accounts.lane.scoped", { name: scoped[1], n: scoped[2] }) : label;
}
