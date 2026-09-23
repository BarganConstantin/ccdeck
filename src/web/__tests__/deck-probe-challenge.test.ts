// A port has to prove it is a deck before anything is done to it — and here it
// is something that is not one.
//
// Before `ccdeck --stop` posts a deck's token to a port, or a start stops an
// "older deck" on it, liveDecks asks that port to prove it knows the token:
// sha256(token:nonce), for a nonce chosen here. challengeDeck is the whole of
// that proof. Every test of liveDecks injects `prove`, and the only runs of the
// real one in the suite are a correct answer and a wrong one, reached by
// accident through other files — so the refusals that matter most were never
// exercised: a 404, a body that is not JSON, one that will not stop coming, and
// a listener that never answers at all.
//
// They matter because the thing on a recycled port can be anything. A
// challenge that took any 200 as proof, or let a JSON throw escape, would have
// `--stop` hand the deck's token to that process and then run the SIGTERM and
// SIGKILL ladder against a recorded pid that may by now belong to something
// else entirely.
//
// A real listener on port 0, whose /api/hook-challenge each case rewrites.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// @ts-expect-error — plain .mjs module, no types
const probe = await import("../../server/deck-probe.mjs");
const { challengeDeck, challengeProof } = probe as {
  challengeDeck: (port: number, token: string) => Promise<boolean>;
  challengeProof: (token: string, nonce: string) => string;
};

const TOKEN = "t";

type Handler = (req: IncomingMessage, res: ServerResponse, nonce: string) => void;
let handler: Handler = (_req, res) => { res.statusCode = 404; res.end(); };
const nonces: string[] = [];

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const nonce = url.searchParams.get("nonce") ?? "";
    nonces.push(nonce);
    handler(req, res, nonce);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(r => server.close(() => r()));
});

/** The challenge, or "hung" if it has not answered in five seconds — so a
 *  regression that waits forever fails here with a reason, rather than as the
 *  suite's timeout. */
const challenge = (p = port, token = TOKEN) => Promise.race([
  challengeDeck(p, token),
  new Promise<"hung">(r => setTimeout(() => r("hung"), 5_000).unref()),
]);

const json = (body: unknown, status = 200): Handler => (_req, res) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

describe("a port that answers the way a deck does", () => {
  it("is believed only with the proof for this token and this nonce", async () => {
    handler = (req, res, nonce) => json({ proof: challengeProof(TOKEN, nonce) })(req, res, nonce);
    expect(await challenge()).toBe(true);
  });

  it("is asked with a fresh nonce every time, so an overheard answer is worth nothing", async () => {
    handler = (req, res, nonce) => json({ proof: challengeProof(TOKEN, nonce) })(req, res, nonce);
    nonces.length = 0;
    await challenge();
    await challenge();
    expect(nonces).toHaveLength(2);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe("a port that is not a deck", () => {
  it("is not one because it answered 404, whatever the body says", async () => {
    // The status is the verdict before a byte of the body is read: a refusal
    // carrying a well-formed proof is still a refusal.
    handler = (req, res, nonce) => json({ proof: challengeProof(TOKEN, nonce) }, 404)(req, res, nonce);
    expect(await challenge()).toBe(false);
  });

  it("is not one because its 200 is not JSON", async () => {
    // A web server, a dev proxy, anything that answers every path with a page.
    // The parse failure has to be an answer, not a throw out of a callback.
    handler = (_req, res) => { res.statusCode = 200; res.end("not json"); };
    expect(await challenge()).toBe(false);
  });

  it("is not one because its proof is not a string", async () => {
    handler = json({ proof: 123 });
    expect(await challenge()).toBe(false);
  });

  it("is not one because it proved a different token", async () => {
    // Another deck — or another user's — on a recycled port: a real proof, of
    // a token that is not the one in this record.
    handler = (req, res, nonce) => json({ proof: challengeProof("other", nonce) })(req, res, nonce);
    expect(await challenge()).toBe(false);
  });

  it("is not one because it says more than a deck ever does, even around a right proof", async () => {
    // A deck answers in about a hundred bytes. The body is read only as far as
    // 4096, so a right proof buried in 5000 bytes of padding is still refused —
    // which is what shows the cap is there at all, since a padded wrong one
    // would fail the compare anyway.
    handler = (req, res, nonce) => json({ proof: challengeProof(TOKEN, nonce), pad: "x".repeat(5000) })(req, res, nonce);
    expect(await challenge()).toBe(false);
  });

  it("is hung up on while it is still talking, rather than read to the end", async () => {
    // A listener that never stops. Without the cap the buffer grows for as long
    // as it keeps sending, and the idle timeout never fires because it is never
    // idle — so the answer is `false` and the connection closed from this side,
    // well before the five-second floor above.
    let written = 0;
    const closed = new Promise<void>(done => {
      handler = (_req, res) => {
        res.statusCode = 200;
        const chunk = "x".repeat(512);
        const timer = setInterval(() => { written += chunk.length; res.write(chunk); }, 5);
        res.on("close", () => { clearInterval(timer); done(); });
      };
    });
    expect(await challenge()).toBe(false);
    await closed;
    // Hung up after a few kilobytes, not after whatever the socket buffers
    // could absorb.
    expect(written).toBeLessThan(64 * 1024);
  });

  it("is not one because nothing is listening", async () => {
    const gone = createServer();
    await new Promise<void>(r => gone.listen(0, "127.0.0.1", () => r()));
    const closedPort = (gone.address() as AddressInfo).port;
    await new Promise<void>(r => gone.close(() => r()));
    expect(await challenge(closedPort)).toBe(false);
  });

  it("is given up on when it accepts and then never answers", async () => {
    // A process that holds the port and is wedged — or is not HTTP at all. The
    // deadline is 400ms, the one hook.js gives a challenge, and `--stop` and a
    // start both wait on it.
    handler = () => { /* never answers */ };
    const started = Date.now();
    expect(await challenge()).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
