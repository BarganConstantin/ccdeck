// The accounts panel's roster as Local network reads it: one row per account,
// named by the identity every deck agrees on, with whether its stored copy is
// alive and whether it can be offered to a peer.
//
// Lifted out of AccountsPanel.tsx unchanged, where it was written inline in
// the prop handed to LanSyncSection. It is two rules the server holds too —
// the key and the export preflight — and a pure function is what lets a test
// hold the two copies to each other.
import { type Account } from "./claude-accounts";
import { type LanAccount } from "./lan-types";

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
