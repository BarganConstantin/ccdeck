// The accounts panel's roster as Local network reads it: one row per account,
// named by the identity every deck agrees on, with whether its stored copy is
// alive and whether it can be offered to a peer.
//
// Lifted out of AccountsPanel.tsx unchanged, where it was written inline in
// the prop handed to LanSyncSection. It is two rules the server holds too —
// the key and the export preflight — and a pure function is what lets a test
// hold the two copies to each other.
import { type Account } from "./claude-accounts";
import { isOnline } from "./lan-roster";
import { type LanAccount, type LanStatus } from "./lan-types";

export function lanAccounts(accounts: readonly Account[]): LanAccount[] {
  return accounts.map(a => ({
    // The same key the server builds, from the same two fields: an
    // account is (email, organizationUuid) and never a slot number,
    // because slots are assigned max+1 per store and diverge between
    // two machines that grew in a different order.
    key: `${String(a.email ?? "").trim().toLowerCase()}@@${a.orgUuid ?? ""}`,
    email: a.email ?? "",
    alive: a.alive === true,
    // A valid stored copy can still be unavailable for LAN export
    // (locked Keychain, deferred refresh, or an unknown CLI verdict).
    // The active slot needs a verdict, as on the server: its export is
    // the live login — see cachedExportReadable.
    shareable: a.collector === "ok" || (a.collector == null && !a.active),
  }));
}

/**
 * No paired deck holds a working copy of this shared account — so nothing
 * will arrive to repair it, however long the row waits.
 *
 * A login expires everywhere at once more often than it sounds: Claude
 * retires the other copies of a login each time one machine refreshes it, so
 * every deck that shares an account races the others for the one copy that
 * stays alive. When all of them have lost, the round finds nothing alive to
 * copy and says nothing, and the row said only "login expired" for hours.
 *
 * True only on evidence: the network is on, at least one paired deck that is
 * on offers it, and every one that does offers it dead. A deck that does not
 * offer it, or has not said, proves nothing either way — and nor does a deck
 * that has gone quiet: what it offered then is its last word, not its current
 * one, and it may have been signed in again since.
 *
 * WHATEVER IS TICKED HERE, as lanRepairExpected below. A round repairs a login
 * from any paired deck that offers a live copy, ticked here or not, so a login
 * not ticked here waits on the same copies. This still asked for the tick, and
 * such a login said only "login expired" with every copy nearby dead too.
 */
export function noCopyWorksNearby(
  key: string,
  status: Pick<LanStatus, "enabled" | "peers"> | null,
  now: number,
): boolean {
  if (!status?.enabled) return false;
  const copies = (status.peers ?? [])
    .filter(p => p.paired && isOnline(p, now))
    .map(p => p.offers?.accounts?.find(o => o.key === key))
    .filter((o): o is NonNullable<typeof o> => o != null);
  return copies.length > 0 && copies.every(o => !o.alive);
}

/**
 * Whether Local network is about to repair this dead login on its own (#1893).
 *
 * A round heals a quarantined account from a paired deck's live copy, and the
 * person should not be asked to sign in while that is on its way. So this is
 * true only when a repair can actually come: the network is on and running,
 * and a paired deck that is online offers a live copy it can hand over —
 * unless that deck's last round already tried to heal this account.
 *
 * WHATEVER IS TICKED HERE. A round repairs a login from any paired deck that
 * offers it, ticked here or not — from a deck somebody chose since 3.37.1, and
 * from one the accept switch paired since 3.38.1 (see roundWith in
 * lan-engine.mjs). This still asked for the tick, and so asked somebody to
 * sign in again to a login the network was about to repair.
 *
 * TRIED AT ALL, NOT TRIED AND FAILED. A heal that took clears claude-swap's
 * failure on the slot as it lands (its import lifts the dead-token quarantine),
 * so a row still in an incident after one is a copy that died again — and
 * waiting on that deck would wait as long as it stays online. A round's record
 * names the account by address only, so one address under two organizations
 * reads as tried for both: the prompt asks rather than waits, which is the side
 * to be wrong on.
 *
 * Everything else is false, including a status not read yet, which the caller
 * waits out rather than reading as "nothing coming".
 */
export function lanRepairExpected(
  key: string,
  email: string | null | undefined,
  status: Pick<LanStatus, "enabled" | "running" | "peers"> | null,
  now: number,
): boolean {
  if (!status?.enabled || status.running === false) return false;
  const who = String(email ?? "").trim().toLowerCase();
  return (status.peers ?? []).some(p => {
    if (!p.paired || !isOnline(p, now)) return false;
    const offer = p.offers?.accounts?.find(o => o.key === key);
    if (!offer?.alive || offer.shareable === false) return false;
    return !p.last?.done?.some(d => d.action === "heal" && String(d.email ?? "").trim().toLowerCase() === who);
  });
}
