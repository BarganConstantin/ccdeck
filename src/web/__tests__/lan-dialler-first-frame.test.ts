// The dialling end refuses an `ok` that arrives before any challenge, and a
// frame handler's throw keeps its error.
//
// The dialler's check before trusting `ok` was `msg.fp !== theirFp`. `theirFp`
// is null until a challenge is accepted, so an `ok` sent as the very FIRST frame
// with `fp: null` matched it and walked into `proof` with no key, which throws.
// Before #1146 that throw ended the deck — and a deck with LAN sync on dials the
// addresses beacons announce. #1146's catch in frameReader turned it into a
// "bad frame" refusal, which survived it by accident and dropped the error. The
// check now asks for a challenge first, and the catch passes the error on.
//
// And a third deck, which answers in order and presents a paired deck's key:
// the pin passes, because a public key is public, and only the proof in `ok`
// is left to say it is not that deck (#1171).

import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer, frameReader } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { challengeFor, handshakeTranscript, identityFrom, proof, sessionKey } from "../../server/lan-sync.mjs";

type Identity = { fp: string; pub: string; secret: string };
const identity = identityFrom as (secret: string) => Identity;
const dial = connectToPeer as (o: Record<string, unknown>) => Promise<unknown>;

// A deck at the dialled address that answers the hello with an `ok` before any
// challenge, naming no fingerprint.
const PORT = 4730;
const liar = net.createServer(sock => {
  sock.on("error", () => { /* the dialler hangs up on it */ });
  sock.once("data", () => { sock.write(JSON.stringify({ t: "ok", fp: null, name: "x", proof: "00" }) + "\n"); });
});
await new Promise<void>((resolve, reject) => {
  liar.once("error", reject);
  liar.listen(PORT, "127.0.0.1", () => resolve());
});
afterAll(() => new Promise<void>(done => liar.close(() => done())));

// A deck at the dialled address wearing a paired deck's key. It holds a key of
// its own and does everything that key allows: it answers the hello in order,
// presents the victim's public key and fingerprint in its challenge — both are
// in every beacon the victim sends — and in `ok` sends the best proof it can
// make, which is over the real transcript and under its own key rather than
// the victim's. It says it does not seal, as a deck from before #810 does, so
// what a dialler that believed it would send next is the plain manifest.
const IMPOSTOR_PORT = 4731;
const victim = identity("");
const imposter = identity("");
const impostor = net.createServer(sock => {
  sock.on("error", () => { /* the dialler hangs up on it */ });
  sock.setEncoding("utf8");
  const mine = (challengeFor as (o: { seals: boolean }) => string)({ seals: false });
  let hello: { fp: string; pub: string; challenge: string } | null = null;
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.t === "hello") {
        hello = msg;
        sock.write(JSON.stringify({ t: "challenge", fp: victim.fp, pub: victim.pub, name: "Victim", challenge: mine }) + "\n");
      } else if (msg.t === "auth" && hello) {
        const key = sessionKey(imposter.secret, hello.pub, handshakeTranscript(hello.fp, victim.fp, hello.challenge, mine));
        sock.write(JSON.stringify({
          t: "ok", fp: victim.fp, name: "Victim",
          proof: proof(key, { challenge: mine, peerChallenge: hello.challenge, fromFp: victim.fp, toFp: hello.fp, direction: "reply" }),
        }) + "\n");
      }
    }
  });
});
await new Promise<void>((resolve, reject) => {
  impostor.once("error", reject);
  impostor.listen(IMPOSTOR_PORT, "127.0.0.1", () => resolve());
});
afterAll(() => new Promise<void>(done => impostor.close(() => done())));

describe("an `ok` before any challenge", () => {
  it("is refused as out of order, not caught as a throw", async () => {
    const me = identity("");
    const err = await dial({
      host: "127.0.0.1", port: PORT, fp: me.fp, pub: me.pub, secret: me.secret, name: "dialler", timeoutMs: 3000,
    }).then(() => null, (e: Error) => e);
    expect(err, "the dial must not succeed").toBeInstanceOf(Error);
    expect((err as Error).message).toBe("expected ok");
  });
});

describe("a deck presenting a paired deck's key", () => {
  it("passes the pin and is still refused, because it cannot prove the key", async () => {
    // Pinned to the victim's key, as a dial to a paired deck always is — and
    // the pin passes, since what it compares is the key the challenge carried.
    // Without the proof check this dial resolves, and the round that follows
    // sends this deck's manifest to whatever answered.
    const me = identity("");
    const err = await dial({
      host: "127.0.0.1", port: IMPOSTOR_PORT, fp: me.fp, pub: me.pub, secret: me.secret, name: "dialler",
      expectPub: victim.pub, timeoutMs: 3000,
    }).then(() => null, (e: Error) => e);
    expect(err, "the dial reached a deck that never proved the key it showed").toBeInstanceOf(Error);
    expect((err as Error).message).toBe("that deck could not prove its own key");
  });
});

describe("the frame reader", () => {
  it("hands the thrown error on with its refusal", () => {
    const thrown = new TypeError("a handler threw");
    const refusals: Array<[string, unknown]> = [];
    const read = (frameReader as (on: (m: unknown) => void, refuse: (why: string, cause?: unknown) => void) => (chunk: string) => void)(
      () => { throw thrown; },
      (why, cause) => { refusals.push([why, cause]); },
    );
    read('{"t":"boom"}\n');
    expect(refusals).toEqual([["bad frame", thrown]]);
  });
});
