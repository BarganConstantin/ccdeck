// The split between Sessions and Accounts in the left column (stack-split.ts).
//
// Drawn only while both are open and neither is leaving, between the two, in
// the column's own flow. It looks like the split between Usage and This
// machine in Workspace's side column: 8 px, a line on each side and a short
// grip in its middle, a row-resize pointer, and the grip darker when it is
// pointed at, held or focused (left-column.css).
//
// A DRAG WRITES THE COLUMN, NOT THE STATE, as the list's own edge does
// (RailEdge.tsx): each pointer move sets the column's --stack-share and marks
// it data-stack-share, so the share rule holds even before anything was kept,
// and the settled share goes to App once, on release. A cancelled drag (Esc,
// or the browser took the pointer) puts the column back as React drew it.
//
// LEAVING: while either panel goes, the split stays where it is and fades with
// it (left-column.css's leaving rule; LeftColumn makes it inert), so the one
// staying takes its room only once the other has gone, as without the split.
//
// A PRESS TAKES NO FOCUS: in Workspace the terminal keeps it. A keyboard
// reaches the split by Tab, where the arrows move it STACK_KEY_STEP
// (STACK_KEY_STEP_BIG with Shift), Home and End take Sessions to its least and
// its most, and Enter, like a double click, gives back the column's own
// layout, with nothing kept.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../i18n";
import { listenForDragEscape } from "../rail-width";
import { ACCOUNTS_MIN, SESSIONS_MIN, STACK_KEY_STEP, STACK_KEY_STEP_BIG, STACK_SPLIT_H, stackShareFor } from "../stack-split";

/** Where the split stands now in its column: its top, and the height the two
 *  parts have between them. */
function measure(split: Element | null): { top: number; room: number } | null {
  const column = split?.closest(".left-column") as HTMLElement | null;
  if (!split || !column) return null;
  return {
    top: split.getBoundingClientRect().top - column.getBoundingClientRect().top,
    room: column.clientHeight - STACK_SPLIT_H,
  };
}

const percent = (share: number) => Math.round(share * 100);

export default function StackSplit({ share, leaving = false, onShare, onReset }: {
  /** Sessions' kept share, or null when the column lays the two out itself. */
  share: number | null;
  /** One of the two panels is on its way out. */
  leaving?: boolean;
  /** A drag or a key settled on a share. */
  onShare: (share: number) => void;
  /** Back to the column's own layout: a double click or Enter. */
  onReset: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; col: HTMLElement; from: number; start: number; room: number; value: number; was: number } | null>(null);
  /** Stops listening for the drag's Esc; set while a drag lasts. */
  const stopEscape = useRef<(() => void) | null>(null);
  const unlisten = () => { stopEscape.current?.(); stopEscape.current = null; };
  /** The share React drew, for a drag that ends after the split has gone. */
  const drawn = useRef(share);
  drawn.current = share;
  // A panel closed mid-drag takes the split with it: the window's Esc goes, and
  // the column is put back as React drew it.
  useEffect(() => () => {
    unlisten();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    holding(d.col, false);
    paint(d.col, drawn.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The value a screen reader hears is where the split stands, kept or not:
  // with nothing kept the column decides, so it is read off the column after
  // each render rather than worked out here.
  useLayoutEffect(() => {
    const at = measure(ref.current);
    if (at && at.room > 0) ref.current?.setAttribute("aria-valuenow", String(percent(at.top / at.room)));
  });

  /** The column drawn with Sessions at `value`, or as React drew it (null). */
  function paint(col: HTMLElement, value: number | null) {
    if (value === null) {
      col.style.removeProperty("--stack-share");
      col.removeAttribute("data-stack-share");
    } else {
      col.style.setProperty("--stack-share", String(value));
      col.setAttribute("data-stack-share", "");
    }
  }
  function holding(col: HTMLElement, on: boolean) {
    if (on) col.setAttribute("data-stack-resizing", ""); else col.removeAttribute("data-stack-resizing");
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = measure(event.currentTarget);
    const col = event.currentTarget.closest(".left-column") as HTMLElement | null;
    if (!at || !col) return;
    // No text selection, no focus moved, nothing under it.
    event.preventDefault();
    event.stopPropagation();
    const split = event.currentTarget;
    split.setPointerCapture(event.pointerId);
    const was = at.room > 0 ? at.top / at.room : 0.5;
    drag.current = { id: event.pointerId, col, from: event.clientY, start: at.top, room: at.room, value: was, was };
    holding(col, true);
    unlisten();
    stopEscape.current = listenForDragEscape(() => {
      const d = drag.current;
      if (!d) return;
      finish(false);
      if (split.hasPointerCapture?.(d.id)) split.releasePointerCapture(d.id);
    });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const value = stackShareFor(d.start + (event.clientY - d.from), d.room);
    if (value === d.value) return;
    d.value = value;
    paint(d.col, value);
    event.currentTarget.setAttribute("aria-valuenow", String(percent(value)));
  };
  /** The drag ends: kept (released) or put back (cancelled). */
  const finish = (keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    unlisten();
    holding(d.col, false);
    if (keep && d.value !== d.was) { onShare(d.value); return; }
    // Nothing settled: the column goes back to what React drew.
    paint(d.col, share);
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onReset();
      return;
    }
    const at = measure(event.currentTarget);
    if (!at) return;
    const step = event.shiftKey ? STACK_KEY_STEP_BIG : STACK_KEY_STEP;
    const top = event.key === "ArrowUp" ? at.top - step : event.key === "ArrowDown" ? at.top + step
      : event.key === "Home" ? SESSIONS_MIN : event.key === "End" ? at.room - ACCOUNTS_MIN : null;
    if (top === null) return;
    // The arrows are the split's while it has the focus, not the board's.
    event.preventDefault();
    event.stopPropagation();
    onShare(stackShareFor(top, at.room));
  };

  return (
    <div ref={ref} className={`stack-split${leaving ? " leaving" : ""}`} role="separator" tabIndex={0} aria-orientation="horizontal"
      aria-controls="session-list"
      aria-label={t("shell.list.stack")} title={t("shell.list.stackHint")}
      aria-valuemin={0} aria-valuemax={100}
      onPointerDown={down} onPointerMove={move}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={event => { event.preventDefault(); onReset(); }}
      onKeyDown={key} />
  );
}
