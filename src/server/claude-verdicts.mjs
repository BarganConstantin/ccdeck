// claude-swap's own verdict on each account, asked for rather than read.
//
// Everything else the accounts panel shows is read straight out of the store
// claude-swap writes (claude-accounts.mjs). The verdict is the one thing that
// is not in a file: it is what `cswap list --json` answers when asked, so it
// comes with a subprocess, a queue that keeps that to one child at a time, and a
// cache with its own clock. claude-accounts.mjs puts the cached verdict on each
// roster row and asks for a new one when its collector nudge finds a
// collection due.
import { cswapBin } from "./cswap-install.mjs";
import { run } from "./exec.mjs";
// The identity of one account, spelled once. claude-swap keys on `(email,
// organizationUuid)`; the verdict cache files each verdict under the pair it was
// collected for, and lan-copies.mjs (which lan-sync.mjs re-exports) matches
// accounts across two stores on the same pair. Nothing either of them imports
// reaches this file, so the edge closes no cycle.
import { accountKey } from "./lan-sync.mjs";

/**
 * What claude-swap says about each slot, in its own words.
 *
 * `usage.json` records numbers and a failure COUNTER; `cswap list --json`
 * records a per-slot VERDICT, and the two answer different questions. Measured
 * on the machine this was written for, at one instant, for the same account:
 *
 *   usage.json  ->  consecutiveFailures: 0, lastError: null
 *   cswap list  ->  usageStatus: "no_credentials"
 *
 * Three verdicts, three different things for a person to do — `no_credentials`
 * is an account to receive or re-add, `relogin_required` is one to sign into,
 * `keychain_unavailable` is not about the account at all but about the process
 * asking. The counter can tell none of them apart, and for two of the three it
 * reads zero.
 *
 * WHERE IT COMES FROM COSTS NOTHING EXTRA. nudgeCollector already spawns
 * `cswap list` when a collection is due, and threw the output away. It now asks
 * for `--json` and keeps the verdicts. Still not awaited by anyone — the nudge
 * stays synchronous for its callers — and still one child at a time.
 */
let _verdicts = { at: 0, byNum: {}, identities: {} };
/** Stale after this, because a verdict that outlives its cause is worse than no
 *  verdict: "no credentials" under an account somebody has since signed into is
 *  a sentence that sends them to fix what is already fixed. */
const VERDICT_TTL_MS = 10 * 60_000;
/** Long enough for a cold collection over a slow network, short enough that a
 *  wedged claude-swap does not hold a child for the rest of the day. */
const VERDICT_TIMEOUT_MS = 90_000;
/** Run one `cswap list --json` at a time. A post-write question must start
 * after any older collection has finished; routine readers can share the
 * latest pending answer without starting another slow collection. */
export function createVerdictQueue(collect) {
  let pending = null;
  return {
    ask({ fresh = false } = {}) {
      if (pending && !fresh) return pending;
      const previous = pending;
      // Start the first poll immediately: requestCollection promises the UI that
      // its refresh has started before it returns. Only subsequent fresh polls
      // wait for the earlier snapshot to finish.
      let next;
      if (previous) next = previous.then(collect, collect);
      else {
        try { next = Promise.resolve(collect()); }
        catch (error) { next = Promise.reject(error); }
      }
      pending = next;
      void next.then(
        () => { if (pending === next) pending = null; },
        () => { if (pending === next) pending = null; },
      );
      return next;
    },
    busy() { return pending !== null; },
  };
}

/**
 * Ask claude-swap about one account RIGHT NOW, rather than reading the cache.
 *
 * The cached verdicts are ten minutes old at worst, which is right for a label
 * and wrong for a decision that writes a credential: somebody who signed in two
 * minutes ago still reads as `no_credentials` there, and acting on that would
 * replace the login they just created with a peer's.
 *
 * Matched on IDENTITY rather than on the slot number, because a number is a
 * position in one machine's store and the caller is holding an account.
 *
 * Returns null when the question cannot be answered — no claude-swap, a refusal,
 * an account it does not know. Null is not `no_credentials`, and the one caller
 * treats it as "do not act".
 */
export async function verdictNow(email, org, { runner = run, bin = cswapBin } = {}) {
  const want = String(email ?? "").trim().toLowerCase();
  if (!want) return null;
  const all = await verdictsNow({ runner, bin, fresh: true });
  return all?.find(a => a.email === want && a.org === (org ?? ""))?.status ?? null;
}

/**
 * Every account's verdict from ONE `cswap list --json`, as `{ email, org,
 * status, active }` rows (email lower-cased, status null when claude-swap gave none),
 * or null when the question could not be asked at all.
 *
 * For a caller holding several identities at once — a round that imported
 * three logins asks once, not three times, since each ask is a full usage
 * collection that can take a minute on a cold network.
 */
async function collectVerdicts({ runner, bin }) {
  try {
    const out = await runner(await bin(), ["list", "--json"], { timeout: VERDICT_TIMEOUT_MS });
    if (!out?.ok) return null;
    const d = JSON.parse(out.stdout);
    // The same freshly-read answer feeds the cache the panel draws from, since
    // it cost a subprocess either way.
    const byNum = readVerdicts(out.stdout);
    const identities = {};
    for (const a of Array.isArray(d?.accounts) ? d.accounts : []) {
      if (Number.isInteger(a?.number) && typeof a?.email === "string" && a.email.trim()) {
        identities[String(a.number)] = accountKey(a.email, a.organizationUuid);
      }
    }
    _verdicts = { at: Date.now(), byNum, identities };
    return (Array.isArray(d?.accounts) ? d.accounts : []).map(a => ({
      number: a?.number,
      email: String(a?.email ?? "").trim().toLowerCase(),
      org: a?.organizationUuid ?? "",
      status: typeof a?.usageStatus === "string" ? a.usageStatus : null,
      // For the account Claude Code is signed in as, claude-swap reads the
      // LIVE credential, not the stored copy — so its verdict there is about
      // the live login. See checkImports.
      active: a?.active === true,
    }));
  } catch { return null; }
}

export const verdictQueue = createVerdictQueue(() => collectVerdicts({ runner: run, bin: cswapBin }));

/** Routine readers share a collection; post-write callers wait for any older
 * collection and start a new one, so they never inspect the pre-write store. */
export function verdictsNow({ runner = run, bin = cswapBin, fresh = false } = {}) {
  // Tests and callers supplying their own runner must receive their own answer.
  if (runner !== run || bin !== cswapBin) return collectVerdicts({ runner, bin });
  return verdictQueue.ask({ fresh });
}

/** claude-swap's verdict for a slot, or null when there is none fresh enough. */
export function verdictFor(num, now, email, org) {
  return cachedVerdictFor(_verdicts, num, now, email, org);
}

/** Only attach a cached slot verdict to the identity it was collected for. */
export function cachedVerdictFor(cache, num, now, email, org) {
  if (now - cache.at > VERDICT_TTL_MS) return null;
  const identity = accountKey(email, org);
  if (cache.identities[String(num)] !== identity) return null;
  const v = cache.byNum[String(num)];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Read the verdicts out of a `cswap list --json` payload. Tolerant by
 *  construction: this is another tool's output, and a shape we do not recognise
 *  means no verdicts rather than a thrown boot. */
export function readVerdicts(stdout) {
  try {
    const d = JSON.parse(stdout);
    const out = {};
    for (const a of Array.isArray(d?.accounts) ? d.accounts : []) {
      if (typeof a?.number === "number" && typeof a?.usageStatus === "string") {
        out[String(a.number)] = a.usageStatus;
      }
    }
    return out;
  } catch { return {}; }
}
