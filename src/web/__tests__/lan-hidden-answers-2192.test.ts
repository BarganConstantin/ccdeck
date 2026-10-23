// What a paired deck can still learn about the login a deck is on while its
// owner hides which account that is (#2192, "Show paired decks which of these
// this deck is using" off).
//
// The list leaves that login out, and a proven request for it is refused "not
// shared", the answer a login that is not ticked gets. Two other answers still
// told them apart, to a paired deck that does not follow the protocol:
//   - a request with a proof that does not hold was refused "proof" for the
//     hidden login, as for any ticked one, but "not shared" for an unticked
//     one, which was refused before the proof was looked at;
//   - an unticked one was refused before the store was read, the hidden one
//     after, so the hidden one answered as late as a store read.
// Now a paired deck's request is answered in one order whatever it names: the
// proof, then the store, then whether that deck may have it.
//
// And a third deck: one that holds a dead copy of a login, paired with a deck
// that hides which account it is on and another whose copy is dead too, said
// "Login expired on all online decks" — while the hiding deck was working on
// that very login. A deck that hides its account leaves exactly that login out
// of its list, so its silence about a login is no evidence that no copy works.
//
// Loopback only, through lan-engine-rig.ts, the pairing switches as shipped,
// every credential a synthetic string.
import { describe, it, expect, afterEach, vi } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, transferChallenge } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer } from "../../server/lan-socket.mjs";
import { noCopyWorksNearby } from "../account-lan";
import type { LanStatus } from "../lan-types";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const HOME = "home@example.test";
const SPARE = "spare@example.test";
const X = accountKey(WORK, "org-w"); // the one the deck is on, ticked
const Y = accountKey(HOME, "org-h"); // ticked, idle
const Z = accountKey(SPARE, "org-s"); // held, not ticked

/** A store row as claude-swap's reader hands it over (see live-login-lan-2192). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

async function rounds(here: RigDeck, most = 4) {
  let done: Array<Record<string, unknown>> = [];
  for (let i = 0; i < most && !done.length; i++) done = await here.e.round();
  return done;
}

/** `who`'s key on its own connection to `far`: a request asked three ways. */
async function wire(who: RigDeck, far: RigDeck) {
  const conn = await connectToPeer({
    host: "127.0.0.1", port: far.port, fp: who.id.fp, pub: who.id.pub, secret: who.id.secret,
    name: "Peer", expectPub: far.id.pub,
  });
  const ask = (frame: Record<string, unknown>) => new Promise<Record<string, any>>(resolve => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i === -1) return;
      conn.sock.off("data", onData);
      resolve(conn.read(JSON.parse(buf.slice(0, i))));
    };
    conn.sock.on("data", onData);
    conn.send(frame);
  });
  return {
    ask,
    proven: (key: string, nonce: string) => ask({
      t: "want", key, nonce, proof: transferChallenge(conn.key, { nonce, accountKey: key, fromFp: who.id.fp, toFp: far.id.fp }),
    }),
    badProof: (key: string, nonce: string) => ask({ t: "want", key, nonce, proof: "not-a-proof" }),
    noProof: (key: string, nonce: string) => ask({ t: "want", key, nonce }),
    close: () => conn.sock.destroy(),
  };
}

/** A deck on X that ticks X and Y, holds Z, and hides which account it is on;
 *  every store read counted, and held while `gate` is set. */
async function hidingDeck() {
  const rows: Row[] = [
    { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
    { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
    { num: 7, email: SPARE, orgUuid: "org-s", alive: true, active: false, collector: "ok" },
  ];
  const exported: number[] = [];
  const store = { reads: 0, gate: null as Promise<void> | null };
  const far = await rigDeck("Private", {
    rows, shared: [X, Y], settings: { ...SHIPPED, shareActive: false },
    deps: {
      exportAccount: async (num: number) => { exported.push(num); return `dummy-refresh-${num}`; },
      readAccounts: async () => { store.reads += 1; if (store.gate) await store.gate; return { accounts: rows }; },
    },
  });
  const peer = await rigDeck("Peer", { settings: SHIPPED, deps: { importAccount: async () => true } });
  announce(peer, { fp: far.id.fp, port: far.port, name: "Private" });
  await rounds(peer);
  return { far, peer, exported, store };
}

describe("a paired deck's request, while the deck it asks hides which account it is on", () => {
  it("is refused alike for the login that deck is on and for one it does not tick, whatever the proof", async () => {
    const { far, peer, exported } = await hidingDeck();
    expect(exported, "Y, which that deck is not on, went out as before").toEqual([6]);
    const w = await wire(peer, far);
    try {
      expect((await w.ask({ t: "manifest" })).accounts.map((a: { key: string }) => a.key)).toEqual([Y]);
      const said = {
        badProof: { X: (await w.badProof(X, "b1")).why, Y: (await w.badProof(Y, "b2")).why, Z: (await w.badProof(Z, "b3")).why },
        noProof: { X: (await w.noProof(X, "c1")).why, Y: (await w.noProof(Y, "c2")).why, Z: (await w.noProof(Z, "c3")).why },
        proven: { X: (await w.proven(X, "g1")).why, Z: (await w.proven(Z, "g3")).why },
      };
      expect(said).toEqual({
        badProof: { X: "proof", Y: "proof", Z: "proof" },
        noProof: { X: "proof", Y: "proof", Z: "proof" },
        proven: { X: "not shared", Z: "not shared" },
      });
      expect(exported).toEqual([6]);
    } finally {
      w.close();
    }
  }, 30_000);

  it("is answered after the same store read for the login that deck is on and for one it does not tick", async () => {
    const { far, peer, store } = await hidingDeck();
    const w = await wire(peer, far);
    try {
      for (const [key, nonce] of [[X, "s1"], [Z, "s2"]] as const) {
        let open!: () => void;
        store.gate = new Promise<void>(resolve => { open = resolve; });
        const before = store.reads;
        let answered = false;
        const answer = w.proven(key, nonce).then(a => { answered = true; return a; });
        // The refusal waits on the store, whichever login was asked for.
        await vi.waitFor(() => expect(store.reads, `no store read for ${key}`).toBe(before + 1), { timeout: 2_000 });
        await new Promise(r => setTimeout(r, 30));
        expect(answered, `answered ${key} before the store was read`).toBe(false);
        open();
        store.gate = null;
        expect(await answer).toEqual({ t: "no", why: "not shared" });
        expect(store.reads).toBe(before + 1);
      }
      // A proof that does not hold is refused before the store, for each alike.
      const before = store.reads;
      for (const key of [X, Y, Z]) expect((await w.badProof(key, `p-${key}`)).why).toBe("proof");
      expect(store.reads).toBe(before);
    } finally {
      w.close();
    }
  }, 30_000);

});

describe("a dead login's row, with a paired deck that hides which account it is on", () => {
  it("does not say every copy nearby is dead while that deck may be working on it", async () => {
    const a = await rigDeck("A", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }] as Row[],
      shared: [X], settings: { ...SHIPPED, shareActive: false },
      deps: { exportAccount: async () => "dummy-refresh-a" },
    });
    const b = await rigDeck("B", {
      rows: [
        { num: 2, email: WORK, orgUuid: "org-w", alive: false, active: false, collector: "relogin_required" },
        { num: 3, email: SPARE, orgUuid: "org-s", alive: true, active: true, collector: "ok" },
      ] as Row[],
      shared: [X], settings: SHIPPED,
    });
    const c = await rigDeck("C", {
      rows: [{ num: 1, email: WORK, orgUuid: "org-w", alive: false, active: false, collector: "relogin_required" }] as Row[],
      settings: SHIPPED, deps: { importAccount: async () => true },
    });
    announce(c, { fp: a.id.fp, port: a.port, name: "A" });
    announce(c, { fp: b.id.fp, port: b.port, name: "B" });
    for (let i = 0; i < 4; i++) await c.e.round();
    const status = c.e.status() as LanStatus;
    const offers = (status.peers ?? []).filter(p => p.paired).map(p => [p.offers?.current ?? null, (p.offers?.accounts ?? []).map(o => o.alive)]);
    // What C was told: one deck hiding its account and listing nothing; one on
    // a login it does not share, listing X dead.
    expect(offers).toContainEqual([{ hidden: true }, []]);
    expect(offers).toContainEqual([{ other: true }, [false]]);
    expect(noCopyWorksNearby(X, status, Date.now())).toBe(false);
  }, 40_000);

  const NOW = 1_790_000_000_000;
  const peer = (i: number, offers: Record<string, unknown>) => ({
    fp: `peer-${i}`, name: `peer-${i}`, addr: "192.0.2.2", port: 1, paired: true, lastSeen: NOW - 10_000, offers: { at: 0, ...offers },
  });
  const status = (peers: unknown[]) => ({ enabled: true, shared: [X], peers }) as unknown as LanStatus;

  it("still says so when the hiding deck lists that login dead itself, which is evidence", () => {
    expect(noCopyWorksNearby(X, status([
      peer(0, { current: { hidden: true }, accounts: [{ key: X, email: WORK, alive: false }] }),
      peer(1, { accounts: [{ key: X, email: WORK, alive: false }] }),
    ]), NOW)).toBe(true);
  });

  it("still says so when no deck hides, as before", () => {
    expect(noCopyWorksNearby(X, status([
      peer(0, { current: { other: true }, accounts: [] }),
      peer(1, { accounts: [{ key: X, email: WORK, alive: false }] }),
    ]), NOW)).toBe(true);
  });

  it("does not count a hiding deck that has gone quiet", () => {
    const quiet = { ...peer(0, { current: { hidden: true }, accounts: [] }), lastSeen: NOW - 3 * 60 * 60 * 1000 };
    expect(noCopyWorksNearby(X, status([quiet, peer(1, { accounts: [{ key: X, email: WORK, alive: false }] })]), NOW)).toBe(true);
  });
});
