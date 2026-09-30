// #1737: the accept switch had no limit.
//
// With it on, every handshake from a key this deck had not met was pinned, and
// the dial-back row for the caller's address and claimed port was added as
// though a person had typed it — `typed: true`, which MAX_AUTO_PEERS does not
// count — and written to prefs through onDial. One host looping over fresh keys
// and claimed ports made sixty pins and sixty kept dial rows in well under a
// second. Every later round dialled each row in turn, each with its own
// ten-second bell when the host dropped the SYN, and the rows survived restarts.
//
// What the switch creates is its own now: the dial-back is a row the deck added
// itself (capped, in memory, never written as an address somebody typed), and
// the pins it makes are capped too. Past the cap a request waits for a person,
// and a person's accept is kept exactly as before.
//
// One engine on loopback; the callers are bare handshakes, each with a key made
// for it. See lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
// Namespaces, so a case that reaches for something the fix adds fails on its
// own assertion rather than at link time.
// @ts-expect-error — plain .mjs server module, no types
import * as engineMod from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom } from "../../server/lan-sync.mjs";
import { rigDeck, stopAll } from "./lan-engine-rig";

afterEach(stopAll);

/** One handshake with a key nobody has met, claiming to listen on `myPort`.
 *  Refused — the listener has not been told to trust it — and that refusal is
 *  what raises the request the switch answers. */
async function knock(port: number, myPort: number) {
  const id = identityFrom("");
  try {
    const conn = await connectToPeer({
      host: "127.0.0.1", port, fp: id.fp, pub: id.pub, secret: id.secret, name: `Caller-${myPort}`, myPort,
    });
    conn.sock.destroy();
  } catch { /* "waiting for them to accept", which is the point */ }
  return id;
}

describe("what the accept switch may create on its own (#1737)", () => {
  it("adds no typed row, keeps no dial row and makes a bounded number of pins", async () => {
    const d = await rigDeck("Deck-A", { settings: { autoAsk: false, autoAccept: true } });
    for (let i = 0; i < 60; i++) await knock(d.port, 41_000 + i);

    const peers = d.e.status().peers as Array<{ typed?: boolean; manual?: boolean }>;
    expect(peers.filter(p => p.typed), "a switch's dial-back was recorded as an address somebody typed").toEqual([]);
    expect(d.dials, "the switch wrote dial rows into prefs").toEqual([]);
    expect(peers.filter(p => p.manual).length).toBeLessThanOrEqual(engineMod.MAX_AUTO_PEERS);

    expect(engineMod.MAX_AUTO_PINS).toBeGreaterThan(0);
    const pins = d.e.status().trusted as unknown[];
    expect(pins.length, "every fresh key was pinned").toBeLessThanOrEqual(engineMod.MAX_AUTO_PINS);
    // And the ones past the cap were not dropped: they are requests, waiting
    // for the press the switch no longer makes.
    expect(d.e.status().pending.length).toBeGreaterThan(0);
  }, 30_000);

  it("leaves a person's accept past the cap working, and kept", async () => {
    const d = await rigDeck("Deck-A", { settings: { autoAsk: false, autoAccept: true } });
    for (let i = 0; i < engineMod.MAX_AUTO_PINS; i++) await knock(d.port, 42_000 + i);
    expect(d.e.status().trusted).toHaveLength(engineMod.MAX_AUTO_PINS);

    const late = await knock(d.port, 43_000);
    expect(d.e.status().pending).toMatchObject([{ fp: late.fp }]);
    expect(d.e.accept(late.fp)).toMatchObject({ fp: late.fp, dialBack: { addr: "127.0.0.1", port: 43_000 } });
    expect(d.dials).toEqual(["127.0.0.1:43000"]);
    const row = (d.e.status().peers as Array<{ port: number; typed?: boolean }>).find(p => p.port === 43_000);
    expect(row?.typed).toBe(true);
  }, 30_000);
});
