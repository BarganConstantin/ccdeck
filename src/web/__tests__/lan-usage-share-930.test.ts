// #930 through two whole decks on loopback (lan-engine-rig.ts): the readings
// ride the manifest each round already exchanges, sealed, and only the deck
// that ranks lower for the account hands them to its claude-swap. The share
// rules on their own are usage-share-930.test.ts.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createUsageShare, rank } from "../../server/usage-share.mjs";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const X = accountKey(WORK, "org-w");

type Import = { holdS: number; emails: string[] };

async function deckWithShare(name: string, imports: Import[], { canImport = true } = {}) {
  const t = Date.now();
  // Read by reference each round, so a test can move the deck onto the account.
  const rows: StoreRow[] = [{ num: 1, email: WORK, orgUuid: "org-w", alive: true }];
  const deck = await rigDeck(name, {
    rows,
    shared: [X],
    settings: SHIPPED,
    deps: {
      importAccount: async () => true,
      usage: (deps: Record<string, unknown>) => createUsageShare({
        ...deps,
        canImport: async () => canImport,
        readStore: async () => [{
          email: WORK, organizationUuid: "org-w", lastGood: { five_hour: { pct: 33, resets_at: new Date(t + 3_600_000).toISOString() } },
          fetchedAt: t - 20_000, nextPollAt: t + 200_000, backoffUntil: null, heldUntil: null,
        }],
        importUsage: async (doc: { accounts: { email: string }[] }, holdS: number) => {
          imports.push({ holdS, emails: doc.accounts.map(a => a.email) });
          return true;
        },
      }),
    },
  });
  return Object.assign(deck, { rows });
}

async function exchange(a: RigDeck, b: RigDeck, times = 3) {
  for (let i = 0; i < times; i++) {
    await a.e.round();
    await b.e.round();
  }
}

describe("two paired decks holding the same account", () => {
  it("leave it to the one that ranks higher, and the other takes its reading with a hold", async () => {
    const importsA: Import[] = [];
    const importsB: Import[] = [];
    const a = await deckWithShare("A", importsA);
    const b = await deckWithShare("B", importsB);
    announce(a, { fp: b.id.fp, port: b.port, name: "B" });
    announce(b, { fp: a.id.fp, port: a.port, name: "A" });
    await exchange(a, b);

    const aOwns = rank(X, a.id.fp) > rank(X, b.id.fp);
    const lower = aOwns ? importsB : importsA;
    const upper = aOwns ? importsA : importsB;
    expect(upper).toEqual([]);
    expect(lower.length).toBeGreaterThan(0);
    expect(lower[0].emails).toEqual([WORK]);
    // ~200 s to the owner's next poll, plus two rounds, rounded up to 30 s.
    expect(lower[0].holdS).toBeGreaterThanOrEqual(300);
    expect(lower[0].holdS).toBeLessThanOrEqual(360);
    // Once: the same measurement is not handed over again every round.
    expect(lower.length).toBe(1);
  }, 30_000);

  it("leave it to the one that is on it, though the other ranks higher", async () => {
    const importsA: Import[] = [];
    const importsB: Import[] = [];
    const a = await deckWithShare("A", importsA);
    const b = await deckWithShare("B", importsB);
    const aOwnsByRank = rank(X, a.id.fp) > rank(X, b.id.fp);
    // The lower one goes onto the account, which its manifest says as `current`.
    (aOwnsByRank ? b : a).rows[0].active = true;
    announce(a, { fp: b.id.fp, port: b.port, name: "B" });
    announce(b, { fp: a.id.fp, port: a.port, name: "A" });
    await exchange(a, b);
    const [onIt, other] = aOwnsByRank ? [importsB, importsA] : [importsA, importsB];
    expect(onIt).toEqual([]);
    expect(other.length).toBe(1);
    expect(other[0].emails).toEqual([WORK]);
  }, 30_000);

  it("send nothing to, and take nothing from, a deck whose claude-swap has no import-usage", async () => {
    const importsA: Import[] = [];
    const importsOld: Import[] = [];
    const a = await deckWithShare("A", importsA);
    const old = await deckWithShare("Old", importsOld, { canImport: false });
    announce(a, { fp: old.id.fp, port: old.port, name: "Old" });
    announce(old, { fp: a.id.fp, port: a.port, name: "A" });
    await exchange(a, old);
    expect(importsA).toEqual([]);
    expect(importsOld).toEqual([]);
  }, 30_000);
});
