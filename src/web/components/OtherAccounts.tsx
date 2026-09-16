// THE FOLD'S ROW, and the card that names what is behind it.
//
// Why the accounts column has a fold at all, and why it unfolds in place
// instead of leading to a view, is written in other-accounts.ts. This file is
// the two surfaces: a row in Local network's idiom, and a peek in Local
// network's shape.
//
// IT BORROWS THAT SECTION'S TIMINGS RATHER THAN CHOOSING ITS OWN. Two hover
// cards in one column that opened on different delays would be two behaviours
// a reader has to learn from the same panel, and nothing about accounts makes
// 160ms the wrong number. The constants are imported for that reason and not
// for reuse; if one of them ever needs to differ, the comment that says why
// belongs here.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Peer, foldPeek, restLine } from "../other-accounts";
import { placeBeside } from "../popover-place";
import { PEEK_DELAY_MS, PEEK_GRACE_MS } from "./LanSyncSection";

/**
 * THE NAMES, BESIDE THE ROW, WITH NOTHING PRESSED.
 *
 * `2 ready` answers how many and refuses to say which, and which is the whole
 * question for somebody whose current window is nearly spent. The press that
 * answers it costs an unfold and a re-fold, for a list of at most a handful of
 * names.
 *
 * NOT ONE CONTROL IN IT, which is the rule LanPeek wrote and the one this card
 * is most tempted to break: the reader hovering it is choosing where to switch,
 * and `Switch` is right there in the sentence. It stays out. A card that shuts
 * 140ms after the pointer leaves is a way to lose a press, not to offer one,
 * and the press it would be offering restarts every session on this machine.
 * Unfold the row and the same switch is on the row it belongs to.
 *
 * PORTALLED and placed by placeBeside, for the reasons LanPeek gives: the panel
 * clips its own overflow, and a card dropped under this row would cover the
 * rows the pointer is moving through.
 */
function FoldPeek({ anchorId, id, peers, onHold, onLet }: {
  anchorId: string;
  id: string;
  peers: Peer[];
  /** The pointer is here: cancel whatever the row scheduled. */
  onHold: () => void;
  /** The pointer left the card: shut it, on the same grace as the row's. */
  onLet: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { title, shown, rest } = foldPeek(peers);

  const place = useCallback(() => {
    const el = ref.current;
    const anchor = document.getElementById(anchorId);
    if (!el || !anchor) return;
    const p = placeBeside(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    el.dataset.side = p.side;
  }, [anchorId]);
  // Before paint, every render: the panel re-polls every fifteen seconds and a
  // number that grew a digit makes the card wider than it was placed at.
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    // Capture: the panel's own scroll does not bubble to window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [place]);

  return createPortal(
    <div ref={ref} id={id} className="ap-peek ap-fold-peek" role="tooltip"
      onPointerEnter={onHold} onPointerLeave={onLet}>
      <p className="ap-peek-title">{title}</p>
      <div className="ap-peek-list">
        {shown.map(p => (
          <span key={p.key} className="ap-peek-who ap-fold-who">
            <span className="ap-fold-name">{p.name}</span>
            {/* The number is what makes this card a choice rather than a list.
                A name nothing has ever been collected for gets no number and no
                guess — see foldPeek on why it also sorts last. */}
            <span className="ap-fold-state" data-tone={p.ready ? "ok" : p.warn ? "warn" : "idle"}>
              {p.ready ? (p.headroom == null ? "not read yet" : `${p.headroom}% free`) : p.why}
            </span>
          </span>
        ))}
      </div>
      {rest && <p className="ap-peek-rest">{rest}</p>}
    </div>,
    document.body,
  );
}

/**
 * ONE ROW FOR EVERY ACCOUNT THAT IS NOT THE LIVE ONE.
 *
 * Drawn as a destination in Local network's idiom — a glyph, a name, a state
 * and a chevron — but it goes nowhere: the press unfolds the list underneath
 * it, and the chevron turns to say which way. What it is standing in for is a
 * list the reader owns and switches between, so the switch stays in this
 * column rather than behind a view and a way back.
 */
export default function OtherAccounts({ peers, strained, open, onToggle }: {
  peers: Peer[];
  /** The live account is past the threshold auto-switch would act on, so where
   *  to go next is the question being asked rather than a number to hide. */
  strained: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  // NOTHING TO PEEK AT WHILE THE LIST IS OPEN. The card would name, beside the
  // row, the accounts standing directly under it — and it would cover them.
  useEffect(() => { if (open) { window.clearTimeout(peekTimer.current); setPeek(false); } }, [open]);

  const openPeek = (delay: number) => {
    if (open) return;
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(true), delay);
  };
  // NOT AT ONCE — the card opens 4px from the row, and a pointer moving onto it
  // crosses those 4px of nothing. The grace is what makes the gap crossable;
  // see PEEK_GRACE_MS, where the whole of that argument is written.
  const shutPeek = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(false), PEEK_GRACE_MS);
  };
  // The pointer is on the card: whatever was pending, it is not wanted.
  const holdPeek = () => window.clearTimeout(peekTimer.current);
  // The press unfolds the list this card is about. No grace: the card would
  // stand over the rows it had just been naming.
  const dropPeek = () => { window.clearTimeout(peekTimer.current); setPeek(false); };

  // AND THE FREEST NUMBER ONLY WHILE THE LIST IS SHUT. It is there to answer
  // "where do I go" before the reader unfolds anything; once they have, the
  // rows underneath say it per account, and a summary repeating one of them
  // makes a reader check whether the two are counting the same thing.
  const line = restLine(peers, strained && !open);
  return (
    <div className="ap-rest">
      <button type="button" id="ap-rest-entry" className="ap-nav"
        aria-expanded={open}
        aria-controls={open ? "ap-rest-list" : undefined}
        // Described by the card while the card is there, so a screen reader on
        // this row is read the same names a pointer is shown.
        aria-describedby={peek ? "ap-rest-peek" : undefined}
        onClick={() => { dropPeek(); onToggle(); }}
        // A mouse only. Touch has no hover, and a pointerenter synthesised by a
        // tap would open a card the tap is already replacing with the list.
        onPointerEnter={e => { if (e.pointerType === "mouse") openPeek(PEEK_DELAY_MS); }}
        onPointerLeave={shutPeek}
        // A KEYBOARD'S FOCUS, NOT EVERY FOCUS — the rule LanSyncSection's row
        // learned from a card that opened on a programmatic hand-back and then
        // had nothing to close it. `:focus-visible` is the browser's own answer
        // to which of the two happened.
        onFocus={e => { if (e.target.matches(":focus-visible")) openPeek(0); }}
        onBlur={shutPeek}>
        {/* TWO ROWS, STACKED — what is literally behind the door, drawn on the
            14px grid the panel's other glyphs are drawn on. Not a pair of
            people: these are logins, and a crowd at 13px is four strokes of
            mush. */}
        <svg className="ap-nav-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="1.8" y="2.6" width="10.4" height="3.7" rx="1.2" />
          <rect x="1.8" y="7.7" width="10.4" height="3.7" rx="1.2" />
        </svg>
        <span className="ap-nav-text">
          <span className="ap-nav-name">Other accounts</span>
          <span className="ap-nav-state" data-tone={line.tone}>{line.text}</span>
        </span>
        <svg className="ap-nav-chev" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.6 3.4 9.2 7l-3.6 3.6" />
        </svg>
      </button>
      {peek && <FoldPeek anchorId="ap-rest-entry" id="ap-rest-peek" peers={peers}
        onHold={holdPeek} onLet={shutPeek} />}
    </div>
  );
}
