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
// Both panels share one persisted width and one resize edge, and with both open
// they stand one under the other in it, Sessions on top (left-column.css), so
// opening the second moves neither the board nor the terminal beside the
// column. Larger text still widens the shared column by --ui-panel-increase.
// The split between the two shares the height (StackSplit.tsx): the reader's
// share, when one is kept, is the column's --stack-share.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

export default function LeftColumn({ width, listWidth, stackShare = null, children, edge }: {
  /** The width the column is moving to, from leftColumnWidth. */
  width: number;
  /** The Sessions list's own width, the reader's (rail-width.ts, internal
   * #103), as --list-w for the list in it; none on a phone, where the list is
   * the screen's width. The column holds it even while Accounts is open, so a
   * list arriving is at its own width from its first frame. */
  listWidth?: number;
  /** Sessions' share of the height it has with Accounts, the reader's
   * (stack-split.ts), or null for the column's own layout. It counts only
   * while the split is drawn (left-column.css). */
  stackShare?: number | null;
  children: ReactNode;
  edge?: ReactNode;
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
      data-stack-share={stackShare === null ? undefined : ""}
      style={{
        "--left-col-w": width === 0 ? "0px" : `calc(${width}px + var(--ui-panel-increase, 0px))`,
        ...(listWidth === undefined ? null : { "--list-w": `calc(${listWidth}px + var(--ui-panel-increase, 0px))` }),
        ...(stackShare === null ? null : { "--stack-share": String(stackShare) }),
      } as CSSProperties}>
      {children}
      {edge}
    </div>
  );
}
