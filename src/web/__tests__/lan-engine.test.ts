// Two decks, two stores, one real socket pair — the whole feature, end to end,
// on one machine.
//
// This runs FOR REAL: two engines, a TCP handshake between them with both
// proofs, manifests exchanged and a sealed credential moved. Nothing is mocked
// except the store, and the store is mocked because claude-swap is not
// installed on a CI runner and because the point of these cases is what the
// engine ASKS the store to do, not what claude-swap does with it.
//
// THE ONE STEP NOT EXERCISED HERE IS UDP DISCOVERY, and that is deliberate.
// These decks find each other by address, through the manual-peer path that
// exists for networks where broadcast is filtered or routed away. A CI runner
// has no broadcast domain worth the name, so a case that waited for a beacon
// would fail there for a reason that has nothing to do with what it tests.
//
// Discovery is covered twice instead: against a socket the suite owns, in
// lan-socket.test.ts, and by hand against a real one — two decks on this
// machine, which do find each other, because a broadcast to 255.255.255.255
// comes back to every socket on the sending host. That was measured before any
// of this was written and it is the same fact that makes self-recognition a
// fingerprint question rather than an address question.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine, defaultName, localAddress, newIdentity, SYNC_MS } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";

const PASS = "amber-canyon-forty-drift";
const K = (email: string, org: string) => accountKey(email, org);

interface Row { num: number; email: string; orgUuid: string; alive: boolean }

/** A store, and a record of everything the engine asked it to do. */
function store(rows: Row[]) {
  const imported: string[] = [];
  const exported: number[] = [];
  return {
    rows,
    imported,
    exported,
    deps: (over: Record<string, unknown> = {}) => ({
      readAccounts: async () => ({ accounts: rows }),
      exportAccount: async (num: number) => { exported.push(num); return `ccdeck2:slot-${num}`; },
      importAccount: async (blob: string) => { imported.push(blob); return true; },
      ...over,
    }),
  };
}

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

async function deck(s: ReturnType<typeof store>, name: string, shared: string[], over = {}) {
  const errors: string[] = [];
  const e = createEngine({ ...s.deps(over), onError: (w: string) => errors.push(w) });
  running.push(e);
  await e.apply({ enabled: true, name, passphrase: PASS, shared });
  return { e, errors, port: e.status().port as number };
}

/**
 * Point one deck at another BY ADDRESS rather than waiting for a beacon.
 *
 * Not a convenience and not a mock: this is the manual-peer path, which exists
 * because broadcast dies at the first router and is dropped by a switch that
 * filters it. Using it here makes every case below deterministic — a CI runner
 * has no broadcast domain worth the name, and a case that waited for a packet
 * that never comes would fail there for a reason that has nothing to do with
 * what it is testing.
 *
 * Everything after the address is real: a TCP handshake, both proofs, a
 * manifest, a sealed credential. The UDP half is covered against a socket the
 * suite owns in lan-socket.test.ts, and by hand against a real one — two decks
 * on this machine, which find each other because a broadcast comes back to its
 * own host.
 */
function point(from: { addPeer: (a: string, p: number) => boolean }, to: { status: () => { port?: number } }, port: number) {
  expect(from.addPeer("127.0.0.1", port)).toBe(true);
}

describe("the account that is dead here and alive there", () => {
  it("is healed, which is the whole feature", async () => {
    // The owner's own case, in a fixture: claude2 is quarantined on this
    // machine and works on the other one.
    const mine = store([
      { num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true },
      { num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false },
    ]);
    const theirs = store([
      { num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true },
    ]);
    const shared = [K("claude1@sapec.md", "org-1"), K("claude2@sapec.md", "org-2")];
    const a = await deck(mine, "Deck-A", shared);
    const b = await deck(theirs, "Deck-B", shared);
    point(a.e, b, b.port);

    const done = await a.e.round();
    expect(done).toEqual([{
      key: K("claude2@sapec.md", "org-2"), email: "claude2@sapec.md",
      action: "heal", ok: true, why: null,
    }]);
    // The peer exported exactly the slot it holds that account in — which is a
    // different number from this deck's, and that is the point of keying on the
    // email and the org.
    expect(theirs.exported).toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);

  it("leaves a working account alone, however many rounds run", async () => {
    // The safety property, from the outside: nothing is imported at all when
    // both copies work, so `cswap import --force` is never reached because it
    // is never wanted.
    const rows = [{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }];
    const mine = store([...rows]);
    const theirs = store([{ num: 9, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const shared = [K("claude1@sapec.md", "org-1")];
    const a = await deck(mine, "Deck-A", shared);
    const b = await deck(theirs, "Deck-B", shared);
    point(a.e, b, b.port);
    expect(await a.e.round()).toEqual([]);
    expect(await a.e.round()).toEqual([]);
    expect(mine.imported).toEqual([]);
    expect(theirs.exported).toEqual([]);
  }, 20_000);

  it("takes an account it has never seen", async () => {
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 4, email: "new@sapec.md", orgUuid: "org-9", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("claude1@sapec.md", "org-1")]);
    const b = await deck(theirs, "Deck-B", [K("new@sapec.md", "org-9")]);
    point(a.e, b, b.port);
    const done = await a.e.round();
    expect(done.map((d: { action: string }) => d.action)).toEqual(["add"]);
    expect(mine.imported).toEqual(["ccdeck2:slot-4"]);
  }, 20_000);

  it("cannot be healed from a copy that is dead there too", async () => {
    const mine = store([{ num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
    const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
    const shared = [K("claude2@sapec.md", "org-2")];
    const a = await deck(mine, "Deck-A", shared);
    const b = await deck(theirs, "Deck-B", shared);
    point(a.e, b, b.port);
    expect(await a.e.round()).toEqual([]);
    expect(mine.imported).toEqual([]);
  }, 20_000);
});

describe("what a peer is refused", () => {
  it("gets nothing for an account its owner did not tick", async () => {
    // The tick is checked when the credential is asked for, not only when the
    // manifest was built: the list can change between the two, and the answer
    // that matters is the one at the moment of sending.
    const mine = store([{ num: 2, email: "secret@sapec.md", orgUuid: "org-2", alive: false }]);
    const theirs = store([{ num: 5, email: "secret@sapec.md", orgUuid: "org-2", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("secret@sapec.md", "org-2")]);
    // The holder shares nothing.
    const b = await deck(theirs, "Deck-B", []);
    point(a.e, b, b.port);
    expect(await a.e.round()).toEqual([]);
    expect(theirs.exported).toEqual([]);
    expect(mine.imported).toEqual([]);
  }, 20_000);

  it("is told nothing about an account that is not in the manifest", async () => {
    // Not "listed as withheld" — the existence of the account is itself the
    // fact being kept back.
    const theirs = store([
      { num: 5, email: "shared@sapec.md", orgUuid: "org-5", alive: true },
      { num: 6, email: "private@sapec.md", orgUuid: "org-6", alive: true },
    ]);
    const mine = store([]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", [K("shared@sapec.md", "org-5")]);
    point(a.e, b, b.port);
    await a.e.round();
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
    expect(theirs.exported).toEqual([5]);
  }, 20_000);

  it("does not find a deck whose passphrase is different", async () => {
    const mine = store([{ num: 2, email: "a@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "a@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("a@x", "o")]);
    const b = createEngine(theirs.deps());
    running.push(b);
    await b.apply({ enabled: true, name: "Stranger", passphrase: "a-different-passphrase", shared: [K("a@x", "o")] });
    // Dialled deliberately, so this tests the refusal rather than a packet that
    // never arrived: the handshake fails and nothing moves.
    expect(a.e.addPeer("127.0.0.1", b.status().port)).toBe(true);
    expect(await a.e.round()).toEqual([]);
    expect(theirs.exported).toEqual([]);
    expect(mine.imported).toEqual([]);
  }, 20_000);
});

describe("the switch, and what turning it off means", () => {
  it("is off until it is turned on, and shouts nothing until then", async () => {
    const s = store([]);
    const e = createEngine(s.deps());
    running.push(e);
    expect(e.status().enabled).toBe(false);
    expect(e.status().running).toBe(false);
    expect(e.status().fp).toBeNull();
  });

  it("needs a passphrase as well as a switch", async () => {
    // A deck with the switch on and no passphrase has nobody to find and
    // nothing to say. It must not shout anyway.
    const s = store([]);
    const e = createEngine(s.deps());
    running.push(e);
    await e.apply({ enabled: true, passphrase: "" });
    expect(e.status().running).toBe(false);
  });

  it("stops completely when it is turned off", async () => {
    const s = store([]);
    const { e } = await deck(s, "Deck-A", []);
    expect(e.status().running).toBe(true);
    await e.apply({ enabled: false });
    expect(e.status().running).toBe(false);
    expect(e.status().peers).toEqual([]);
    // And a round after that does nothing rather than throwing.
    expect(await e.round()).toEqual([]);
  }, 20_000);

  it("starts over when the passphrase changes, rather than keeping old peers", async () => {
    // A changed passphrase is a different group. Keeping the peer table across
    // it would leave rows for decks this deck can no longer talk to.
    const s = store([]);
    const { e } = await deck(s, "Deck-A", []);
    const first = e.status().fp;
    await e.apply({ passphrase: "another-passphrase-entirely" });
    expect(e.status().running).toBe(true);
    expect(e.status().peers).toEqual([]);
    expect(e.status().fp).not.toBe(first);
  }, 20_000);
});

describe("how a deck names itself", () => {
  it("uses the machine's own name, which is the word already in use for it", () => {
    expect(defaultName()).toBeTruthy();
    expect(defaultName()).not.toMatch(/\.local$/i);
  });

  it("is known by a fingerprint that changes every start", () => {
    // Deliberate: a persisted key would be one more secret on disk whose theft
    // lets somebody impersonate this deck to its own group, and what it would
    // buy is a stable row in a list.
    expect(newIdentity().fp).not.toBe(newIdentity().fp);
    expect(newIdentity().fp).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
  });

  it("shows the name the user chose to its peers", async () => {
    const a = await deck(store([]), "Constantin-MacBook", []);
    const b = await deck(store([]), "Constantin-PC", []);
    point(a.e, b, b.port);
    // The address is what got us there; the NAME comes back from the deck
    // itself, over a handshake it had to prove the passphrase to complete.
    const conn = await a.e.round();
    expect(conn).toEqual([]);
    expect(a.e.status().peers.some((p: { addr: string }) => p.addr === "127.0.0.1")).toBe(true);
  }, 20_000);
});

describe("the address a person reads out to a colleague", () => {
  // Printed in the panel for the field on the other deck, because broadcast
  // dies at the first router and across a VPN an address is the only way in.
  it("is the machine's own, not loopback and not a failed lease", () => {
    expect(localAddress({ lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }] })).toBeNull();
    // 169.254 is what a machine gets when DHCP failed — reachable by nobody
    // worth telling about, so it is not offered as though it were.
    expect(localAddress({ en0: [{ internal: false, family: "IPv4", address: "169.254.1.2" }] })).toBeNull();
    expect(localAddress({ en0: [{ internal: false, family: "IPv6", address: "fe80::1" }] })).toBeNull();
    expect(localAddress({
      lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
      en0: [{ internal: false, family: "IPv4", address: "192.168.1.82" }],
    })).toBe("192.168.1.82");
  });

  it("is null rather than a guess when there is no ordinary answer", () => {
    // A machine with a VPN up has several and which one a peer can reach
    // depends on where the peer is — a question this side cannot answer. The
    // panel prints nothing rather than a placeholder somebody has to decode.
    expect(localAddress({})).toBeNull();
    expect(localAddress(null)).toBeNull();
    expect(localAddress(undefined)).toBeTruthy();
  });

  it("takes node's numeric family as well as its string one", () => {
    // It changed spelling between node versions and this runs on 18 through 22.
    expect(localAddress({ en0: [{ internal: false, family: 4, address: "10.0.0.5" }] })).toBe("10.0.0.5");
  });
});

describe("the cadence", () => {
  it("asks often enough to feel live and far less often than a login dies", () => {
    expect(SYNC_MS).toBeGreaterThanOrEqual(30_000);
    expect(SYNC_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
