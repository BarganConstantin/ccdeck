// The accounts panel's header: its title, and the five controls that act on
// the panel as a whole — add an account, the usage report, share several,
// reload, close.
//
// Lifted out of AccountsPanel.tsx unchanged. It is drawn while the accounts
// have the column; Local network draws a header of its own, and the one close
// button is the panel's, handed to whichever header is up. Nothing here holds
// state: the three acts are the panel's, and the reload's two attributes come
// from the panel's one request slot like every other control's (#518).
import { type ReactNode } from "react";

import { PRODUCT } from "../brand";
import { type useRequestSlot } from "../use-request-slot";

type RequestSlot = ReturnType<typeof useRequestSlot>;

interface Props {
  /** Whether the store holds any account to share. */
  canShare: boolean;
  /** Whether there is any account to report on (#1707). */
  canReport: boolean;
  onAdd: () => void;
  onReport: () => void;
  onShareSet: () => void;
  onReload: () => void;
  pressProps: RequestSlot["pressProps"];
  /** A reload the reader asked for is out — see the panel's `load`. */
  reloading: boolean;
  closeButton: ReactNode;
}

export default function AccountsHeader({
  canShare, canReport, onAdd, onReport, onShareSet, onReload, pressProps, reloading, closeButton,
}: Props) {
  return (
    <div className="ap-header">
      {/* h2, under the topbar's h1 — the level every panel title sits at.

          CLAUDE ACCOUNTS, BECAUSE THAT IS WHAT IS IN IT. `Accounts` was
          written when Claude was the only thing this deck watched. The deck
          has drawn Codex sessions on the same canvas for months, and a Codex
          login is NOT in this list and cannot be — claude-swap manages Claude
          credentials, and nothing here reads or switches a Codex one. So a
          panel titled `Accounts` beside a canvas holding both promises a
          place to manage the other one and then never mentions it.

          Sentence case, like `Local network` below and every other caption in
          this sheet, and now identical to the landmark name this panel has
          carried since #381 — a region whose heading and whose accessible
          name are the same string is one thing to a screen reader rather than
          two. */}
      <h2>Claude accounts</h2>
      <div className="ap-header-right">
        {/* The `+` is one glyph, so `title` was its whole accessible name.
            A last-resort name source that a touch user never sees and that
            some readers are configured to ignore is not a name; this is the
            second and last of the two the #381 sweep found. The tooltip stays
            as the longer hover sentence. */}
        <button type="button" className="glyph-btn ap-add" onClick={() => onAdd()}
          aria-label="Add an account"
          title="Sign in to another Claude account, or paste one shared from another deck">
          {/* AUTHORED, NOT TYPED. These four were `+`, `↗`, `↻` and `×` —
              four Unicode codepoints out of four different blocks, all set at
              16px and measuring 8.3, 9.1, 10.9 and 7.4 of ink, with the
              reload 78% taller than the close beside it. A row of one-size
              buttons cannot be one size while the glyphs in them come from
              four typefaces. Drawn at the app's own small-icon spec, which is
              what the topbar's five already are. */}
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" aria-hidden>
            <path d="M7 2.2v9.6M2.2 7h9.6" />
          </svg>
        </button>
        {/* THE USAGE REPORT (#1707): the 5-hour and 7-day quota added up
            across every account here — the question ten rows cannot answer
            at a glance. A panel-level read, so it is up here with the
            panel's other acts, and drawn only when there is an account to
            report on. A gauge, drawn to the small-icon spec: three bars
            would be the topbar's History glyph again, one button over. */}
        {canReport && (
          <button type="button" className="glyph-btn" onClick={() => onReport()}
            aria-label="Usage report" aria-haspopup="dialog"
            title="Usage report — the 5h and 7d quota added up across every account">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M2.5 10.5a4.5 4.5 0 0 1 9 0" />
              <path d="M7 10.5l2.2-2.6" />
            </svg>
          </button>
        )}
        {/* #518: this used to be `disabled={reloading}`, which disabled the
            control the press came from and dropped focus to the document
            body on every reload. It is inert while somebody ELSE is working and busy while
            its own request is out — the same two attributes every control in
            the panel takes from pressProps — and the glyph goes on saying
            which of the two it is.
            `reloading` is a second flag rather than the panel request slot
            because a reload is fired by the poll and by every other action
            too, and a reload that took the slot would disable the control
            that had just fired it — which is the defect, one step further
            along. */}
        {/* A panel-level act and not a row one, so it is up here beside the
            other two. It is drawn only when there is something to share:
            a header offering to send accounts from a deck that holds none
            is a control whose only outcome is an error.

            It has no class of its own any more. The one it had existed to
            nudge a text arrow inside the 24px box, and an icon is centred by
            `.glyph-btn` itself — a class that styles nothing is a hook nobody
            is holding. */}
        {canShare && (
          <button type="button" className="glyph-btn" onClick={() => onShareSet()}
            aria-label="Share accounts with another deck"
            title={`Copy several accounts to another ${PRODUCT} in one paste. The text carries a live login for each one — treat it as those passwords.`}>
            {/* Out and away: the same arrowhead the reload beside it is built
                from, so the two read as one hand rather than two. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3.3 10.7L10.7 3.3" />
              <path d="M5.5 3.3h5.2v5.2" />
            </svg>
          </button>
        )}
        <button type="button" className="glyph-btn ap-refresh" onClick={() => onReload()}
          {...pressProps("reload", reloading)} aria-label="Reload accounts"
          title="Reload from claude-swap">
          {/* IT TURNS WHILE IT WORKS, where it used to swap the arrow for an
              ellipsis. Both say which of the two states the control is in,
              which is what #518 asked of it; a rotation says it without the
              button's ink changing shape. The LAN section's check turns the
              same way while it works, with its own glyph since #838. */}
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
            <path d="M11.9 2.6v3.7h-3.6" />
          </svg>
        </button>
        {closeButton}
      </div>
    </div>
  );
}
