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

import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer, frameReader } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom } from "../../server/lan-sync.mjs";

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
