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
import { useCallback, useEffect, useRef, useState } from "react";
import { readStored, writeStored } from "./storage";

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

  return { sessionListOpen, accountsPanelOpen, toggleSessionList, toggleAccountsPanel,
           closeSessionList, closeAccountsPanel };
}
