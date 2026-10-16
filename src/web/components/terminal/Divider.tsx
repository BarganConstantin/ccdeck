// The edge between the navigator and the stage, which sets how many columns
// the session gets (DESIGN-UI decision 6).
//
// IT MOVES IN COLUMNS. A pointer anywhere along a drag asks stage-geometry for
// the whole-cell width it means, pulled onto 80, 100, 120 or 160 within three
// columns; plates for those detents stand over the edge while it is held, with
// a "cols × rows" readout beside the pointer. The stage follows the drag live,
// but the pane is told only once, after the drag ends and the width has
// rested (use-terminal-session's RESIZE_SETTLE_MS) — a SIGWINCH per frame
// would have the TUI redraw forty times for one gesture.
//
// IT IS A SEPARATOR WITH A VALUE: focusable, ← and → step between detents
// (← widens the stage, the way the edge moves), Home and End run to the ends,
// Enter or a double click go back to the default width, and the value is read
// out as "120 columns".
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { colsAtX, snapCols, stageWidthFor, stepCols, type ColsRange } from "../../stage-geometry";

export interface DividerProps {
  cols: number;
  rows: number;
  range: ColsRange;
  /** The width the navigator and the stage share. */
  appW: number;
  /** The navigator's width now — where the edge is. */
  navW: number;
  cellW: number;
  /** A new column count; `settled` once the gesture is over. */
  onCols(cols: number, settled: boolean): void;
  /** Back to the default width. */
  onReset(): void;
  /** The edge is held (true) or let go (false). */
  onHold(held: boolean): void;
}

/** What each divider key does, or null for a key it leaves alone. */
export function dividerKey(key: string): "wider" | "narrower" | "widest" | "narrowest" | "reset" | null {
  switch (key) {
    case "ArrowLeft": return "wider";
    case "ArrowRight": return "narrower";
    case "Home": return "widest";
    case "End": return "narrowest";
    case "Enter": return "reset";
    default: return null;
  }
}

export default function Divider(p: DividerProps) {
  const [held, setHeld] = useState(false);
  // Read by the handlers, which can fire twice for one release (pointerup,
  // then lostpointercapture) before the state above has re-rendered.
  const holding = useRef(false);
  const bodyLeft = useRef(0);
  const last = useRef(p.cols);

  const drag = (clientX: number) => {
    const next = snapCols(colsAtX(clientX - bodyLeft.current, p.appW, p.cellW), p.range);
    if (next === last.current) return;
    last.current = next;
    p.onCols(next, false);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // The stage's left edge is the navigator's width in from the body's, and
    // the pointer is read against the body — so measure once, at the press.
    const stage = e.currentTarget.parentElement?.getBoundingClientRect();
    bodyLeft.current = (stage?.left ?? 0) - p.navW;
    last.current = p.cols;
    holding.current = true;
    setHeld(true);
    p.onHold(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (holding.current) drag(e.clientX); };
  const letGo = () => {
    if (!holding.current) return;
    holding.current = false;
    setHeld(false);
    p.onHold(false);
    p.onCols(last.current, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = dividerKey(e.key);
    if (!step) return;
    e.preventDefault();
    // Kept from the deck's window listener, which reads Enter on the stage as
    // "type in the pane": one key, one meaning.
    e.stopPropagation();
    if (step === "reset") { p.onReset(); return; }
    const next = stepCols(p.cols, step, p.range);
    if (next !== p.cols) p.onCols(next, true);
  };

  return (
    <>
      <div
        className="ts-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Stage width"
        aria-valuemin={p.range.min}
        aria-valuemax={p.range.max}
        aria-valuenow={p.cols}
        aria-valuetext={`${p.cols} columns`}
        tabIndex={0}
        data-held={held || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={letGo}
        onPointerCancel={letGo}
        onLostPointerCapture={letGo}
        onDoubleClick={p.onReset}
        onKeyDown={onKeyDown}
      >
        <span className="ts-grip" />
      </div>
      {held && (
        <div className="ts-detents" aria-hidden="true">
          {p.range.detents.map(d => (
            <span
              key={d}
              className="ts-detent"
              data-on={d === p.cols || undefined}
              style={{ left: `${p.appW - stageWidthFor(d, p.cellW) - p.navW}px` }}
            >
              <span>{d} col</span>
            </span>
          ))}
          <span className="ts-readout">{p.cols} × {p.rows}</span>
        </div>
      )}
    </>
  );
}
