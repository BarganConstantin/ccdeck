// Which accounts this deck signed in itself, and whether one of them is waiting
// on its owner to sign in again (#1893).
//
// claude-swap's store says nothing about how an account got there. A slot made
// by the deck's own `+ → Sign in`, one pasted from a share, one a paired deck
// delivered over Local network and one somebody added with `cswap add` long
// before the deck existed all look the same in sequence.json. So the deck keeps
// the one fact it can vouch for — "I signed this one in" — in prefs.json, keyed
// by the identity every deck agrees on (accountKey) and never by slot number,
// which claude-swap reuses.
//
// THE PROMPT FOLLOWS EVIDENCE, NOT THE CLOCK. An account needs its owner when
// claude-swap has had its stored login refused — `invalid_grant` or
// `no_refresh_token` on its last read, or its own `relogin_required` verdict on
// a slot it stopped collecting — and that refusal came on an attempt made AFTER
// the deck last signed it in. Nothing here reads a token's expiry, and time
// passing never makes a login dead on its own.
//
// AN INCIDENT IS NAMED BY WHAT IT FOLLOWS. `since` is the later of the last good
// read and the last sign-in through the deck: the moment the login was last
// known to work. Every refusal after it is one incident, however many polls,
// refreshes or restarts it spans — which is what lets "Not now" stick to it. A
// good read or a new sign-in moves `since`, so a refusal after THAT is a new
// incident and may ask again.
//
// Pure: no file, no clock, no subprocess. The roster read (claude-accounts.mjs)
// asks reauthFor about each row and says what it found out of date,
// cswap-admin.mjs reports sign-ins, and account-routes.mjs hands these mutators
// to prefs.json's queued writer.
import { accountKey } from "./lan-copies.mjs";

/** The provenance a completed `+ → Sign in` leaves. The only one there is:
 *  everything else is "the deck cannot say", which is no entry at all. */
export const SIGNED_IN_HERE = "ccdeck_signin";

/** claude-swap's two words for a stored refresh token only a person can
 *  replace. The panel's errorText calls both "login expired". */
const DEAD_LOGIN = new Set(["invalid_grant", "no_refresh_token"]);

/** Bounds on a file a person can edit. An email is at most 254 characters and
 *  an organization uuid 36, so a key past this is not one the deck wrote. */
const MAX_KEY = 320;
const MAX_ENTRIES = 500;

/**
 * prefs.json's `accounts`, coerced: `{ [accountKey]: { origin, signedInAt,
 * dismissed? } }`, and nothing that is not one.
 *
 * Built with Object.fromEntries rather than by assignment, so a key read out of
 * a hand-edited file defines a property and can never reach a prototype.
 */
export function normaliseOrigins(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const kept = [];
  for (const [key, v] of Object.entries(src)) {
    if (kept.length >= MAX_ENTRIES) break;
    if (!key.includes("@@") || key.length > MAX_KEY) continue;
    if (!v || typeof v !== "object" || v.origin !== SIGNED_IN_HERE) continue;
    kept.push([key, {
      origin: SIGNED_IN_HERE,
      signedInAt: Number.isFinite(v.signedInAt) && v.signedInAt > 0 ? v.signedInAt : 0,
      ...(Number.isFinite(v.dismissed) && v.dismissed >= 0 ? { dismissed: v.dismissed } : {}),
    }]);
  }
  return Object.fromEntries(kept);
}

// ── what changes it ─────────────────────────────────────────────────────────
//
// Each of these is an `updatePrefs` mutator: it reads the file's own `accounts`
// and answers the WHOLE map, or null for no change. Whole, because prefs.json
// merges a patch one top-level field deep — a map that only named the account
// it changed would drop every other one.

/**
 * The deck's own sign-in finished and claude-swap recorded the account.
 *
 * Marked only when the sign-in ADDED it, or when the deck had marked it before.
 * An account that was already in the store when somebody signed into it here
 * was put there some other way — a share, Local network, a terminal — and a
 * sign-in that only refreshed it does not change where it came from.
 *
 * A re-sign-in of a marked account keeps the mark and moves `signedInAt`, which
 * is what closes its incident: a refusal from before that moment is about the
 * login it replaced. Any "Not now" goes with it.
 */
export function withSignIn({ email, org, added, now }) {
  return prev => {
    if (!String(email ?? "").trim()) return null;
    const all = normaliseOrigins(prev?.accounts);
    const key = accountKey(email, org);
    if (!added && !Object.hasOwn(all, key)) return null;
    return { accounts: { ...all, [key]: { origin: SIGNED_IN_HERE, signedInAt: now } } };
  };
}

/** "Not now" on these incidents. Only for an account the deck marked: a key it
 *  does not hold is not one it would ever ask about. */
export function withDismissed(incidents) {
  return prev => {
    const all = normaliseOrigins(prev?.accounts);
    let changed = false;
    const next = Object.fromEntries(Object.entries(all).map(([key, entry]) => {
      const hit = incidents.find(i => i.key === key);
      if (!hit || entry.dismissed === hit.since) return [key, entry];
      changed = true;
      return [key, { ...entry, dismissed: hit.since }];
    }));
    return changed ? { accounts: next } : null;
  };
}

/**
 * What a roster read found out of date, put right in one write.
 *
 * `recovered`: accounts read successfully after the incident somebody put off,
 * so the put-off is forgotten rather than kept for an incident that is over.
 * `gone`: accounts no longer in claude-swap's store, however they left — the
 * mark goes with them, so the same address arriving later by a share or Local
 * network is not mistaken for one this deck signed in.
 *
 * `seen` is the map the read judged, when there is one, and an entry that has
 * changed since — signed in again, or put off for a newer incident — is left as
 * it is: the read's verdict was about the entry it saw.
 */
export function withTidied({ recovered = [], gone = [], seen = null }) {
  const judged = (key, entry) => !seen || sameEntry(entry, seen[key]);
  return prev => {
    const all = normaliseOrigins(prev?.accounts);
    let changed = false;
    const next = Object.fromEntries(Object.entries(all).flatMap(([key, entry]) => {
      if (!judged(key, entry)) return [[key, entry]];
      if (gone.includes(key)) { changed = true; return []; }
      if (!recovered.includes(key) || entry.dismissed == null) return [[key, entry]];
      changed = true;
      const { dismissed: _dropped, ...rest } = entry;
      return [[key, rest]];
    }));
    return changed ? { accounts: next } : null;
  };
}

const sameEntry = (a, b) => Boolean(a && b)
  && a.origin === b.origin && a.signedInAt === b.signedInAt && a.dismissed === b.dismissed;

/** Pick out the incidents a request named, dropping anything that is not one.
 *  The route's boundary: a page sends these, and nothing else reaches a write. */
export function incidentsFrom(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(i => i && typeof i.key === "string" && i.key.includes("@@") && i.key.length <= MAX_KEY
      && Number.isFinite(i.since) && i.since >= 0)
    .slice(0, MAX_ENTRIES)
    .map(i => ({ key: i.key, since: i.since }));
}

// ── what it means for a row ─────────────────────────────────────────────────

/**
 * Whether claude-swap's verdict on a row is a stored login only a sign-in can
 * bring back. `trouble` is authTrouble's answer for the row and `collector` the
 * slot's cached verdict.
 *
 * The server's copy of account-issue.ts's deadLogin, held to it by
 * reauth-prompt-1893.test.ts: a stale copy is never this (the reader IS signed
 * in and the deck re-captures it alone, #721), a collector that stopped counts
 * only on claude-swap's own `relogin_required`, and a refusal counts only when
 * it is one of the two refresh-token words.
 */
export function needsSignIn(trouble, collector) {
  if (trouble?.kind === "auth") return DEAD_LOGIN.has(trouble.error);
  if (trouble?.kind === "stopped") return collector === "relogin_required";
  return false;
}

/**
 * The incident one roster row is in, or null.
 *
 * `{ since, dismissed }`: `since` names the incident (see the header) and
 * `dismissed` says somebody put this very one off. Null for every account the
 * deck did not sign in, every login that works or fails for another reason, and
 * a login whose refusal predates the last sign-in here — the read that proves
 * the new login has not happened yet, and saying "expired" over a sign-in that
 * just succeeded is the one moment this must stay quiet.
 */
export function reauthFor({ entry, trouble, collector, fetchedAt = null, attemptedAt = null, verdictAt = null }) {
  if (entry?.origin !== SIGNED_IN_HERE) return null;
  if (!needsSignIn(trouble, collector)) return null;
  const signedInAt = entry.signedInAt ?? 0;
  if (!Number.isFinite(attemptedAt) || attemptedAt <= signedInAt) return null;
  // A collector that stopped is a dead login only on claude-swap's own
  // verdict, and a verdict asked before the last sign-in here is about the
  // login that sign-in replaced. Without this, the first collection after a
  // re-sign-in — which stamps its attempt as it claims the slot, long before
  // it records anything — read as a refusal of the new login, on a row whose
  // last good read is still from before (`cswap add` does not move it).
  if (trouble?.kind === "stopped" && !(Number.isFinite(verdictAt) && verdictAt > signedInAt)) return null;
  const since = Math.floor(Math.max(Number.isFinite(fetchedAt) ? fetchedAt : 0, signedInAt));
  return { since, dismissed: entry.dismissed === since };
}

/** A good read after the incident that was put off: the login works again.
 *  Floored as `since` is — claude-swap stamps fractional seconds, and the read
 *  that STARTED the incident must not count as the one that ended it. */
export function hasRecovered(entry, fetchedAt) {
  return Number.isFinite(entry?.dismissed) && Number.isFinite(fetchedAt)
    && Math.floor(fetchedAt) > entry.dismissed;
}
