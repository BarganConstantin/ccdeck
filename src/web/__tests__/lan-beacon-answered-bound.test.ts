// A deck answers each deck it has never heard once, so the second deck to start
// is not blind for thirty seconds — and remembers whom it answered, so a deck
// nobody accepts is not answered on every packet. That memory is one entry per
// fingerprint, and a fingerprint is sixteen hex characters anybody on the
// network can make up. It keeps the newest few hundred, the way the heard and
// asked lists do (#1738): the oldest goes first, and a deck forgotten that way
// is answered once more if it is heard again, which costs one packet.
//
// The beacon on a socket the test owns, with a clock the test moves past the
// reply cooldown between packets.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createBeacon } from "../../server/lan-beacon.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { PROTOCOL } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { MAX_STRANGERS } from "../../server/lan-requests.mjs";

/** A made-up fingerprint for the n-th stranger. */
const fpOf = (n: number) => n.toString(16).padStart(12, "0").match(/.{3}/g)!.join("-");

function rig() {
  const clock = { t: 1_790_550_000_000 };
  const sent: Buffer[] = [];
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const sock = {
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(msg: Buffer, _p: number, _a: string, cb?: (e: Error | null) => void) { sent.push(msg); cb?.(null); },
    close() { /* nothing to release */ },
  };
  const b = createBeacon({
    port: 51234, name: "Here", fp: "fff-fff-fff-fff", createSocket: () => sock, ifaces: () => ({}), now: () => clock.t,
  });
  /** One stranger's beacon, a cooldown after the last packet. */
  const hear = (n: number) => {
    clock.t += 2_500;
    const packet = Buffer.from(JSON.stringify({ m: "CCDK", v: PROTOCOL, n: `Deck-${n}`, f: fpOf(n), p: 4319, i: "0badc0de" }));
    handlers.get("message")?.(packet, { address: "192.168.1.42" });
  };
  return { b, sent, hear };
}

describe("the decks a beacon has answered", () => {
  it("answers a deck heard again only once while it is among the newest", async () => {
    const { b, sent, hear } = rig();
    await b.start();
    hear(0);
    for (let n = 1; n <= 10; n++) hear(n);
    const before = sent.length;
    hear(0);
    expect(sent.length, "a deck it had just answered was answered again").toBe(before);
    b.stop();
  });

  it("keeps no more of them than the heard list does, oldest out first", async () => {
    const { b, sent, hear } = rig();
    await b.start();
    hear(0);
    for (let n = 1; n <= MAX_STRANGERS + 10; n++) hear(n);
    const before = sent.length;
    hear(0);
    expect(sent.length, "the first deck answered was never forgotten").toBe(before + 1);
    b.stop();
  });
});
