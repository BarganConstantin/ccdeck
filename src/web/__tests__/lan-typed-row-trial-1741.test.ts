// #1741: a typed address was taken away after one failed round.
//
// A paired deck that calls in from somewhere nothing here dials is given a
// dial-back row on trial, and a round that cannot reach it takes the row away
// again (see learnCaller in lan-engine.mjs). The trial was started whenever
// `addPeer` said yes — and it says yes for an address already on the list, a
// typed one included, while leaving that row typed. So a deck restarted (its
// typed rows back from prefs, its record of who answered where gone), called
// in by the paired deck from exactly the typed address before this one had
// reached it, and one failed round later the address somebody typed was gone.
// #1674's rule is the opposite: a typed row stays, failing, and says why.
//
// The list on its own, then two engines on loopback; see lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createDials } from "../../server/lan-dials.mjs";
import { rigDeck, stopAll } from "./lan-engine-rig";

afterEach(stopAll);

type Row = { addr: string; port: number; manual?: boolean; typed?: boolean; last?: { error?: string } | null };

describe("a typed row and a trial (#1741)", () => {
  it("is never put on trial, so a failed round never takes it away", () => {
    const d = createDials();
    d.add("10.0.0.5", 4800);
    // What learnCaller does when a paired deck calls in from that address.
    expect(d.add("10.0.0.5", 4800, { typed: false })).toBe(true);
    d.trial("10.0.0.5:4800", { fp: "fp-a", name: "A" });
    expect(d.failed("10.0.0.5:4800"), "a typed row was on trial").toBe(false);
    expect(d.rows()).toEqual([expect.objectContaining({ addr: "10.0.0.5", port: 4800, typed: true })]);
    // Who called from there is still known, so the row reads as that deck.
    expect(d.metAt("10.0.0.5:4800")).toEqual({ fp: "fp-a", name: "A" });
  });

  it("survives a restart, a call from the paired deck and a round that cannot reach it", async () => {
    const hand = { autoAsk: false, autoAccept: false };
    const a = await rigDeck("Deck-A", { settings: hand });
    const b = await rigDeck("Deck-B", { settings: hand });
    // Paired by address: B typed A's, A pressed accept and dials B back.
    b.e.addPeer("127.0.0.1", a.port);
    await b.e.round();
    expect(a.e.accept(b.id.fp), "A had nothing to accept").toBeTruthy();
    await b.e.round();
    const trusted = b.trustWrites.at(-1);
    expect(trusted?.map(t => t.fp), "B never pinned A").toContain(a.id.fp);

    // B restarts: its key, its pins, its port and its typed rows come back
    // from prefs; what answered at each address does not.
    const port = b.port;
    b.e.stop();
    const b2 = await rigDeck("Deck-B", { settings: { ...hand, secret: b.id.secret, trusted, port } });
    expect(b2.port).toBe(port);
    b2.e.setPeers([`127.0.0.1:${a.port}`]);

    // A calls in from exactly the address B typed, before B has reached it.
    await a.e.round();
    a.e.stop();
    await b2.e.round();

    const row = (b2.e.status().peers as Row[]).find(p => p.addr === "127.0.0.1" && p.port === a.port);
    expect(row, "the typed address was taken away").toBeTruthy();
    expect(row).toMatchObject({ manual: true, typed: true });
    expect(row?.last?.error, "the row does not say why it failed").toBeTruthy();
  }, 30_000);
});
