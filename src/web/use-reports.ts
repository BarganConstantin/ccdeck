// The page's side of anonymous reports (#1853): whether they are on, read with
// the rest of /api/prefs and changed through /api/reports by the switch in
// Appearance; whether the machine ruled them out at launch; and the page's own
// errors, handed to the server while they are on.
//
// On by default, so the only thing a page can learn from the server is that
// somebody switched them off. Until that read lands the page does not know, and
// not knowing is not "on": no error is forwarded before it, since the one deck
// that must never send one is the deck whose owner said so.
import { useCallback, useEffect, useRef, useState } from "react";
import { forwardPageErrors } from "./report-errors";

export function useReports() {
  /** undefined until /api/prefs was read; after that, on unless switched off. */
  const [reportsOn, setReportsOn] = useState<boolean | undefined>(undefined);
  const [reportsVetoed, setReportsVetoed] = useState(false);
  const sending = useRef(false);
  sending.current = reportsOn === true && !reportsVetoed;

  useEffect(() => forwardPageErrors(() => sending.current), []);

  /** Handed the one GET /api/prefs the page makes (use-prefs-read.ts). */
  const loadReportsPrefs = useCallback((d: { prefs?: { reports?: unknown }; reportsVetoed?: unknown }) => {
    setReportsOn(d.prefs?.reports !== false);
    setReportsVetoed(d.reportsVetoed === true);
  }, []);

  /** The switch, shown at once and corrected from what the server says it kept. */
  const answerReports = useCallback(async (on: boolean) => {
    setReportsOn(on);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      const d = await response.json();
      if (d?.ok) {
        setReportsOn(d.reports !== false);
        setReportsVetoed(d.reportsVetoed === true);
      }
    } catch {
      // The switch keeps what was pressed; the next read of /api/prefs corrects it.
    }
  }, []);

  return { reportsOn, reportsVetoed, loadReportsPrefs, answerReports };
}
