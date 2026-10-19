import { useRef, type RefObject, type PointerEvent } from "react";

export default function RadarSplitter({ workspace, width, onCommit }: { workspace: RefObject<HTMLDivElement>; width: number; onCommit: (width: number) => void }) {
  const drag = useRef<number | null>(null);
  const clamp = (value: number) => Math.max(28, Math.min(65, value));
  const apply = (value: number) => workspace.current?.style.setProperty("--tr-feed-width", `${value}%`);
  const commit = (value: number) => { const next = clamp(value); apply(next); onCommit(next); };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null || !workspace.current) return;
    const box = workspace.current.getBoundingClientRect();
    drag.current = clamp((event.clientX - box.left) / box.width * 100);
    apply(drag.current);
    event.currentTarget.setAttribute("aria-valuenow", String(Math.round(drag.current)));
  };
  const end = () => { if (drag.current === null) return; const next = drag.current; drag.current = null; workspace.current?.removeAttribute("data-resizing"); commit(next); };
  return <div className="tr-splitter" role="separator" aria-label="Activity list width" aria-orientation="vertical" aria-valuemin={28} aria-valuemax={65} aria-valuenow={Math.round(width)} tabIndex={0}
    title="Drag to resize · double-click to reset · arrow keys to adjust"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = width; event.currentTarget.setPointerCapture(event.pointerId); workspace.current?.setAttribute("data-resizing", ""); }}
    onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onDoubleClick={() => commit(34)}
    onKeyDown={event => { const next = event.key === "ArrowLeft" ? width - (event.shiftKey ? 10 : 2) : event.key === "ArrowRight" ? width + (event.shiftKey ? 10 : 2) : event.key === "Home" ? 28 : event.key === "End" ? 65 : event.key === "Enter" ? 34 : null; if (next !== null) { event.preventDefault(); commit(next); } }} />;
}
