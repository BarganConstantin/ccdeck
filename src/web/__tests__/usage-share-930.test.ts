// #930: paired decks share usage readings, so one of them polls each account.
//
// Anthropic budgets /api/oauth/usage per account, about thirty calls an hour
// across every machine holding it; ten decks each on claude-swap's own plan
// spend ten times that and the accounts show as rate limited. These cases pin
// the rules of usage-share.mjs on the wire — who owns an account (a deck on it
// first), what is sent, what is taken and what is refused — and then run ten
// decks against a fake
// claude-swap that keeps `import-usage --hold` the way the real one does
// (usage_store.adopt), counting the requests each account costs.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — .mjs server module, no types
import { createUsageShare, holdFor, rank, usageJson } from "../../server/usage-share.mjs";

type Win = { pct: number; resets_at?: string };
type Row = {
  email: string; organizationUuid: string; lastGood: { five_hour?: Win; seven_day?: Win } | null;
  fetchedAt: number | null; nextPollAt: number | null; backoffUntil: number | null; heldUntil: number | null;
  lastError?: string | null;
};
type Share = {
  refresh: (accounts: { key: string; alive: boolean; active?: boolean }[]) => Promise<void>;
  fieldFor: (key: Buffer, toFp: string, sent: { key: string; email: string; alive: boolean }[]) => { usage?: unknown };
  heard: (key: Buffer, frame: unknown, fromFp: string, list: { key: string; email: string; alive: boolean }[]) => Promise<void>;
  ownerOf: (key: string) => string | null;
  settled: () => Promise<void>;
};

const keyOf = (email: string, org: string) => `${email.toLowerCase()}@@${org}`;
const ACCOUNTS = [
  { email: "alice@x", org: "org-a" },
  { email: "bob@x", org: "org-b" },
  { email: "carol@x", org: "org-c" },
].map(a => ({ ...a, key: keyOf(a.email, a.org) }));

const SERVE_TTL_MS = 180_000;
const PLAN_MS = 300_000;

/**
 * One deck: a share, and a store standing in for its claude-swap. `tick` is
 * claude-swap's collector — it fetches a row that is stale, due and not held,
 * and counts it — and `importUsage` is `cswap import-usage --hold`: adopt a
 * newer reading, and hold the row until now + hold, never past an hour from
 * the measurement nor past the reading's earliest reset.
 */
function makeDeck(fp: string, clock: { t: number }, { canImport = true, alive = true } = {}) {
  const store = new Map<string, Row>();
  const fetches = new Map<string, number>();
  const imports: { holdS: number; keys: string[] }[] = [];
  for (const a of ACCOUNTS) {
    store.set(a.key, { email: a.email, organizationUuid: a.org, lastGood: null, fetchedAt: null, nextPollAt: null, backoffUntil: null, heldUntil: null });
  }
  const share: Share = createUsageShare({
    now: () => clock.t,
    myFp: () => fp,
    canImport: async () => canImport,
    readStore: async () => [...store.values()].filter(r => r.lastGood && r.fetchedAt != null).map(r => ({ ...r })),
    importUsage: async (doc: { accounts: { email: string; organizationUuid: string; usageAgeSeconds: number; usage: { fiveHour?: { pct: number; resetsAt?: string } } }[] }, holdS: number) => {
      imports.push({ holdS, keys: doc.accounts.map(a => keyOf(a.email, a.organizationUuid)) });
      for (const a of doc.accounts) {
        const r = store.get(keyOf(a.email, a.organizationUuid))!;
        const measured = clock.t - a.usageAgeSeconds * 1000;
        if (r.fetchedAt == null || measured > r.fetchedAt) {
          r.lastGood = { five_hour: { pct: a.usage.fiveHour!.pct, resets_at: a.usage.fiveHour!.resetsAt } };
          r.fetchedAt = measured;
        }
        r.heldUntil = Math.min(clock.t + holdS * 1000, r.fetchedAt + 3_600_000);
      }
      return true;
    },
  });
  const tick = () => {
    for (const [key, r] of store) {
      if (!alive) continue;
      if (r.heldUntil != null && r.heldUntil > clock.t) continue;
      if (r.backoffUntil != null && r.backoffUntil > clock.t) continue;
      const stale = r.fetchedAt == null || clock.t - r.fetchedAt > SERVE_TTL_MS;
      const due = r.nextPollAt == null || clock.t >= r.nextPollAt;
      if (!stale || !due) continue;
      fetches.set(key, (fetches.get(key) ?? 0) + 1);
      r.lastGood = { five_hour: { pct: 40, resets_at: new Date(clock.t + 4 * 3_600_000).toISOString() } };
      r.fetchedAt = clock.t;
      r.nextPollAt = clock.t + PLAN_MS;
    }
  };
  // `on`: the account this deck is on, which its manifest names as `current`.
  const deck = { fp, share, store, fetches, imports, tick, alive, on: null as string | null, list: () => [] as Listed[] };
  deck.list = () => ACCOUNTS.map(a => ({ key: a.key, email: a.email, alive, active: deck.on === a.key }));
  return deck;
}
type Listed = { key: string; email: string; alive: boolean; active: boolean };
type Deck = ReturnType<typeof makeDeck>;

/** One round between two decks, as lan-engine runs it: A asks with its
 *  manifest and B answers with its own; each keeps what it heard. */
async function round(a: Deck, b: Deck) {
  const key = randomBytes(32);
  const frame = (from: Deck, to: Deck) => ({
    t: "manifest", accounts: from.list(), ...(from.on ? { current: { key: from.on } } : {}),
    ...from.share.fieldFor(key, to.fp, from.list()),
  });
  await a.share.refresh(a.list());
  const heardA = b.share.heard(key, frame(a, b), a.fp, a.list());
  await b.share.refresh(b.list());
  const heardB = a.share.heard(key, frame(b, a), b.fp, b.list());
  await Promise.all([heardA, heardB]);
  // And a hold a refresh lifted behind the round.
  await Promise.all([a.share.settled(), b.share.settled()]);
}

/** Every pair, both ways, then every deck's collector: one minute. */
async function minute(decks: Deck[], clock: { t: number }) {
  for (const d of decks) d.tick();
  for (const a of decks) for (const b of decks) if (a !== b) await round(a, b);
  clock.t += 60_000;
}

const total = (decks: Deck[], key: string) => decks.reduce((n, d) => n + (d.fetches.get(key) ?? 0), 0);

describe("who owns an account", () => {
  it("is the same deck from every deck's view, without any vote", () => {
    const fps = ["aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb", "ccc-ccc-ccc-ccc"];
    for (const a of ACCOUNTS) {
      const best = [...fps].sort((x, y) => (rank(a.key, y) > rank(a.key, x) ? 1 : -1))[0];
      expect(fps.map(() => [...fps].reduce((m, fp) => (rank(a.key, fp) > rank(a.key, m) ? fp : m)))).toEqual([best, best, best]);
    }
  });

  it("holds for as long as the owner's next poll plus two rounds, or its backoff", () => {
    expect(holdFor({ nextS: 180, backoffS: null })).toBe(300);
    expect(holdFor({ nextS: 0, backoffS: null })).toBe(120);
    expect(holdFor({ nextS: 180, backoffS: 900 })).toBe(1020);
    expect(holdFor({ nextS: null, backoffS: null })).toBe(420);
    expect(holdFor({ nextS: 7200, backoffS: null })).toBe(3600);
  });

  it("puts a store row on the wire in cswap list --json's shape", () => {
    expect(usageJson({
      five_hour: { pct: 42, resets_at: "2026-10-28T10:00:00+00:00", countdown: "2h" },
      seven_day: { pct: 11 },
      scoped: [{ name: "opus", pct: 5, resets_at: "2026-11-01T00:00:00+00:00" }, { pct: 1 }],
      spend: { pct: 3, used: 1, limit: 30, currency: "USD" },
    })).toEqual({
      fiveHour: { pct: 42, resetsAt: "2026-10-28T10:00:00+00:00" },
      sevenDay: { pct: 11 },
      scoped: [{ name: "opus", pct: 5, resetsAt: "2026-11-01T00:00:00+00:00" }],
    });
    expect(usageJson(null)).toBeNull();
  });
});

/** Two decks, `hi` outranking `lo` for every account here, each having heard
 *  the other once. `hi` has a fresh reading of everything. */
async function pair() {
  const clock = { t: 1_800_000_000_000 };
  const fps = ["d1-111-111-111", "d2-222-222-222", "d3-333-333-333", "d4-444-444-444", "d5-555-555-555"];
  // Two fingerprints ordered the same way for all three accounts.
  let hiFp = "", loFp = "";
  for (const x of fps) for (const y of fps) {
    if (x !== y && !hiFp && ACCOUNTS.every(a => rank(a.key, x) > rank(a.key, y))) { hiFp = x; loFp = y; }
  }
  expect(hiFp).not.toBe("");
  const hi = makeDeck(hiFp, clock);
  const lo = makeDeck(loFp, clock);
  hi.tick();
  await round(hi, lo);      // they learn of each other; nothing is held yet
  return { clock, hi, lo };
}

describe("what goes over the wire", () => {

  it("sends the owner's readings and holds the lower deck off them until its next poll plus two rounds", async () => {
    const { hi, lo } = await pair();
    await round(hi, lo);
    expect(lo.imports.length).toBeGreaterThan(0);
    expect(lo.imports[0].holdS).toBe(holdFor({ nextS: 300, backoffS: null }));
    for (const a of ACCOUNTS) {
      expect(lo.store.get(a.key)!.heldUntil).toBeGreaterThan(0);
      expect(lo.store.get(a.key)!.lastGood?.five_hour?.pct).toBe(40);
    }
    // And the lower deck's collector leaves them alone.
    lo.tick();
    expect(total([lo], ACCOUNTS[0].key)).toBe(0);
  });

  it("never takes a hold from a deck it outranks", async () => {
    const { hi, lo } = await pair();
    lo.tick();                // lo has readings of its own now
    await round(lo, hi);
    expect(hi.imports).toEqual([]);
  });

  it("takes them from a lower deck when its own copy of the login cannot poll", async () => {
    const clock = { t: 1_800_000_000_000 };
    const { hi: hiFp, lo: loFp } = await pair().then(p => ({ hi: p.hi.fp, lo: p.lo.fp }));
    const lo = makeDeck(loFp, clock);
    const deadHi = makeDeck(hiFp, clock, { alive: false });
    lo.tick();
    await round(lo, deadHi);
    await round(lo, deadHi);
    expect(deadHi.imports.length).toBeGreaterThan(0);
  });

  it("refuses a reading that names another account, or carries numbers out of range", async () => {
    const { hi, lo } = await pair();
    const key = randomBytes(32);
    const { seal } = await import("../../server/lan-wire.mjs");
    const sealFor = (readings: unknown[]) => seal(key, JSON.stringify({ v: 1, readings }), `${hi.fp}->${lo.fp}|usage`);
    const good = { key: ACCOUNTS[0].key, email: "alice@x", organizationUuid: "org-a", ageS: 10, usage: { fiveHour: { pct: 10 } }, nextS: 60 };
    for (const bad of [
      { ...good, key: ACCOUNTS[1].key },
      { ...good, ageS: -1 },
      { ...good, ageS: 7200 },
      { ...good, usage: { fiveHour: { pct: 5000 } } },
      { ...good, usage: { fiveHour: { pct: 10, resetsAt: "not a time" } } },
      { ...good, usage: {} },
      { ...good, nextS: "soon" },
    ]) {
      lo.imports.length = 0;
      await lo.share.heard(key, { t: "manifest", accounts: hi.list(), usage: sealFor([bad]) }, hi.fp, hi.list());
      expect(lo.imports).toEqual([]);
    }
    // A seal that does not open is a deck that said nothing.
    await lo.share.heard(key, { t: "manifest", accounts: hi.list(), usage: sealFor([good]) }, "zzz-zzz-zzz-zzz", hi.list());
    expect(lo.imports).toEqual([]);
    // The good one, for contrast.
    await lo.share.heard(key, { t: "manifest", accounts: hi.list(), usage: sealFor([good]) }, hi.fp, hi.list());
    expect(lo.imports).toEqual([{ holdS: 180, keys: [ACCOUNTS[0].key] }]);
  });

  it("sends a reading only for an account the other deck offers", async () => {
    // Not ticked for this deck there, so not in its manifest: it says nothing
    // about holding that account, and is told nothing about it.
    const { hi, lo } = await pair();
    const key = randomBytes(32);
    const offered = lo.list().filter(a => a.key !== ACCOUNTS[1].key);
    await hi.share.heard(key, { t: "manifest", accounts: offered, ...lo.share.fieldFor(key, hi.fp, lo.list()) }, lo.fp, offered);
    await hi.share.refresh(hi.list());
    const field = hi.share.fieldFor(key, lo.fp, hi.list());
    lo.imports.length = 0;
    await lo.share.heard(key, { t: "manifest", accounts: hi.list(), ...field }, hi.fp, hi.list());
    expect(lo.imports.flatMap(i => i.keys).sort()).toEqual([ACCOUNTS[0].key, ACCOUNTS[2].key].sort());
  });

  it("hands a reading over once, not every round, until it is new or its hold runs short", async () => {
    const { clock, hi, lo } = await pair();
    await round(hi, lo);
    const first = lo.imports.length;
    clock.t += 60_000;
    await round(hi, lo);
    expect(lo.imports.length).toBe(first);
    clock.t += 300_000;       // the hold (300 s to the next poll + 120) now ends within 90 s
    await round(hi, lo);
    expect(lo.imports.length).toBeGreaterThan(first);
  });

  it("holds every deck through the owner's backoff after a 429", async () => {
    const { clock, hi, lo } = await pair();
    for (const r of hi.store.values()) r.backoffUntil = clock.t + 900_000;
    lo.imports.length = 0;
    await round(hi, lo);
    expect(lo.imports[0].holdS).toBe(holdFor({ nextS: 300, backoffS: 900 }));
  });

  it("says nothing of an account its own reads of are failing, so the others read for themselves", async () => {
    // This machine's network, its login, a timeout: nothing about the account.
    const { clock, hi, lo } = await pair();
    for (const r of hi.store.values()) Object.assign(r, { lastError: "network", backoffUntil: clock.t + 300_000 });
    await round(hi, lo);
    expect(lo.imports).toEqual([]);
  });

  it("passes a rate limit on with its backoff: that budget is the account's, on every machine", async () => {
    const { clock, hi, lo } = await pair();
    for (const r of hi.store.values()) Object.assign(r, { lastError: "http-429", backoffUntil: clock.t + 900_000 });
    await round(hi, lo);
    expect(lo.imports[0].holdS).toBe(holdFor({ nextS: 300, backoffS: 900 }));
  });

  it("says nothing once its own plan has lapsed, as a collector that stopped would", async () => {
    const { clock, hi, lo } = await pair();
    clock.t += 300_000 + 181_000;   // hi's next poll was due 181 s ago, and nothing fetched
    await round(hi, lo);
    expect(lo.imports).toEqual([]);
  });

  it("says nothing, and is no candidate, without import-usage", async () => {
    const clock = { t: 1_800_000_000_000 };
    const old = makeDeck("old-old-old-old", clock, { canImport: false });
    const peer = makeDeck("new-new-new-new", clock);
    await old.share.refresh(old.list());
    expect(old.share.fieldFor(randomBytes(32), peer.fp, old.list())).toEqual({});
    await round(old, peer);
    for (const a of ACCOUNTS) expect(peer.share.ownerOf(a.key)).toBe(peer.fp);
  });

  it("does not pass on a reading it is holding for another deck", async () => {
    const { hi, lo } = await pair();
    await round(hi, lo);
    const key = randomBytes(32);
    const third = makeDeck("t3-333-333-333", { t: 0 });
    await lo.share.refresh(lo.list());
    const field = lo.share.fieldFor(key, third.fp, lo.list()) as { usage?: unknown };
    // Whatever lo says to a third deck, its held rows are not in it.
    expect(JSON.stringify(field)).not.toContain(ACCOUNTS[0].email);
  });
});

// The manifest these ride in is what pairing and the shared logins run on, and
// a promise nobody handles ends the deck's process. So nothing here may throw
// into a round or reject, whatever a paired deck sends or claude-swap does.
describe("what cannot be read or done", () => {
  it("never breaks the manifest it came in, nor rejects", async () => {
    const { hi, lo } = await pair();
    const key = randomBytes(32);
    const frames = [null, undefined, 42, "x", { usage: 7 }, { usage: { iv: 1, ct: [] } }, { usage: {}, current: { key: 5 } }];
    for (const frame of frames) {
      let answer: Promise<void> | undefined;
      expect(() => { answer = lo.share.heard(key, frame, hi.fp, hi.list()); }).not.toThrow();
      await expect(answer).resolves.toBeUndefined();
    }
    await expect(lo.share.heard(key, { usage: {} }, hi.fp, null as never)).resolves.toBeUndefined();
    expect(lo.imports).toEqual([]);
  });

  it("leaves its own frame as an older deck sends it when the field cannot be sealed", async () => {
    const { hi, lo } = await pair();
    await hi.share.refresh(hi.list());
    expect(() => hi.share.fieldFor("not a key" as never, lo.fp, hi.list())).not.toThrow();
    expect(hi.share.fieldFor("not a key" as never, lo.fp, hi.list())).toEqual({});
  });

  it("sits the round out rather than throw into it when the store cannot be read", async () => {
    const share = createUsageShare({
      now: () => 0, myFp: () => "x", canImport: async () => true,
      readStore: async () => ({ not: "rows" }),
    });
    await expect(share.refresh([{ key: ACCOUNTS[0].key, alive: true }])).resolves.toBeUndefined();
    await expect(share.refresh(null as never)).resolves.toBeUndefined();
  });

  it("settles, never rejects, when claude-swap throws or the deck's name cannot be read", async () => {
    const { clock, hi, lo } = await pair();
    for (const [importUsage, peerName] of [
      [async () => { throw new Error("cswap gone"); }, () => "iMac"],
      [async () => true, () => { throw new Error("no name"); }],
    ] as const) {
      const share = createUsageShare({
        now: () => clock.t, myFp: () => lo.fp, canImport: async () => true, readStore: async () => [],
        importUsage, peerName, register: true,
      });
      await share.refresh(lo.list());
      const key = randomBytes(32);
      await hi.share.refresh(hi.list());
      const frame = { t: "manifest", accounts: hi.list(), ...hi.share.fieldFor(key, lo.fp, hi.list()) };
      await expect(share.heard(key, frame, hi.fp, hi.list())).resolves.toBeUndefined();
      await expect(share.settled()).resolves.toBeUndefined();
    }
  });
});

describe("a deck on the account", () => {
  // claude-swap reads the account a machine is on every five minutes at most
  // and every minute close to a limit; any other account up to every ten, and
  // never faster. So the owner is a deck on it, wherever the hash puts it.
  async function pairOnIt() {
    const clock = { t: 1_800_000_000_000 };
    const fps = ["d1-111-111-111", "d2-222-222-222", "d3-333-333-333", "d4-444-444-444", "d5-555-555-555"];
    let hiFp = "", loFp = "";
    for (const x of fps) for (const y of fps) {
      if (x !== y && !hiFp && ACCOUNTS.every(a => rank(a.key, x) > rank(a.key, y))) { hiFp = x; loFp = y; }
    }
    const hi = makeDeck(hiFp, clock);
    const lo = makeDeck(loFp, clock);
    hi.tick();
    await round(hi, lo);
    await round(hi, lo);      // lo now holds all three on hi's readings
    return { clock, hi, lo };
  }
  const A = ACCOUNTS[0].key;

  it("owns it before a deck that ranks higher and is on another account", async () => {
    const { hi, lo } = await pairOnIt();
    lo.on = A;
    hi.on = ACCOUNTS[1].key;
    await round(hi, lo);
    expect(lo.share.ownerOf(A)).toBe(lo.fp);
    expect(hi.share.ownerOf(A)).toBe(lo.fp);
    // The hash still decides where neither is on the account.
    expect(hi.share.ownerOf(ACCOUNTS[2].key)).toBe(hi.fp);
    expect(lo.share.ownerOf(ACCOUNTS[2].key)).toBe(hi.fp);
  });

  it("lifts the hold it took on it once it moves onto it, and its readings go the other way", async () => {
    const { clock, hi, lo } = await pairOnIt();
    expect(lo.store.get(A)!.heldUntil).toBeGreaterThan(clock.t);
    lo.on = A;
    await round(hi, lo);
    // `--hold 0` with lo's own reading, which replaces nothing.
    expect(lo.imports.at(-1)).toEqual({ holdS: 0, keys: [A] });
    expect(lo.store.get(A)!.heldUntil).toBeLessThanOrEqual(clock.t);
    expect(lo.store.get(A)!.lastGood?.five_hour?.pct).toBe(40);
    // The accounts hi still owns stay held.
    expect(lo.store.get(ACCOUNTS[1].key)!.heldUntil).toBeGreaterThan(clock.t);
    // lo's claude-swap reads A on its own plan now, and hi takes that reading.
    clock.t += 200_000;
    lo.tick();
    expect(lo.fetches.get(A)).toBe(1);
    hi.imports.length = 0;
    await round(hi, lo);
    expect(hi.imports.flatMap(i => i.keys)).toEqual([A]);
    const before = hi.fetches.get(A);
    clock.t += 200_000;
    hi.tick();
    expect(hi.fetches.get(A)).toBe(before);
  });

  it("lets a hold it finds at start run out, having taken it from nobody it knows", async () => {
    const clock = { t: 1_800_000_000_000 };
    const d = makeDeck("d1-111-111-111", clock);
    for (const r of d.store.values()) {
      r.lastGood = { five_hour: { pct: 12 } };
      r.fetchedAt = clock.t - 10_000;
      r.heldUntil = clock.t + 300_000;
    }
    d.on = A;
    await d.share.refresh(d.list());
    await d.share.settled();
    expect(d.imports).toEqual([]);
  });
});

describe("ten paired decks on the same three accounts", () => {
  const fps = Array.from({ length: 10 }, (_, i) => `d${i}${i}-${i}${i}${i}-${i}${i}${i}-${i}${i}${i}`);

  it("cost one deck's requests per account, not ten", async () => {
    const clock = { t: 1_800_000_000_000 };
    const decks = fps.map(fp => makeDeck(fp, clock));
    for (let m = 0; m < 120; m++) await minute(decks, clock);
    for (const a of ACCOUNTS) {
      // One deck on claude-swap's 5-minute plan for two hours is 24 fetches;
      // ten were 240. The first minute, before anyone has heard anyone, every
      // deck fetches once.
      const n = total(decks, a.key);
      expect(n).toBeLessThanOrEqual(24 + 10 + 2);
      expect(n).toBeGreaterThanOrEqual(24);
      const owner = decks.find(d => d.fp === decks[0].share.ownerOf(a.key))!;
      expect(owner.fetches.get(a.key)).toBeGreaterThanOrEqual(23);
    }
  });

  it("go on with the next deck in the ranking when the owner leaves", async () => {
    const clock = { t: 1_800_000_000_000 };
    let decks = fps.map(fp => makeDeck(fp, clock));
    for (let m = 0; m < 30; m++) await minute(decks, clock);
    const key = ACCOUNTS[0].key;
    const gone = decks[0].share.ownerOf(key);
    decks = decks.filter(d => d.fp !== gone);
    const before = total(decks, key);
    let lastFetch = clock.t;
    let longestGap = 0;
    for (let m = 0; m < 60; m++) {
      const n = total(decks, key);
      await minute(decks, clock);
      if (total(decks, key) > n) { longestGap = Math.max(longestGap, clock.t - lastFetch); lastFetch = clock.t; }
    }
    const after = total(decks, key) - before;
    // An hour on the 5-minute plan is 12; the hand-over may cost a few more.
    expect(after).toBeGreaterThanOrEqual(11);
    expect(after).toBeLessThanOrEqual(12 + 9);
    // Nobody is left holding for a deck that is gone for longer than a hold.
    expect(longestGap).toBeLessThanOrEqual((holdFor({ nextS: 300, backoffS: null }) + 180) * 1000);
    const next = decks[0].share.ownerOf(key);
    expect(next).not.toBe(gone);
    expect(decks.every(d => d.share.ownerOf(key) === next)).toBe(true);
  });

  it("leave each account to a deck on it, and pass it on when that deck switches", async () => {
    const clock = { t: 1_800_000_000_000 };
    const decks = fps.map(fp => makeDeck(fp, clock));
    const [A, , C] = ACCOUNTS.map(a => a.key);
    decks[3].on = A;
    decks[7].on = A;
    for (let m = 0; m < 30; m++) await minute(decks, clock);
    const ownerA = decks[0].share.ownerOf(A);
    expect([decks[3].fp, decks[7].fp]).toContain(ownerA);
    expect(decks.every(d => d.share.ownerOf(A) === ownerA)).toBe(true);

    // Both move to C: A goes back to the hash, C to one of them.
    decks[3].on = C;
    decks[7].on = C;
    const before = { A: total(decks, A), C: total(decks, C) };
    let lastFetch = clock.t;
    let longestGap = 0;
    for (let m = 0; m < 60; m++) {
      const n = total(decks, A);
      await minute(decks, clock);
      if (total(decks, A) > n) { longestGap = Math.max(longestGap, clock.t - lastFetch); lastFetch = clock.t; }
    }
    const ownerC = decks[0].share.ownerOf(C);
    expect([decks[3].fp, decks[7].fp]).toContain(ownerC);
    expect(decks.every(d => d.share.ownerOf(C) === ownerC)).toBe(true);
    const ownerA2 = decks[0].share.ownerOf(A);
    expect(decks.every(d => d.share.ownerOf(A) === ownerA2)).toBe(true);
    // An hour on the 5-minute plan is 12 per account; the hand-over a few more.
    expect(total(decks, A) - before.A).toBeLessThanOrEqual(12 + 4);
    expect(total(decks, C) - before.C).toBeLessThanOrEqual(12 + 4);
    // The new owner lifted its hold rather than sat it out.
    expect(longestGap).toBeLessThanOrEqual((300 + 120) * 1000);
  });

  it("leave a deck without import-usage polling for itself", async () => {
    const clock = { t: 1_800_000_000_000 };
    const decks = fps.slice(0, 3).map(fp => makeDeck(fp, clock));
    const old = makeDeck("old-old-old-old", clock, { canImport: false });
    const all = [...decks, old];
    for (let m = 0; m < 60; m++) await minute(all, clock);
    for (const a of ACCOUNTS) {
      expect(old.fetches.get(a.key)).toBeGreaterThanOrEqual(11);
      expect(decks.every(d => d.share.ownerOf(a.key) !== old.fp)).toBe(true);
      expect(total(decks, a.key)).toBeLessThanOrEqual(12 + 3 + 1);
    }
  });
});
