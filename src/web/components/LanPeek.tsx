// Who is on the network now, in a card beside the way-in row.
//
// Lifted out of LanSyncSection.tsx unchanged, with the one constant only it
// reads. The row decides when the card is showing — its delay, its grace, and
// the one timer that runs both — and hands this the rows it draws from; what
// the card says, and where on the screen it goes, is this file's.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DeckRow } from "../lan-roster";
import { placeBeside } from "../popover-place";

/** How many names the peek prints before it counts the rest. Six rows is the
 *  most a card can show and still be read in the moment a hover lasts. */
export const PEEK_NAMES = 6;

/**
 * WHO IS ON, BESIDE THE ROW, WITHOUT PRESSING ANYTHING.
 *
 * `1 of 8 online` answers how many and refuses to say which — and which is the
 * question somebody has when they are about to send a login to a colleague's
 * machine. Pressing the row answers it and costs a view change, a read and a
 * way back, for a list that is usually two names long.
 *
 * THE POINTER MAY REST ON IT, AND IT HOLDS NO FOCUS. It began refusing the
 * pointer outright, and that was one rule too many: a list of names appears, and
 * what a reader does next is move onto it — to read the fourth name, to follow
 * one with the eye — and the card went out from under them. So the pointer is
 * allowed on it, the card holds itself open while it is there, and leaving it
 * shuts it after the same grace that lets the pointer cross the gap.
 *
 * What stays refused is everything else: no control inside it, nothing to tab
 * to, no focus taken. Every name in it is a press away in the view itself, so
 * the card can never be the only route to anything.
 *
 * PORTALLED for the reason AnchoredPopover is — `.accounts-panel` clips its own
 * overflow and this row is at the foot of it — and placed by placeBeside, which
 * is where the rule about which side it opens on is written and checked.
 */
export default function LanPeek({ anchorId, id, rows, onHold, onLet }: {
  anchorId: string;
  id: string;
  rows: DeckRow[];
  /** The pointer is here: cancel whatever the row scheduled. */
  onHold: () => void;
  /** The pointer left the card: shut it, on the same grace as the row's. */
  onLet: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const paired = rows.filter(r => r.kind === "paired");
  const here = paired.filter(r => r.here);
  const shown = here.slice(0, PEEK_NAMES);
  const off = paired.length - here.length;
  // One tail line, and the count that is missing from the names above it: the
  // ones too many to print if there are any, the ones not on if there are not.
  const rest = here.length > shown.length
    ? `and ${here.length - shown.length} more`
    : off > 0
      ? `${off} not on right now`
      : null;

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
  // Before paint, every render: the roster re-polls every five seconds and a
  // name arriving makes the card taller than the window's margin allows.
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
    <div ref={ref} id={id} className="ap-peek" role="tooltip" onPointerEnter={onHold} onPointerLeave={onLet}>
      <p className="ap-peek-title">{here.length ? "On the network now" : "Nobody on the network"}</p>
      {shown.length > 0 && (
        <div className="ap-peek-list">
          {shown.map(r => (
            <span key={`${r.kind}:${r.fp}`} className="ap-peek-who">
              <i className="ap-nav-live" aria-hidden />
              <span title={r.via === "tailscale" ? `${r.name} · Tailscale` : r.name}>{r.name}{r.via === "tailscale" && <span className="ap-lan-via"> · Tailscale</span>}</span>
            </span>
          ))}
        </div>
      )}
      {rest && <p className="ap-peek-rest">{rest}</p>}
    </div>,
    document.body,
  );
}
