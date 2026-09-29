// Is a deck that calls in present? The status line and the row must give one
// answer (#1690).
//
// A paired deck this one holds no address for is drawn as `one-way`: it calls
// in, and it is here if it has called inside the window a beacon is held to.
// lan-roster.ts asked that twice — sectionState counted the calling decks for
// the line under the switch, and callsIn drew the row — and the two were
// written apart. The line also refused any deck whose `last` round carried an
// error. A deck nothing dials has no round of its own, so that error can only
// be left over from when the deck was still dialled, which takes a run of
// failures in a row: rounds with a deck that could be heard and not reached,
// its beacon gone for a day, then a call from it and a dial-back that fails.
// After that the row said `online · one-way, it calls in`, drawn live, the way
// in said `1 online` — and the line under the switch said, in the warning
// ink, `this deck cannot reach the one it is paired with`. Both ask
// calledLately now, and a round left over from before is not part of it.
//
// Driven for real below: two engines on loopback, the beacon delivered by
// hand, and the deck under test on a clock the case moves. Then the answer
// both places give for that one row, from the status the engine hands out.
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { FORGET_MS, hostId, identityFrom, PROTOCOL } from "../../server/lan-sync.mjs";
import { deckRows, entryLine, sectionState } from "../lan-roster";
import type { LanStatus, Peer } from "../lan-types";

/** A UDP socket that sends nowhere, and hands the engine a beacon on demand —
 *  lan-engine.test.ts's, for the same reason: the suite must not announce
 *  test decks to whatever network the machine is on. */
function deafSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
    deliver(msg: Buffer, from: string) { handlers.get("message")?.(msg, { address: from }); },
  };
}

interface Engine {
  apply: (next: object) => Promise<void>;
  addPeer: (addr: string, port: number) => boolean;
  setPeers: (list: string[]) => number;
  accept: (fp: string) => unknown;
  round: () => Promise<unknown>;
  status: () => LanStatus & { fp: string; port: number };
  stop: () => void;
}

const running: Engine[] = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

async function deck(name: string, now?: () => number) {
  const id = identityFrom("");
  const trusted: unknown[] = [];
  const sock = deafSocket();
  const e: Engine = createEngine({
    readAccounts: async () => ({ accounts: [] }),
    exportAccount: async () => "",
    importAccount: async () => true,
    createSocket: () => sock,
    host: "127.0.0.1",
    onTrust: (list: unknown[]) => { trusted.splice(0, trusted.length, ...list); },
    ...(now ? { now } : {}),
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared: [], trusted, unpaired: [], autoAsk: false, autoAccept: false });
  return { e, id, sock, port: e.status().port };
}

/** One deck types the other's address and the other presses accept. */
async function point(from: Awaited<ReturnType<typeof deck>>, to: Awaited<ReturnType<typeof deck>>) {
  expect(from.e.addPeer("127.0.0.1", to.port)).toBe(true);
  await from.e.round();
  expect(to.e.accept(from.e.status().fp)).toBeTruthy();
}

/** A port nothing listens on: taken from the OS, then let go. */
async function deadPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>(r => srv.close(() => r()));
  return port;
}

const rowOf = (s: LanStatus, fp: string) => (s.peers ?? []).find(p => (p.peerFp ?? p.fp) === fp) as Peer;

describe("a deck that calls in, after the rounds with it failed", () => {
  it("is present on the status line exactly when its row is", async () => {
    const clock = { t: Date.now() };
    const a = await deck("Deck-A");
    const b = await deck("Deck-B", () => clock.t);
    // Paired both ways, and then B keeps no address for A.
    await point(a, b);
    await point(b, a);
    b.e.setPeers([]);

    // B hears A's beacon — at a port where nothing answers, which is what a
    // deck behind an inbound firewall looks like from here — and the round
    // with it fails. That failure is kept under A's own fingerprint.
    b.sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Deck-A", f: a.id.fp, p: await deadPort(),
      i: "00".repeat(8), h: hostId({ hostname: "somewhere-else", home: "/home/somebody" }),
    })), "127.0.0.1");
    await b.e.round();
    expect(rowOf(b.e.status(), a.id.fp)?.last?.error).toBeTruthy();

    // A day without a beacon, and the heard row is gone from the list.
    clock.t += FORGET_MS + 60_000;
    // A calls B. B learns A's address from the call and tries it once; A's
    // listener is gone by then, so the dial-back fails and is taken away.
    await a.e.round();
    a.e.stop();
    await b.e.round();

    const status = b.e.status();
    const peer = rowOf(status, a.id.fp);
    // The state the rest of this is about: calling in, called just now, and
    // still carrying the error from the rounds a day ago.
    expect(peer).toMatchObject({ waiting: true, lastSeen: clock.t });
    expect(peer.last?.error).toBeTruthy();

    const rows = deckRows(status, clock.t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "paired", state: "online · one-way, it calls in", here: true });
    expect(entryLine(status, rows).text).toBe("1 online");
    // The line under the switch counts the same deck the row draws live.
    expect(sectionState(status, clock.t)).toEqual({ text: "1 deck ready", tone: "ok" });
  }, 20_000);
});

describe("sectionState and the row, on every calling-in deck", () => {
  const NOW = 1_790_550_000_000;
  const caller = (lastSeen: number | undefined, last: Peer["last"]): Peer => ({
    fp: "aaa-aaa-aaa-aaa", peerFp: "aaa-aaa-aaa-aaa", name: "Far", addr: "", port: 0,
    paired: true, waiting: true, lastSeen, last,
  });

  it("agree whether it is here, whatever its last round said", () => {
    const seens = [undefined, NOW, NOW - 94_999, NOW - 95_000, NOW - 3_600_000];
    const lasts: Peer["last"][] = [
      null, undefined,
      { at: NOW - 86_400_000, error: "connect ECONNREFUSED 127.0.0.1:4319" },
      { at: NOW - 86_400_000, error: "timed out" },
      { at: NOW - 60_000, error: "waiting for the other deck to accept this one" },
      { at: NOW - 60_000, error: "that deck said no" },
      { at: NOW - 60_000, done: [] },
    ];
    for (const lastSeen of seens) {
      for (const last of lasts) {
        const s = { enabled: true, running: true, peers: [caller(lastSeen, last)] };
        const [row] = deckRows(s, NOW);
        const line = sectionState(s, NOW);
        const said = `${lastSeen} ${JSON.stringify(last)}`;
        if (row.here) expect(line, said).toEqual({ text: "1 deck ready", tone: "ok" });
        else expect(line, said).toEqual({ text: "this deck cannot reach the one it is paired with", tone: "bad" });
      }
    }
  });
});
