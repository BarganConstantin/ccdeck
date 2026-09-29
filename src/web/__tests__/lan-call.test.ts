// What a dialling deck makes of a refusal, driven against a listener that says
// nothing but `no`.
//
// lan-socket.test.ts, and the #810, #1120 and #1137 suites, dial real
// listeners and prove the handshake both ways. What they reach of the refusal
// table is the handful of reasons their cases happen to provoke. The panel
// keys on these sentences (lan-round.ts) and prints the rest verbatim, so
// every reason a listener sends is pinned here to the sentence it is read as —
// and every other string, the prototype's names first (#1046), to the one
// generic sentence rather than to whatever a bracket read would have found.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import * as call from "../../server/lan-call.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as socket from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom } from "../../server/lan-wire.mjs";

const ME = identityFrom("");
const open: net.Server[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

/** A listener that answers the first thing it hears with `no` and `why`, and
 *  the port it is on. */
async function refuser(why: unknown): Promise<number> {
  const srv = net.createServer(sock => {
    sock.on("error", () => {});
    sock.once("data", () => sock.end(`${JSON.stringify({ t: "no", why })}\n`));
  });
  open.push(srv);
  await new Promise<void>(res => srv.listen(0, "127.0.0.1", res));
  return (srv.address() as net.AddressInfo).port;
}

/** What dialling that listener fails with. */
async function refusedWith(why: unknown): Promise<string> {
  const port = await refuser(why);
  try {
    await call.connectToPeer({ host: "127.0.0.1", port, fp: ME.fp, pub: ME.pub, secret: ME.secret, name: "Me" });
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the dial did not fail");
}

describe("a refusal from the deck that was dialled", () => {
  it("is read as the sentence for its reason", async () => {
    const sentences: Record<string, string> = {
      pending: "waiting for the other deck to accept this one",
      declined: "that deck said no",
      "invite only": "that deck pairs only by invite",
      "not asking": "this deck pairs only by invite",
      impostor: "that deck has this one pinned under a different key",
      "wrong invite": "that deck did not take this invite — ask them for a new one",
      "bad proof": "the other deck refused this one's proof",
    };
    for (const [why, sentence] of Object.entries(sentences)) {
      expect(await refusedWith(why), why).toBe(sentence);
    }
  });

  it("is the generic sentence for any other reason, and never one the prototype supplies", async () => {
    for (const why of ["bad hello", "expected auth", "constructor", "toString", "__proto__", "hasOwnProperty", 5, null]) {
      expect(await refusedWith(why), String(why)).toBe("the other deck refused this handshake");
    }
  });
});

describe("lan-socket.mjs", () => {
  it("hands out this very dialler", () => {
    expect(socket.connectToPeer).toBe(call.connectToPeer);
  });
});
