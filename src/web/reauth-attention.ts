// Which accounts the deck asks its owner to sign in again, and the words it
// asks with (#1893).
//
// The server decides what an incident IS — an account the deck's own
// `+ → Sign in` added, whose login claude-swap has refused since (see
// account-origins.mjs) — and puts it on the roster row as `reauth`. What is left
// for the page is the three things only it can see: whether somebody already
// put this one off, whether Local network is about to repair it, and whether a
// sign-in from this very prompt has just fixed it ahead of the next read.
//
// Pure, for the reason the rest of the accounts surface is: the component is
// drawn from this, and this can be tested without React or a DOM.
import { lanRepairExpected } from "./account-lan";
import { type Account } from "./claude-accounts";
import type { LanStatus } from "./lan-types";

/** One account the prompt names. */
export interface AttentionRow {
  /** The incident: `key#since`. What "Not now" and a finished sign-in close. */
  id: string;
  key: string;
  since: number;
  num: number;
  email: string;
  /** What the row calls the account: its address, or its slot without one. */
  name: string;
  /** The name somebody gave it here, shown beside the address. */
  alias: string | null;
}

/** The name an incident goes by, from the two halves the server sent. */
export function incidentId(key: string, since: number): string {
  return `${key}#${since}`;
}

/**
 * The accounts to ask about right now, in roster order.
 *
 * `lan` is the status the deck's own /api/lan poll last read, or `undefined`
 * while that poll has not answered yet: Local network may be about to repair
 * the very login the prompt would ask about, and a prompt that appears and is
 * then repaired out from under its reader is the noise this is meant to avoid.
 * Once it has answered — `null` for a deck whose network could not be read — a
 * repair is expected only on the evidence lanRepairExpected wants.
 *
 * `closed` holds incidents this page has already settled: put off with "Not
 * now" (the server keeps that too, and says so on the next read) or signed in
 * again from the prompt itself, before the read that proves it.
 */
export function attentionRows(
  accounts: readonly Account[] | null | undefined,
  {
    lan, now, closed,
  }: { lan: LanStatus | null | undefined; now: number; closed: ReadonlySet<string> },
): AttentionRow[] {
  if (lan === undefined) return [];
  const rows: AttentionRow[] = [];
  for (const a of accounts ?? []) {
    const r = a.reauth;
    if (!r || r.dismissed || a.origin !== "ccdeck_signin") continue;
    const id = incidentId(r.key, r.since);
    if (closed.has(id)) continue;
    if (lanRepairExpected(r.key, a.email, lan, now)) continue;
    const email = a.email ?? "";
    rows.push({
      id, key: r.key, since: r.since, num: a.num, email,
      name: email || a.alias || `Account ${a.num}`,
      alias: email && a.alias ? a.alias : null,
    });
  }
  return rows;
}

/**
 * Which rows a finished sign-in settles.
 *
 * The sign-in dialog reports the account claude-swap recorded — its slot and
 * address — and that is the account settled, whichever row the reader pressed:
 * somebody who approved a different address in the browser fixed that account,
 * not the one they were asked about, and the asked-about row stays.
 */
export function settledBy(
  rows: readonly AttentionRow[],
  account: { num: string | number | null; email: string } | null | undefined,
): string[] {
  const who = String(account?.email ?? "").trim().toLowerCase();
  if (!who) return [];
  return rows
    .filter(r => r.email.toLowerCase() === who && (account?.num == null || String(r.num) === String(account.num)))
    .map(r => r.id);
}

/**
 * Whether the prompt is drawn now.
 *
 * IT WAITS ITS TURN. It arrives on its own, on a poll, and a dialog somebody
 * opened is one they are in the middle of: the panel's own sign-in, a share,
 * the tour. Drawn over one of those it would take the keyboard from a person
 * mid-task — or start a second sign-in beside one already running on the
 * server. So it waits until no other dialog is up (`dialogs`, the shared
 * stack's count). Once it is up (`ours`) it stays, whatever opens over it, and
 * a dialog it opened itself — its own sign-in — does not count against it.
 */
export function promptShows({ rows, ours, dialogs }: { rows: number; ours: boolean; dialogs: number }): boolean {
  if (rows === 0) return false;
  return ours || dialogs === 0;
}

/** The dialog's title: one account, or more than one. */
export function attentionTitle(count: number): string {
  return count === 1 ? "Account needs your attention" : "Accounts need your attention";
}

/** The sentence under the title when there are several. One account is named
 *  in a sentence of its own, by the component, so it can be bold. */
export function attentionLead(count: number): string {
  const n = count === 1 ? "One Claude account needs" : `${count} Claude accounts need`;
  return `${n} you to sign in again.`;
}

/** What one account's row says about it. Calm and factual: the login has
 *  stopped working, nothing is lost, and a sign-in brings it back. */
export const LOGIN_EXPIRED = "Login expired";

/** What the single-account body says after naming it: what stopped, and that
 *  nothing is lost by signing in again. */
export const SINGLE_NOTE =
  "Until then the deck cannot read its usage or switch to it. Signing in again brings it back — "
  + "it keeps its slot, its alias and its history.";

/** What "Not now" promises, said on the button's title. */
export const LATER_EXPLAINED =
  "The account stays marked in the Accounts panel. This will not ask again until it has worked and stopped again.";
