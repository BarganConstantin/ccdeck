// The language the user chose in ccdeck's own page ("ro", "pt-BR"), as the
// server keeps it for the usage reports (reports.mjs `uiLanguage`).
//
// The choice lives in the browser (localStorage, src/web/i18n), so the page
// tells the server (POST /api/ui-language) and the server keeps the answer in
// prefs.json under `report.uiLanguage`, where the reporter finds it with no
// page open. The server cannot import the web registry, so the check is the
// token's shape, and this file is the one place that shape is written.

/** A language tag as a token: "ro", "pt-BR", "zh-Hans". */
const SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
export const UI_LANGUAGE_MAX = 16;

/** The code if it is a language tag, else "" (which means: not known). */
export function uiLanguageCode(value) {
  return typeof value === "string" && value.length <= UI_LANGUAGE_MAX && SHAPE.test(value) ? value : "";
}
