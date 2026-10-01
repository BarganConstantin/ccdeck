// What a report sent from this deck carries besides its words — the ccdeck
// version and the system — asked of the deck's own server once, when the
// feedback dialog opens. The server answers from the same function that
// attaches the two to the post (feedbackFacts in reports-routes.mjs), so the
// line drawn before Send is what is sent rather than the page's guess at it:
// the browser cannot tell an arm64 Mac from an Intel one, and does not need to.
//
// Null until it answers, and for good when it cannot — a deck from before the
// route — and the line then says the same thing without the numbers.
import { useEffect, useState } from "react";
import { parseFacts, type FeedbackFacts } from "./feedback";

export function useFeedbackFacts(): FeedbackFacts | null {
  const [facts, setFacts] = useState<FeedbackFacts | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/feedback")
      .then(r => (r.ok ? r.json() : null))
      .then(answer => { if (alive) setFacts(parseFacts(answer)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return facts;
}
