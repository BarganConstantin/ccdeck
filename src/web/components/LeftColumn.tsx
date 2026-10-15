// The left column: one element the session list and the accounts panel are
// drawn in, and the only thing that decides how wide the column is.
//
// The two panels used to be grid items of their own, sharing the first track,
// and a switch had both of them in it for the 200ms the leaving one takes to
// go: the track was whatever the grid made of the pair. The session list had
// no width of its own and the accounts panel's `auto` template outranked its
// 240px one, so the track opened to the list's longest row — 360px on the demo
// deck, half the window on a busy one — and snapped to 240px when the accounts
// panel unmounted.
//
// Here the panels are out of flow inside the column, each at its own width,
// and the column's width is leftColumnWidth's: the open panel's, or nothing.
// The sheet eases it from the last one (styles/left-column.css), so every frame
// of a switch is between the two panels' widths and the canvas beside it rides
// along. A panel that arrives with the column slides in with its edge; one that
// arrives in a column already open fades in where it stands, at its own width,
// over the one leaving.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

export default function LeftColumn({ width, children }: {
  /** The width the column is moving to, from leftColumnWidth. */
  width: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A panel on its way out stays on screen for its exit and is no longer the
  // reader's: it cannot be tabbed into or read while it fades.
  useLayoutEffect(() => {
    for (const panel of Array.from(ref.current?.children ?? [])) {
      (panel as HTMLElement).inert = panel.classList.contains("leaving");
    }
  });
  return (
    <div ref={ref} className={`left-column${width === 0 ? " closing" : ""}`}
      style={{ "--left-col-w": `${width}px` } as CSSProperties}>
      {children}
    </div>
  );
}
