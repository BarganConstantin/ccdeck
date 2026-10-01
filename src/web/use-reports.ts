// The page's side of usage reports (#1853): whether they are on, read with
// the rest of /api/prefs; whether the machine ruled them out at launch; and the
// page's own errors, handed to the server while they are on.
//
// On by default, and the page has no switch for them (Appearance's went on
// 2026-10-01), so the only thing it can learn from the server is that they are
// off: a launch-time veto, or a `false` saved by a deck that still had the
// switch. Until that read lands the page does not know, and not knowing is not
// "on": no error is forwarded before it, since the one deck that must never
// send one is the deck whose owner said so.
import { useCallback, useEffect, useRef, useState } from "react";
import { forwardPageErrors } from "./report-errors";

export function useReports() {
  /** undefined until /api/prefs was read; after that, on unless it holds `false`. */
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

  return { loadReportsPrefs };
}
