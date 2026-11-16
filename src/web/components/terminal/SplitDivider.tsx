// The line between two panes of a split Workspace (internal #102,
// workspace-split.ts, StageShell.tsx): dragged, double-clicked back to halves,
// or moved by the arrow keys. A window splitter, so its own tab stop, as the
// stage's Divider and the side columns' edges are.
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { ratioAt, type Divider } from "../../workspace-split";

export interface SplitDividerProps {
  d: Divider;
  label: string;
  /** The Workspace's box, which the pointer is measured against. */
  inRef: MutableRefObject<HTMLDivElement | null>;
  onRatio(path: string, ratio: number): void;
}

export default function SplitDivider({ d, label, inRef, onRatio }: SplitDividerProps) {
  const frame = useRef(0);
  const at = (e: { clientX: number; clientY: number }) => {
    const box = inRef.current?.getBoundingClientRect();
    if (!box) return null;
    return d.dir === "row" ? e.clientX - box.left : e.clientY - box.top;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.setAttribute("data-moving", "");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
    const pos = at(e);
    if (pos == null) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => onRatio(d.path, ratioAt(d, pos)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    e.currentTarget.removeAttribute("data-moving");
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const back = d.dir === "row" ? "ArrowLeft" : "ArrowUp";
    const on = d.dir === "row" ? "ArrowRight" : "ArrowDown";
    let ratio: number | null = null;
    if (e.key === back || e.key === on) ratio = d.ratio + (e.key === on ? 0.05 : -0.05);
    else if (e.key === "Home") ratio = 0;
    else if (e.key === "End") ratio = 1;
    else if (e.key === "Enter") ratio = 0.5;
    if (ratio == null) return;
    e.preventDefault();
    e.stopPropagation();
    onRatio(d.path, ratioAt(d, d.start + ratio * d.length));
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const r = d.rect;
  return (
    <div
      role="separator"
      tabIndex={0}
      className="wsp-divider"
      data-dir={d.dir}
      aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(d.ratio * 100)}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onRatio(d.path, ratioAt(d, d.start + d.length / 2))}
      onKeyDown={onKeyDown}
    />
  );
}
