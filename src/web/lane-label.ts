// A quota lane's name as the deck's server sends it ("5h", "7d", "Sonnet (7d)"),
// in the language on show. The window shorthands stay; a model-scoped lane
// says its window in words ("Sonnet (7 Tage)").
import type { TFunction } from "./i18n";

export function laneLabel(label: string, t: TFunction): string {
  const scoped = /^(.+?) \((\d+)d\)$/.exec(label);
  return scoped ? t("accounts.lane.scoped", { name: scoped[1], n: scoped[2] }) : label;
}
