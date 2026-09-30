// The page's side of opt-in anonymous reports (#1853): the person's answer,
// read with the rest of /api/prefs and changed through /api/reports; whether the
// one-time question should be up; and the page's own errors, handed to the
// server while the answer is yes.
import { useCallback, useEffect, useRef, useState } from "react";
import { forwardPageErrors } from "./report-errors";

/** null: never asked. undefined: not read yet, so nothing is asked either. */
export type ReportsAnswer = boolean | null | undefined;

export function useReports({ welcomeSettled, tourOpen, releaseNotesOpen }: {
  /** The tour and the release notes have had their turn: the question comes after them, never over them. */
  welcomeSettled: boolean;
  tourOpen: boolean;
  releaseNotesOpen: boolean;
}) {
  const [reportsAnswer, setReportsAnswer] = useState<ReportsAnswer>(undefined);
  const [reportsVetoed, setReportsVetoed] = useState(false);
  const sending = useRef(false);
  sending.current = reportsAnswer === true && !reportsVetoed;

  useEffect(() => forwardPageErrors(() => sending.current), []);

  /** Handed the one GET /api/prefs the page makes (use-prefs-read.ts). */
  const loadReportsPrefs = useCallback((d: { prefs?: { reports?: unknown }; reportsVetoed?: unknown }) => {
    const answer = d.prefs?.reports;
    setReportsAnswer(typeof answer === "boolean" ? answer : null);
    setReportsVetoed(d.reportsVetoed === true);
  }, []);

  /** The answer, shown at once and corrected from what the server says it kept. */
  const answerReports = useCallback(async (on: boolean) => {
    setReportsAnswer(on);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      const d = await response.json();
      if (d?.ok) {
        setReportsAnswer(typeof d.reports === "boolean" ? d.reports : null);
        setReportsVetoed(d.reportsVetoed === true);
      }
    } catch {
      // The switch keeps what was pressed; the next read of /api/prefs corrects it.
    }
  }, []);

  const reportsQuestionOpen = reportsAnswer === null && !reportsVetoed && welcomeSettled && !tourOpen && !releaseNotesOpen;

  return { reportsAnswer, reportsVetoed, loadReportsPrefs, answerReports, reportsQuestionOpen };
}
