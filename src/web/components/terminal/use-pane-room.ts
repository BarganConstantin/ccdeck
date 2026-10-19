// Room on the stage for a pane that keeps its own size.
//
// A pane in the user's own tmux keeps the size of the user's terminal (case
// B: the deck joins it ignore-size, so their terminal is never resized under
// them). On a stage narrower than that pane the right of every line was cut
// off under the rail. Where the window has the room, the stage makes it, for
// as long as that session is on stage, and gives the width back after —
// unless the divider was moved meanwhile, which is the reader's say. Where it
// has not, the pane scrolls sideways instead (terminal-stage.css).
import { useEffect, useRef } from "react";
import type { StageGeometry } from "../../stage-geometry";

/** The columns the stage should take for a pane `paneCols` wide, or null
 *  when it already fits or cannot be made to. */
export function roomFor(paneCols: number, g: Pick<StageGeometry, "cols" | "range" | "takeover">, expanded: boolean): number | null {
  if (!paneCols || g.takeover || expanded) return null;
  if (paneCols <= g.cols || paneCols > g.range.max) return null;
  return paneCols;
}

/**
 * Makes room for a pane `paneCols` wide (0: a pane the stage sizes itself)
 * while the session `key` is on stage. `onCols` is the divider's own setter,
 * called unsettled, so nothing is stored.
 */
export function usePaneRoom(
  key: string,
  paneCols: number,
  geometry: Pick<StageGeometry, "cols" | "range" | "takeover">,
  expanded: boolean,
  onCols: (cols: number, settled: boolean) => void,
): void {
  const onColsRef = useRef(onCols);
  onColsRef.current = onCols;
  const colsNow = useRef(geometry.cols);
  colsNow.current = geometry.cols;
  const made = useRef<{ before: number; made: number } | null>(null);
  /** The divider moved off the room made: the width is the reader's now,
   *  for as long as this session stays on stage. */
  const declined = useRef(false);
  const want = roomFor(paneCols, geometry, expanded);
  useEffect(() => {
    if (made.current && geometry.cols !== made.current.made) declined.current = true;
  }, [geometry.cols]);
  useEffect(() => {
    if (want == null || declined.current) return;
    made.current = { before: made.current?.before ?? colsNow.current, made: want };
    onColsRef.current(want, false);
  }, [want]);
  useEffect(() => () => {
    const m = made.current;
    made.current = null;
    declined.current = false;
    if (m && colsNow.current === m.made) onColsRef.current(m.before, false);
  }, [key]);
}
