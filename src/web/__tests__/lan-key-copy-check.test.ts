// Taking a new key because another deck holds this one — only when one does.
//
// A ~/.claude copied to a second machine leaves two decks with one key, each
// filing the other's beacons as its own and invisible to it for good unless
// one of them moves. So a beacon carrying this deck's fingerprint from another
// process made it take a new key there and then. But a beacon proves nothing
// about who holds a key — the fingerprint is in every beacon this deck sends —
// and a new key is a stranger to every deck paired with this one: an
// invite-only pairing stays broken until somebody sends a new invite.
//
// So the beacon is now only where to look. The deck dials the address it names
// and pins its own key there; a deck that really holds the key completes that
// handshake, and only then is a new one taken — once, however many beacons
// keep arriving meanwhile. Its own listener, which holds the key too, is not a
// copy.
//
// Whole engines on loopback, with the beacon socket deaf and handed packets by
// the case; see lan-engine-rig.ts.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { hostId, identityFrom, PROTOCOL } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { mintInvite, readInvite } from "../../server/lan-invite.mjs";
import { rigDeck, stopAll, type RigDeck } from "./lan-engine-rig";

afterEach(stopAll);

/** A beacon wearing `fp`, from another process (`i`) and, when `h` is given,
 *  another machine, saying it listens on `port`. */
function wearing(to: RigDeck, fp: string, port: number, i: string, h?: string) {
  to.sock.deliver(Buffer.from(JSON.stringify({
    m: "CCDK", v: PROTOCOL, n: "Twin", f: fp, p: port, i, ...(h ? { h } : {}),
  })), "127.0.0.1");
}

/** A loopback port nothing listens on. */
async function closedPort() {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}

/** Long enough for a dial to loopback to be refused, answered or given up. */
const settle = () => new Promise(r => setTimeout(r, 300));

describe("a beacon carrying this deck's own fingerprint", () => {
  it("does not change the key when nothing at the address it names holds it", async () => {
    const keys: string[] = [];
    const d = await rigDeck("Deck-A", { deps: { onIdentity: (s: string) => keys.push(s) } });
    const fp = d.e.status().fp;
    const nobody = await closedPort();
    for (let n = 0; n < 5; n++) wearing(d, fp, nobody, `deadbeef${n}`);
    await settle();
    expect(keys, "a beacon alone replaced the deck's key").toEqual([]);
    expect(d.e.status().fp).toBe(fp);
  }, 20_000);

  it("does not take the deck's own listener for a copy", async () => {
    const keys: string[] = [];
    const d = await rigDeck("Deck-A", { deps: { onIdentity: (s: string) => keys.push(s) } });
    const fp = d.e.status().fp;
    wearing(d, fp, d.port, "deadbeef00", hostId({ hostname: "elsewhere", home: "/h" }));
    await settle();
    expect(keys, "the deck's own listener answering was read as another machine").toEqual([]);
    expect(d.e.status().fp).toBe(fp);
  }, 20_000);

  it("leaves an invite-only pairing working", async () => {
    const only = { pairingMode: "invite", autoAsk: false, autoAccept: false };
    // A takes a new key the way the deck does: kept, and restarted on.
    let a!: RigDeck;
    a = await rigDeck("Deck-A", { settings: only, deps: { onIdentity: (secret: string) => a.e.apply({ secret }) } });
    const b = await rigDeck("Deck-B", { settings: only });
    const code = readInvite(a.e.invite().token).code;
    const token = mintInvite({ addrs: [`127.0.0.1:${a.port}`], name: "Deck-A", code }).token;
    expect((await b.e.join(token)).ok, "the invite did not pair them").toBe(true);

    const fp = a.e.status().fp;
    wearing(a, fp, await closedPort(), "deadbeef01");
    await settle();
    expect(a.e.status().fp).toBe(fp);

    await b.e.round();
    type Row = { addr: string; port: number; peerFp?: string | null; last?: { error?: string } | null };
    const row = (b.e.status().peers as Row[]).find(p => p.addr === "127.0.0.1" && p.port === a.port);
    expect(row?.last?.error, "B's round no longer reaches A").toBeUndefined();
    expect(row?.peerFp).toBe(fp);
  }, 20_000);

  it("is never a deck a round pins, when an address somebody typed answers with the deck's own key", async () => {
    // The listener answers a caller holding its own key now, so a typed row
    // that reaches this deck itself must not read as a deck met for the first
    // time — pinned on sight, and trusted by every handler after.
    const d = await rigDeck("Deck-A", { settings: { autoAsk: false, autoAccept: false } });
    d.e.addPeer("127.0.0.1", d.port);
    await d.e.round();
    expect(d.e.status().trusted, "the deck pinned its own key").toEqual([]);
    const row = (d.e.status().peers as Array<{ port: number; last?: { error?: string } | null }>)
      .find(p => p.port === d.port);
    expect(row?.last?.error).toBe("that address answers with this deck's own key");
  }, 20_000);

  it("still takes a new key, once, when another deck really holds this one", async () => {
    const keys: string[] = [];
    const d = await rigDeck("Deck-A", { deps: { onIdentity: (s: string) => keys.push(s) } });
    const fp = d.e.status().fp;
    // The copy: the same key, its own process and port.
    const copy = await rigDeck("Deck-A", { settings: { secret: d.id.secret } });
    expect(copy.e.status().fp).toBe(fp);
    const elsewhere = hostId({ hostname: "the-copy", home: "/home/somebody" });

    wearing(d, fp, copy.port, "deadbeef02", elsewhere);
    await vi.waitFor(() => expect(keys).toHaveLength(1), { timeout: 5_000 });
    expect(identityFrom(keys[0]).fp, "the key handed over is the old one").not.toBe(fp);

    // More beacons from the copy while the new key is being put to work.
    for (let n = 0; n < 3; n++) wearing(d, fp, copy.port, "deadbeef02", elsewhere);
    await settle();
    expect(keys, "one copy made the deck take more than one key").toHaveLength(1);
  }, 20_000);
});
