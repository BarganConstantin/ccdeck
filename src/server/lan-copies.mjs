// Which copy of a login wins when two decks both hold one, what a deck tells
// the decks it is paired with about the logins it holds — the lists a manifest
// carries, as they go out and as they are read coming in — and the words for
// why a login did not move. Moved out of lan-sync.mjs, which re-exports all of
// it: none of it reads the beacon, the handshake or the seals, and the identity
// of an account is the one rule modules far from this feature ask for. Like
// everything there it is pure — no sockets, no timers, no filesystem.
import { storedCopyAlive } from "./account-health.mjs";

// ── which copy wins ─────────────────────────────────────────────────────────

/**
 * The identity of one account, which is NOT its slot number.
 *
 * claude-swap keys on `(email, organizationUuid)` — same email under two orgs
 * is two accounts on purpose — and assigns slots as max+1 per store, so the
 * account that is 4 here is 2 there. Anything keyed on the number would swap
 * the wrong pair the first time two stores had grown in a different order.
 */
export function accountKey(email, orgUuid) {
  return `${String(email ?? "").trim().toLowerCase()}@@${String(orgUuid ?? "")}`;
}

/**
 * What to do about one account, given what I have and what a peer has.
 *
 * TWO OUTCOMES, AND NEITHER OVERWRITES SOMETHING THAT WORKS.
 *
 *   "add"   I do not have this account at all.
 *   "heal"  I have it and claude-swap has quarantined it — refresh token dead,
 *           verified by an invalid_grant from Anthropic rather than guessed
 *           from an expiry field — and the peer's copy is alive.
 *   null    Anything else, which is most of the time.
 *
 * A third outcome was designed and dropped, and the reason is worth keeping
 * because it looks like a feature being given up. It was "replace": take a
 * peer's copy when it is strictly newer than mine, so the freshest copy wins
 * everywhere. Measuring "newer" needs the OAuth payload's `expiresAt`, which
 * means the deck opening a credential — something it does not do, claude-swap
 * owns that — and on macOS that credential is in the Keychain, which a
 * background process cannot reliably read at all.
 *
 * What settled it is not the obstacle. It is that a working credential replaced
 * by a newer working credential changes nothing today. It would only matter if
 * mine were about to die — and a login dies from not being used, so if I am not
 * using it I do not care, and if I am using it the refresh keeps it alive. The
 * whole value is in the account that is already dead.
 *
 * So this never returns an outcome that needs `cswap import --force`, which
 * makes claude-swap's own rule the entire safety property: a plain import skips
 * an account that is present and healthy, and replaces exactly one that is
 * quarantined. A peer cannot overwrite a credential of mine that works, because
 * nothing here ever asks for that.
 */
export function syncAction(mine, theirs) {
  if (!theirs || !theirs.alive || theirs.shareable === false) return null;
  if (!mine) return "add";
  return mine.alive ? null : "heal";
}

/**
 * Everything to do this round, over one peer's manifest.
 *
 * Sorted by account key rather than left in manifest order, so two decks
 * reconciling the same pair of stores do the same work in the same sequence —
 * which is what makes a failure halfway through repeatable rather than a
 * different half each time.
 */
export function plan(local, remote) {
  // Through onePerKey, not array order: a Map built straight from the rows
  // keeps the LAST one for a key, so an expired second slot hid a live first
  // one and every round "healed" a login that works here.
  const mine = new Map(onePerKey(local).map(a => [a.key, a]));
  const out = [];
  for (const theirs of remote) {
    const action = syncAction(mine.get(theirs.key), theirs);
    if (action) out.push({ key: theirs.key, email: theirs.email, action });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * One row per identity, and THE rule for which one when claude-swap holds two
 * slots for the same login: a live copy beats an expired one, then one this
 * process can read beats one it cannot, then the earlier slot.
 *
 * ONE RULE, FOUR PLACES. The manifest this deck sends, the peer manifest it
 * reads, the export it answers a `want` with, and plan's view of this deck's
 * own copy all pick through this, so the slot a peer was told about is the
 * slot it is then handed, and the copy this deck advertises as working is the
 * one it plans from. Each used to take array order on its own and agreed only
 * by coincidence — and two slots for one identity became two imports of it in
 * a single round.
 */
export function onePerKey(rows) {
  const rank = a => (a.alive ? 2 : 0) + (a.readable === false ? 0 : 1);
  const best = new Map();
  for (const a of rows) {
    const had = best.get(a.key);
    if (!had || rank(a) > rank(had)) best.set(a.key, a);
  }
  return [...best.values()];
}

/** This deck's own slot for one identity, by onePerKey's rule, or null. */
export function slotFor(accounts, key) {
  return onePerKey(accounts.filter(a => a.key === key))[0] ?? null;
}

/**
 * What this deck publishes about its own accounts — to the group, and only to
 * the group.
 *
 * `alive` says whether the stored copy is still valid. `shareable: false` is
 * the separate, temporary condition where this process cannot read that valid
 * copy (for example a locked macOS Keychain). Keeping those facts separate is
 * what stops another deck treating a healthy-but-inaccessible copy as expired
 * and repeatedly trying to heal it.
 *
 * Emails are in it, and the manifest is sealed on its way. This said "in the
 * clear inside the encrypted channel" until #810, and there was no such
 * channel: the handshake derived a key and sealed a credential and a version
 * card with it, and nothing else — so every email in this list crossed the
 * network readable by anybody on it. Between two decks that both seal, every
 * frame after the handshake now is (see frameChannel). Toward a deck from
 * before that it still travels plain, because that deck cannot open anything
 * else, until it updates.
 *
 * Plain emails INSIDE the seal are a deliberate line: a manifest only ever
 * reaches a deck that proved the key somebody here accepted, and the panel has
 * to name the account it is offering to heal. Hashing the email would buy
 * nothing against that reader and would cost the one thing the row needs to say.
 *
 * `shared` is the user's list. An account absent from it is absent from the
 * manifest entirely — not listed as withheld, which would tell the group that
 * an account exists and is being kept back, and that is itself the fact being
 * kept back.
 */
export function manifestFor(accounts, shared) {
  const want = new Set(shared);
  return onePerKey(accounts.filter(a => want.has(a.key)))
    .map(a => ({
      key: a.key,
      email: a.email,
      alive: !!a.alive,
      ...(a.readable === false ? { shareable: false } : {}),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Which account this deck is on, as a frame field for the decks it is paired
 * with — or nothing.
 *
 * ONLY ONE IT SHARES IS EVER NAMED. The account a deck works on is named only
 * when it is also in the list the owner ticked, so the promise the share list
 * makes — an unticked account is never told to anybody — holds for this too.
 * On one it does not share, it says `other` and nothing more: a paired deck
 * reads "on another account", which says this machine is working without
 * saying on what.
 *
 * `hidden` is the owner's switch turned off, and that IS said, on purpose: a
 * paired deck then reads "current account hidden" rather than nothing, so the
 * person over there knows this machine is working and chose not to say where.
 * A deck with no account at all says nothing.
 */
export function currentFor(accounts, shared, shareActive) {
  if (shareActive === false) return { current: { hidden: true } };
  const on = accounts.find(a => a.active);
  if (!on) return {};
  return new Set(shared).has(on.key) ? { current: { key: on.key } } : { current: { other: true } };
}

/** One peer-supplied string as the panel may draw it: no control or format
 *  characters, whitespace collapsed, bounded. The rule cleanName applies to a
 *  deck's name and lan-about's `field` to a card, applied to the two strings
 *  that sit next to the fingerprint in the import dialog. */
function flatten(v, max) {
  if (typeof v !== "string") return "";
  const flat = v.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return [...flat].slice(0, max).join("");
}

/**
 * The accounts a peer's manifest listed, as the panel may keep them.
 *
 * It arrived from another machine, so it is read rather than trusted: strings
 * where strings belong, a boolean for the verdict, and no more rows than a
 * manifest may carry. What is kept is only what the deck's dialog draws.
 */
export function offered(list) {
  return onePerKey((Array.isArray(list) ? list : [])
    .filter(a => a && typeof a.key === "string" && typeof a.email === "string")
    // Character-filtered, not merely cut. These two are drawn beside the
    // fingerprint at the moment the operator picks which of a peer's logins to
    // import (LanPeerModal.tsx:497), and a bare slice let a format character
    // through — the same class cleanName strips from the name one frame over.
    .map(a => ({
      key: flatten(a.key, 320),
      email: flatten(a.email, 254),
      alive: storedCopyAlive(a.alive, a.collector),
      // Additive wire field: an older peer omitted it, which means shareable.
      ...(a.shareable === false ? { shareable: false } : {}),
    }))
    .filter(a => a.key && a.email))
    // Fifty IDENTITIES, so the cap is spent after onePerKey rather than before
    // it: a peer with duplicate slots could otherwise push a live copy past
    // row fifty and out of the list while offering far fewer than fifty
    // logins. The raw array is already bounded by MAX_FRAME_BYTES.
    .slice(0, 50);
}

/**
 * Which account a peer said it is on, as the panel may keep it: the key of one
 * of the accounts it listed in the same frame, that its owner is hiding it, or
 * that it is on one it does not share — and nothing for anything else. A key
 * that is not in its own list is dropped rather than drawn: a deck only ever
 * names an account it shares, and one that names another is saying something
 * this deck will not show.
 */
export function heardCurrent(raw, list) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.hidden === true) return { hidden: true };
  if (raw.other === true) return { other: true };
  if (typeof raw.key !== "string") return null;
  return list.some(a => a.key === raw.key) ? { key: raw.key } : null;
}

// ── why a login did not move ────────────────────────────────────────────────

/**
 * The reason a sending deck gives for a login it holds and cannot read: on a
 * Mac, claude-swap could not open the Keychain from the session this deck runs
 * in. A fixed code, never the CLI's words — export's stdout IS the credential,
 * and nothing it printed is any business of the deck asking.
 */
export const SENDER_UNREADABLE = "keychain_unavailable";

/** Every reason `serve` answers a `want` with. */
const WIRE_REFUSALS = new Set(["proof", "not shared", "not mine to give", "export failed", SENDER_UNREADABLE, "error"]);

/**
 * A peer's refusal, as this deck records it. The panel prints these, so a peer
 * must not be able to put words in its mouth — least of all one of the HERE
 * codes, which are sentences about this machine. Anything outside the closed
 * set is "refused", which is all it ever proved.
 */
export function peerWhy(why) {
  return typeof why === "string" && WIRE_REFUSALS.has(why) ? why : "refused";
}

/**
 * What this deck found wrong with a login it received. Produced by the local
 * adapters only and never read off a frame — see peerWhy — so a code here is
 * always about THIS machine, and on an arrived row it is a warning rather than
 * a failure: the credential landed and something about this machine stops it
 * being used.
 */
export const HERE = Object.freeze({
  // claude-swap cannot open this Mac's Keychain from the deck's session.
  unreadable: "unreadable_here",
  // It landed, and claude-swap still holds no login for it.
  noLogin: "no_credentials_here",
  // It landed, and the login it carried was rejected.
  expired: "relogin_required_here",
  // It landed, and claude-swap could not be asked whether it is readable.
  unverified: "unverified_here",
});
