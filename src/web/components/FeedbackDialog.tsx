// Feedback, sent from inside the deck (#1853): a bug, an idea or anything else,
// posted to this deck's server, which passes it to api.ccdeck.dev with the
// ccdeck version and platform. There it becomes a public GitHub issue; the
// contact, if one is given, stays with the API and is never put on the issue.
// The dialog says both before Send is pressed, because a person writing to a
// maker and a person writing in public choose different words.
//
// Not gated on the reports answer: pressing Send is its own answer, for this
// one message. Nothing typed is lost to a failure — the form stays filled.
import { useRef, useState, type FormEvent } from "react";
import { useModalDismiss } from "./use-modal-dismiss";

type Kind = "bug" | "idea" | "other";
const KINDS: { value: Kind; label: string }[] = [
  { value: "bug", label: "Something is wrong" },
  { value: "idea", label: "An idea" },
  { value: "other", label: "Something else" },
];
export const TITLE_MAX = 120;
export const BODY_MAX = 10_000;
const CONTACT_MAX = 200;

type Outcome =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "sent"; issue: string | null }
  | { state: "failed"; message: string };

/** What the server's answer means for the person who pressed Send. */
export function feedbackFailure(status: number, reason: unknown): string {
  if (reason === "vetoed") return "This deck was started with AGENTS_DECK_NO_INSTALL=1, which keeps it off the network, so nothing was sent.";
  if (status === 429 || reason === "too_many") return "Too much feedback from this network in the last hour. Try again later; your text is still here.";
  if (status === 400) return "The server did not accept this. Check that the title and the text are filled in.";
  return "ccdeck's server could not be reached. Nothing was sent; your text is still here, so try again in a moment.";
}

interface Props {
  onClose: () => void;
}

export default function FeedbackDialog({ onClose }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: titleRef });
  const [kind, setKind] = useState<Kind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  const ready = title.trim().length >= 3 && body.trim().length > 0 && outcome.state !== "sending";

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setOutcome({ state: "sending" });
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, title: title.trim(), body: body.trim(), contact: contact.trim() || undefined }),
      });
      const d = await response.json().catch(() => null);
      setOutcome(response.ok && d?.ok
        ? { state: "sent", issue: typeof d.issue === "string" ? d.issue : null }
        : { state: "failed", message: feedbackFailure(response.status, d?.reason) });
    } catch {
      setOutcome({ state: "failed", message: feedbackFailure(0, null) });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal feedback-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span id="feedback-title" className="modal-tool-name">Send feedback</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <section className="modal-body">
          {outcome.state === "sent" ? (
            <div className="fb-done" role="status">
              <p>Thank you. It is on its way to ccdeck's issue tracker.</p>
              {outcome.issue && (
                <p><a href={outcome.issue} target="_blank" rel="noreferrer">See the issue on GitHub</a></p>
              )}
              <div className="fb-actions">
                <button type="button" className="btn primary" onClick={onClose}>Close</button>
              </div>
            </div>
          ) : (
            <form className="fb-form" onSubmit={send} noValidate>
              <fieldset className="fb-kinds">
                <legend className="vis-hidden">What is it about</legend>
                {KINDS.map(option => (
                  <label key={option.value} className="fb-kind">
                    <input type="radio" name="feedback-kind" value={option.value} checked={kind === option.value} onChange={() => setKind(option.value)} />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
              <label className="fb-field">
                <span>Title</span>
                <input ref={titleRef} className="ap-manage-input" type="text" value={title} maxLength={TITLE_MAX} onChange={e => setTitle(e.target.value)} required />
              </label>
              <label className="fb-field">
                <span>What happened, or what you would like</span>
                <textarea className="ap-manage-input" value={body} maxLength={BODY_MAX} rows={6} onChange={e => setBody(e.target.value)} required />
              </label>
              <label className="fb-field">
                <span>How to reach you, if you want an answer (optional)</span>
                <input className="ap-manage-input" type="text" value={contact} maxLength={CONTACT_MAX} autoComplete="email" onChange={e => setContact(e.target.value)} />
              </label>
              <p className="fb-note">
                This becomes a public issue on GitHub, with your ccdeck version and system. How to reach you is
                kept private and never put on the issue.
              </p>
              {outcome.state === "failed" && <p className="fb-error" role="alert">{outcome.message}</p>}
              <div className="fb-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn primary" disabled={!ready}>
                  {outcome.state === "sending" ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
