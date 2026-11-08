// A quota lane's name as the deck's server sends it ("5h", "7d", "Sonnet (7d)"),
// in the language on show. The window shorthands stay; a model-scoped lane
// says its window in words ("Sonnet (7 Tage)").
import type { TFunction } from "./i18n";

/** A window's whole name, for the open row's lines ("5-hour · 0% · not
 *  started"): the account's own two windows by their names, any other lane as
 *  laneLabel says it. Claude's and Codex's lanes share the two ids. */
export function windowName(lane: { id?: string; label: string }, t: TFunction): string {
  return lane.id === "five_hour" || lane.id === "seven_day" ? t(`accounts.win.${lane.id}`) : laneLabel(lane.label, t);
}

export function laneLabel(label: string, t: TFunction): string {
  const scoped = /^(.+?) \((\d+)d\)$/.exec(label);
  return scoped ? t("accounts.lane.scoped", { name: scoped[1], n: scoped[2] }) : label;
}
