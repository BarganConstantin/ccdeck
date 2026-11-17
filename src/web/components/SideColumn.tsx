// Workspace's side column (side-column.ts): the one element Usage and This
// machine are drawn in, its left edge, and the split between the two parts.
//
// Always drawn, around the panels, so a panel never remounts when it docks,
// floats or the view switches: on the Board, and in Workspace with nothing
// docked, the element is `display: contents` (workspace.css) and the panels are
// the fixed panels they always were. In Workspace with a part docked it is a
// grid track of its own, between the pane's cell and the Inspector.
//
// A DRAG WRITES THE ELEMENT, NOT THE STATE. Width and split move the column's
// own style on every pointer move, as the Radar's splitter does, and the
// settled value goes to the column's state once, on release; React leaves a
// style it is not changing alone, so App's own renders in between do not undo
// the drag. The pane's cell is measured as it narrows, so the terminal reflows
// with the edge.
//
// BOTH ARE SEPARATORS a keyboard can move: focused, the arrows move them by
// KEY_STEP, as a window splitter does (WAI-ARIA), with the value they stand at.
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useT } from "../i18n";
import { KEY_STEP, SIDE_W, SPLIT_H, clampWidth, splitFor, type PanelDock } from "../side-column";
import { KitIcon } from "./kit-icons";

/**
 * A part's own buttons, before its close (V4's Figma): docked, the
 * chevron that folds it to its header (pointing right while it is folded) and
 * ⧉ that pops it out; popped out, the one that docks it back. Named buttons,
 * so a keyboard and a screen reader have each by what it does. Nothing on the
 * Board, where a panel floats and has its close alone.
 */
export function DockButtons({ dock, popOut }: { dock?: PanelDock; popOut: () => void }) {
  const t = useT();
  if (!dock || dock.mode === "board") return null;
  if (dock.mode === "float") {
    return (
      <button type="button" className="glyph-btn side-btn" data-act="dock" onClick={dock.dock}
        aria-label={t("shell.side.dock")} title={t("shell.side.dock")}><KitIcon name="arrange" /></button>
    );
  }
  const fold = dock.folded ? t("shell.side.unfold") : t("shell.side.fold");
  return (
    <>
      <button type="button" className="glyph-btn side-btn" data-act="fold" onClick={dock.folded ? dock.unfold : dock.fold}
        aria-label={fold} title={fold}><KitIcon name={dock.folded ? "chevron-right" : "chevron-down"} /></button>
      <button type="button" className="glyph-btn side-btn" data-act="popout" onClick={popOut}
        aria-label={t("shell.side.popOut")} title={t("shell.side.popOut")}><KitIcon name="external" /></button>
    </>
  );
}

export default function SideColumn({ on, split, width, share, onWidth, onShare, children }: {
  /** A part is docked: the column is drawn. */
  on: boolean;
  /** Both parts are open, so the split between them is drawn. */
  split: boolean;
  width: number;
  /** Usage's share of the height the parts have between them. */
  share: number;
  onWidth: (width: number) => void;
  onShare: (share: number) => void;
  /** Usage, then This machine (either may be absent). */
  children: [ReactNode, ReactNode];
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: number; start: number; value: number } | null>(null);

  // ── the edge: the column's width ─────────────────────────────────────────
  const edgeDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, from: event.clientX, start: ref.current.getBoundingClientRect().width, value: width };
    ref.current.setAttribute("data-resizing", "");
  };
  const edgeMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !ref.current) return;
    // The edge is on the left: moving it left widens the column.
    d.value = clampWidth(d.start + (d.from - event.clientX));
    ref.current.style.width = `${d.value}px`;
    event.currentTarget.setAttribute("aria-valuenow", String(d.value));
  };
  // ── the split: Usage's share of the height ───────────────────────────────
  const room = () => (ref.current ? ref.current.clientHeight - SPLIT_H : 0);
  const splitDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // From the split's own top, so the part above follows the pointer from
    // wherever on the split it was pressed.
    const top = event.currentTarget.getBoundingClientRect().top - ref.current.getBoundingClientRect().top;
    drag.current = { id: event.pointerId, from: event.clientY, start: top, value: share };
    ref.current.setAttribute("data-resizing", "");
  };
  const splitMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !ref.current) return;
    d.value = splitFor(d.start + (event.clientY - d.from), room());
    ref.current.style.setProperty("--split", String(d.value));
    event.currentTarget.setAttribute("aria-valuenow", String(Math.round(d.value * 100)));
  };
  const end = (settle: (value: number) => void) => () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    ref.current?.removeAttribute("data-resizing");
    settle(d.value);
  };
  const edgeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowLeft" ? width + KEY_STEP : event.key === "ArrowRight" ? width - KEY_STEP
      : event.key === "Home" ? SIDE_W.min : event.key === "End" ? SIDE_W.max : null;
    if (next === null) return;
    event.preventDefault();
    onWidth(clampWidth(next));
  };
  const splitKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowUp" ? -KEY_STEP : event.key === "ArrowDown" ? KEY_STEP : null;
    if (step === null) return;
    event.preventDefault();
    const r = room();
    onShare(splitFor(share * r + step, r));
  };

  return (
    <div ref={ref} className="ws-side" data-on={on ? "" : undefined} data-split={on && split ? "" : undefined}
      style={{ width: `${width}px`, "--split": String(share) } as CSSProperties}>
      {children[0]}
      {on && split && (
        <div className="ws-split" role="separator" tabIndex={0} aria-orientation="horizontal"
          aria-label={t("shell.side.split")} title={t("shell.side.splitHint")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}
          onPointerDown={splitDown} onPointerMove={splitMove}
          onPointerUp={end(onShare)} onPointerCancel={end(onShare)} onLostPointerCapture={end(onShare)}
          onKeyDown={splitKey} />
      )}
      {children[1]}
      {on && (
        <div className="ws-edge" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t("shell.side.width")} title={t("shell.side.widthHint")}
          aria-valuemin={SIDE_W.min} aria-valuemax={SIDE_W.max} aria-valuenow={width}
          onPointerDown={edgeDown} onPointerMove={edgeMove}
          onPointerUp={end(onWidth)} onPointerCancel={end(onWidth)} onLostPointerCapture={end(onWidth)}
          onKeyDown={edgeKey} />
      )}
    </div>
  );
}
