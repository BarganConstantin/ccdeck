// When the page asks "How useful is ccdeck to you?" (RatingBanner.tsx), and what
// it does with the answer.
//
// The server decides whether it is time (rating.mjs, through GET /api/rating):
// seven days the deck was used, reports on, not in the minutes after a launch,
// not answered and not put off. The page adds the two things only it knows —
// that this tab is being looked at, and that no dialog is open — and so it
// looks a few minutes after it loads and then now and again, never at once. A
// question that turns up while a dialog is open waits for the next look.
//
// The answer and "Not now" go to the server (POST /api/rating), which keeps
// them and sends the answer on; the page keeps nothing. Two tabs can both be
// asking: the first answer is the one kept, and the other tab's question goes
// at its next look.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

export type RatingPhase = "hidden" | "asking" | "thanks";

/** The first look, a few minutes after the page loads. */
const FIRST_LOOK_MS = 5 * 60 * 1000;
/** And then this often while the tab is open. */
const LOOK_EVERY_MS = 30 * 60 * 1000;
/** How long the thanks stays: long enough to read, and for a low score long
 *  enough to take up the offer of the feedback dialog. */
const THANKS_MS = 8_000;
const THANKS_LOW_MS = 30_000;

function post(body: unknown) {
  return fetch("/api/rating", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
}

export function useRatingAsk({ modalOpenRef }: {
  /** Whether a dialog is up — use-dialogs.ts's gate, read at each look. */
  modalOpenRef: MutableRefObject<boolean>;
}) {
  const [phase, setPhase] = useState<RatingPhase>("hidden");
  const [score, setScore] = useState<number | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    let stopped = false;
    const look = async () => {
      if (phaseRef.current === "thanks") return;
      if (phaseRef.current === "hidden" && (document.hidden || modalOpenRef.current)) return;
      const answer = await fetch("/api/rating")
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null) as { ask?: unknown } | null;
      if (stopped || !answer) return;
      setPhase(p => (p === "thanks" ? p : answer.ask === true ? "asking" : "hidden"));
    };
    const first = window.setTimeout(look, FIRST_LOOK_MS);
    const every = window.setInterval(look, LOOK_EVERY_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [modalOpenRef]);

  // The thanks goes by itself.
  useEffect(() => {
    if (phase !== "thanks") return;
    const t = window.setTimeout(() => setPhase("hidden"), score !== null && score <= 6 ? THANKS_LOW_MS : THANKS_MS);
    return () => window.clearTimeout(t);
  }, [phase, score]);

  const answerRating = useCallback((picked: number) => {
    setScore(picked);
    setPhase("thanks");
    void post({ score: picked });
  }, []);

  const rateLater = useCallback(() => {
    setPhase("hidden");
    void post({ later: true });
  }, []);

  const closeRating = useCallback(() => setPhase("hidden"), []);

  return { ratingPhase: phase, ratingScore: score, answerRating, rateLater, closeRating };
}
