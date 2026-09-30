// Feedback, sent from inside the deck (#1853): a bug, an idea or anything else,
// posted to this deck's server, which passes it to api.ccdeck.dev with the
// ccdeck version and platform. The API stores it and the people who make
// ccdeck read it there. Nothing becomes public by being sent: they may open a
// public GitHub issue from it, and the contact and the images, if any are
// given, are never put on one. The dialog says so before Send is pressed,
// because words that may end up in public are chosen differently from words to
// a maker alone — and it promises no link afterwards, since there may never be
// an issue to link to.
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
//
// THE MESSAGE IS THE ONE THING IT ASKS FOR. A required title over a required
// body read as a chore before a word was typed, so the body comes first and
// takes focus, and the title moved under it and became optional: left empty,
// it is taken from the message's first line or first sentence, which is where
// a person already puts the point (Apple Notes names a note that way), and the
// empty title field shows that line as it is typed, so what will be sent is
// never a guess. The API still gets the title it requires, 3 to 120
// characters (ccdeck-api FeedbackRequest.Validate). A few starters over the
// body — "It happened when", "I expected" — put the first words down for a
// person who does not know how to begin; each is added on a line of its own
// after what is typed, never over it, and through the field's own editing so
// ⌘Z takes it back out.
//
// A SCREENSHOT CAN COME WITH IT, up to three, and the form is no taller for a
// person who never adds one: "Add a screenshot" sits in the message's label
// row, and the thumbnails appear under the message only once there is one. An
// image arrives the way a screenshot does — pasted, the most common way, or
// dropped anywhere on the dialog, which says so while a file is over it — or
// through the picker. What is checked and redrawn before it goes is
// feedback-images.ts's; FeedbackShots.tsx draws it. With no image, Send posts
// the same JSON it always did.
import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { useFocusRescue } from "./use-focus-rescue";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import SuccessMark from "./SuccessMark";
import FeedbackShots, { AddScreenshot, ImageGlyph } from "./FeedbackShots";
import { carriesFiles, feedbackRequest, shouldAttachPaste } from "../feedback-images";
import { useFeedbackImages } from "../use-feedback-images";

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
  /** The first words of a sentence this kind usually needs, offered over the
   *  body. No ellipsis: the chip draws one, and the text added is these words
   *  and a space, so typing carries straight on. */
  starters: readonly string[];
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
    starters: ["It happened when", "I expected", "Instead, it"],
  },
  {
    value: "idea",
    label: "An idea",
    hint: "Something ccdeck could do, or do better",
    titlePlaceholder: "A line that names the idea…",
    bodyLabel: "What you would like",
    bodyPlaceholder: "What it would let you do, and when you would reach for it…",
    bodyMissing: "Say what you would like.",
    starters: ["It would help if", "I would use it when", "Today I work around it by"],
  },
  {
    value: "other",
    label: "Something else",
    hint: "A question, or anything at all",
    titlePlaceholder: "A line that sums it up…",
    bodyLabel: "What is on your mind",
    bodyPlaceholder: "Anything the people who make ccdeck should know…",
    bodyMissing: "Say what is on your mind.",
    starters: ["I was wondering", "I noticed", "Thank you for"],
  },
];

/** The copy for one kind. Total: every Kind has a row above. */
export function kindCopy(kind: Kind): KindCopy {
  return KINDS.find(k => k.value === kind) ?? KINDS[0];
}

/** The API's limits (ccdeck-api FeedbackRequest): a title of 3 to 120
 *  characters and a body of 1 to 10,000, both counted after a trim. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const BODY_MAX = 10_000;
const CONTACT_MAX = 200;
export const TITLE_HINT = "Left empty, the first line of your message is used.";
export const TITLE_MISSING = "Three characters or more, or leave it empty to use your first line.";
/** A message too short to name itself, with no title typed: two characters
 *  cannot make the three a title needs. */
export const BODY_SHORT = "Say a little more: three characters or more.";

/** The title a message gives itself: its first line, cut at the end of the
 *  first sentence when that sentence can stand as a title, without the full
 *  stop a title does not wear. A first line too short to be one gives way to
 *  the whole message on one line. Past the API's 120 it is cut at a word and
 *  ends in an ellipsis. Shorter than three means the message cannot name
 *  itself, and missingFields says so. */
export function titleFromBody(body: string): string {
  const text = body.trim();
  if (text === "") return "";
  const line = oneLine(text.split(/\r?\n/, 1)[0]);
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(line)?.[1] ?? line;
  const lead = withoutFullStop(sentence).length >= TITLE_MIN ? withoutFullStop(sentence) : withoutFullStop(line);
  return clipTitle(lead.length >= TITLE_MIN ? lead : oneLine(text));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One full stop off the end, and never the last of three dots, a question
 *  mark or an exclamation, which say something a full stop does not. */
function withoutFullStop(text: string): string {
  return /[^.]\.$/.test(text) ? text.slice(0, -1) : text;
}

/** At most TITLE_MAX, cut at the last word that fits and marked with an
 *  ellipsis, which counts toward the limit. A word too long to leave room is
 *  cut where it stands. Never half of a surrogate pair. */
function clipTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const room = text.slice(0, TITLE_MAX - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= TITLE_MAX / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\uD800-\uDBFF]$/, "").replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** What goes as the title: the one typed, or the one the message gives. A
 *  title of spaces is no title, so the message names itself then too. */
export function titleToSend(title: string, body: string): string {
  return title.trim() || titleFromBody(body);
}

/** Every kind's starters, since a starter put down under one kind stays in
 *  the message when the kind is changed. */
const STARTERS: ReadonlySet<string> = new Set(KINDS.flatMap(k => k.starters));

/** Whether the message holds a word somebody wrote, rather than only spaces
 *  and the words a starter put down: "It would help if" on its own says
 *  nothing, and would otherwise go out as its own title. */
export function hasWriting(body: string): boolean {
  return body.split(/\r?\n/).some(line => line.trim() !== "" && !STARTERS.has(line.trim()));
}

export type FeedbackField = "title" | "body";

/** The fields Send cannot go without, in the order the form draws them — the
 *  first is where focus goes. The message is the one required thing; a title
 *  is wrong only when one is typed and is under three characters. A message
 *  too short to name itself, with no title, is the message's problem, not the
 *  title's: the fix is a few more words. Trimmed throughout. */
export function missingFields(title: string, body: string): FeedbackField[] {
  const missing: FeedbackField[] = [];
  const typed = title.trim();
  if (!hasWriting(body) || (typed === "" && titleFromBody(body).length < TITLE_MIN)) missing.push("body");
  if (typed !== "" && typed.length < TITLE_MIN) missing.push("title");
  return missing;
}

/** Where a starter goes and what it adds: over a field that holds nothing but
 *  spaces, the whole field; otherwise at the end, on a line of its own. It
 *  never replaces a character anybody typed. */
export function starterEdit(body: string, starter: string): { from: number; text: string } {
  const phrase = `${starter} `;
  if (body.trim() === "") return { from: 0, text: phrase };
  return { from: body.length, text: body.endsWith("\n") ? phrase : `\n${phrase}` };
}

/** The body once a starter is added — what starterEdit describes, applied. */
export function withStarter(body: string, starter: string): string {
  const { from, text } = starterEdit(body, starter);
  return body.slice(0, from) + text;
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

/** What the server's answer means for the person who pressed Send. `errors` is
 *  a 400's, keyed by field; an image's is quoted, since it names which one. */
export function feedbackFailure(status: number, reason: unknown, errors?: unknown): string {
  if (reason === "vetoed") return "This deck was started with AGENTS_DECK_NO_INSTALL=1, which keeps it off the network, so nothing was sent.";
  if (status === 429 || reason === "too_many") return "Too much feedback from this network in the last hour. Try again later; your text is still here.";
  if (status === 413 || reason === "too_large") return "The images are too large to send together. Remove one and send again; your text is still here.";
  const imageError = (errors as { images?: unknown } | null | undefined)?.images;
  if (status === 400 && Array.isArray(imageError) && typeof imageError[0] === "string") {
    return `The server did not accept an image. ${imageError[0]} Remove it and send again; your text is still here.`;
  }
  if (status === 400) return "The server did not accept the title or the text. Both are still here; check them and send again.";
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
 *  stroke, round caps and joins. Something wrong is the topbar Feedback button's
 *  own bubble, so the door and the choice it opens on look alike; something
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
  const addRef = useRef<HTMLButtonElement>(null);
  const sendingRef = useRef(false);
  const dragDepth = useRef(0);
  const dialogRef = useModalDismiss(onClose, { focusRef: bodyRef });
  const [kind, setKind] = useState<Kind>(initialKind ?? "bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(initialBody ?? "");
  const [contact, setContact] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  const [triedToSend, setTriedToSend] = useState(false);
  const [dragging, setDragging] = useState(false);
  const images = useFeedbackImages();
  const armRescue = useFocusRescue(outcome.state === "sent", closeRef);
  const copy = kindCopy(kind);
  const missing = missingFields(title, body);
  const titleMissing = triedToSend && missing.includes("title");
  const bodyMissing = triedToSend && missing.includes("body");
  const bodyError = hasWriting(body) ? BODY_SHORT : copy.bodyMissing;
  const derivedTitle = hasWriting(body) ? titleFromBody(body) : "";
  const sentTitle = titleToSend(title, body);
  const sending = outcome.state === "sending";
  const [capA, capB] = sendShortcutCaps(platformName());

  /** Puts a starter's words down through the field's own editing, so the
   *  field keeps it on its undo stack and ⌘Z takes it back out. Where the
   *  browser will not insert text that way, the value is set instead. */
  function startWith(starter: string) {
    const field = bodyRef.current;
    if (!field) return;
    const { from, text } = starterEdit(field.value, starter);
    field.focus();
    if (from + text.length > BODY_MAX) return;
    field.setSelectionRange(from, field.value.length);
    if (!document.execCommand("insertText", false, text)) setBody(withStarter(field.value, starter));
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selfPressAccepted(sendingRef.current)) return;
    if (missing.length > 0) {
      setTriedToSend(true);
      (missing[0] === "body" ? bodyRef : titleRef).current?.focus();
      return;
    }
    armRescue();
    sendingRef.current = true;
    setOutcome({ state: "sending" });
    try {
      const attached = await images.ready();
      const response = await fetch("/api/feedback", feedbackRequest({ kind, title: sentTitle, body: body.trim(), contact: contact.trim() || undefined }, attached));
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

  /** The whole dialog takes a dropped file while the form is up. The depth
   *  counts enters against leaves, since the pointer crossing into a child is
   *  a leave from its parent and would otherwise flicker the overlay off. */
  const accepting = outcome.state !== "sent";
  const fileDrag = (e: DragEvent) => carriesFiles(Array.from(e.dataTransfer.types));
  function dragEnter(e: DragEvent) {
    if (!fileDrag(e) || !accepting) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }
  function dragOver(e: DragEvent) {
    if (!fileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = accepting ? "copy" : "none";
  }
  function dragLeave(e: DragEvent) {
    if (!fileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function drop(e: DragEvent) {
    if (!fileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (accepting) images.add(Array.from(e.dataTransfer.files));
  }
  /** A file let go beside the dialog would otherwise open in place of the
   *  deck, and everything typed would go with it. */
  function refuseBesideDialog(e: DragEvent) {
    if (e.target !== e.currentTarget || !fileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  }
  function dropBesideDialog(e: DragEvent) {
    if (fileDrag(e)) e.preventDefault();
  }
  /** A pasted screenshot, from anywhere in the dialog — see shouldAttachPaste
   *  for when a paste is words instead. */
  function paste(e: ClipboardEvent) {
    if (!accepting) return;
    const files = Array.from(e.clipboardData.files);
    const field = e.target;
    const intoTextField = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement;
    const hasText = Array.from(e.clipboardData.types).includes("text/plain");
    if (!shouldAttachPaste({ files: files.length, hasText, intoTextField })) return;
    e.preventDefault();
    images.add(files);
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation" onDragOver={refuseBesideDialog} onDrop={dropBesideDialog}>
      <div
        ref={dialogRef}
        className="modal feedback-dialog"
        onClick={e => e.stopPropagation()}
        onDragEnter={dragEnter}
        onDragOver={dragOver}
        onDragLeave={dragLeave}
        onDrop={drop}
        onPaste={paste}
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
                <span>{sentTitle}</span>
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
                  <div className="fb-label-row">
                    <label className="fb-label" htmlFor="fb-body">{copy.bodyLabel}</label>
                    <AddScreenshot images={images} buttonRef={addRef} />
                  </div>
                  {/* Before the field, so Tab from the message goes on to the
                      title and a starter is one Shift+Tab back. */}
                  <div className="fb-starters" role="group" aria-label="Start a sentence with">
                    {copy.starters.map(starter => (
                      <button key={starter} type="button" className="fb-starter" onClick={() => startWith(starter)}>
                        {starter}…
                      </button>
                    ))}
                  </div>
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
                  {bodyMissing && <p id="fb-body-error" className="fb-error">{bodyError}</p>}
                  <FeedbackShots images={images} addRef={addRef} />
                </div>
                <div className="fb-field">
                  <label className="fb-label" htmlFor="fb-title">
                    Title
                    <span className="fb-optional">optional</span>
                  </label>
                  {/* Empty, the field shows the title the message gives, as
                      it is typed: the one that will be sent. */}
                  <input
                    ref={titleRef}
                    id="fb-title"
                    className="ap-manage-input"
                    type="text"
                    value={title}
                    maxLength={TITLE_MAX}
                    placeholder={derivedTitle.length >= TITLE_MIN ? derivedTitle : copy.titlePlaceholder}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => {
                      if (!isPlainEnter(e.nativeEvent) || body.trim() !== "") return;
                      e.preventDefault();
                      bodyRef.current?.focus();
                    }}
                    aria-invalid={titleMissing || undefined}
                    aria-describedby={titleMissing ? "fb-title-error" : "fb-title-hint"}
                  />
                  {titleMissing
                    ? <p id="fb-title-error" className="fb-error">{TITLE_MISSING}</p>
                    : <p id="fb-title-hint" className="fb-hint">{TITLE_HINT}</p>}
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
                  public GitHub issue from it; your images and how to reach you stay with them and are never put
                  there.
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
        <div className="fb-drop" aria-hidden="true" data-active={dragging || undefined}>
          <div className="fb-drop-frame">
            <ImageGlyph className="fb-drop-glyph" />
            <p className="fb-drop-title">Drop to attach</p>
            <p className="fb-drop-note">PNG or JPEG, up to three</p>
          </div>
        </div>
      </div>
    </div>
  );
}
