// Tells the deck's server which language the page is showing, so the usage
// reports can say it (server/ui-language.mjs). The choice lives in this
// browser, and the server has no page open when it sends a report.
//
// Once on load and again whenever the language changes. Best effort and silent:
// it never blocks, never throws and shows nothing; a refused or failed post is
// forgotten, and the next load says it again.
import { currentLanguage, subscribeLanguage } from "./i18n";

function tell(): void {
  try {
    void fetch("/api/ui-language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: currentLanguage() }),
    }).catch(() => null);
  } catch {
    // No fetch, or a page being torn down: nothing to tell.
  }
}

/** Report now and on every language change. Returns the stop function. */
export function startLanguageReport(): () => void {
  tell();
  try {
    return subscribeLanguage(tell);
  } catch {
    return () => {};
  }
}
