import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clampDetails, DETAILS_WIDTH } from '../tool-audit-layout';

/** The line between the report and the details. Drag it, or focus it and use
 *  the arrow keys; a double click or Enter puts the standard width back.
 *  While dragging, the width goes straight onto the workspace so the list does
 *  not re-render on every pointer move; React hears of it once, on release. */
export default function ToolAuditSplitter({ width, workspace, onCommit }: {
  width: number; workspace: RefObject<HTMLDivElement>; onCommit: (width: number) => void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; room: number; last: number } | null>(null);
  const room = () => workspace.current?.clientWidth ?? window.innerWidth;
  const shown = clampDetails(width, room());
  const apply = (next: number) => {
    workspace.current?.style.setProperty("--ta-details-w", `${next}px`);
    self.current?.setAttribute('aria-valuenow', String(next));
  };
  const commit = (next: number) => { apply(next); onCommit(next); };

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: shown, room: room(), last: shown };
    workspace.current?.setAttribute('data-resizing', '');
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clampDetails(d.width + d.x - event.clientX, d.room);
    apply(d.last);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    workspace.current?.removeAttribute('data-resizing');
    commit(d.last);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === 'ArrowLeft' ? shown + step
      : event.key === 'ArrowRight' ? shown - step
      : event.key === 'Home' ? DETAILS_WIDTH.min
      : event.key === 'End' ? DETAILS_WIDTH.max
      : event.key === 'Enter' ? DETAILS_WIDTH.standard : null;
    if (next === null) return;
    event.preventDefault();
    commit(clampDetails(next, room()));
  };

  return <div ref={self} className="ta-splitter" role="separator" aria-orientation="vertical" aria-label="Details width"
    aria-controls="tool-operation-inspector" aria-valuemin={DETAILS_WIDTH.min} aria-valuemax={clampDetails(DETAILS_WIDTH.max, room())} aria-valuenow={shown}
    tabIndex={0} title="Drag to resize · double-click for the standard width"
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => commit(clampDetails(DETAILS_WIDTH.standard, room()))} onKeyDown={key} />;
}
