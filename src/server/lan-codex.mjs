// Codex accounts on Local network: the rules, pure, as lan-copies.mjs holds
// Claude's. No sockets, no timers, no filesystem — the store is
// lan-codex-store.mjs, and the engine carries both kinds of login over one
// pairing, one seal and one `want`.
//
// THEY TRAVEL IN THEIR OWN LIST. A manifest's `accounts` is Claude's, and every
// deck since the first one reads it as claude-swap logins: a Codex row there
// would be asked for, handed over, and refused by `cswap import` on every round
// of an older deck. So Codex rows go in a `codex` field that an older deck never
// reads — the same additive rule the card and the usage readings follow.
import { manifestFor, offered, onePerKey, slotFor } from "./lan-copies.mjs";
import { CODEX_KEY_PREFIX, codexLanKey, tokenHash } from "./codex-lan-identity.mjs";

// The name of a login is a leaf of its own — see codex-lan-identity.mjs.
export { CODEX_KEY_PREFIX, codexLanKey, tokenHash };

/** How many superseded logins a row remembers. A login is renewed about once a
 *  week; eight covers two months of a paired deck that was switched off. */
export const LINEAGE_MAX = 8;

const HASH = /^[a-f0-9]{32}$/;

export const isCodexKey = key => typeof key === "string" && key.startsWith(CODEX_KEY_PREFIX);

/**
 * Remember the refresh token one profile holds now, and the ones it held before.
 * `entry` is what was kept for that profile, or nothing. Returns the entry to
 * keep and whether it changed, so the store writes only when it did.
 */
export function nextLineage(entry, rt) {
  const was = Array.isArray(entry?.was) ? entry.was.filter(h => HASH.test(h)) : [];
  if (!HASH.test(rt ?? "")) return { entry: { rt: null, was }, changed: !!entry?.rt };
  if (entry?.rt === rt) return { entry: { rt, was }, changed: false };
  const older = HASH.test(entry?.rt ?? "") ? [entry.rt, ...was.filter(h => h !== entry.rt)] : was;
  return { entry: { rt, was: older.filter(h => h !== rt).slice(0, LINEAGE_MAX) }, changed: true };
}

/**
 * What to do about one Codex account, given my copy and a paired deck's.
 *
 *   "add"   I do not have this account at all.
 *   "heal"  My copy's refresh token is one the other deck has already renewed
 *           past. A Codex refresh token works once: the deck that renews it
 *           keeps the account and every other copy is refused from then on. So
 *           when that deck says it held my token before the one it holds now,
 *           my copy is dead — proven, not guessed from an expiry or a failed
 *           read — and its copy is the same login, renewed.
 *   null    Anything else, which is most of the time.
 *
 * A DIFFERENT LOGIN IS NEVER REPLACED. Somebody who signed in on each machine
 * holds two token families that share no history, so neither deck can find its
 * token in the other's list, and both keep their own. The same holds for a copy
 * that works: it is in nobody's history until somebody renews past it.
 */
export function codexSyncAction(mine, theirs) {
  if (!theirs || !theirs.alive || theirs.shareable === false) return null;
  if (!mine) return "add";
  return HASH.test(mine.rt ?? "") && Array.isArray(theirs.was) && theirs.was.includes(mine.rt) ? "heal" : null;
}

/** Everything to do this round over one paired deck's Codex list, in key order
 *  like Claude's plan, so a failure halfway is the same half each time. */
export function planCodex(local, remote) {
  const mine = new Map(onePerKey(local).map(a => [a.key, a]));
  const out = [];
  for (const theirs of remote) {
    const action = codexSyncAction(mine.get(theirs.key), theirs);
    if (action) out.push({ key: theirs.key, email: theirs.email, action, provider: "codex" });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * This deck's Codex list for one paired deck: the Claude rules word for word —
 * only what is ticked, the login it is on listed and not given unless its owner
 * said so, nothing about it while that is hidden — plus each row's token
 * history, which is what lets the other deck tell a dead copy of this login from
 * a different login of the same account.
 */
export function codexManifest(accounts, shared, opts = {}) {
  const codex = accounts.filter(a => isCodexKey(a.key));
  return manifestFor(codex, shared.filter(isCodexKey), opts).map(row => {
    const held = slotFor(codex, row.key);
    return HASH.test(held?.rt ?? "")
      ? { ...row, rt: held.rt, was: (held.was ?? []).filter(h => HASH.test(h)).slice(0, LINEAGE_MAX) }
      : row;
  });
}

/**
 * A paired deck's Codex list as this deck keeps it: read, not trusted. The
 * Claude list's rules — strings where strings belong, fifty logins at most — and
 * only keys that are Codex keys, with hashes that are hashes.
 */
export function offeredCodex(list) {
  const raw = (Array.isArray(list) ? list : []).filter(a => a && isCodexKey(a.key));
  return offered(raw).filter(a => isCodexKey(a.key)).map(row => {
    const src = raw.find(a => a.key === row.key && HASH.test(a.rt ?? ""));
    if (!src) return row;
    const was = Array.isArray(src.was) ? src.was.filter(h => typeof h === "string" && HASH.test(h)).slice(0, LINEAGE_MAX) : [];
    return { ...row, rt: src.rt, was };
  });
}
