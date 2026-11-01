// The words of Settings › Claude Code in the language on show. The table the
// rows are drawn from (src/server/claude-settings-catalog.mjs) keeps the
// English, which the server and the tests read; the page asks for each id's
// text here, and a text with no entry in a language falls back to English
// through t(), then to the table's own words.
import { t as tNow, type TFunction } from "./i18n";
import type { ClaudeSettingEntry } from "../server/claude-settings-catalog.mjs";
import { daysLabel } from "../server/claude-settings-catalog.mjs";

function said(t: TFunction, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

export const claudeGroupTitle = (id: string, fallback: string, t: TFunction = tNow) => said(t, `settings.claudeGroup.${id}`, fallback);
export const claudeRowLabel = (entry: Pick<ClaudeSettingEntry, "id" | "label">, t: TFunction = tNow) => said(t, `settings.claudeRow.${entry.id}.label`, entry.label);
export const claudeRowNote = (entry: Pick<ClaudeSettingEntry, "id" | "note">, t: TFunction = tNow) => said(t, `settings.claudeRow.${entry.id}.note`, entry.note);
export const claudeOptionLabel = (id: string, value: string | null, fallback: string, t: TFunction = tNow) =>
  said(t, `settings.claudeOpt.${id}.${value ?? "default"}`, fallback);

export function claudeDaysLabel(days: number, t: TFunction = tNow): string {
  if (days === 3650) return t("settings.claude.days.decade");
  if (days === 365) return t("settings.claude.days.year");
  return t("settings.claude.days", { count: days, n: days });
}

export { daysLabel };
