// Which side of the Accounts panel is up, on a deck with both CLIs.
//
// Both sides stay mounted while the panel is open, so a switch is instant and
// the side out of sight can still say its account needs attention. The second
// one is mounted a beat after the panel opens: the column chooses a slide or a
// fade by whether a panel arrives alone (`:only-child`, left-column.css), and a
// hidden sibling would turn the slide into a fade.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type AccountSide } from "./components/AccountsSwitch";
import { readStored, writeStored } from "./storage";

const STORED = "agent-dag.accountPanelProvider";
/** Longer than the column's slide, shorter than a reader's first look around. */
const SECOND_SIDE_AFTER_MS = 400;

const NONE: Record<AccountSide, boolean> = { claude: false, codex: false };

export function useAccountSide(providers: { claude: boolean; codex?: boolean }, panelOpen: boolean) {
  const [chosen, setChosen] = useState<AccountSide>(() => readStored(STORED) === "codex" ? "codex" : "claude");
  const both = providers.claude && Boolean(providers.codex);
  const shown: AccountSide = both ? chosen : providers.codex ? "codex" : "claude";

  const [bothMounted, setBothMounted] = useState(false);
  useEffect(() => {
    if (!both || !panelOpen) { setBothMounted(false); return; }
    const timer = setTimeout(() => setBothMounted(true), SECOND_SIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [both, panelOpen]);

  /** Remembered for the next visit. The switch and the doors that name a side
   *  all come through here. */
  const remember = useCallback((side: AccountSide) => {
    setChosen(side);
    writeStored(STORED, side);
  }, []);

  // The press came from the switch in the header going out of sight, so focus
  // goes to the same switch in the header coming up. The arrows then walk on
  // from there, as they do in any radio group.
  const carryFocus = useRef(false);
  const pick = useCallback((side: AccountSide) => {
    if (side === shown) return;
    carryFocus.current = true;
    setBothMounted(true);
    remember(side);
  }, [remember, shown]);
  useLayoutEffect(() => {
    if (!carryFocus.current) return;
    carryFocus.current = false;
    document.querySelector<HTMLElement>(`#${panelId(shown)} [role="radio"][aria-checked="true"]`)?.focus();
  }, [shown]);

  // Kept while the panel is shut: each side says again once it has read, so a
  // reopened panel's dot does not blink out and back while the side loads.
  const [notices, setNotices] = useState(NONE);
  const noteClaude = useCallback((needs: boolean) => setNotices(now => ({ ...now, claude: needs })), []);
  const noteCodex = useCallback((needs: boolean) => setNotices(now => ({ ...now, codex: needs })), []);

  return { both, shown, bothMounted, remember, pick, notices, noteClaude, noteCodex };
}

export function panelId(side: AccountSide): string {
  return side === "codex" ? "codex-accounts-panel" : "accounts-panel";
}
