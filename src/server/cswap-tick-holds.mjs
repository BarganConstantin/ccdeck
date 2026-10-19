// Auto-switch, kept off the logins another deck is on (#2192).
//
// A tick is claude-swap's own decision — `cswap auto --once` reads the store,
// picks a target and switches — and ccdeck only says when to ask. So when a
// paired deck says it is on one of this store's accounts, nothing on this side
// could stop the tick landing there, and landing there puts one login live on
// two machines: the next renewal signs one of them out (see lan-elsewhere.mjs).
//
// claude-swap takes no "not that one, this time" — `cswap auto` has no exclude
// flag and reads no variable for it. What it does read is the rotation flag a
// person sets from an account's ⋯ ("hold out", `cswap disable`): a held-out
// slot is never an automatic target, and stays a valid manual one. So a tick
// that WOULD land on a login another deck is on holds those logins out for
// that one tick and puts them back after it, all inside the store lock the
// tick already takes, so nothing in the deck reads the store in between.
//
// ONLY WHEN IT WOULD LAND THERE. Holding out on every tick would rewrite
// sequence.json twice a minute per login for as long as a paired deck is on
// one — which, between one person's machines, is always. So the tick is asked
// first with `--dry-run`, which decides and changes nothing, and the holds are
// made only when that answer is one of those logins. A tick that switches
// nowhere — nearly all of them — costs one extra `cswap auto --dry-run` and no
// write at all, and only while some paired deck is on an account this store
// holds. With no such deck, a tick is exactly what it always was.
//
// THE PERSON'S OWN HOLDS ARE NOT TOUCHED. A slot already held out is not held
// again and not put back: its flag is the owner's, and this only ever lifts the
// ones it set.
//
// WRITTEN DOWN BEFORE IT IS DONE. Each hold is recorded in the loop's state file
// before `cswap disable` runs and dropped once `cswap enable` has put it back,
// so a deck killed in the middle of a tick finds the record at its next start
// and returns the slot to rotation (releaseLeft). Only a slot that still holds
// the same login is returned — a slot number reused since is somebody else's.
//
// WHEN NOTHING ELSE QUALIFIES, THE TICK STAYS PUT. claude-swap then answers
// with no switch, and the live account keeps working until its window is full.
// Switching onto a login another machine is using trades that for a sign-out on
// one of the two machines at the next renewal, so it is left to a person: a
// switch pressed in the panel still goes there, with the warning on the row.

/** How long one `cswap disable` / `cswap enable` may take: a flag in one file. */
const FLAG_TIMEOUT_MS = 30_000;

/** One rotation flag, set or lifted. `num` is a slot number (holdable made it
 *  an integer), so the vector is two fixed words and a number — the shape
 *  cswap-argv-position.test.ts counts. */
function setFlag(run, bin, verb, slot) {
  const num = Number(slot);
  return run(bin, [verb === "disable" ? "disable" : "enable", String(num)], { timeout: FLAG_TIMEOUT_MS });
}

/**
 * The slots a tick must not land on: accounts this store holds that a paired
 * deck says it is on (`elsewhere` — see namesByAccount), apart from the one
 * this deck is on — a tick never targets that — and apart from any the owner
 * has already held out. `keyOf` is the identity rule (accountKey).
 */
export function holdable(accounts, elsewhere, keyOf) {
  if (!elsewhere || elsewhere.size === 0 || !Array.isArray(accounts)) return [];
  const out = [];
  for (const a of accounts) {
    if (!a || a.active === true || a.disabled === true || !a.email) continue;
    const num = Number(a.num);
    if (!Number.isInteger(num) || num < 1) continue;
    const key = keyOf(a.email, a.orgUuid);
    if (!elsewhere.has(key)) continue;
    out.push({ num, email: a.email, org: a.orgUuid ?? "", decks: elsewhere.get(key) });
  }
  return out;
}

/** The slot a tick's output says it switched to — or, for `--dry-run`, would
 *  have — or null. claude-swap writes `to` as `{ number, email }`; a bare number
 *  is accepted too. */
export function switchTarget(stdout) {
  const lines = typeof stdout === "string" ? stdout.split("\n") : [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.event !== "switch") continue;
    const n = Number(e.to && typeof e.to === "object" ? e.to.number : e.to);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * One tick, steered off `holds` (see holdable). Returns `{ r, held }`: what the
 * tick's `run` answered — or `{ skipped }` when it was not run — and which
 * slots were held out for it.
 *
 * `run` and `bin` are exec.mjs's and cswapBin's; `journal` keeps the holds in
 * the loop's state file — `keep(list)` before a hold, `drop()` after they are
 * all put back.
 */
export async function steeredTick({ run, bin, timeout, holds, journal }) {
  // The tick, as cswap-auto-loop.mjs always ran it.
  const tick = () => run(bin, ["auto", "--once", "--json"], { timeout });
  if (!holds?.length) return { r: await tick(), held: [] };
  // The same tick asked to decide and change nothing.
  const probe = await run(bin, ["auto", "--once", "--json", "--dry-run"], { timeout });
  const to = switchTarget(probe?.stdout);
  if (to == null || !holds.some(h => h.num === to)) return { r: await tick(), held: [] };

  // It would land on one of them, so every one of them sits this tick out:
  // holding only that one would let the tick land on the next.
  const held = [];
  try {
    await journal.keep(holds);
    for (const h of holds) {
      const d = await setFlag(run, bin, "disable", h.num);
      if (d?.ok) held.push(h);
    }
    // A hold that did not take leaves the tick free to land where the probe
    // said, so it does not run. The next interval asks again.
    if (!held.some(h => h.num === to)) return { r: { skipped: "hold-failed" }, held };
    return { r: await tick(), held };
  } finally {
    const stuck = [];
    for (const h of held) {
      const e = await setFlag(run, bin, "enable", h.num).catch(() => null);
      if (!e?.ok) stuck.push(h);
    }
    // Whatever could not be put back stays written down for releaseLeft.
    await (stuck.length ? journal.keep(stuck) : journal.drop()).catch(() => {});
  }
}

/**
 * Put back what a tick held out and never returned — a deck stopped mid-tick.
 * `left` is the journal's list, `accounts` the store's rows now. Only a slot
 * that is still held out AND still holds the login that was held is returned;
 * the rest are dropped from the record, which is what the answer is.
 */
export async function releaseLeft({ run, bin, left, accounts, keyOf, journal }) {
  if (!Array.isArray(left) || left.length === 0) return;
  const rows = Array.isArray(accounts) ? accounts : [];
  const stuck = [];
  for (const h of left) {
    const row = rows.find(a => Number(a?.num) === Number(h?.num));
    if (!row || row.disabled !== true || !h?.email || keyOf(row.email, row.orgUuid) !== keyOf(h.email, h.org)) continue;
    const e = await setFlag(run, bin, "enable", h.num).catch(() => null);
    if (!e?.ok) stuck.push(h);
  }
  await (stuck.length ? journal.keep(stuck) : journal.drop()).catch(() => {});
}
