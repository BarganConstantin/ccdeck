// Feedback, sent from inside the deck (#1853): a bug, an idea or anything else,
// posted to this deck's server, which passes it to api.ccdeck.dev with the
// ccdeck version and system. The API stores it and the people who make ccdeck
// read it there. Nothing becomes public by being sent: they may open a public
// GitHub issue from it, choosing its title and text, and the contact and the
// images are never put on one.
//
// IT ASKS FOR ONE THING. Somebody who noticed something should be able to say
// it in ten seconds, so the dialog opens on a message field with the caret in
// it, a compact choice of kind over it, and nothing else that wants an answer.
// It used to look like an issue form — three cards, a title, starter chips, a
// contact field and a paragraph about privacy, all before a word was typed —
// and every one of those was organising the report for the people reading it
// rather than letting it be written. What the API needs beyond the message the
// deck works out itself (feedback.ts): the title from the message's own first
// line, the version and system from the deck's server, which says what they
// are on one quiet line before Send. The contact and what happens to a report
// are one press away under "Add details" (FeedbackDetails.tsx); a screenshot
// is one press, a paste or a drop (FeedbackShots.tsx). Sending, and what
// happens once it has gone, is use-feedback-send.ts's.
//
// SEND IS NEVER GREYED OUT BEFORE IT IS PRESSED. Pressed with nothing written
// it says so beside the message and moves there; while the request is out it
// stays focusable and says aria-busy (#518). Once sent, the form goes inert
// under a thanks, focus goes to the × (#1762's rule), the one live
// region — present from the first render — says it was sent, and the dialog
// closes itself a moment later.
//
// AN IMAGE ARRIVES THE WAY A SCREENSHOT DOES — pasted, the common way, or
// dropped anywhere on the dialog, which says so while a file is over it — or
// through the picker. What is checked and redrawn before it goes is
// feedback-images.ts's. With no image, Send posts the JSON it always did.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { focusDropped, selfPressProps } from "../panel-press";
import SuccessMark from "./SuccessMark";
import FeedbackKinds from "./FeedbackKinds";
import FeedbackDetails, { DetailsToggle } from "./FeedbackDetails";
import FeedbackShots, { AddScreenshot, ImageGlyph } from "./FeedbackShots";
import { carriesFiles, shouldAttachPaste } from "../feedback-images";
import { useFeedbackImages } from "../use-feedback-images";
import { useFeedbackFacts } from "../use-feedback-facts";
import { useCloseWhenSent, useFeedbackSend } from "../use-feedback-send";
import {
  BODY_MAX, FACTS_SUFFIX, FACTS_UNKNOWN, MESSAGE_MISSING, SENT_LINE, factsLabel, hasMessage, isSendShortcut,
  isSymbolCap, kindCopy, outcomeAnnouncement, sendShortcutCaps, type FeedbackPrefill, type Kind,
} from "../feedback";

function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return hinted || navigator.platform || "";
}

interface Props extends FeedbackPrefill {
  onClose: () => void;
}

export default function FeedbackDialog({ onClose, initialKind, initialBody }: Props) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const dragDepth = useRef(0);
  const dialogRef = useModalDismiss(onClose, { focusRef: bodyRef });
  const [kind, setKind] = useState<Kind>(initialKind ?? "bug");
  const [body, setBody] = useState(initialBody ?? "");
  const [contact, setContact] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [triedToSend, setTriedToSend] = useState(false);
  const [dragging, setDragging] = useState(false);
  const images = useFeedbackImages();
  const facts = factsLabel(useFeedbackFacts());
  const { outcome, sending, send } = useFeedbackSend(images);
  const sent = outcome.state === "sent";
  const leaving = useCloseWhenSent(sent, onClose);
  const copy = kindCopy(kind);
  const bodyMissing = triedToSend && !hasMessage(body);
  const [capA, capB] = sendShortcutCaps(platformName());

  // Sent, the form stays drawn under the thanks, so the dialog keeps its
  // height, and goes inert: nothing in it can be reached or read. Focus in it
  // would go down with it, so it moves to the ×, which outlives the form
  // (#1762's rule); focus the reader has put anywhere else stays there.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const held = form.contains(document.activeElement) || focusDropped(document.activeElement?.tagName ?? null);
    form.inert = sent;
    if (sent && held) closeRef.current?.focus();
  }, [sent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!hasMessage(body)) {
      setTriedToSend(true);
      bodyRef.current?.focus();
      return;
    }
    void send({ kind, body, contact });
  }

  /** The whole dialog takes a dropped file while the form is up. The depth
   *  counts enters against leaves, since the pointer crossing into a child is
   *  a leave from its parent and would otherwise flicker the overlay off. */
  const accepting = !sent;
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
    <div className="modal-backdrop" onClick={onClose} role="presentation" onDragOver={refuseBesideDialog} onDrop={dropBesideDialog}
      data-leaving={leaving || undefined}>
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
            <button ref={closeRef} type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <p className="vis-hidden" role="status">{outcomeAnnouncement(outcome.state)}</p>
        <div className="fb-stage">
          <form
            ref={formRef}
            className="fb-form"
            onSubmit={submit}
            onKeyDown={e => {
              if (!isSendShortcut(e.nativeEvent)) return;
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }}
            noValidate
          >
            <section className="modal-body fb-body">
              <FeedbackKinds kind={kind} onChange={setKind} />
              <div className="fb-compose">
                <label className="fb-label" htmlFor="fb-body">{copy.question}</label>
                <textarea
                  ref={bodyRef}
                  id="fb-body"
                  className="ap-manage-input fb-message"
                  value={body}
                  maxLength={BODY_MAX}
                  rows={5}
                  placeholder={copy.placeholder}
                  onChange={e => setBody(e.target.value)}
                  aria-invalid={bodyMissing || undefined}
                  aria-describedby={bodyMissing ? "fb-body-error" : undefined}
                  required
                />
                {/* A sibling of the field rather than inside its label: inside,
                    it would join the field's name and be read twice. */}
                {bodyMissing && <p id="fb-body-error" className="fb-error">{MESSAGE_MISSING}</p>}
                <FeedbackShots images={images} addRef={addRef} />
                <div className="fb-tools">
                  <AddScreenshot images={images} buttonRef={addRef} />
                  <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(open => !open)} />
                </div>
                <FeedbackDetails open={detailsOpen} contact={contact} onContact={setContact} />
              </div>
              <p className="fb-facts">
                {facts ? <><span className="fb-facts-value">{facts}</span> — {FACTS_SUFFIX}</> : FACTS_UNKNOWN}
              </p>
              {outcome.state === "failed" && <p className="fb-error" role="alert">{outcome.message}</p>}
            </section>
            <div className="fb-foot">
              <span className="fb-shortcut" aria-hidden="true">
                <kbd data-symbol={isSymbolCap(capA) || undefined}>{capA}</kbd><kbd>{capB}</kbd> to send
              </span>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn primary fb-send" aria-keyshortcuts="Meta+Enter Control+Enter" {...selfPressProps(sending)}>
                {/* Both words always laid out in one cell, one of them hidden,
                    so the button is as wide sending as before and Cancel never
                    shifts under the pointer. */}
                <span className="fb-send-label">
                  <span className="fb-send-idle">Send feedback</span>
                  <span className="fb-send-busy">Sending…</span>
                </span>
              </button>
            </div>
          </form>
          {sent && (
            <div className="fb-done">
              <SuccessMark />
              <p className="fb-done-line">{SENT_LINE}</p>
            </div>
          )}
        </div>
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
