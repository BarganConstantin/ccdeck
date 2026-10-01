// What a report needs no one to fill in, kept one press away: how to reach the
// person who sent it, and what happens to it once sent. The dialog opens
// without either — a message is all it takes — and "Add details" unfolds them
// under the message, inline, so nothing that was typed moves out of view or is
// lost when the section folds away again. The contact is the dialog's state,
// not this section's, and the section is always drawn, only hidden.
//
// FOLDED, IT IS NOT THERE: no height, no tab stop, nothing a screen reader
// reads — `visibility: hidden`, which also takes it out of the accessibility
// tree. The disclosure is a button with aria-expanded naming the region it
// controls (the WAI-ARIA disclosure pattern).
import { useId } from "react";
import {
  ADD_DETAILS, CONTACT_HINT, CONTACT_LABEL, CONTACT_MAX, CONTACT_PLACEHOLDER, WHERE_IT_GOES, isPlainEnter,
} from "../feedback";

export const DETAILS_ID = "fb-details";

/** The way in: quiet, in the row under the message, opposite Add screenshot. */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="fb-tool fb-more" aria-expanded={open} aria-controls={DETAILS_ID} onClick={onToggle}>
      {ADD_DETAILS}
      <svg className="fb-chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
        strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        <path d="M2.5 3.75 5 6.25l2.5-2.5" />
      </svg>
    </button>
  );
}

interface Props {
  open: boolean;
  contact: string;
  onContact: (contact: string) => void;
}

export default function FeedbackDetails({ open, contact, onContact }: Props) {
  const hintId = useId();
  return (
    <div id={DETAILS_ID} className="fb-details" data-open={open || undefined}>
      <div className="fb-details-clip">
        <div className="fb-details-body">
          <div className="fb-field">
            <label className="fb-field-label" htmlFor="fb-contact">
              {CONTACT_LABEL}
              <span className="fb-optional">optional</span>
            </label>
            <input
              id="fb-contact"
              className="ap-manage-input"
              type="text"
              value={contact}
              maxLength={CONTACT_MAX}
              autoComplete="email"
              placeholder={CONTACT_PLACEHOLDER}
              aria-describedby={hintId}
              onChange={e => onContact(e.target.value)}
              onKeyDown={e => { if (isPlainEnter(e.nativeEvent)) e.preventDefault(); }}
            />
            <p id={hintId} className="fb-hint">{CONTACT_HINT}</p>
          </div>
          <div className="fb-where">
            {WHERE_IT_GOES.map(line => <p key={line}>{line}</p>)}
          </div>
        </div>
      </div>
    </div>
  );
}
