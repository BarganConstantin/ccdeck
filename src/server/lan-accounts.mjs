// This deck's accounts in the shape the sync rules want, read off the rows
// claude-swap's reader hands back. Lifted out of createEngine in lan-engine.mjs,
// where it closed over nothing but the reader: the rule for each field is here
// and runs without a store, and the engine reads the store and hands the rows
// over. What each verdict means is account-health.mjs's.
import { accountKey, SENDER_UNREADABLE } from "./lan-sync.mjs";
import { storedCopyAlive, cachedExportReadable } from "./account-health.mjs";

/** Every account in `got` — what the deck's account reader returns, or
 *  nothing — as the rules in lan-sync.mjs read one. */
export function syncAccounts(got) {
  return (got?.accounts ?? []).map(a => ({
    key: accountKey(a.email, a.orgUuid),
    email: a.email,
    org: a.orgUuid,
    alive: storedCopyAlive(a.alive, a.collector),
    // False only for a login the wiring knows this process cannot read (a
    // Mac whose Keychain will not open from here). Absent means readable,
    // which is every deck that does not say.
    readable: a.readable !== false && cachedExportReadable(a.collector, { active: a.active === true }),
    unreadableWhy: a.readable === false || a.collector === "keychain_unavailable"
      ? SENDER_UNREADABLE : "export failed",
    num: a.num,
    // The one this deck is on — claude-swap's own answer, one at most.
    active: a.active === true,
  }));
}
