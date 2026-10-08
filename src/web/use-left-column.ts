// The left column: one slot, and two panels that want it.
//
// The session list and the accounts panel share the left column of the grid, and
// opening either evicts the other rather than stacking both in the same slot.
// An eviction is not the reader closing the panel (#824): it is remembered, never
// written to storage as a close, and undone when the list gives the column back.
//
// Lifted out of App.tsx's `Inner`, where it was spread across three places a
// hundred lines apart — the list's state near the top, the panel's state and its
// eviction further down, and the two toggles further still.
//
// What the move buys is an invariant. The setters are private, so the only ways
// to OPEN either panel are the two toggles, which are the only code that knows
// about the other one. Before, any line in `Inner` could call
// `setAccountsPanelOpen(true)` with the list open and draw both panels into one
// slot. Closing is still free — `closeSessionList` / `closeAccountsPanel` — and
// closing the list by any route still gives the panel its column back, because
// that is an effect on the list's state rather than a step each caller must
// remember.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { readStored, writeStored } from "./storage";
import { prefersReducedMotion } from "./viewport-motion";

/** The two panels' own widths, and so the only widths the column can take.
 *  The sheet draws each panel at its own (session-list.css, accounts-panel.css)
 *  and left-column-motion.test.ts holds the two to these. */
export const SESSION_LIST_WIDTH = 240;
export const ACCOUNTS_PANEL_WIDTH = 288;

/** Which of the two the column is for. */
export type LeftPanel = "session-list" | "accounts";

/** The panel the column is for, given the two open flags and whether the
 *  accounts panel is waiting behind the list (#824). The list wins: opening it
 *  evicts the panel. A panel waiting behind a list that has just closed is the
 *  column's already — it is reopened by an effect one render later, and a
 *  column that took that render to be empty would start to close. */
export function leftColumnPanel(sessionListOpen: boolean, accountsOpen: boolean, accountsWaiting: boolean): LeftPanel | null {
  if (sessionListOpen) return "session-list";
  return accountsOpen || accountsWaiting ? "accounts" : null;
}

/** THE WIDTH THE COLUMN IS DRAWN AT, decided here and only here: the open
 *  panel's own, or nothing. During a switch both panels are in the column —
 *  the one arriving and the one leaving — and the column used to be whatever
 *  the grid's track made of the two: the session list had no width of its
 *  own, the accounts panel's `auto` template outranked its 240px one, and the
 *  track opened to the list's longest row, half the window on a busy deck,
 *  until the leaving panel unmounted 200ms later and it snapped to 240. The
 *  column is one element now, this is its width, and the sheet eases it from
 *  the last one: every frame of a switch is between the two panels' widths. */
export function leftColumnWidth(panel: LeftPanel | null): number {
  if (panel === "session-list") return SESSION_LIST_WIDTH;
  if (panel === "accounts") return ACCOUNTS_PANEL_WIDTH;
  return 0;
}

/** How long the column takes to open or to change panels; a close takes
 *  --side-exit. The sheet's --column-move, which left-column-motion.test.ts
 *  holds to this. */
export const COLUMN_MOVE_MS = 240;
/** A frame past the move, so the reading taken at the end is the last one. */
const SETTLE_SLACK_MS = 20;

/** When the column's current move ends, in `performance.now()` time: set the
 *  moment its width changes, before the frame that starts the move is laid
 *  out, and read by use-canvas-size.ts, which holds the canvas's reading until
 *  then. Under reduced motion the column does not move, and nothing is held. */
export function useColumnSettle(width: number): MutableRefObject<number> {
  const settleRef = useRef(0);
  const lastWidth = useRef(width);
  useLayoutEffect(() => {
    if (lastWidth.current === width) return;
    lastWidth.current = width;
    settleRef.current = prefersReducedMotion() ? 0 : performance.now() + COLUMN_MOVE_MS + SETTLE_SLACK_MS;
  }, [width]);
  return settleRef;
}

const SESSION_LIST_OPEN_KEY = "agent-dag.sessionListOpen";
const ACCOUNTS_PANEL_OPEN_KEY = "agent-dag.accountsPanelOpen";

function loadSessionListOpen(): boolean {
  return readStored(SESSION_LIST_OPEN_KEY) === "1";
}
function saveSessionListOpen(open: boolean): void {
  writeStored(SESSION_LIST_OPEN_KEY, open ? "1" : "0");
}
/** Open unless the reader closed it: a first run gets the panel. */
function loadAccountsPanelOpen(): boolean {
  const stored = readStored(ACCOUNTS_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}

export interface LeftColumn {
  sessionListOpen: boolean;
  accountsPanelOpen: boolean;
  /** Which panel the column is for — leftColumnPanel. */
  panel: LeftPanel | null;
  /** Opening the list takes the column; an open accounts panel is evicted. */
  toggleSessionList: () => void;
  /** The reader's own call on the panel, which also ends any eviction. */
  toggleAccountsPanel: () => void;
  closeSessionList: () => void;
  closeAccountsPanel: () => void;
}

export function useLeftColumn(): LeftColumn {
  /** Left sidebar (session list) visibility — persisted across refresh. */
  const [sessionListOpen, setSessionListOpen] = useState<boolean>(loadSessionListOpen);
  useEffect(() => { saveSessionListOpen(sessionListOpen); }, [sessionListOpen]);
  /** True while the session list holds the left column the accounts panel was
   *  open in (#824). Opening the list used to close the panel for good: the
   *  close was persisted as "0", so the panel stayed gone across reloads, and a
   *  reader lost a panel they never closed. An eviction is not that choice — it
   *  is remembered here, never written as one, and undone when the list goes. */
  const accountsEvictedRef = useRef(false);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState<boolean>(() => {
    const wanted = loadAccountsPanelOpen();
    // The list holds the column on this load, so the panel waits behind it.
    if (wanted && sessionListOpen) { accountsEvictedRef.current = true; return false; }
    return wanted;
  });
  useEffect(() => {
    // An eviction is not the reader closing the panel, so it is not stored as one.
    if (!accountsPanelOpen && accountsEvictedRef.current) return;
    writeStored(ACCOUNTS_PANEL_OPEN_KEY, accountsPanelOpen ? "1" : "0");
  }, [accountsPanelOpen]);
  // The list gave the column back, by any of its ways out: so does the panel it
  // took the column from (#824).
  useEffect(() => {
    if (!sessionListOpen && accountsEvictedRef.current) {
      accountsEvictedRef.current = false;
      setAccountsPanelOpen(true);
    }
  }, [sessionListOpen]);

  // One left column, two things that want it. Opening either evicts the other
  // rather than fighting over the same grid slot.
  //
  // Still two, and still both callers' problem, even though only one of them
  // has a button left: the session list is reached from L alone now, and the
  // eviction is what stops that key from stacking it under an open accounts
  // panel in the same slot.
  const toggleSessionList = useCallback(() => {
    setSessionListOpen(open => {
      // Opening the list takes the column. If the panel was in it, that is an
      // eviction to undo when the list closes (#824), not the panel closing.
      if (!open) setAccountsPanelOpen(was => { if (was) accountsEvictedRef.current = true; return false; });
      return !open;
    });
  }, []);
  const toggleAccountsPanel = useCallback(() => {
    // The reader's own call on the panel ends any eviction.
    accountsEvictedRef.current = false;
    setAccountsPanelOpen(open => {
      if (!open) setSessionListOpen(false);
      return !open;
    });
  }, []);

  const closeSessionList = useCallback(() => setSessionListOpen(false), []);
  const closeAccountsPanel = useCallback(() => setAccountsPanelOpen(false), []);

  const panel = leftColumnPanel(sessionListOpen, accountsPanelOpen, accountsEvictedRef.current);

  return { sessionListOpen, accountsPanelOpen, panel, toggleSessionList, toggleAccountsPanel,
           closeSessionList, closeAccountsPanel };
}
