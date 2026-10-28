// Usage readings between paired decks (#930).
//
// Anthropic budgets GET /api/oauth/usage per account — roughly thirty calls a
// rolling hour, shared by every machine holding that account, whatever token
// each one uses (claude-swap's poll_policy.py, realiti4/claude-swap#152). Each
// deck's claude-swap polls on its own plan, so ten machines on the same
// accounts spend ten budgets' worth, and the accounts panel shows them as rate
// limited.
//
// So among paired decks one polls each account and the others take its
// reading. Nothing is voted on: every deck ranks the decks it hears from that
// hold the account with a working login and speak this — first the ones on
// that account right now, then by a hash of the account and the deck — and the
// top one is the account's owner (rendezvous hashing). On it first, because
// that is the machine whose claude-swap reads it often: every five minutes at
// most and every minute close to a limit, where an account a machine is not on
// waits up to ten and never hurries. The owner puts its claude-swap row for the
// account into the manifest it already exchanges every round, sealed like the
// card; a deck that
// ranks lower hands it to its own claude-swap with `cswap import-usage --hold`,
// which keeps every collector on that machine off the account until the
// owner's next poll is due plus two rounds. A hold always ends on its own, so a
// deck that stops hearing goes back to polling for itself — today's behaviour —
// and two decks that disagree for a moment cost one fetch each, not a stall.
//
// Pairing is per pair and an account appears in a manifest only when it is
// ticked for that deck, so two decks can see different candidates. The rule
// that keeps that safe is the receiving one: a reading's hold is applied only
// when its sender outranks this deck for that account, so two decks that both
// believe they own it end with the higher one polling, never with neither.
//
// Times travel as ages, never as wall-clock times, so skewed clocks between the
// machines do not matter.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.mjs";
import { accountKey, heardCurrent, open, seal } from "./lan-sync.mjs";

const VERSION = 1;
// A paired deck stays a candidate this long after its last manifest: a round
// runs every minute each way (lan-round-timer.mjs), so this rides out one that
// failed without counting a deck that has gone.
const HEARD_FRESH_MS = 150_000;
// The hold runs to the owner's next planned poll (or the end of its backoff)
// plus two rounds, so the next reading arrives before the hold ends.
const SLACK_S = 120;
// claude-swap's own bounds: it never holds past an hour from the measurement
// (usage_store.TRUST_MAX_AGE_S), so an older reading is not worth sending.
const MAX_HOLD_S = 3600;
const MAX_AGE_S = 3600;
// When the owner's plan cannot be read: claude-swap's ceiling for an active
// account (poll_policy.py).
const DEFAULT_NEXT_S = 300;
// A reading already handed over is handed over again only when it is a new
// measurement, or when its hold would end within this.
const RENEW_BEFORE_MS = 90_000;
// Two readings of one account taken this close together are the same one.
const SAME_MEASUREMENT_MS = 5_000;
const MAX_READINGS = 50;
const MAX_SCOPED = 16;

/** The rendezvous score of deck `fp` for account `key`: the highest owns it. */
export function rank(key, fp) {
  return createHash("sha256").update(`${key}|${fp}`).digest("hex");
}

/** Where deck `fp` stands for account `key`: on it now first, then by rank.
 *  Every rank is the same length, so the strings compare as the pair would. */
export function standing(key, fp, onIt) {
  return `${onIt ? 1 : 0}${rank(key, fp)}`;
}

/** Bound to one connection AND one direction, like the card (lan-about.mjs). */
const usageAad = (fromFp, toFp) => `${fromFp}->${toFp}|usage`;

/** One window from claude-swap's store, in `cswap list --json`'s shape. */
function windowJson(w) {
  if (!w || typeof w.pct !== "number" || !Number.isFinite(w.pct) || w.pct < 0) return null;
  return { pct: w.pct, ...(typeof w.resets_at === "string" ? { resetsAt: w.resets_at } : {}) };
}

/**
 * A store row's `lastGood` as `cswap list --json` prints `usage`, which is what
 * `import-usage` reads back. The windows only: spend is not what the budget
 * problem is about, and an import replaces the whole reading.
 */
export function usageJson(lastGood) {
  const out = {};
  const five = windowJson(lastGood?.five_hour);
  const seven = windowJson(lastGood?.seven_day);
  if (five) out.fiveHour = five;
  if (seven) out.sevenDay = seven;
  const scoped = (Array.isArray(lastGood?.scoped) ? lastGood.scoped : []).slice(0, MAX_SCOPED).flatMap(s => {
    const w = windowJson(s);
    return w && typeof s.name === "string" && s.name ? [{ name: s.name, ...w }] : [];
  });
  if (scoped.length) out.scoped = scoped;
  return Object.keys(out).length ? out : null;
}

/** A peer's window, or null — numbers in range and a reset that parses. */
function readWindow(w) {
  if (!w || typeof w !== "object") return null;
  if (typeof w.pct !== "number" || !Number.isFinite(w.pct) || w.pct < 0 || w.pct > 1000) return null;
  if (w.resetsAt === undefined) return { pct: w.pct };
  if (typeof w.resetsAt !== "string" || w.resetsAt.length > 64 || !Number.isFinite(Date.parse(w.resetsAt))) return null;
  return { pct: w.pct, resetsAt: w.resetsAt };
}

/** A peer's `usage`, rebuilt from what checks out — never forwarded as sent. */
function readUsage(u) {
  if (!u || typeof u !== "object") return null;
  const out = {};
  for (const k of ["fiveHour", "sevenDay"]) {
    if (u[k] === undefined) continue;
    const w = readWindow(u[k]);
    if (!w) return null;
    out[k] = w;
  }
  if (u.scoped !== undefined) {
    if (!Array.isArray(u.scoped) || u.scoped.length > MAX_SCOPED) return null;
    const scoped = [];
    for (const s of u.scoped) {
      const w = readWindow(s);
      if (!w || typeof s.name !== "string" || !s.name || s.name.length > 64) return null;
      scoped.push({ name: s.name, ...w });
    }
    if (scoped.length) out.scoped = scoped;
  }
  return Object.keys(out).length ? out : null;
}

const seconds = v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86_400 * 7 ? v : null;

/** One reading off the wire, or null. `key` must be the account it names. */
function readReading(r) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.email !== "string" || !r.email || r.email.length > 320) return null;
  if (typeof r.organizationUuid !== "string" || r.organizationUuid.length > 64) return null;
  const key = accountKey(r.email, r.organizationUuid);
  if (r.key !== key) return null;
  const ageS = seconds(r.ageS);
  if (ageS == null || ageS > MAX_AGE_S) return null;
  const usage = readUsage(r.usage);
  if (!usage) return null;
  const nextS = r.nextS === undefined ? null : seconds(r.nextS);
  const backoffS = r.backoffS === undefined ? null : seconds(r.backoffS);
  if ((r.nextS !== undefined && nextS == null) || (r.backoffS !== undefined && backoffS == null)) return null;
  return { key, email: r.email, organizationUuid: r.organizationUuid, ageS, usage, nextS, backoffS };
}

/** How long a reading holds this deck's collectors off its account, in s. */
export function holdFor({ nextS, backoffS }) {
  const until = backoffS ?? nextS ?? DEFAULT_NEXT_S;
  return Math.min(MAX_HOLD_S, Math.ceil(until + SLACK_S));
}

// Who each account's reading here came from, for the accounts panel: one map
// for the deck's one engine, read by claude-accounts.mjs. `{ name, until }` by
// account key.
const _sources = new Map();

/** The paired deck this account's current reading came from, or null. */
export function sharedReadingFrom(key, now = Date.now()) {
  const s = _sources.get(key);
  return s && s.until > now ? s.name : null;
}

/**
 * Hand readings to this machine's claude-swap: `cswap import-usage <file>
 * --hold <s>`. A file rather than stdin because `run` closes stdin; it holds
 * account addresses and numbers, no credential, and is removed straight after.
 */
export async function importUsage(doc, holdS) {
  const { cswapBin } = await import("./cswap-install.mjs");
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-usage-"));
  const file = join(dir, "usage.json");
  try {
    await writeFile(file, JSON.stringify(doc), { mode: 0o600 });
    const r = await run(await cswapBin(), ["import-usage", file, "--hold", String(holdS)], { timeout: 30_000 });
    if (r.ok) (await import("./claude-accounts.mjs")).invalidateClaudeAccountsCache();
    return r.ok;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One deck's side of it, for its LAN engine.
 *
 * `readStore` answers claude-swap's stored readings (storedUsageReadings), and
 * `canImport` whether this deck's claude-swap has `import-usage`. A deck
 * without it says nothing and polls for itself, and nobody counts it as a
 * candidate. `peerName` names a paired deck for the panel. `register` makes
 * this instance the one sharedReadingFrom answers for; only the deck's own
 * engine sets it.
 */
export function createUsageShare({
  now = Date.now, myFp, readStore, canImport, importUsage: handOver = importUsage,
  peerName = () => null, register = false,
} = {}) {
  /** Fingerprint → `{ at, keys, all, current }`: the accounts each deck that
   *  speaks this offered in its last manifest — alive (`keys`, which make it a
   *  candidate) and at all (`all`, which it can be sent readings for) — and
   *  the one of them it is on, if it said. */
  const heardBy = new Map();
  /** Account key → `{ fp, measuredAt, holdUntil }`, for what was handed over. */
  const handed = new Map();
  /** The last store read: account key → stored reading. */
  let store = new Map();
  let capable = false;
  // Every account this deck holds, and the ones whose stored login works: a
  // reading is taken for any of them, but only a working login can poll.
  let mine = new Set();
  let mineAlive = new Set();
  // The account this deck is on, or null.
  let myCurrent = null;
  let chain = Promise.resolve();

  /** Read the store and the capability, and note which accounts this deck
   *  holds. Called with the accounts the manifest is built from. */
  const refresh = async accounts => {
    mine = new Set((accounts ?? []).map(a => a.key));
    mineAlive = new Set((accounts ?? []).filter(a => a.alive).map(a => a.key));
    myCurrent = (accounts ?? []).find(a => a.active)?.key ?? null;
    try { capable = (await canImport()) === true; } catch { capable = false; }
    if (!capable) return;
    try {
      const rows = await readStore();
      store = new Map(rows.map(r => [accountKey(r.email, r.organizationUuid), r]));
    } catch { store = new Map(); }
    release();
  };

  /** The decks that compete for `key`, this one included when it qualifies,
   *  each with where it stands. */
  const candidates = key => {
    const t = now();
    const out = [];
    if (capable && mineAlive.has(key)) out.push({ fp: myFp(), at: standing(key, myFp(), myCurrent === key) });
    for (const [fp, h] of heardBy) {
      if (t - h.at <= HEARD_FRESH_MS && h.keys.has(key)) out.push({ fp, at: standing(key, fp, h.current === key) });
    }
    return out;
  };

  const ownerOf = key => {
    let best = null;
    let bestAt = "";
    for (const c of candidates(key)) if (c.at > bestAt) { best = c.fp; bestAt = c.at; }
    return best;
  };

  /** This deck's reading of `key` for the wire, or null. */
  const readingOf = key => {
    const r = store.get(key);
    const t = now();
    if (!r || typeof r.fetchedAt !== "number") return null;
    // Held is somebody else's reading, kept here: not this deck's to pass on.
    if (typeof r.heldUntil === "number" && r.heldUntil > t) return null;
    const ageS = Math.max(0, (t - r.fetchedAt) / 1000);
    if (ageS > MAX_AGE_S) return null;
    const usage = usageJson(r.lastGood);
    if (!usage) return null;
    const reading = { key, email: r.email, organizationUuid: r.organizationUuid, ageS: Math.round(ageS), usage };
    if (typeof r.backoffUntil === "number" && r.backoffUntil > t) reading.backoffS = Math.ceil((r.backoffUntil - t) / 1000);
    if (typeof r.nextPollAt === "number") reading.nextS = Math.max(0, Math.ceil((r.nextPollAt - t) / 1000));
    return reading;
  };

  /**
   * The `usage` field for the manifest to `toFp` over `connKey`, or nothing
   * for a deck that cannot take part. `sent` is the list the manifest itself
   * carries: a reading goes only for an account in it, so nothing reaches a
   * deck that this deck did not already name to it.
   */
  const fieldFor = (connKey, toFp, sent) => {
    if (!capable || !connKey) return {};
    const theirs = heardBy.get(toFp);
    const readings = [];
    for (const a of sent ?? []) {
      if (readings.length >= MAX_READINGS) break;
      if (!a?.alive || !theirs?.all.has(a.key) || ownerOf(a.key) !== myFp()) continue;
      const r = readingOf(a.key);
      if (r) readings.push(r);
    }
    return { usage: seal(connKey, JSON.stringify({ v: VERSION, readings }), usageAad(myFp(), toFp)) };
  };

  /** Run one hand-over at a time: claude-swap writes one store. */
  const enqueue = job => { chain = chain.then(job, job); return chain; };

  /**
   * Lift the holds this deck took from a deck it now outranks, rather than sit
   * them out: that deck moved off the account, this one moved onto it, or that
   * one went quiet. `import-usage --hold 0` with this deck's own reading, a
   * second older than the stored one so it replaces nothing (usage_store.adopt),
   * and claude-swap reads the account on its own plan again. A deck that has
   * just started took nothing from anyone, and lets a hold it finds run out.
   */
  const release = () => {
    const t = now();
    for (const [key, h] of handed) {
      if (h.holdUntil <= t) { handed.delete(key); continue; }
      if (ownerOf(key) !== myFp()) continue;
      handed.delete(key);
      if (register) _sources.delete(key);
      const r = store.get(key);
      const usage = r && typeof r.heldUntil === "number" && r.heldUntil > t ? usageJson(r.lastGood) : null;
      if (!usage) continue;
      const doc = {
        schemaVersion: 1,
        accounts: [{
          email: r.email, organizationUuid: r.organizationUuid,
          usageStatus: "ok", usageAgeSeconds: Math.max(0, (t - r.fetchedAt) / 1000) + 1, usage,
        }],
      };
      // A lift that fails leaves a hold that ends on its own.
      enqueue(async () => { try { await handOver(doc, 0); } catch { /* as above */ } });
    }
  };

  /**
   * What `fromFp` said in its manifest: whether it speaks this, which
   * accounts it offers alive (`list`, as keepManifest read it), and the
   * readings it sends. Answers the hand-over it started, for tests.
   */
  const heard = (connKey, frame, fromFp, list) => {
    const text = frame?.usage && typeof frame.usage === "object" ? open(connKey, frame.usage, usageAad(fromFp, myFp())) : null;
    let payload = null;
    try { payload = text == null ? null : JSON.parse(text); } catch { payload = null; }
    if (!payload || payload.v !== VERSION || !Array.isArray(payload.readings) || payload.readings.length > MAX_READINGS) {
      heardBy.delete(fromFp);
      return Promise.resolve();
    }
    const offeredAlive = new Set((list ?? []).filter(a => a.alive).map(a => a.key));
    const current = heardCurrent(frame.current, list ?? [])?.key ?? null;
    heardBy.set(fromFp, { at: now(), keys: offeredAlive, all: new Set((list ?? []).map(a => a.key)), current });
    if (!capable) return Promise.resolve();

    const t = now();
    const groups = new Map();
    for (const raw of payload.readings) {
      const r = readReading(raw);
      if (!r || !offeredAlive.has(r.key) || !mine.has(r.key)) continue;
      // Only from a deck that outranks this one for the account, unless this
      // one cannot poll it at all. A lower one that believes it owns it will
      // hear this deck's readings and stop.
      if (mineAlive.has(r.key)
        && !(standing(r.key, fromFp, current === r.key) > standing(r.key, myFp(), myCurrent === r.key))) continue;
      const measuredAt = t - r.ageS * 1000;
      const holdS = holdFor(r);
      const prev = handed.get(r.key);
      if (prev && prev.fp === fromFp && Math.abs(prev.measuredAt - measuredAt) < SAME_MEASUREMENT_MS
        && prev.holdUntil - t > RENEW_BEFORE_MS) continue;
      // One import per hold, rounded up to 30 s so a round's readings share one.
      const bucket = Math.ceil(holdS / 30) * 30;
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push({ r, measuredAt });
    }
    if (!groups.size) return Promise.resolve();

    return enqueue(async () => {
      for (const [holdS, items] of groups) {
        const doc = {
          schemaVersion: 1,
          accounts: items.map(({ r }) => ({
            email: r.email, organizationUuid: r.organizationUuid,
            usageStatus: "ok", usageAgeSeconds: Math.max(0, (now() - t) / 1000 + r.ageS), usage: r.usage,
          })),
        };
        let ok = false;
        try { ok = await handOver(doc, holdS); } catch { ok = false; }
        if (!ok) continue;
        const until = t + holdS * 1000;
        for (const { r, measuredAt } of items) {
          handed.set(r.key, { fp: fromFp, measuredAt, holdUntil: until });
          if (register) _sources.set(r.key, { name: peerName(fromFp), until });
        }
      }
    });
  };

  /** Settles once every hand-over and lift queued so far has run, for tests. */
  const settled = () => chain.then(() => {});

  // A deck that was unpaired sends no manifest, and stops counting once it has
  // not been heard for HEARD_FRESH_MS.
  return { refresh, fieldFor, heard, ownerOf, settled };
}
