// Sending a piece of feedback, and what the dialog does once it has gone.
//
// Not gated on the reports switch: pressing Send is its own decision, for this
// one message. Nothing typed is lost to a failure — the form stays as it was,
// and the failure says what happened and whether trying again helps.
//
// THE PRESS RULE (#518). Send is never disabled: while the request is out it
// says aria-busy and this refuses a second press itself, off a ref, since the
// state a handler closed over is a render old.
//
// SENT, IT THANKS AND GOES. The dialog shows the thanks for SENT_HOLD_MS, then
// fades out over SENT_EXIT_MS and closes itself, the way a toast leaves: the
// person pressed Send to be done, and a Close button to press afterwards was
// one more thing to do. Escape, the × and the scrim still close it at once.
import { useEffect, useRef, useState } from "react";
import { selfPressAccepted } from "./panel-press";
import { feedbackRequest } from "./feedback-images";
import {
  SENT_EXIT_MS, SENT_HOLD_MS, feedbackFailure, fieldsToSend, type FeedbackDraft, type Outcome,
} from "./feedback";
import type { FeedbackImages } from "./use-feedback-images";

export interface FeedbackSend {
  outcome: Outcome;
  sending: boolean;
  send(draft: FeedbackDraft): Promise<void>;
}

export function useFeedbackSend(images: FeedbackImages): FeedbackSend {
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  const sendingRef = useRef(false);

  async function send(draft: FeedbackDraft) {
    if (!selfPressAccepted(sendingRef.current)) return;
    sendingRef.current = true;
    setOutcome({ state: "sending" });
    try {
      const attached = await images.ready();
      const response = await fetch("/api/feedback", feedbackRequest(fieldsToSend(draft), attached));
      const d = await response.json().catch(() => null);
      setOutcome(response.ok && d?.ok
        ? { state: "sent" }
        : { state: "failed", message: feedbackFailure(response.status, d?.reason, d?.errors) });
    } catch {
      setOutcome({ state: "failed", message: feedbackFailure(0, null) });
    } finally {
      sendingRef.current = false;
    }
  }

  return { outcome, sending: outcome.state === "sending", send };
}

/** Once `sent`, true after the hold — the cue for the fade out — and then
 *  `onClose`. Both timers go with the dialog, so a dialog closed by hand in
 *  the meantime is never closed twice. */
export function useCloseWhenSent(sent: boolean, onClose: () => void): boolean {
  const [leaving, setLeaving] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!sent) return;
    const fade = window.setTimeout(() => setLeaving(true), SENT_HOLD_MS);
    const close = window.setTimeout(() => onCloseRef.current(), SENT_HOLD_MS + SENT_EXIT_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(close);
    };
  }, [sent]);
  return leaving;
}
