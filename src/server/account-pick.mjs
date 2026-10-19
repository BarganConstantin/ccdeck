// Which account a command line means (#2183): `ccdeck switch 2`, `ccdeck switch
// work`, `ccdeck switch alice@`, `ccdeck switch --best`.
//
// Pure — roster rows in, a verdict out — because both halves are rules a person
// leans on without looking, and a rule nobody can run in a test is the one that
// drifts. The rows are the roster's own (claude-accounts.mjs rosterRow), read
// either from a running deck or from claude-swap's store in this process.
import { oneLine } from "./cli-lines.mjs";

/**
 * The account `query` names, as `{ account }`, or why there is none: `{ none }`
 * for a name nothing matches, `{ ambiguous: [rows] }` for one several do.
 *
 * In the order a person means them. A whole number is a slot, and only a slot —
 * `2` is never the second account in the list, because the list's order is the
 * rotation's and the slot is what `cswap` and the panel both print. Then an
 * exact email or alias, case-insensitive. Then a fragment of either, which is
 * what `alice` or `@corp` is, accepted only when it narrows to one account: a
 * switch that guessed between two would move the live login of every running
 * session on a coin toss.
 */
export function resolveAccount(accounts, query) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const q = String(query ?? "").trim();
  if (!q) return { none: true };
  if (/^\d+$/.test(q)) {
    const hit = rows.find(a => a.num === Number(q));
    return hit ? { account: hit } : { none: true };
  }
  const lower = q.toLowerCase();
  const exact = rows.filter(a => lc(a.email) === lower || lc(a.alias) === lower);
  if (exact.length === 1) return { account: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const partial = rows.filter(a => lc(a.email).includes(lower) || lc(a.alias).includes(lower));
  if (partial.length === 1) return { account: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };
  return { none: true };
}

const lc = (s) => (typeof s === "string" ? s.toLowerCase() : "");

/**
 * Could the live login be moved here at all?
 *
 * Not a disabled slot — claude-swap's own "keep out of rotation", which a
 * person set on purpose — and not one whose stored login is known to be dead:
 * switching to it signs every running session out. A `stale-copy` row is fine,
 * since its login works and only claude-swap's copy is behind (see authTrouble).
 */
export function switchable(a) {
  return Boolean(a) && a.disabled !== true && !(a.error && a.staleCopy !== true);
}

/**
 * The account with the most room, as `{ account }`, `{ already: row }` when the
 * active one is it, or `{ none: true }` when nothing is switchable.
 *
 * Room is the roster's own `headroom` — against the tightest lane, so an account
 * at 10% of five hours and 97% of the week is not chosen over one at 50% of
 * both. A reading nobody has taken counts as no room rather than as full: the
 * point of `--best` is to land somewhere known to have space. A tie with the
 * active account stays where it is — a switch that gains no room still moves
 * every running session — and other ties go to a fresh reading over a stale
 * one, then to the lower slot, so the answer is the same every time it is asked.
 */
export function bestAccount(accounts) {
  const rows = (Array.isArray(accounts) ? accounts : []).filter(switchable);
  if (!rows.length) return { none: true };
  const room = (a) => (typeof a.headroom === "number" ? a.headroom : -1);
  const best = [...rows].sort((x, y) =>
    room(y) - room(x)
    || Number(y.active === true) - Number(x.active === true)
    || Number(x.stale === true) - Number(y.stale === true)
    || x.num - y.num)[0];
  return best.active ? { already: best } : { account: best };
}

/** How a row is named back to its reader: `#2 alice@corp.com (work)`. On one
 *  line and without control bytes, since an alias is whatever was typed. */
export function accountName(a) {
  if (!a) return "";
  const who = a.email ?? "(no email)";
  return oneLine(`#${a.num} ${who}${a.alias ? ` (${a.alias})` : ""}`);
}
