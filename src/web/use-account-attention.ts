// The re-sign-in prompt over the canvas (#1893): which accounts it names, the
// sign-in it opens, and the "Not now" it remembers.
//
// Held up here, beside the LAN pairing request, for that request's reason: the
// accounts panel is a place somebody GOES, and a login that has stopped working
// is something somebody has to be TOLD. So the prompt cannot wait for the panel
// to be opened — and it does not get a poll of its own either. It reads the
// roster once when the deck opens, which is what carries an incident across a
// restart, and from then on it sees every roster the panel's own poll reads.
// What Local network can repair comes from the /api/lan poll the pairing
// request already runs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Account, type AccountsData } from "./claude-accounts";
import type { LanStatus } from "./lan-types";
import { attentionRows, settledBy, type AttentionRow } from "./reauth-attention";

export interface AccountAttention {
  /** The accounts to ask about now. Empty is no prompt. */
  rows: AttentionRow[];
  /** The account whose sign-in is open, which the prompt steps aside for. */
  signingIn: AttentionRow | null;
  /** A roster arrived — from the panel's poll, or this hook's own read. */
  observe: (fresh: AccountsData) => void;
  signIn: (row: AttentionRow) => void;
  /** The sign-in dialog finished and claude-swap recorded this account. */
  signedIn: (account: { num: string | null; email: string; added: boolean }) => void;
  /** The sign-in dialog changed something: read the roster again. */
  refresh: () => void;
  /** The sign-in dialog closed, however it ended. */
  closeSignIn: () => void;
  /** "Not now", Escape, the backdrop and the ×: put off every incident shown. */
  later: () => void;
}

export function useAccountAttention(
  { enabled, lanStatus, now }: { enabled: boolean; lanStatus: LanStatus | null | undefined; now: number },
): AccountAttention {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  /** Incidents this page has settled ahead of the read that will say so: put
   *  off here, or signed in again from the prompt. See attentionRows. */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [signingIn, setSigningIn] = useState<AttentionRow | null>(null);

  // Only a roster that was read. `no_accounts` is also what the server answers
  // for the moment claude-swap spends rewriting its store, and a prompt that
  // vanished and came back across that would be a prompt nobody can press.
  const observe = useCallback((fresh: AccountsData) => {
    if (fresh?.ok && Array.isArray(fresh.accounts)) setAccounts(fresh.accounts);
  }, []);

  const read = useCallback(async (force: boolean) => {
    try {
      const res = await fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`);
      if (res.ok) observe(await res.json());
    } catch { /* the deck is down; the panel's poll or the next start reads it */ }
  }, [observe]);

  // ONCE, when the deck opens on a Claude machine — never on a timer. An
  // unforced read, so it is the cached roster when the panel has just read one.
  useEffect(() => { if (enabled) void read(false); }, [enabled, read]);

  const rows = useMemo(
    () => (enabled ? attentionRows(accounts, { lan: lanStatus, now, closed }) : []),
    [enabled, accounts, lanStatus, now, closed],
  );
  // The rows as last drawn, for the two callbacks below to act on without
  // being rebuilt on every tick of the board's clock.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const close = useCallback((ids: readonly string[]) => {
    if (ids.length) setClosed(prev => new Set([...prev, ...ids]));
  }, []);

  const later = useCallback(() => {
    const shown = rowsRef.current;
    if (!shown.length) return;
    // Down at once, whatever the write does: a dialog that waited on a request
    // to go away is a dialog that can be pressed twice. The server keeps the
    // put-off for the next reload and the next start.
    close(shown.map(r => r.id));
    void fetch("/api/claude-accounts/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reauth-later", incidents: shown.map(r => ({ key: r.key, since: r.since })) }),
    }).catch(() => { /* put off for this page; asked again after a reload */ });
  }, [close]);

  // The row the dialog was opened for counts even if a read has since taken it
  // off the list, so a sign-in that lands after that read still settles it.
  const signingInRef = useRef(signingIn);
  signingInRef.current = signingIn;
  const signedIn = useCallback((account: { num: string | null; email: string; added: boolean }) => {
    const opened = signingInRef.current;
    close(settledBy(opened ? [opened, ...rowsRef.current] : rowsRef.current, account));
  }, [close]);

  return {
    rows,
    signingIn,
    observe,
    signIn: setSigningIn,
    signedIn,
    refresh: useCallback(() => { void read(true); }, [read]),
    closeSignIn: useCallback(() => setSigningIn(null), []),
    later,
  };
}
