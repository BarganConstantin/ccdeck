// Claude's saved limit resets — "Reset for free" in Claude's Settings → Usage —
// read out of the `cedar_ember` block of Anthropic's usage response.
//
// WHAT THEY ARE, AND WHAT THEY ARE NOT. A grant is a coupon Anthropic hands out
// (a model launch, a promotion) that clears a rate-limit window on demand. It
// has nothing to do with the `resets_at` timestamps on `five_hour` and
// `seven_day`: those say when a window rolls over by itself, and a panel that
// read one as the other would promise a reset the account does not have.
//
// THE DECK ONLY COUNTS THEM. Redeeming one is a POST to a different endpoint,
// and nothing in ccdeck makes it — spending a one-off reset is the user's
// decision, taken in Claude itself. So nothing here reads a grant's `id`, its
// `label`, `next_grant_id` or `event_props`: an id is a redemption handle, and
// a value that is never read cannot end up in a response, a log line or a test
// fixture. What survives the parse is a count and two instants per grant.
//
// FAIL CLOSED. The shape below is Claude Code's own (its zod schema for this
// block, read out of the 2.1.283 binary), and it can change without notice. A
// block that does not look like it is not evidence of zero resets, and a grant
// that does not look like one is not evidence of a reset, so either is dropped
// rather than guessed at: a missing row is a small loss, a count the account
// cannot actually spend is the confidently wrong number this panel exists not
// to show. CodexBar, which shipped this first, draws the same lines.
//
// Pure, and a leaf: quota.mjs is the only caller, and the tests reach every
// rule here without a network, a credential or a clock of their own.

/**
 * More grants than this in one block is not an inventory, it is a payload
 * nobody has seen. Every grant observed so far holds one reset.
 */
export const MAX_GRANT_RECORDS = 200;

/**
 * More resets than this available at once reads as a malformed block rather
 * than a generous one, and the row would print it with a straight face.
 */
export const MAX_AVAILABLE_RESETS = 50;

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * A grant's start or end as epoch milliseconds: `null` when it has none, and
 * `undefined` when it has one nobody can read. The difference matters — an
 * absent bound is an open one, an unreadable bound is a malformed grant, and
 * treating the second as the first would count a reset that may have lapsed.
 */
function bound(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** One grant, reduced to what counting needs, or null when it is malformed. */
function readGrant(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  if (!isCount(g.resets_left)) return null;
  // `resets_total` is optional, but when it is sent it has to be able to
  // contain `resets_left`. A grant that has more left than it ever held is
  // saying something false about at least one of the two.
  if (g.resets_total !== undefined && g.resets_total !== null
      && (!isCount(g.resets_total) || g.resets_total < g.resets_left)) return null;
  // Required, although Claude Code defaults it to false: a grant whose pause
  // state is unknown might be paused, and a paused reset cannot be used.
  if (typeof g.paused !== "boolean") return null;
  const startsAt = bound(g.starts_at);
  const endsAt = bound(g.ends_at);
  if (startsAt === undefined || endsAt === undefined) return null;
  return { resetsLeft: g.resets_left, paused: g.paused, startsAt, endsAt };
}

/**
 * The grants in a `cedar_ember` block, or null when the block says nothing
 * this deck can trust.
 *
 * Null covers every "we do not know": no block at all (a response to a request
 * that did not ask, or from a server that stopped sending it), `eligible` not
 * exactly `true` — which is also how the endpoint answers a client it does not
 * recognise, with `ineligible_reason: "surface"` — and a grant list that is not
 * a list or is implausibly long. An eligible block with no grants is an empty
 * list, which is a real answer: zero.
 *
 * A single malformed grant is dropped without hiding the others, the way both
 * Claude Code and CodexBar treat one.
 */
export function readResetGrants(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  if (block.eligible !== true) return null;
  const raw = block.grants ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_GRANT_RECORDS) return null;
  return raw.map(readGrant).filter(Boolean);
}

/**
 * What the Usage panel shows, from grants readResetGrants accepted: how many
 * resets can be spent at `now`, and when the first of them lapses.
 *
 * A grant counts when it is not paused, has resets left, has started and has
 * not ended. `usable_now` is deliberately not consulted: Claude sets it false
 * while the account is under its limit, because a reset only redeems against a
 * window that is full, and a reset saved for later is still a reset the user
 * owns.
 *
 * `nextExpiryAt` is epoch milliseconds, like the Codex row's, and null when no
 * counted grant has an end.
 *
 * Recomputed at every read rather than frozen at fetch time, because the
 * inventory is held between fetches: a grant that ends while it is held has to
 * stop being counted when it ends, not when the next fetch happens to land.
 */
export function availableResetCredits(grants, now) {
  if (!Array.isArray(grants)) return null;
  let availableCount = 0;
  let nextExpiryAt = null;
  for (const g of grants) {
    if (g.paused || g.resetsLeft <= 0) continue;
    if (g.startsAt !== null && g.startsAt > now) continue;
    if (g.endsAt !== null && g.endsAt <= now) continue;
    availableCount += g.resetsLeft;
    if (g.endsAt !== null && (nextExpiryAt === null || g.endsAt < nextExpiryAt)) nextExpiryAt = g.endsAt;
  }
  if (availableCount > MAX_AVAILABLE_RESETS) return null;
  return { availableCount, nextExpiryAt };
}

/** Both of the above, for a response read once and shown straight away. */
export function resetCreditsFrom(block, now) {
  return availableResetCredits(readResetGrants(block), now);
}
