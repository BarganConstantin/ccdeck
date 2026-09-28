// AN INVITE'S CODE, AND WHEN IT STOPS BEING WORTH ANYTHING (#1137).
//
// The code was six digits — about twenty bits — and both handshake proofs are
// made over it and a transcript that crosses the wire, so a proof somebody saw
// kept the code only as well as the code could not be counted through. It
// also outlived its use: a deck already paired could prove it and leave it
// live, and so could a deck whose first pairing had dropped out after the
// proof. What these cases pin is the other side of each of those: a code
// nobody can count through, retired by any proof that holds, and put away
// after a few that do not — and what that does to pairing across versions,
// in each direction.
//
// Everything here is the real engine over real sockets, bound to loopback,
// with a beacon that goes nowhere. The tokens are re-addressed to loopback
// through the real minting function, as lan-engine.test.ts does, so nothing
// here dials an address anything else could be listening on.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { INVITE_PREFIX, mintInvite, readInvite } from "../../server/lan-invite.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createSyncServer } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom, PROTOCOL } from "../../server/lan-sync.mjs";

/** A beacon socket that sends nothing and hears nothing — see deafSocket in
 *  lan-engine.test.ts for why a suite must never use the real one. */
function deafSocket() {
  return {
    on() { /* nothing arrives */ },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
  };
}

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

/** One deck: a real engine, listening on loopback only, with its own key. */
async function deck(name: string, on: Record<string, unknown> = {}) {
  const id = identityFrom("");
  const errors: Array<[string, string]> = [];
  const e = createEngine({
    readAccounts: async () => ({ accounts: [] }),
    exportAccount: async () => null,
    importAccount: async () => false,
    createSocket: () => deafSocket(),
    host: "127.0.0.1",
    onError: (what: string, err: Error) => errors.push([what, String(err?.message ?? err)]),
  });
  running.push(e);
  await e.apply({
    enabled: true, name, secret: id.secret, shared: [], trusted: [], unpaired: [],
    autoAsk: false, autoAccept: false, ...on,
  });
  return { e, id, errors, port: e.status().port as number };
}

/** The deck's own invite, re-addressed to the loopback its listener is on —
 *  through the real minting function, so the code and the checks are real. */
function invitedAt(d: Awaited<ReturnType<typeof deck>>) {
  const read = readInvite(d.e.invite().token);
  return mintInvite({ addrs: [`127.0.0.1:${d.port}`], name: read.name, code: read.code }).token as string;
}

/** A token body, as text — for the tokens no deck of this version mints. */
const tokenOf = (body: Record<string, unknown>) =>
  INVITE_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
const bodyOf = (token: string) =>
  JSON.parse(Buffer.from(token.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));

describe("across versions", () => {
  it("is refused by an older deck as not an invite, before that deck dials anything", () => {
    // Every deck from the first invite to #1137 read the code with exactly
    // this rule and refused the token outright when it failed — before the
    // expiry, before the addresses, so before any dialling. That deck says
    // "That is not an invite", and updating it is the fix.
    //
    // The other way to keep that deck joining would be six digits riding
    // alongside the real code, which is the weak code kept alive; so the
    // second half says there is no such thing anywhere in the token.
    const OLDER_READER = /^[0-9]{6}$/;
    const made = mintInvite({ addrs: ["10.0.0.4:5000"], name: "x" });
    const body = bodyOf(made.token);
    expect(OLDER_READER.test(body.c), "an older deck would dial on this token").toBe(false);
    expect(Object.values(body).filter(v => typeof v === "string" && OLDER_READER.test(v)))
      .toEqual([]);
  });

  it("joins an older deck's six-digit invite, and never mints one of its own", async () => {
    // The other direction keeps working: the six digits are the older deck's
    // to hold, and joining on them is what joining between two older decks
    // always was. This one answers the proof back, as every deck since the
    // `pb` flag does, and the joiner checks it — see lan-engine.test.ts for a
    // deck from before the flag.
    const j = await deck("Joiner");
    const older = identityFrom("");
    const minter = createSyncServer({
      fp: older.fp, pub: older.pub, secret: older.secret, name: "Older minter", host: "127.0.0.1",
      invite: () => ({ code: "482100", expiresAt: Date.now() + 60_000 }),
    });
    running.push(minter);
    const port = await minter.start();
    const token = tokenOf({ v: PROTOCOL, a: [`127.0.0.1:${port}`], n: "Older minter", c: "482100", x: Date.now() + 60_000, pb: 1 });
    expect(readInvite(token).provesBack).toBe(true);
    const res = await j.e.join(token);
    expect(res.ok, JSON.stringify(res.tried ?? [])).toBe(true);
    expect(j.e.status().trusted).toMatchObject([{ fp: older.fp }]);

    // And this deck never holds six digits itself: not from its own invite,
    // and not when a caller hands the minting function some.
    expect(readInvite(j.e.invite().token).code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(mintInvite({ addrs: ["10.0.0.4:5000"], name: "x", code: "482100" })).toBeNull();
  }, 20_000);
});
