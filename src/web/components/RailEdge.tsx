// The Sessions list's right edge, which drags its width (internal #103,
// rail-width.ts).
//
// It is the list's own last child, out of its flow at its right edge, so it
// slides in and out with the list and goes inert with it when the list leaves.
// The column clips what is outside it, so the edge is the list's last 6 px,
// over the rows: nothing of the board is under it, and a press on it pans no
// canvas, opens no row and selects no text.
//
// A DRAG WRITES THE ELEMENTS, NOT THE STATE, as Workspace's side column does:
// each pointer move sets the column's --left-col-w and --list-w, the
// column's own easing is off while it moves (data-resizing), and the settled
// width goes to App once, on release. React leaves a style it is not changing
// alone, so App's renders in between do not undo the drag. A cancelled drag
// (the browser took the pointer, or Esc) puts both back where they were.
//
// A PRESS TAKES NO FOCUS. Whatever had it keeps it — in Workspace that is the
// terminal, which the reader goes on typing into after the list is wider — and
// no focus ring is drawn beside the line the drag shows. Esc is heard from the
// window while the drag lasts (as a panel's own drag does, panel-place.ts), so
// it reaches neither the terminal nor the deck's own Esc.
//
// IT IS A SEPARATOR A KEYBOARD CAN MOVE (WAI-ARIA window splitter): the arrows
// move it RAIL_KEY_STEP (RAIL_KEY_STEP_BIG with Shift), Home and End to the
// range's ends, and Enter, like a double click, gives the list back its
// density's width.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../i18n";
import { RAIL_KEY_STEP, RAIL_KEY_STEP_BIG, RAIL_W, dragMax, listenForDragEscape } from "../rail-width";

/** How wide the board or the pane beside the list is now, for dragMax. */
function mainWidth(): number {
  if (typeof document === "undefined") return Number.POSITIVE_INFINITY;
  const main = document.querySelector(".ws-cell") ?? document.querySelector(".canvas-wrap");
  return main ? main.getBoundingClientRect().width : Number.POSITIVE_INFINITY;
}

const drawn = (width: number) => `calc(${width}px + var(--ui-panel-increase, 0px))`;

export default function RailEdge({ width, cap, onWidth, onReset }: {
  /** The list's width now, before larger text's increase. */
  width: number;
  /** The most the window lets it be drawn at (railCap). */
  cap: number;
  /** A drag or a key settled on a width. */
  onWidth: (width: number) => void;
  /** Back to the density's width: a double click or Enter. */
  onReset: () => void;
}) {
  const t = useT();
  const drag = useRef<{ id: number; from: number; start: number; max: number; value: number } | null>(null);
  /** Stops listening for the drag's Esc; set while a drag lasts. */
  const stopEscape = useRef<(() => void) | null>(null);
  const max = Math.max(RAIL_W.min, Math.min(cap, RAIL_W.max));
  const unlisten = () => { stopEscape.current?.(); stopEscape.current = null; };
  // A list closed mid-drag takes its edge with it, and the window's Esc too.
  useEffect(() => unlisten, []);

  // Both are the column's (LeftColumn): its own width, and the list's in it.
  const paint = (edge: Element | null, value: number) => {
    const column = edge?.closest(".left-column") as HTMLElement | null;
    column?.style.setProperty("--left-col-w", drawn(value));
    column?.style.setProperty("--list-w", drawn(value));
  };
  const resizing = (edge: Element | null, on: boolean) => {
    const column = edge?.closest(".left-column");
    if (on) column?.setAttribute("data-resizing", ""); else column?.removeAttribute("data-resizing");
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No text selection, no focus moved, no row under it.
    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget;
    edge.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, from: event.clientX, start: width, max: dragMax(width, mainWidth(), max), value: width };
    resizing(edge, true);
    unlisten();
    stopEscape.current = listenForDragEscape(() => {
      const d = drag.current;
      if (!d) return;
      finish(edge, false);
      if (edge.hasPointerCapture?.(d.id)) edge.releasePointerCapture(d.id);
    });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    // The edge is on the right: moving it right widens the list.
    const value = Math.round(Math.max(RAIL_W.min, Math.min(d.max, d.start + (event.clientX - d.from))));
    if (value === d.value) return;
    d.value = value;
    paint(event.currentTarget, value);
    event.currentTarget.setAttribute("aria-valuenow", String(value));
  };
  /** The drag ends: kept (released) or put back (cancelled). */
  const finish = (edge: Element, keep: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    unlisten();
    resizing(edge, false);
    if (keep && d.value !== d.start) { onWidth(d.value); return; }
    // Nothing settled: the elements go back to what React drew.
    paint(edge, d.start);
    edge.setAttribute("aria-valuenow", String(d.start));
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onReset();
      return;
    }
    const step = event.shiftKey ? RAIL_KEY_STEP_BIG : RAIL_KEY_STEP;
    const next = event.key === "ArrowRight" ? width + step : event.key === "ArrowLeft" ? width - step
      : event.key === "Home" ? RAIL_W.min : event.key === "End" ? RAIL_W.max : null;
    if (next === null) return;
    // The arrows are the edge's while it has the focus, not the board's.
    event.preventDefault();
    event.stopPropagation();
    const settled = Math.round(Math.max(RAIL_W.min, Math.min(dragMax(width, mainWidth(), max), next)));
    if (settled !== width) onWidth(settled);
  };

  return (
    <div className="sl-edge" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-controls="session-list"
      aria-label={t("shell.list.width")} title={t("shell.list.widthHint")}
      aria-valuemin={RAIL_W.min} aria-valuemax={max} aria-valuenow={width}
      onPointerDown={down} onPointerMove={move}
      onPointerUp={event => finish(event.currentTarget, true)}
      onPointerCancel={event => finish(event.currentTarget, false)}
      onLostPointerCapture={event => finish(event.currentTarget, true)}
      onDoubleClick={event => { event.preventDefault(); onReset(); }}
      onKeyDown={key} />
  );
}
