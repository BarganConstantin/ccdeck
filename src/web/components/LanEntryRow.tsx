// The way into Local network: one row at the foot of the accounts view, and
// the peek beside it.
//
// Lifted out of LanSyncSection.tsx unchanged. The row names the section and
// says the two facts a reader decides on — is it on, is anything wrong — and a
// mouse resting on it, or a keyboard landing on it, is shown who is on. Whether
// the card is showing is the section's, from use-hover-peek.ts, because the
// row goes with the accounts view and the state has to outlive it; so is the
// live region beside the row. What is here is how the row is drawn and what
// each thing that can happen to it asks of the peek.
import type { DeckRow, entryLine } from "../lan-roster";
import { PEEK_DELAY_MS, type useHoverPeek } from "../use-hover-peek";
import LanPeek from "./LanPeek";

export default function LanEntryRow({ entry, rows, onOpen, peek, openPeek, shutPeek, holdPeek, dropPeek }: {
  /** What the row says: entryLine, from the same rows the list is drawn from. */
  entry: ReturnType<typeof entryLine>;
  /** The rows the peek names. */
  rows: DeckRow[];
  /** The row was pressed: give the section the column. */
  onOpen: () => void;
} & ReturnType<typeof useHoverPeek>) {
  return (
    <>
      <button type="button" id="ap-lan-entry" className="ap-nav"
        onClick={() => { dropPeek(); onOpen(); }}
        // Described by the card while the card is there, so a screen reader
        // on this row is read the same names a pointer is shown.
        aria-describedby={peek ? "ap-lan-peek" : undefined}
        // A mouse only. Touch has no hover, and a pointerenter synthesised by
        // a tap would open a card the tap is already replacing with the view.
        onPointerEnter={e => { if (e.pointerType === "mouse") openPeek(PEEK_DELAY_MS); }}
        onPointerLeave={shutPeek}
        // A KEYBOARD'S FOCUS, NOT EVERY FOCUS. The keyboard is owed what the
        // pointer is shown, which is the whole of hover's a11y debt — but
        // `Back` hands focus to this row programmatically, and that hand-back
        // is not somebody asking to see the card. It opened one anyway, with
        // the pointer up in the header where Back was, and it stayed open
        // because nothing was ever going to blur or leave it. `:focus-visible`
        // is the browser's own answer to which of the two happened.
        onFocus={e => { if (e.target.matches(":focus-visible")) openPeek(0); }}
        // AND NO ESCAPE HANDLER. Escape is for a surface a reader is stuck
        // inside; this one holds no focus, takes no pointer and covers
        // nothing that can be pressed — there is nothing to escape from, and
        // App.tsx stays the only place in this app that reads that key.
        onBlur={shutPeek}>
        <svg className="ap-nav-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="1.8" y="2.3" width="10.4" height="7.2" rx="1.2" />
          <path d="M5 11.9h4M7 9.5v2.4" />
        </svg>
        <span className="ap-nav-text">
          <span className="ap-nav-name">Local network</span>
          <span className="ap-nav-state" data-tone={entry.tone}>
            {/* The mark, before the count, and only while somebody is there:
                `online` is a word in the muted tier, read by whoever is
                already reading the row, and a glance wants the same dot the
                machines inside wear. */}
            {entry.live && <i className="ap-nav-live" aria-hidden />}
            {entry.text}
          </span>
        </span>
        <svg className="ap-nav-chev" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.6 3.4 9.2 7l-3.6 3.6" />
        </svg>
      </button>
      {peek && <LanPeek anchorId="ap-lan-entry" id="ap-lan-peek" rows={rows} onHold={holdPeek} onLet={shutPeek} />}
    </>
  );
}
