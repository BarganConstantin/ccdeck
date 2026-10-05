// What a warning in the accounts panel opens, and the warning mark itself.
//
// Lifted out of AccountsPanel.tsx unchanged. The popover draws one account's
// issue — claude-swap's verdict in the product's voice, when the account was
// last read, and the one press that repairs it — and the panel still decides
// everything around it: which account's warning is open, which control it hangs
// from, and which box it closes against. The mark came with it because it is
// the issue's own: a row's warning, the notice over the list and this popover's
// title are the three places it is drawn, and the panel imports it for the
// other two.
import { useRef } from "react";
import AnchoredPopover from "./AnchoredPopover";
import { type AccountIssue } from "../account-issue";
import { ago } from "../account-freshness";

/** The panel's one warning mark, drawn at the header icons' spec — a triangle
 *  and a stroke, in whatever ink the words beside it are in. */
export function WarnGlyph() {
  return (
    <svg className="ap-warn-glyph" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 1.9 12.9 12H1.1Z" />
      <path d="M7 5.6v2.9" />
      <path d="M7 10.3v.05" />
    </svg>
  );
}

interface Props {
  /** The warning that was pressed, by id — a row's, or the notice's. */
  anchorId: string;
  /** The box that warning scrolls in, which the popover closes against. */
  boundaryId: string;
  issue: AccountIssue;
  /** The account's name, as its row calls it. */
  who: string;
  /** When claude-swap last read the account, in ms, or null if it never has. */
  fetchedAt: number | null;
  nowSec: number;
  /** Shut the popover; `true` hands focus back to the warning it hangs from. */
  onClose: (refocus?: boolean) => void;
  /** Open the sign-in dialog, which is what the fix is. */
  onSignIn: () => void;
  /** Open the feedback dialog seeded with this issue (#1853). Absent, no button
   *  is drawn — the panel decides whether reporting is wired up at all. */
  onReport?: () => void;
}

/**
 * WHY, AND WHAT FIXES IT — for whichever warning was pressed. The sentences are
 * claude-swap's verdicts in the product's voice, the same ones that lived in a
 * title and then in a line that pushed the row open; the press is the sign-in
 * the row used to carry as a second pill. Portalled like the ⋯ menu, so it
 * moves nothing.
 */
export default function AccountIssuePopover({ anchorId, boundaryId, issue, who, fetchedAt, nowSec, onClose, onSignIn, onReport }: Props) {
  // Focus opens on Done. Report this is first in the DOM, held left, and was
  // the first control the dismiss hook found: a keyboard Enter after opening
  // the popover filed a report instead of answering it.
  const doneRef = useRef<HTMLButtonElement>(null);
  return (
    <AnchoredPopover
      anchorId={anchorId}
      boundaryId={boundaryId}
      id="ap-issue-pop"
      className="ap-pop ap-issue-pop"
      role="dialog"
      labelledBy="ap-issue-title"
      focusRef={doneRef}
      onClose={() => onClose()}
    >
      <div className="ap-pop-form">
        <p className="ap-pop-title ap-issue-title" id="ap-issue-title" data-tone={issue.tone}>
          {issue.tone === "warn" && <WarnGlyph />}
          {issue.text}
        </p>
        <p className="ap-pop-note ap-issue-hint">{issue.hint}</p>
        <p className="ap-pop-note ap-issue-when">
          <span className="ap-issue-who">{who}</span>
          {" · "}
          {fetchedAt ? `last collected ${ago(fetchedAt, nowSec)}` : "never collected"}
        </p>
        <div className="ap-pop-actions">
          {/* Subordinate to Done and the fix — a quiet word on the left, no box,
              for the rare reader who wants to tell the makers about this rather
              than act on it (#1853). It carries the issue's words, never the
              account's name. `margin-right: auto` in the sheet holds it left
              while the two answers stay right. */}
          {onReport && (
            <button type="button" className="ap-issue-report" onClick={() => { onClose(); onReport(); }}>
              Report this
            </button>
          )}
          <button type="button" ref={doneRef} className="btn" onClick={() => onClose(true)}>Done</button>
          {issue.fix && (
            <button type="button" className="btn primary" onClick={() => { onClose(true); onSignIn(); }}
              title="Open the sign-in dialog. Signing in as this account puts its login back in this slot — it keeps its slot, its alias and its history.">
              {issue.fix}
            </button>
          )}
        </div>
      </div>
    </AnchoredPopover>
  );
}
