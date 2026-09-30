// A beacon only moves where a round dials a paired deck after a handshake
// there has completed.
//
// A beacon from a paired deck's fingerprint set the address and port this deck
// dialled for it, with nothing to say the deck was really there, and kept that
// row dialled for a day. A deck reached by a typed address — the usual reason
// to type one is that its beacons never arrive — then had that typed row
// skipped, because the heard row "already dialled it", and every round failed
// at the beacon's address until the row aged out.
//
// Now the deck keeps the last address each paired deck completed a handshake
// at. A heard address that fails is followed in the same round by that one,
// or by the typed row that answered as the deck; a typed row is skipped only
// when the deck was reached some other way this round; and a heard address
// that never completed a handshake is dialled only while its beacons keep
// arriving.
//
// Two engines on loopback; see lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, PRESENT_MS } from "../../server/lan-sync.mjs";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const EMAIL = "heal@example.test";
const KEY = accountKey(EMAIL, "org-heal");
const HAND = { autoAsk: false, autoAccept: false };

/** A loopback port that takes a connection and drops it at once, counting. */
async function dropsEverything() {
  const seen = { n: 0 };
  const s = net.createServer(sock => { seen.n++; sock.destroy(); });
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as net.AddressInfo).port;
  return { port, seen, close: () => new Promise<void>(resolve => s.close(() => resolve())) };
}

/** A and B paired by the address A typed for B, and a login A holds that B can
 *  heal. A's clock is the case's. */
async function pairedByAddress(clock: { t: number }) {
  const mine: StoreRow[] = [{ num: 2, email: EMAIL, orgUuid: "org-heal", alive: true }];
  const a = await rigDeck("Deck-A", { rows: mine, shared: [KEY], settings: HAND, deps: { now: () => clock.t } });
  const b = await rigDeck("Deck-B", {
    rows: [{ num: 5, email: EMAIL, orgUuid: "org-heal", alive: true }], shared: [KEY], settings: HAND,
  });
  a.e.addPeer("127.0.0.1", b.port);
  await a.e.round();
  expect(b.e.accept(a.id.fp), "B had nothing to accept").toBeTruthy();
  await a.e.round();
  expect((a.e.status().trusted as Array<{ fp: string }>).map(t => t.fp)).toContain(b.id.fp);
  expect(a.imported, "nothing needed healing yet").toEqual([]);
  return { a, b, mine };
}

type Row = { id?: string; manual?: boolean; paired?: boolean; last?: { error?: string } | null };
const rowFor = (d: RigDeck, fp: string) => (d.e.status().peers as Row[]).find(p => p.id === fp);

describe("a beacon for a paired deck, naming an address where it does not answer", () => {
  it("does not stop the round healing from the address that works", async () => {
    const clock = { t: Date.now() };
    const { a, b, mine } = await pairedByAddress(clock);
    const elsewhere = await dropsEverything();
    try {
      announce(a, { fp: b.id.fp, port: elsewhere.port, name: "Deck-B" });
      mine[0].alive = false;
      await a.e.round();

      expect(a.imported, "the login was not healed").toHaveLength(1);
      expect(b.exported).toEqual([5]);
      // The beacon's address was tried first, as a moved deck's should be.
      expect(elsewhere.seen.n).toBe(1);
      // And the deck's row says how it went, not how the first try went.
      const row = rowFor(a, b.id.fp);
      expect(row).toMatchObject({ manual: true, paired: true });
      expect(row?.last?.error).toBeUndefined();
    } finally {
      await elsewhere.close();
    }
  }, 30_000);

  it("falls back to the address it last answered at, when no typed row is left", async () => {
    const clock = { t: Date.now() };
    const { a, b, mine } = await pairedByAddress(clock);
    const elsewhere = await dropsEverything();
    try {
      // Heard where it really is, and reached there, with nothing typed.
      announce(a, { fp: b.id.fp, port: b.port, name: "Deck-B" });
      a.e.setPeers([]);
      await a.e.round();
      expect(rowFor(a, b.id.fp)?.last?.error).toBeUndefined();

      announce(a, { fp: b.id.fp, port: elsewhere.port, name: "Deck-B" });
      mine[0].alive = false;
      await a.e.round();
      expect(elsewhere.seen.n).toBe(1);
      expect(a.imported, "the login was not healed").toHaveLength(1);
      expect(rowFor(a, b.id.fp)?.last?.error).toBeUndefined();
    } finally {
      await elsewhere.close();
    }
  }, 30_000);

  it("stops dialling that address once its beacons stop, well before a day", async () => {
    const clock = { t: Date.now() };
    const { a, b } = await pairedByAddress(clock);
    const elsewhere = await dropsEverything();
    try {
      announce(a, { fp: b.id.fp, port: elsewhere.port, name: "Deck-B" });
      await a.e.round();
      expect(elsewhere.seen.n).toBe(1);

      // No beacon since, and nothing ever answered there.
      clock.t += PRESENT_MS + 1_000;
      await a.e.round();
      expect(elsewhere.seen.n, "an address nothing answered at was dialled again").toBe(1);
      expect(rowFor(a, b.id.fp)?.last?.error).toBeUndefined();
    } finally {
      await elsewhere.close();
    }
  }, 30_000);
});
