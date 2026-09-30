// Feedback, sent from inside the deck (#1853): a bug, an idea or anything else,
// posted to this deck's server, which passes it to api.ccdeck.dev with the
// ccdeck version and platform. The API stores it and the people who make
// ccdeck read it there. Nothing becomes public by being sent: they may open a
// public GitHub issue from it, and the contact, if one is given, is never put
// on one. The dialog says both before Send is pressed, because words that may
// end up in public are chosen differently from words to a maker alone — and it
// promises no link afterwards, since there may never be an issue to link to.
//
// Not gated on the reports switch: pressing Send is its own decision, for this
// one message. Nothing typed is lost to a failure — the form stays filled.
//
// THE KIND IS CHOSEN FIRST AND THE FORM FOLLOWS IT. Each kind is a card with its
// glyph, its name and one line saying what it covers, so the three can be told
// apart before any is read closely; the body's label and both placeholders then
// ask the question that kind needs answered — what went wrong, what you would
// like — rather than one label hedging across all three. The cards are native
// radios under the paint, so the arrows walk them and Tab stops once, as the
// plain radios they replaced did.
//
// SEND IS NEVER GREYED OUT BEFORE IT IS PRESSED. A disabled Send said "not yet"
// without saying why, and read as broken. Pressed on an unfinished form it names
// what is missing beside that field and moves there; while the request is out
// it stays focusable and says aria-busy, the rule every press in this app keeps
// since #518 — disabling the focused button is what drops focus to <body>. When
// the answer takes the form away, focus goes to Close (useFocusRescue, #1762)
// and the one live region, present from the first render, says it was sent.
import { useRef, useState, type FormEvent } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { useFocusRescue } from "./use-focus-rescue";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import SuccessMark from "./SuccessMark";

export type Kind = "bug" | "idea" | "other";
/** How a caller seeds the dialog — the error boundary opens it as a filled-in
 *  bug, the account popover as the issue it explains (#1853). Absent fields keep
 *  the empty defaults, so an unseeded open is exactly what it always was. */
export interface FeedbackPrefill {
  initialKind?: Kind;
  initialBody?: string;
}

/** Everything the form says that depends on the kind chosen. */
export interface KindCopy {
  value: Kind;
  label: string;
  /** One line under the name: what the kind covers. No full stop — it is a
   *  caption, and a screen reader reads it as the choice's description. */
  hint: string;
  titlePlaceholder: string;
  bodyLabel: string;
  bodyPlaceholder: string;
  /** What an empty body is told when Send is pressed. */
  bodyMissing: string;
}

export const KINDS: readonly KindCopy[] = [
  {
    value: "bug",
    label: "Something is wrong",
    hint: "A crash, or something that misbehaves",
    titlePlaceholder: "A line that names the problem…",
    bodyLabel: "What went wrong",
    bodyPlaceholder: "What you did, what you expected, and what happened instead…",
    bodyMissing: "Say what went wrong.",
  },
  {
    value: "idea",
    label: "An idea",
    hint: "Something ccdeck could do, or do better",
    titlePlaceholder: "A line that names the idea…",
    bodyLabel: "What you would like",
    bodyPlaceholder: "What it would let you do, and when you would reach for it…",
    bodyMissing: "Say what you would like.",
  },
  {
    value: "other",
    label: "Something else",
    hint: "A question, or anything at all",
    titlePlaceholder: "A line that sums it up…",
    bodyLabel: "What is on your mind",
    bodyPlaceholder: "Anything the people who make ccdeck should know…",
    bodyMissing: "Say what is on your mind.",
  },
];

/** The copy for one kind. Total: every Kind has a row above. */
export function kindCopy(kind: Kind): KindCopy {
  return KINDS.find(k => k.value === kind) ?? KINDS[0];
}

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const BODY_MAX = 10_000;
const CONTACT_MAX = 200;
export const TITLE_MISSING = "Give it a title of three characters or more.";

export type FeedbackField = "title" | "body";

/** The fields Send cannot go without, in the order the form draws them — the
 *  first is where focus goes. Trimmed, so a line of spaces is not a title. */
export function missingFields(title: string, body: string): FeedbackField[] {
  const missing: FeedbackField[] = [];
  if (title.trim().length < TITLE_MIN) missing.push("title");
  if (body.trim().length === 0) missing.push("body");
  return missing;
}

/** The keystroke fields a shortcut is read from. Structural, so a test can pass
 *  a plain object; a real KeyboardEvent satisfies it. */
export interface EnterKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** ⌘+Enter or Ctrl+Enter sends from anywhere in the form, on every platform —
 *  a textarea keeps a bare Enter for a new line. Never while an input method is
 *  composing: that Enter commits the characters, not the message. */
export function isSendShortcut(e: EnterKey): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing;
}

/** A bare Enter. In the title it moves on to the body instead of submitting a
 *  form whose body is still empty. */
export function isPlainEnter(e: EnterKey): boolean {
  return e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing;
}

/** The caps the footer draws for the send shortcut: the one this platform's
 *  keyboard says. Both chords work everywhere; this only picks which to show. */
export function sendShortcutCaps(platform: string): [string, string] {
  return /mac|iphone|ipad/i.test(platform) ? ["⌘", "Enter"] : ["Ctrl", "Enter"];
}

/** A cap that is one symbol rather than a word — ⌘ — and is drawn a size up in
 *  the system face, because the mono stack draws the glyph at a fraction of the
 *  word beside it. */
export function isSymbolCap(cap: string): boolean {
  return [...cap].length === 1;
}

function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return hinted || navigator.platform || "";
}

type Outcome =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "sent" }
  | { state: "failed"; message: string };

/** What the server's answer means for the person who pressed Send. */
export function feedbackFailure(status: number, reason: unknown): string {
  if (reason === "vetoed") return "This deck was started with AGENTS_DECK_NO_INSTALL=1, which keeps it off the network, so nothing was sent.";
  if (status === 429 || reason === "too_many") return "Too much feedback from this network in the last hour. Try again later; your text is still here.";
  if (status === 400) return "The server did not accept this. Check that the title and the text are filled in.";
  return "ccdeck's server could not be reached. Nothing was sent; your text is still here, so try again in a moment.";
}

/** What the dialog's live region says for each outcome. The region is drawn from
 *  the first render, so the change is what a screen reader hears. */
export function outcomeAnnouncement(outcome: Outcome["state"]): string {
  if (outcome === "sending") return "Sending…";
  if (outcome === "sent") return "Sent. It reached the people who make ccdeck.";
  return "";
}

/** The kind's glyph, on the topbar's one icon spec (#837): a 14 viewBox, a 1.4
 *  stroke, round caps and joins. Something wrong is the topbar's own Report a
 *  problem bubble, so the door and the choice it opens on look alike; something
 *  else is the same bubble with an ellipsis; an idea is a bulb. */
function KindGlyph({ kind }: { kind: Kind }) {
  return (
    <svg className="fb-glyph" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {kind === "idea" ? (
        <>
          <path d="M7 1.8a3.6 3.6 0 0 0-2.2 6.45c.35.28.5.62.5 1.05v.3h3.4v-.3c0-.43.15-.77.5-1.05A3.6 3.6 0 0 0 7 1.8Z" />
          <path d="M5.6 11.9h2.8" />
        </>
      ) : (
        <>
          <path d="M2.2 3.3h9.6v5.3H6.1L3.5 10.8V8.6H2.2Z" />
          {kind === "bug" ? (
            <>
              <path d="M7 4.9v1.7" />
              <path d="M7 7.7v.05" />
            </>
          ) : (
            <>
              <path d="M4.9 5.95h.05" />
              <path d="M7 5.95h.05" />
              <path d="M9.1 5.95h.05" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

interface Props extends FeedbackPrefill {
  onClose: () => void;
}

export default function FeedbackDialog({ onClose, initialKind, initialBody }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sendingRef = useRef(false);
  const dialogRef = useModalDismiss(onClose, { focusRef: titleRef });
  const [kind, setKind] = useState<Kind>(initialKind ?? "bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialBody ?? "");
  const [contact, setContact] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  const [triedToSend, setTriedToSend] = useState(false);
  const armRescue = useFocusRescue(outcome.state === "sent", closeRef);
  const copy = kindCopy(kind);
  const missing = missingFields(title, body);
  const titleMissing = triedToSend && missing.includes("title");
  const bodyMissing = triedToSend && missing.includes("body");
  const sending = outcome.state === "sending";
  const [capA, capB] = sendShortcutCaps(platformName());

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selfPressAccepted(sendingRef.current)) return;
    if (missing.length > 0) {
      setTriedToSend(true);
      (missing[0] === "title" ? titleRef : bodyRef).current?.focus();
      return;
    }
    armRescue();
    sendingRef.current = true;
    setOutcome({ state: "sending" });
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, title: title.trim(), body: body.trim(), contact: contact.trim() || undefined }),
      });
      const d = await response.json().catch(() => null);
      setOutcome(response.ok && d?.ok
        ? { state: "sent" }
        : { state: "failed", message: feedbackFailure(response.status, d?.reason) });
    } catch {
      setOutcome({ state: "failed", message: feedbackFailure(0, null) });
    } finally {
      sendingRef.current = false;
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
        <p className="vis-hidden" role="status">{outcomeAnnouncement(outcome.state)}</p>
        {outcome.state === "sent" ? (
          <section className="modal-body">
            <div className="fb-done">
              <SuccessMark />
              <p className="fb-done-title">Thank you</p>
              <p className="fb-done-note">It reached the people who make ccdeck.</p>
              <p className="fb-receipt">
                <KindGlyph kind={kind} />
                <span>{title.trim()}</span>
              </p>
              <button ref={closeRef} type="button" className="btn primary" onClick={onClose}>Close</button>
            </div>
          </section>
        ) : (
          <form
            className="fb-form"
            onSubmit={send}
            onKeyDown={e => {
              if (!isSendShortcut(e.nativeEvent)) return;
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }}
            noValidate
          >
            <section className="modal-body">
              <fieldset className="fb-kinds">
                <legend className="vis-hidden">What is it about</legend>
                {KINDS.map(option => (
                  <label key={option.value} className="fb-kind">
                    <input
                      type="radio"
                      name="feedback-kind"
                      value={option.value}
                      checked={kind === option.value}
                      onChange={() => setKind(option.value)}
                      aria-labelledby={`fb-kind-name-${option.value}`}
                      aria-describedby={`fb-kind-hint-${option.value}`}
                    />
                    <KindGlyph kind={option.value} />
                    <svg className="fb-kind-check" viewBox="0 0 12 12" aria-hidden focusable="false">
                      <path d="M2.5 6.4 4.9 8.7 9.5 3.6" />
                    </svg>
                    {/* Named by the name alone and described by the hint: the
                        <label> round both would otherwise make the hint part
                        of the name, and it would be read twice. */}
                    <span id={`fb-kind-name-${option.value}`} className="fb-kind-name">{option.label}</span>
                    <span id={`fb-kind-hint-${option.value}`} className="fb-kind-hint">{option.hint}</span>
                  </label>
                ))}
              </fieldset>
              {/* Each error is a sibling of its field rather than inside the
                  <label>: inside, it would join the field's name and be read
                  twice, once as the name and once as the description. */}
              <div className="fb-fields">
                <div className="fb-field">
                  <label className="fb-label" htmlFor="fb-title">Title</label>
                  <input
                    ref={titleRef}
                    id="fb-title"
                    className="ap-manage-input"
                    type="text"
                    value={title}
                    maxLength={TITLE_MAX}
                    placeholder={copy.titlePlaceholder}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => {
                      if (!isPlainEnter(e.nativeEvent)) return;
                      e.preventDefault();
                      bodyRef.current?.focus();
                    }}
                    aria-invalid={titleMissing || undefined}
                    aria-describedby={titleMissing ? "fb-title-error" : undefined}
                    required
                  />
                  {titleMissing && <p id="fb-title-error" className="fb-error">{TITLE_MISSING}</p>}
                </div>
                <div className="fb-field">
                  <label className="fb-label" htmlFor="fb-body">{copy.bodyLabel}</label>
                  <textarea
                    ref={bodyRef}
                    id="fb-body"
                    className="ap-manage-input"
                    value={body}
                    maxLength={BODY_MAX}
                    rows={6}
                    placeholder={copy.bodyPlaceholder}
                    onChange={e => setBody(e.target.value)}
                    aria-invalid={bodyMissing || undefined}
                    aria-describedby={bodyMissing ? "fb-body-error" : undefined}
                    required
                  />
                  {bodyMissing && <p id="fb-body-error" className="fb-error">{copy.bodyMissing}</p>}
                </div>
                <div className="fb-field">
                  <label className="fb-label" htmlFor="fb-contact">
                    How to reach you, if you want an answer
                    <span className="fb-optional">optional</span>
                  </label>
                  <input
                    id="fb-contact"
                    className="ap-manage-input"
                    type="text"
                    value={contact}
                    maxLength={CONTACT_MAX}
                    autoComplete="email"
                    placeholder="An email address, or your GitHub @name…"
                    onChange={e => setContact(e.target.value)}
                  />
                </div>
              </div>
              <div className="fb-note">
                <svg className="fb-glyph" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                  strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                  <path d="M1.4 7S3.4 3.4 7 3.4 12.6 7 12.6 7 10.6 10.6 7 10.6 1.4 7 1.4 7Z" />
                  <circle cx="7" cy="7" r="1.7" />
                </svg>
                <p>
                  This goes to the people who make ccdeck, with your ccdeck version and system. They may open a
                  public GitHub issue from it; how to reach you is never put there.
                </p>
              </div>
              {outcome.state === "failed" && <p className="fb-error" role="alert">{outcome.message}</p>}
            </section>
            <div className="fb-foot">
              <span className="fb-shortcut" aria-hidden="true">
                <kbd data-symbol={isSymbolCap(capA) || undefined}>{capA}</kbd><kbd>{capB}</kbd> to send
              </span>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn primary fb-send" aria-keyshortcuts="Meta+Enter Control+Enter" {...selfPressProps(sending)}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
