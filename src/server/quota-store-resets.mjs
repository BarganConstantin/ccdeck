// Claude's saved limit resets, on the store path (#1308).
//
// When claude-swap's store supplies the windows, nothing in its row says how
// many resets the account has saved, so the inventory is a read of its own
// with Claude Code's token: on a floor of its own, behind the quota read that
// starts it, and published only once the token's owner has been checked
// against the account claude-swap says is active. quota.mjs's header says why
// the other two sources need none of this; what is here is that check, the
// inventory it guards, and the floor it is read on.
import { availableResetCredits, readResetGrants } from "./claude-reset-credits.mjs";
import {
  SELF_POLL_MS, USAGE_URL, cooldownUntil, oauthHeaders, readOAuthToken, startCooldown,
} from "./quota-oauth.mjs";
import { createHash } from "node:crypto";

// The store path's inventory read. `skip_spend=1` is what Claude Code adds to
// the same request, because the spend breakdown is not what it is asking for;
// neither is it here, where the windows come from claude-swap instead.
const RESETS_ONLY_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
// Whose token this is. claude-swap asks the same endpoint the same question
// before it trusts a credential with an account; see tokenOwner.
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

// Floor between two inventory reads while claude-swap supplies the windows. A
// grant is issued for a launch and lasts weeks, so this is two requests an hour
// out of a budget claude-swap plans to leave eight to ten of unspent. A forced
// refresh, or an account not tried yet, waits SELF_POLL_MS.
const CREDITS_POLL_MS = 30 * 60_000;

// How long an inventory is shown after the last read that succeeded. Expiry is
// worked out at every read, but a reset redeemed in Claude only leaves the
// inventory when a read says so, and a read that keeps failing must not keep
// promising it.
const CREDITS_TRUSTED_MS = 3 * CREDITS_POLL_MS;

// What the last successful read found, and for whom: `{ account, grants, at }`,
// where `grants` is readResetGrants's answer — a list, or null for a block that
// said nothing readable. Never an id: the parser does not keep one.
let _credits = null;
// When the store path last tried, successful or not, and for which account,
// so a failing read is on the same floor as a working one.
let _creditsTriedAt = 0;
let _creditsTriedFor = null;
let _creditsInflight = null;
// The last token whose owner was looked up, by hash, and the answer. A token
// belongs to one account for its whole life, so this is asked once per token
// rather than once per read. The token itself is not kept.
let _owner = null;

/**
 * A Claude account as the two halves claude-swap keys one on, or null when
 * either is missing, because half an identity cannot be matched against
 * anything.
 */
export function accountOf(email, org) {
  const e = typeof email === "string" ? email.trim() : "";
  const o = typeof org === "string" ? org.trim() : "";
  return e && o ? { email: e, organizationUuid: o } : null;
}

/**
 * Whether two identities are the same Claude account.
 *
 * Both halves, because claude-swap treats one address under two organizations
 * as two accounts on purpose, and those two have separate inventories. The
 * address is compared without case — it is the same mailbox either way — and
 * the organization exactly.
 *
 * Exported for tests: this comparison is the whole of what keeps one account's
 * resets off another account's card.
 */
export function sameAccount(a, b) {
  if (!a || !b) return false;
  return a.email.toLowerCase() === b.email.toLowerCase() && a.organizationUuid === b.organizationUuid;
}

/** The held inventory, if it was read for `account` and recently enough. */
export function heldResetCredits(account, now) {
  if (!_credits || !sameAccount(_credits.account, account)) return null;
  if (now - _credits.at > CREDITS_TRUSTED_MS) return null;
  return availableResetCredits(_credits.grants, now);
}

/**
 * Whether the store path may spend a request on the inventory now.
 *
 * The long floor once this account has been tried, whether that worked or not
 * — a profile lookup that keeps failing is not a reason to ask twelve times an
 * hour. The short one for an account not tried yet, which is what an account
 * switch produces, and for the refresh button.
 *
 * Exported for tests, like maySelfPoll, and for the same reason: it is a
 * budget rule, and it is pure. The 429 cooldown is maySelfPoll's own — one
 * token, one budget — so a 429 here holds source 2 off as well, and the other
 * way round.
 */
export function resetCreditsDue({ now, force, triedAt, rateLimitedUntil, triedThisAccount }) {
  if (now < rateLimitedUntil) return false;
  return now - triedAt >= (triedThisAccount && !force ? CREDITS_POLL_MS : SELF_POLL_MS);
}

/**
 * The account a token belongs to, as `{ email, organizationUuid }`, or null
 * when that cannot be established.
 *
 * `/api/oauth/profile` answers about the token it is sent, which makes it the
 * one source that cannot describe a different account than the token will be
 * used for. The Claude config's `oauthAccount` block would have been free, but
 * it is a separate file from the credential, written at a separate moment, and
 * "usually agrees" is not the bar for publishing an account's data.
 */
async function tokenOwner(token) {
  const key = createHash("sha256").update(token).digest("hex");
  if (_owner?.key === key) return _owner.identity;
  let identity = null;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: oauthHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.json();
      identity = accountOf(body?.account?.email, body?.organization?.uuid);
    }
  } catch { /* unreachable or unreadable: no identity, so nothing is published */ }
  if (identity) _owner = { key, identity };
  return identity;
}

/**
 * The inventory for `token`: readResetGrants's answer, or undefined when the
 * request did not produce one — in which case whatever is held stays held.
 */
async function fetchResetGrants(token) {
  try {
    const res = await fetch(RESETS_ONLY_URL, {
      headers: oauthHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 429) {
      startCooldown(res);
      return undefined;
    }
    if (!res.ok) return undefined;
    return readResetGrants((await res.json())?.cedar_ember);
  } catch {
    return undefined;
  }
}

/**
 * Read the reset inventory for the account claude-swap says is active, when
 * the store is what the panel's windows came from.
 *
 * Best-effort in every direction, and never awaited by a quota read: it runs
 * behind the read that started it, and the next read picks the answer up. It
 * cannot delay, fail or change the windows, and nothing it catches is logged —
 * there is nothing in a failure here the user can act on, and the one thing
 * the error path must never do is print a request that carried a token.
 *
 * THE ACCOUNT CHECK IS THE POINT. The token is Claude Code's, from the Claude
 * config dir; the windows are claude-swap's, for whichever slot it has marked
 * active. Those are the same account after a `cswap switch`, and need not be
 * after a `claude auth login` done in a terminal. So the token's owner is looked
 * up first, and when it is not the store's active account the inventory
 * request is never made. What is kept is stamped with the account it was
 * checked against, and heldResetCredits compares that stamp with the store's
 * active account again at every read — so a switch made anywhere, by the deck,
 * by `cswap` in a terminal or by claude-swap's auto-switch, cannot carry one
 * account's resets onto the next account's card.
 */
export function refreshStoreResetCredits({ now, force = false, account }) {
  if (_creditsInflight || !account) return;
  const triedThisAccount = sameAccount(_creditsTriedFor, account);
  if (!resetCreditsDue({ now, force, triedAt: _creditsTriedAt, rateLimitedUntil: cooldownUntil(), triedThisAccount })) return;
  _creditsTriedAt = now;
  _creditsTriedFor = account;
  const run = (async () => {
    const token = await readOAuthToken();
    if (!token) return;
    const owner = await tokenOwner(token);
    if (!sameAccount(owner, account)) return;
    const grants = await fetchResetGrants(token);
    if (grants !== undefined) _credits = { account, grants, at: now };
  })();
  // Settles rather than rejects: nothing in here is news to anyone.
  _creditsInflight = run.catch(() => {}).finally(() => { _creditsInflight = null; });
}

/** Exported for tests: the inventory read runs behind the quota read that
 *  started it, and a test has to be able to wait for it to land. */
export function resetCreditsSettled() {
  return _creditsInflight ?? Promise.resolve();
}

/** The held inventory, forgotten — for invalidateQuotaCache. */
export function forgetResetCredits() { _credits = null; }

/** The inventory floor, cleared — for resetQuotaPollFloor, beside the
 *  self-poll floor it clears. */
export function clearResetCreditsFloor() {
  _creditsTriedAt = 0;
  _creditsTriedFor = null;
}
