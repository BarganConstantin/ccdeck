// #1738: the heard list and the request list only ever grew.
//
// Every beacon with a fingerprint not yet heard added a row to the strangers
// map, and nothing but an accept, a no, the same machine's newer key or the
// Tailscale switch going off ever took one out — with the ask switch off (the
// setting recommended on a network somebody does not own) nothing asks them
// and drops them either. Beacons are UDP, so a host sending forged ones with a
// fresh fingerprint each time grew the heap without end, and every panel poll
// sorted the lot. Every handshake from a fresh key with the accept switch off
// did the same to the requests, and status() handed the panel all of them.
//
// Now a heard deck is forgotten once it has been quiet for as long as presence
// lasts — the window the list already drew by — and a request once its deck
// has stopped asking; and each list has a size it cannot pass, the deck heard
// or asked longest ago going first.
import { describe, it, expect, afterEach } from "vitest";
// Namespaces, so a case that reaches for something the fix adds fails on its
// own assertion rather than at link time.
// @ts-expect-error — plain .mjs server module, no types
import * as requestsMod from "../../server/lan-requests.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom } from "../../server/lan-sync.mjs";
import { announce, rigDeck, stopAll } from "./lan-engine-rig";

afterEach(stopAll);

const T0 = 1_790_550_000_000;
const DAY = 24 * 60 * 60_000;

/** A fingerprint in the beacon's own shape, one per `i`. */
const fpOf = (i: number) => {
  const h = i.toString(16).padStart(12, "0");
  return `${h.slice(0, 3)}-${h.slice(3, 6)}-${h.slice(6, 9)}-${h.slice(9, 12)}`;
};

/** One handshake with a key nobody has met — see lan-auto-accept-cap-1737. */
async function knock(port: number, myPort: number) {
  const id = identityFrom("");
  try {
    const conn = await connectToPeer({
      host: "127.0.0.1", port, fp: id.fp, pub: id.pub, secret: id.secret, name: `Caller-${myPort}`, myPort,
    });
    conn.sock.destroy();
  } catch { /* "waiting for them to accept" */ }
  return id;
}

/** The requests module on its own, with a clock the case moves. */
function requestsRig() {
  const clock = { t: T0 };
  const r = requestsMod.createRequests({
    now: () => clock.t,
    settings: () => ({ pairingMode: "automatic", autoAsk: false, autoAccept: false, tailscale: false }),
    routeTo: () => null,
    wasUnpaired: () => false,
    engineNow: () => ({ accept: () => null }),
    onChange: () => {},
    localAddresses: () => [],
  });
  return { r, clock };
}

describe("the decks this one has heard (#1738)", () => {
  it("forgets a deck gone quiet, whatever else was heard since", async () => {
    const clock = { t: T0 };
    const d = await rigDeck("Deck-A", { settings: { autoAsk: false }, deps: { now: () => clock.t } });
    const N = 20_000;
    for (let i = 0; i < N; i++) announce(d, { fp: fpOf(i), port: 40_000 + (i % 1000), name: `Ghost-${i}` });
    clock.t += 2 * DAY;
    announce(d, { fp: fpOf(N), port: 44_444, name: "Latest" });

    expect(d.e.accept(fpOf(0)), "a deck heard once two days ago could still be accepted").toBeNull();
    // The one heard just now is still somebody to accept.
    expect(d.e.accept(fpOf(N))).toMatchObject({ fp: fpOf(N), dialled: true });
  }, 30_000);

  it("keeps no more than a fixed number, however fast new ones arrive", () => {
    const { r } = requestsRig();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      r.heardStranger({ fp: fpOf(i), name: `Ghost-${i}`, addr: "192.168.1.5", port: 40_000, at: T0, via: "lan" });
    }
    let kept = 0;
    for (let i = 0; i < N; i++) if (r.seen(fpOf(i))) kept++;
    expect(kept, "every fingerprint heard was kept").toBeLessThan(N);
    expect(requestsMod.MAX_STRANGERS).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(requestsMod.MAX_STRANGERS);
    // Newest kept, oldest gone.
    expect(r.seen(fpOf(N - 1))).toBeTruthy();
    expect(r.seen(fpOf(0))).toBeNull();
  });
});

describe("the decks that asked (#1738)", () => {
  it("hands the panel no more than a fixed number of requests", async () => {
    const d = await rigDeck("Deck-A", { settings: { autoAsk: false, autoAccept: false } });
    for (let i = 0; i < 200; i++) await knock(d.port, 45_000 + i);
    const shown = d.e.status().pending.length;
    expect(shown, "every fresh key became a request in the panel").toBeLessThanOrEqual(32);
    expect(shown).toBeGreaterThan(0);
    expect(requestsMod.MAX_PENDING).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(requestsMod.MAX_PENDING);
  }, 60_000);

  it("keeps a request while its deck keeps asking, and drops one that stopped", () => {
    const { r, clock } = requestsRig();
    const ask = (fp: string) => r.askToAccept({ fp, pub: `pub-${fp}`, name: `Deck-${fp}`, addr: "192.168.1.5", port: 4800 });
    ask("steady");
    ask("gone");
    // The one still asking asks every round, for a day; the other never again.
    for (let t = 0; t <= DAY; t += 60_000) {
      clock.t = T0 + t;
      ask("steady");
    }
    expect(r.seen("gone"), "a request nobody has repeated for a day").toBeNull();
    expect(r.seen("steady")).toMatchObject({ at: T0 });
    expect(r.pendingRows().map((p: { fp: string }) => p.fp)).toEqual(["steady"]);
  });

  it("makes room by dropping the request asked longest ago", () => {
    const { r, clock } = requestsRig();
    const ask = (fp: string) => r.askToAccept({ fp, pub: `pub-${fp}`, name: `Deck-${fp}`, addr: "192.168.1.5", port: 4800 });
    // The first deck keeps asking; every other one asks once.
    ask("first");
    for (let i = 0; i < 200; i++) {
      clock.t += 1_000;
      ask(`once-${i}`);
      if (i % 4 === 0) ask("first");
    }
    expect(r.pendingRows().length).toBeLessThanOrEqual(32);
    expect(r.seen("first"), "a deck still asking was pushed out by ones that asked once").toBeTruthy();
  });
});
