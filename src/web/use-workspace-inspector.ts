// THE INSPECTOR STARTS CLOSED IN WORKSPACE (V4 top-10 #7). Workspace is the
// view where the pane is the point, and a 320 Inspector beside it left the
// terminal under 40% of a 1440 window. So entering Workspace closes it, at
// every width: the column folds (1320 and wider), the sheet stays folded as
// it always started (1100 to 1319), and the detail sheet under 1100 is shut.
// Its door on the right stripe, D, and every way a session is inspected open
// it again, and then it stays open for the rest of that visit.
//
// Each visit starts closed. The reader's open is not carried to the next
// entry, so the rule is one sentence: Workspace opens on the pane. Leaving
// gives the Board the Inspector it had on entry, open or closed, whatever was
// done to it inside.
//
// Nothing here is stored. The Board's flag is held shut in memory (the same
// hold the sheet width uses, use-right-panels.ts), so a reload in Workspace
// still finds the Board's choice, and leaving puts it back. As the left
// column's hook does (use-left-column.ts useWorkspaceColumn), it acts in a
// layout effect, so the view and its Inspector are one commit: a switch by
// key is one frame.
//
// Except the hold on a load that lands in Workspace. use-right-panels.ts's
// save effect has a first run too, with the flag the page loaded with: open,
// it ends any hold and writes "open", and the held close that follows is then
// written as the reader's. Held in that load's layout effect, the Board's
// stored choice became closed on every reload in Workspace. So on a load the
// hold waits for this hook's own passive effect, which runs after that first
// save (App calls useRightPanels first). The column is still folded in the
// layout effect, so nothing is drawn open.
import { useEffect, useLayoutEffect, useRef } from "react";

export function useWorkspaceInspector({ active, detailOpen, fold, hold, restore }: {
  /** Workspace is on screen (the Command Panel on, off a phone). */
  active: boolean;
  /** The Board's Inspector flag: open or not, whether or not a session is
   *  selected for it to show. */
  detailOpen: boolean;
  /** Folds Workspace's column (App's inspectorFolded). */
  fold: () => void;
  /** Shuts the flag for now without storing the close (use-right-panels.ts). */
  hold: () => void;
  /** Sets the Board's flag back to `open`, as the reader's own. */
  restore: (open: boolean) => void;
}): void {
  /** What the Board had when Workspace was entered; null outside Workspace. */
  const boardRef = useRef<boolean | null>(null);
  const wasRef = useRef(false);
  const loadRef = useRef(true);
  /** A hold the load's layout effect left for the passive one. */
  const heldOnLoadRef = useRef(false);
  useLayoutEffect(() => {
    const was = wasRef.current;
    const load = loadRef.current;
    wasRef.current = active;
    loadRef.current = false;
    if (active && !was) {
      boardRef.current = detailOpen;
      fold();
      if (detailOpen) {
        if (load) heldOnLoadRef.current = true;
        else hold();
      }
    } else if (!active && was) {
      const board = boardRef.current;
      boardRef.current = null;
      if (board !== null) restore(board);
    }
    // Only the view's change acts: what the reader does inside is theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => {
    if (!heldOnLoadRef.current) return;
    heldOnLoadRef.current = false;
    hold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
