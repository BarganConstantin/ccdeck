// Which account a command line means (#2183): `ccdeck switch 2`, `ccdeck switch
// work`, `ccdeck switch alice@`, `ccdeck switch --best`.
//
// Pure — roster rows in, a verdict out — because both halves are rules a person
// leans on without looking, and a rule nobody can run in a test is the one that
// drifts. The rows are the roster's own (claude-accounts.mjs rosterRow), read
// either from a running deck or from claude-swap's store in this process.
import { oneLine } from "./cli-lines.mjs";
// Auto-switch's own chooser (#2200) and the key it names accounts by. Both are
// pure and import nothing that starts anything.
import { chooseAccount, readingCurrent, usedOf } from "./account-choice.mjs";
import { accountKey } from "./lan-copies.mjs";

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

/** The errors that mean the stored login itself was refused — the ones the
 *  panel offers "Sign in again" for (account-issue.ts errorText `fixable`). */
const SIGN_IN_ERRORS = new Set(["invalid_grant", "no_refresh_token", "http-401"]);

/**
 * Whether the accounts panel withholds its Switch button from this row — the
 * server-side copy of account-issue.ts's `blocksSwitch`, which
 * cli-switch-rules-2183.test.ts holds to it row by row.
 *
 * A login that is dead or was never stored: claude-swap refused its token, or
 * stopped collecting it on a verdict that only a sign-in clears. Never a stale
 * copy (#721): the login works, only claude-swap's copy is behind. And not a
 * rate limit, a timeout or a network error — those clear by themselves, and the
 * panel switches to such an account when asked.
 */
export function blocksSwitch(a) {
  if (!a || a.staleCopy === true) return false;
  if (a.stopped === true) return a.collector === "no_credentials" || a.collector === "relogin_required";
  return typeof a.error === "string" && SIGN_IN_ERRORS.has(a.error);
}

/**
 * Could the live login be moved here at all, when somebody names it?
 *
 * Exactly when the panel would offer the switch: not a disabled slot —
 * claude-swap's own "keep out of rotation", which a person set on purpose —
 * and not one whose stored login is known to be dead (blocksSwitch): switching
 * to it signs every running session out.
 */
export function switchable(a) {
  return Boolean(a) && a.disabled !== true && !blocksSwitch(a);
}

/** Whether `--best` may land on this row by room alone: switchable, and with no
 *  collector error at all. A reading that failed — a rate limit, a timeout — is
 *  no evidence of room, which is what `--best` promises; Auto-switch's own
 *  chooser skips any row with an error too (account-choice.mjs `landable`). A
 *  stale copy is fine, since its login works (see authTrouble). */
function roomCandidate(a) {
  return switchable(a) && !(a.error && a.staleCopy !== true);
}

/**
 * Where `--best` goes: `{ account, rule }`, `{ already: row, rule }` when the
 * active account is it, or `{ none: true }` when nothing can take the login.
 *
 * WHAT AUTO-SWITCH WOULD PICK (#2200). `rules` is Auto-switch's own state as
 * the deck holds it — `{ next, home, threshold, models, busy, quarantined,
 * optional, now }`, see cswap-auto-choice.mjs bestRules — or null. With a home
 * account or "soonest weekly reset" set, the answer is account-choice.mjs's
 * chooseAccount's, asked the way a tick right after a person's request would
 * be: nothing picked by hand to protect, the home asked for, no cooldown. Its
 * `rule` is that pick's trigger, "home" or "weekly-reset". When it names no
 * account and the account in use is under the threshold on a current reading,
 * Auto-switch would keep it, and so does this (`rule: "rules"`, or "home" on
 * the home account). Otherwise — no rule set, or the active account full or
 * unread and no rule's account free — it is the engine's own choice, below.
 *
 * MOST ROOM, the engine's `best`. Room is the roster's own `headroom` — against
 * the tightest lane, so an account at 10% of five hours and 97% of the week is
 * not chosen over one at 50% of both. A reading nobody has taken counts as no
 * room rather than as full: the point of `--best` is to land somewhere known to
 * have space. A tie with the active account stays where it is — a switch that
 * gains no room still moves every running session — and other ties go to a
 * fresh reading over a stale one, then to the lower slot, so the answer is the
 * same every time it is asked.
 */
export function bestAccount(accounts, rules = null) {
  const all = Array.isArray(accounts) ? accounts : [];
  const rows = all.filter(roomCandidate);
  const ruled = rules ? byRules(all, rules) : null;
  if (ruled) return ruled;
  if (!rows.length) return { none: true };
  const room = (a) => (typeof a.headroom === "number" ? a.headroom : -1);
  const best = [...rows].sort((x, y) =>
    room(y) - room(x)
    || Number(y.active === true) - Number(x.active === true)
    || Number(x.stale === true) - Number(y.stale === true)
    || x.num - y.num)[0];
  return best.active ? { already: best, rule: "most-room" } : { account: best, rule: "most-room" };
}

/** chooseAccount's answer for `--best`, as bestAccount describes it, or null
 *  for "the engine's own choice". */
function byRules(rows, { next = "room", home = null, threshold, models = [], busy, quarantined, optional = true, now = Date.now() } = {}) {
  if (next !== "weekly" && !home) return null;
  if (!Number.isFinite(threshold)) return null;
  const keyed = rows.map(a => ({ ...a, key: accountKey(a.email, a.orgUuid) }));
  const original = (k) => rows[keyed.indexOf(k)];
  const pick = chooseAccount({
    accounts: keyed,
    choice: { next, home, manual: false, goHome: true },
    threshold,
    models,
    busy: busy instanceof Set ? busy : new Set(),
    quarantined: quarantined instanceof Set ? quarantined : new Set(),
    sinceMove: Infinity,
    optional: optional !== false,
    now,
  });
  if (pick) return { account: original(pick.to), rule: pick.trigger };
  const active = keyed.find(a => a.active);
  if (!active || !readingCurrent(active, models, now)) return null;
  const used = usedOf(active, models);
  if (used == null || used >= threshold) return null;
  return { already: original(active), rule: home && active.key === home ? "home" : "rules" };
}

/** How a row is named back to its reader: `#2 alice@corp.com (work)`. On one
 *  line and without control bytes, since an alias is whatever was typed. */
export function accountName(a) {
  if (!a) return "";
  const who = a.email ?? "(no email)";
  return oneLine(`#${a.num} ${who}${a.alias ? ` (${a.alias})` : ""}`);
}
