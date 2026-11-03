import { useEffect, useRef, useState, type ReactNode } from "react";

import type { SharedMark } from "../account-lan";
import { useT } from "../i18n";
import type { LanAccount } from "../lan-types";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import CodexProfilesSection from "./CodexProfilesSection";
import LanSyncSection from "./LanSyncSection";

/** Codex's side of the Accounts panel, or the whole panel on a deck with only
 *  Codex. It is drawn the way Claude's is (the header, the open default account
 *  with its bars, Other accounts behind one row) and ends on the same Local
 *  network row (#2472): that row is about this deck and the decks paired with
 *  it, not about one CLI, so both sides draw it and open the same view. */
export default function CodexAccountsPanel({
  onClose, leaving, switcher, side, onNotice, lanAccounts = [], lanReady = true, lanWanted = false, onLanShown, onLanAccounts,
}: {
  onClose: () => void;
  leaving?: boolean;
  switcher?: ReactNode;
  side?: "shown" | "hidden";
  onNotice?: (needs: boolean) => void;
  /** What Local network offers from this deck: Claude's logins, read by
   *  Claude's side, then Codex's, read here and handed up by onLanAccounts. */
  lanAccounts?: LanAccount[];
  onLanAccounts?: (accounts: LanAccount[]) => void;
  /** Whether that list has been read. Until then Local network waits, as it
   *  does on Claude's side until its roster arrives: the share dialog it opens
   *  would otherwise list nothing. */
  lanReady?: boolean;
  /** Settings › Local network (#2176), answered by whichever side is up. */
  lanWanted?: boolean;
  onLanShown?: () => void;
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  const [view, setView] = useState<"accounts" | "lan">("accounts");
  // Which Codex logins this deck offers, and to whom, for the share mark on
  // their rows — from the status Local network's own section polls, as on
  // Claude's side, so a row and the setup dialog's ticks never disagree.
  const [shared, setShared] = useState<ReadonlyMap<string, SharedMark>>(() => new Map());
  const shown = side !== "hidden";
  // Focus follows the view, as on Claude's side: Back on the way in, the row
  // that opened it on the way out. After the frame, once it has mounted.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    window.requestAnimationFrame(() => {
      document.getElementById(view === "lan" ? "ap-lan-back" : "ap-lan-entry")?.focus();
    });
  }, [view]);
  useEffect(() => {
    if (!lanWanted || !lanReady || !shown) return;
    setView("lan");
    onLanShown?.();
  }, [lanWanted, lanReady, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeBtn = (
    <button type="button" className="glyph-btn" aria-label={t("codex.panel.close")} title={withKey(t("accounts.close"), "A", singleKeys)} onClick={onClose}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
        <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
      </svg>
    </button>
  );
  return (
    <aside className={`accounts-panel codex-accounts-panel${leaving ? " leaving" : ""}`} id="codex-accounts-panel" aria-label={t("codex.panel.title")}
      hidden={side === "hidden"} data-side={side}>
      <CodexProfilesSection onClose={onClose} switcher={switcher} onNotice={onNotice} away={view === "lan"} onLanAccounts={onLanAccounts} shared={shared} />
      {lanReady && (
        <LanSyncSection
          accounts={lanAccounts}
          // Both rosters this list comes from read themselves again on their
          // own polls; a Local network write changes neither.
          onChanged={() => {}}
          onShared={setShared}
          view={view === "lan"}
          onOpen={() => setView("lan")}
          onBack={() => setView("accounts")}
          closeButton={closeBtn}
          active={shown}
        />
      )}
    </aside>
  );
}
