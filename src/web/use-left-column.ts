// The left column: the session list and the accounts panel, one under the other.
//
// Both are drawn in the left column of the grid, and each door opens and closes
// its own panel only. With both open the list is on top and Accounts under it,
// a 1px line between them, as Usage stands over This machine in the right
// column (styles/left-column.css). The column has one width either way.
//
// It used to be one slot the two took turns at: opening either evicted the
// other, and an eviction was remembered rather than stored as a close (#824).
// The owner asked for both at once (2026-11-23), so nothing is evicted any more
// and there is nothing to remember. A store written while that was the rule
// loads as it stands: a list and an Accounts both stored open are the two
// stacked, which is what the reader had asked for and only one of them got.
//
// Lifted out of App.tsx's `Inner`, where it was spread across three places a
// hundred lines apart. The setters are private, so every open and close goes
// through the functions below, and the rules that keep a flag out of storage —
// a phone's load, a narrowing to a phone, Workspace — sit here, beside the
// writes they hold back.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { readStored, writeStored } from "./storage";
import { prefersReducedMotion } from "./viewport-motion";
import { loadsOnPhone } from "./phone-load";

/** The two panels' own widths, and so the only widths the column can take.
 *  The sheet draws each panel at its own (session-list.css, accounts-panel.css)
 *  and left-column-motion.test.ts holds the two to these. */
export const ACCOUNTS_PANEL_WIDTH = 288;
/** The rail's width at Default and Comfortable. Compact and below draw it 24px
 *  narrower (--rail-w, V4's Figma size variable): useRailWidth reads the token
 *  at the density in force, and this is what it falls back to. */
export const SESSION_LIST_WIDTH = ACCOUNTS_PANEL_WIDTH;

/** The rail's width now, from --rail-w on the root. The accounts panel is drawn
 *  at it too. */
function railWidthPx(): number {
  const read = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-w"));
  return Number.isFinite(read) && read > 0 ? read : SESSION_LIST_WIDTH;
}

/** The session list's width at the density in force, for leftColumnWidth. The
 *  accounts panel keeps its 288; the column eases between the two as it
 *  always has. Re-read when the density changes, on the attribute that
 *  switches the tokens. */
export function useRailWidth(): number {
  const [width, setWidth] = useState(SESSION_LIST_WIDTH);
  useLayoutEffect(() => {
    const read = () => setWidth(railWidthPx());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, []);
  return width;
}

/** One of the two panels the column holds. */
export type LeftPanel = "session-list" | "accounts";

/** The panel at the top of the column, given the two open flags: the list when
 *  it is open, else Accounts, else nothing. With both open, Accounts stands
 *  under the list in the same column, so whether the column is drawn and how
 *  wide it is follow from this alone. */
export function leftColumnPanel(sessionListOpen: boolean, accountsOpen: boolean): LeftPanel | null {
  if (sessionListOpen) return "session-list";
  return accountsOpen ? "accounts" : null;
}

/** THE WIDTH THE COLUMN IS DRAWN AT, decided here and only here: the open
 *  panel's own, or nothing. The column used to be whatever the grid's track
 *  made of the two panels in it: the session list had no width of its own,
 *  the accounts panel's `auto` template outranked its 240px one, and the track
 *  opened to the list's longest row, half the window on a busy deck. The
 *  column is one element now, this is its width, and the sheet eases it from
 *  the last one. With both panels open, one under the other, it is the same
 *  width: the two share it. */
export function leftColumnWidth(panel: LeftPanel | null, railWidth: number = SESSION_LIST_WIDTH, listWidth: number = railWidth): number {
  // The list's own width: the one the reader dragged its edge to, held to the
  // window, else the density's (rail-width.ts, internal #103).
  if (panel === "session-list") return listWidth;
  // Accounts and Sessions share the same persisted width and resize edge.
  if (panel === "accounts") return listWidth;
  return 0;
}

/** How long the column takes to open or to change panels; a close takes
 *  --side-exit. The sheet's --dur-move, which left-column-motion.test.ts
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
/** Shut until the reader opens it: a first run meets the board, not a panel
 *  about a tool it has not set up yet. A profile from before is pinned open at
 *  boot when it never stored this (storage.ts, settlePanelDefaults). */
function loadAccountsPanelOpen(): boolean {
  return readStored(ACCOUNTS_PANEL_OPEN_KEY) === "1";
}

/** Which of the two flags Workspace keeps out of storage for now: the list it
 *  put in the column, or the whole column it emptied. */
export type StoreHeld = "list" | "both";
/** Neither flag held. Replaced whole, never changed in place. */
const NOTHING_HELD: Readonly<{ list: boolean; accounts: boolean }> = { list: false, accounts: false };

export interface LeftColumn {
  sessionListOpen: boolean;
  accountsPanelOpen: boolean;
  /** The panel at the top of the column — leftColumnPanel. */
  panel: LeftPanel | null;
  /** The list opened or closed. Accounts is left as it is. */
  toggleSessionList: () => void;
  /** Accounts opened or closed. The list is left as it is. */
  toggleAccountsPanel: () => void;
  /** The panel opened, or left open if it is — Settings' door to it (#2176). */
  openAccountsPanel: () => void;
  closeSessionList: () => void;
  /** The list closing to show the session just picked, on a phone. */
  closeSessionListToCanvas: () => void;
  closeAccountsPanel: () => void;
  /** Whatever the column holds goes (Workspace under 1100, where the column
   *  would be a sheet over the pane). */
  dismissColumn: () => void;
  /** Accounts waits shut while another sheet keeps a phone's screen: not
   *  stored (use-phone-sheets.ts). */
  holdAccounts: () => void;
  /** WORKSPACE changing the column is not the reader's choice, so it is not
   *  stored: `hold` stops the writes of the flags it names, `release` lets them
   *  go on, with `write` saying whether the column as it stands is the
   *  reader's. */
  storeHold: { hold: (held: StoreHeld) => void; release: (write: boolean, baseline?: { list: boolean; accounts: boolean }) => void };
}

export function useLeftColumn(): LeftColumn {
  const accountsHeldRef = useRef(false);
  /** Workspace has put the list in the column, or taken out what it held:
   *  neither is written, so a reload (or a crash) in Workspace comes back to
   *  the column the reader left, and leaving gives it back. Per flag: putting
   *  the list in holds the list's write alone, and the reader's own Accounts
   *  under it is stored as ever. */
  const workspaceHeldRef = useRef(NOTHING_HELD);
  /** Left sidebar (session list) visibility — persisted across refresh. */
  /** A phone opens on Sessions, full width: the list is the home screen there,
   *  whatever the browser stored for a wider window, which this load leaves as
   *  it was. */
  const phoneOpenedRef = useRef(false);
  const [sessionListOpen, setSessionListOpen] = useState<boolean>(() => {
    const wanted = loadSessionListOpen();
    if (loadsOnPhone()) { phoneOpenedRef.current = !wanted; return true; }
    return wanted;
  });
  useEffect(() => {
    if (phoneOpenedRef.current) { phoneOpenedRef.current = false; return; }
    if (workspaceHeldRef.current.list) return;
    saveSessionListOpen(sessionListOpen);
  }, [sessionListOpen]);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState<boolean>(() => {
    const wanted = loadAccountsPanelOpen();
    // A phone's load opens Sessions alone: Accounts is a sheet over it, from its door.
    if (wanted && loadsOnPhone()) { accountsHeldRef.current = true; return false; }
    // Wider, it opens as it was left, under the list when that is open too.
    return wanted;
  });
  useEffect(() => {
    if (accountsPanelOpen) accountsHeldRef.current = false;
    else if (accountsHeldRef.current) return;
    if (workspaceHeldRef.current.accounts) return;
    writeStored(ACCOUNTS_PANEL_OPEN_KEY, accountsPanelOpen ? "1" : "0");
  }, [accountsPanelOpen]);

  // Each door toggles its own panel and leaves the other as it is: two open
  // are one under the other in the same column (styles/left-column.css), and
  // on a phone Accounts is a sheet over the list, so on no width does one
  // take the other's place.
  const toggleSessionList = useCallback(() => setSessionListOpen(open => !open), []);
  const toggleAccountsPanel = useCallback(() => setAccountsPanelOpen(open => !open), []);

  // Settings › General's door to the panel (#2176): the toggle's opening half
  // alone. A door that shut a panel already open would hide the very thing it
  // names. The list, open or not, stays as it is.
  const openAccountsPanel = useCallback(() => setAccountsPanelOpen(true), []);

  const closeSessionList = useCallback(() => setSessionListOpen(false), []);
  /** On a phone the column is a drawer over the canvas, and the list closes
   *  there to show the session the reader just picked. Accounts is a sheet of
   *  its own there and is left as it is; the stored preference is untouched,
   *  so the next load still opens the list. */
  const closeSessionListToCanvas = closeSessionList;
  const closeAccountsPanel = useCallback(() => setAccountsPanelOpen(false), []);
  const dismissColumn = useCallback(() => {
    setSessionListOpen(false);
    setAccountsPanelOpen(false);
  }, []);

  const panel = leftColumnPanel(sessionListOpen, accountsPanelOpen);

  // What the column is now, for a release that keeps it as the reader left it.
  const nowRef = useRef<{ sessionListOpen: boolean; accountsPanelOpen: boolean } | null>(null);
  nowRef.current = { sessionListOpen, accountsPanelOpen };
  /** A window narrowed to a phone's width with several panels open draws one
   *  sheet, and Accounts, the lowest, waits shut: in memory, by the hold a
   *  phone's load uses, so the flag turns false and is not written. The
   *  reader's own open ends it; widening does not reopen it. */
  const holdAccounts = useCallback(() => {
    accountsHeldRef.current = true;
    setAccountsPanelOpen(false);
  }, []);
  const storeHold = useMemo(() => ({
    hold: (held: StoreHeld) => { workspaceHeldRef.current = { list: true, accounts: held === "both" }; },
    // `baseline` is the column as Workspace itself left it: only a held flag
    // that differs from it is the reader's, and only that one is written. A
    // flag that was not held has been written all along.
    release: (write: boolean, baseline?: { list: boolean; accounts: boolean }) => {
      const held = workspaceHeldRef.current;
      workspaceHeldRef.current = NOTHING_HELD;
      const now = nowRef.current;
      if (!write || !now) return;
      if (held.list && (!baseline || now.sessionListOpen !== baseline.list)) saveSessionListOpen(now.sessionListOpen);
      if (held.accounts && (!baseline || now.accountsPanelOpen !== baseline.accounts)) {
        writeStored(ACCOUNTS_PANEL_OPEN_KEY, now.accountsPanelOpen ? "1" : "0");
      }
    },
  }), []);

  return { sessionListOpen, accountsPanelOpen, panel, toggleSessionList, toggleAccountsPanel, openAccountsPanel,
           closeSessionList, closeSessionListToCanvas, closeAccountsPanel, dismissColumn, holdAccounts, storeHold };
}

/**
 * WORKSPACE's left column. The rail the view is made of is the Sessions list.
 * Entering at 1100px and wider puts the list in the column, through the state L
 * uses, when it is not open already; an open Accounts stays, under it. Entering
 * under 1100, where the column is a fixed sheet over the pane, closes whatever
 * it holds, through the state its doors use; the Sessions sheet then opens only
 * from its door. What the column held is remembered either way, and leaving
 * gives it back if the column is as entering left it. A reader who changed
 * what Workspace changed (closed the list it put there, opened a panel in the
 * column it emptied) is left as they left it, and the memory is forgotten.
 * Nothing is forced at render: the doors work as on the Board.
 */
export function useWorkspaceColumn({ active, wide, column }: {
  /** Workspace is on screen (the Command Panel on, off a phone). */
  active: boolean;
  /** The window is 1100px or wider. */
  wide: boolean;
  column: Pick<LeftColumn, "sessionListOpen" | "accountsPanelOpen" | "toggleSessionList" | "closeSessionList" | "openAccountsPanel" | "dismissColumn"> & { storeHold?: LeftColumn["storeHold"] };
}): void {
  /** What entering did to the column: put the list in it, or took out what it held. */
  const putRef = useRef<null | { kind: "list" } | { kind: "dismissed"; list: boolean; accounts: boolean }>(null);
  /** The column has been seen as entering left it, so a change after is the reader's. */
  const seenRef = useRef(false);
  const wasRef = useRef(false);
  const { sessionListOpen, accountsPanelOpen, toggleSessionList, closeSessionList, openAccountsPanel, dismissColumn, storeHold } = column;
  // A layout effect, so the column Workspace needs is in the same commit as
  // the view that needs it: a switch by key is one frame, not two.
  useLayoutEffect(() => {
    const was = wasRef.current;
    wasRef.current = active;
    if (active && !was) {
      seenRef.current = false;
      if (wide && !sessionListOpen) {
        putRef.current = { kind: "list" };
        storeHold?.hold("list");
        toggleSessionList();
      } else if (!wide && (sessionListOpen || accountsPanelOpen)) {
        putRef.current = { kind: "dismissed", list: sessionListOpen, accounts: accountsPanelOpen };
        storeHold?.hold("both");
        dismissColumn();
      }
      return;
    }
    const put = putRef.current;
    if (!active && was) {
      putRef.current = null;
      // The column goes back to what the reader left, and what is written is
      // what that change makes of it.
      storeHold?.release(false);
      if (put?.kind === "list" && sessionListOpen) closeSessionList();
      // The emptied column gets back what it held: the list, Accounts, or the
      // two, one under the other.
      else if (put?.kind === "dismissed" && !sessionListOpen && !accountsPanelOpen) {
        if (put.list) toggleSessionList();
        if (put.accounts) openAccountsPanel();
      }
      return;
    }
    if (!active || !put) return;
    // The list Workspace put in is the only thing it changed there: Accounts
    // under it is the reader's, and written as ever.
    const asLeft = put.kind === "list" ? sessionListOpen : !sessionListOpen && !accountsPanelOpen;
    if (asLeft) seenRef.current = true;
    else if (seenRef.current) {
      // The reader changed the column inside Workspace: that is their choice
      // and is kept, as the column now stands.
      putRef.current = null;
      storeHold?.release(true, put.kind === "list" ? { list: true, accounts: false } : { list: false, accounts: false });
    }
  }, [active, sessionListOpen, accountsPanelOpen]);
}
