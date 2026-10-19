// The list and the detail of an integration panel (#2178), side by side with a
// line between them the reader can drag — Tool activity's splitter, an ARIA
// window splitter: arrows move it, Home and End go to the ends, Enter or a
// double click puts the standard width back — and under 900px one screen at a
// time, the detail drilled into with a Back that returns to the row.
//
// The core's, not a provider's: every tracker panel is a list of things and
// the one thing chosen, and each gets the same split and the same memory of
// its width (integration-layout.ts).
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { clampDetail, DETAIL_WIDTH, DRILL_IN_QUERY, readDetailWidth, writeDetailWidth } from "../integrations/layout";
import { useMediaQuery } from "../use-media-query";

function Splitter({ width, workspace, controls, onCommit }: {
  width: number; workspace: RefObject<HTMLDivElement>; controls: string; onCommit: (width: number) => void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; room: number; last: number } | null>(null);
  const room = () => workspace.current?.clientWidth ?? window.innerWidth;
  const shown = clampDetail(width, room());
  const apply = (next: number) => {
    workspace.current?.style.setProperty("--ig-detail-w", `${next}px`);
    self.current?.setAttribute("aria-valuenow", String(next));
  };
  const commit = (next: number) => { apply(next); onCommit(next); };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: shown, room: room(), last: shown };
    workspace.current?.setAttribute("data-resizing", "");
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampDetail(d.width + d.x - event.clientX, d.room);
    apply(d.last);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    workspace.current?.removeAttribute("data-resizing");
    commit(d.last);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowLeft" ? shown + step
      : event.key === "ArrowRight" ? shown - step
      : event.key === "Home" ? DETAIL_WIDTH.min
      : event.key === "End" ? DETAIL_WIDTH.max
      : event.key === "Enter" ? DETAIL_WIDTH.standard : null;
    if (next === null) return;
    event.preventDefault();
    commit(clampDetail(next, room()));
  };
  return <div ref={self} className="ig-splitter" role="separator" aria-orientation="vertical" aria-label="Detail width"
    aria-controls={controls} aria-valuemin={DETAIL_WIDTH.min} aria-valuemax={clampDetail(DETAIL_WIDTH.max, room())} aria-valuenow={shown}
    tabIndex={0} title="Drag to resize · double-click for the standard width"
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => commit(clampDetail(DETAIL_WIDTH.standard, room()))} onKeyDown={key} />;
}

export interface IntegrationSplitProps {
  list: ReactNode;
  /** The chosen thing, or null for none (the list takes the whole width). */
  detail: ReactNode | null;
  /** Back, on the drill-in screen. */
  onBack: () => void;
  /** What Back says it returns to: "Back to the board". */
  backLabel: string;
  /** Whose detail width this is, remembered per browser: "jira". */
  storageKey: string;
}

/** Whether the detail is a screen of its own rather than a column. */
export function useDrillIn(): boolean {
  return useMediaQuery(DRILL_IN_QUERY);
}

export default function IntegrationSplit({ list, detail, onBack, backLabel, storageKey }: IntegrationSplitProps) {
  const drillIn = useDrillIn();
  const detailId = `${useId()}-detail`;
  const workspace = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readDetailWidth(storageKey));
  const commit = (next: number) => { setWidth(next); writeDetailWidth(storageKey, next); };
  const open = detail != null;
  return (
    <div ref={workspace} className="ig-split" data-detail={open || undefined} data-drill-in={drillIn || undefined}
      style={{ "--ig-detail-w": `${width}px` } as CSSProperties}>
      {/* The list stays mounted on the drill-in screen, only hidden, so its
          scroll and its open groups are where the reader left them. */}
      <div className="ig-list" hidden={(drillIn && open) || undefined}>{list}</div>
      {open && !drillIn && <Splitter width={width} workspace={workspace} controls={detailId} onCommit={commit} />}
      {open && (
        <section className="ig-detail" id={detailId} aria-label="Details">
          {drillIn && (
            <button type="button" className="ig-back" data-ig-back onClick={onBack}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8.6 3 4.6 7l4 4" /></svg>
              {backLabel}
            </button>
          )}
          {detail}
        </section>
      )}
    </div>
  );
}
