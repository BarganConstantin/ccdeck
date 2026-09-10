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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine, defaultName, localAddresses, SYNC_MS } from "../../server/lan-engine.mjs";
import { parseAddress } from "../components/LanSyncSection";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, identityFrom } from "../../server/lan-sync.mjs";


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

/**
 * A socket that goes nowhere.
 *
 * The TCP half of every case below is real — two engines, one handshake, a
 * sealed credential — and that is the point. The UDP half must not be: the
 * beacon broadcasts to 255.255.255.255, so a suite left on the default socket
 * announced `Deck-A` and `Stranger` on whatever network the machine was on.
 * They arrived in a real panel, on a real screen, in the list of decks a person
 * can pair with. Found exactly that way.
 */
function deafSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
  };
}

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

async function deck(s: ReturnType<typeof store>, name: string, shared: string[], over = {}) {
  const errors: string[] = [];
  // The key is kept by the caller in the real deck, so it is kept here too:
  // every engine gets its own, made once, rather than a fresh one per apply.
  const id = identityFrom("");
  const trusted: Array<{ fp: string; pub: string; name: string }> = [];
  const e = createEngine({
    ...s.deps(over),
    createSocket: () => deafSocket(),
    onError: (w: string) => errors.push(w),
    // Written straight back into what the next apply is given, which is what
    // index.mjs does through prefs.
    onTrust: (list: Array<{ fp: string; pub: string; name: string }>) => {
      trusted.splice(0, trusted.length, ...list);
    },
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared, trusted });
  return { e, errors, id, trusted, port: e.status().port as number };
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
async function point(
  from: { e: { addPeer: (a: string, p: number) => boolean; round: () => Promise<unknown>; status: () => { fp: string } } },
  to: { e: { accept: (fp: string) => unknown } },
  port: number,
) {
  expect(from.e.addPeer("127.0.0.1", port)).toBe(true);
  // TWO PRESSES, AND BOTH OF THEM ARE REAL. Somebody types an address here and
  // somebody presses accept there. The first round is refused — the listener
  // has never been told to trust this deck — and that refusal is what puts it
  // in the list with an accept on it.
  await from.e.round();
  expect(to.e.accept(from.e.status().fp), "the other deck had nothing to accept").toBeTruthy();
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
    await point(a, b, b.port);

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
    await point(a, b, b.port);
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
    await point(a, b, b.port);
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
    await point(a, b, b.port);
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
    await point(a, b, b.port);
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
    await point(a, b, b.port);
    await a.e.round();
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
    expect(theirs.exported).toEqual([5]);
  }, 20_000);

  it("does not talk to a deck nobody has accepted", async () => {
    const mine = store([{ num: 2, email: "a@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "a@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("a@x", "o")]);
    const b = await deck(theirs, "Stranger", [K("a@x", "o")]);
    // Dialled deliberately AND NEVER ACCEPTED, so this tests the refusal rather
    // than a packet that never arrived: the handshake completes, the listener
    // has no reason to talk to this deck, and nothing moves.
    expect(a.e.addPeer("127.0.0.1", b.port)).toBe(true);
    expect(await a.e.round()).toEqual([]);
    expect(theirs.exported).toEqual([]);
    expect(mine.imported).toEqual([]);
  }, 20_000);
});

describe("the switch, and what turning it off means", () => {
  it("is off until it is turned on, and shouts nothing until then", async () => {
    const s = store([]);
    const e = createEngine({ ...s.deps(), createSocket: () => deafSocket() });
    running.push(e);
    expect(e.status().enabled).toBe(false);
    expect(e.status().running).toBe(false);
    expect(e.status().fp).toBeNull();
  });

  it("needs nothing but the switch, because there is no passphrase to wait for", async () => {
    // IT USED TO NEED ONE. A deck with the switch on and no passphrase had
    // nobody to find and nothing to say, so it stayed silent. There is nothing
    // to hold it back now: it makes its own key on the first start, announces
    // itself, and waits for somebody to accept it.
    const s = store([]);
    const e = createEngine({ ...s.deps(), createSocket: () => deafSocket() });
    running.push(e);
    await e.apply({ enabled: true });
    expect(e.status().running).toBe(true);
    expect(e.status().fp).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
  }, 20_000);

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

  it("starts over when its own key changes, rather than keeping old peers", async () => {
    // A new key is a different deck to everybody who pinned the old one.
    // Keeping the peer table across it would leave rows for decks that will
    // refuse this one on the next connection.
    const s = store([]);
    const { e } = await deck(s, "Deck-A", []);
    const first = e.status().fp;
    await e.apply({ secret: identityFrom("").secret });
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

  it("keeps the same fingerprint across restarts, once it has one", () => {
    // The first version regenerated the identity every start, on the argument
    // that a stored key is one more secret to protect. What that cost was
    // measured on a real machine: every peer's list held a row per restart,
    // dozens of them, each reporting ECONNREFUSED every minute against a port
    // nothing had listened on for an hour.
    //
    // It is a real private key now rather than a public id, so it is a secret
    // after all — and prefs.json is written 0600 for exactly that. What it buys
    // is the thing a pin is worth: a deck that comes back is the same deck.
    const first = identityFrom("");
    expect(first.fp).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
    expect(identityFrom(first.secret).fp).toBe(first.fp);
    expect(identityFrom(first.secret).pub).toBe(first.pub);
    // A fresh deck still gets one, and two fresh decks are not the same deck.
    expect(identityFrom("").fp).not.toBe(identityFrom("").fp);
  });

  it("replaces a stored key it cannot use, rather than refusing to start", () => {
    // A corrupt key is not something anybody can act on mid-session, and
    // refusing to start would take the feature away over one bad string. The
    // cost is real: this deck gets a new fingerprint, so every peer that pinned
    // the old one asks its owner again.
    for (const junk of ["", "nope", "ZZZZZZZZZZZZ", "0123456789abcdef", 5, null]) {
      const made = identityFrom(junk as string);
      expect(made.fp, String(junk)).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
      expect(made.fresh, String(junk)).toBe(true);
    }
  });

  it("hands a new key back so the caller can keep it", async () => {
    const kept: string[] = [];
    const e = createEngine({ ...store([]).deps(), createSocket: () => deafSocket(), onIdentity: (secret: string) => kept.push(secret) });
    running.push(e);
    await e.apply({ enabled: true, name: "Deck-A", shared: [] });
    expect(kept).toHaveLength(1);
    // And says nothing when it was given one, because there is nothing to keep.
    const kept2: string[] = [];
    const e2 = createEngine({ ...store([]).deps(), createSocket: () => deafSocket(), onIdentity: (secret: string) => kept2.push(secret) });
    running.push(e2);
    await e2.apply({ enabled: true, name: "Deck-B", shared: [], secret: kept[0] });
    expect(kept2).toEqual([]);
    expect(e2.status().fp).toBe(e.status().fp);
  }, 20_000);

  it("shows the name the user chose to its peers", async () => {
    const a = await deck(store([]), "Constantin-MacBook", []);
    const b = await deck(store([]), "Constantin-PC", []);
    await point(a, b, b.port);
    // The address is what got us there; the NAME comes back from the deck
    // itself, over a handshake it had to prove its own key to complete.
    const conn = await a.e.round();
    expect(conn).toEqual([]);
    expect(a.e.status().peers.some((p: { addr: string }) => p.addr === "127.0.0.1")).toBe(true);
  }, 20_000);
});

describe("an address somebody typed", () => {
  // The field's own parser, which is strict about the port and loose about the
  // host: this side cannot tell a typo from a hostname it has never heard of —
  // the network will — while a bad port means dialling nothing forever, which
  // is a row that reports an error every minute and can never come right.
  it("takes the shapes a person would type", () => {
    expect(parseAddress("192.168.1.5:54340")).toEqual({ addr: "192.168.1.5", port: 54340 });
    expect(parseAddress("  laptop.local:5000  ")).toEqual({ addr: "laptop.local", port: 5000 });
    // Last colon, not the first, or a bracketed IPv6 loses its address.
    expect(parseAddress("[fe80::1]:5000")).toEqual({ addr: "[fe80::1]", port: 5000 });
  });

  it("refuses anything that could only ever dial nothing", () => {
    for (const bad of ["", "   ", "192.168.1.5", "192.168.1.5:", ":5000", "host:0", "host:70000", "host:abc"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("replaces the list wholesale, so removing one really stops it", async () => {
    // Adding one at a time would leave a removed address still dialled every
    // minute until the next restart — the row would vanish from the panel while
    // the socket kept opening, which is the worst of both.
    const e = createEngine({ ...store([]).deps(), createSocket: () => deafSocket() });
    running.push(e);
    expect(e.setPeers(["1.2.3.4:5", "6.7.8.9:10"])).toBe(2);
    expect(e.setPeers(["1.2.3.4:5"])).toBe(1);
    expect(e.setPeers([])).toBe(0);
    expect(e.setPeers(["nonsense", "", "x:0"]), "junk was stored as a row that can never connect").toBe(0);
  });

  it("dials a typed address that no beacon would have found", async () => {
    // The whole reason the field exists. These two are on loopback, which no
    // broadcast reaches from another subnet either.
    const mine = store([{ num: 2, email: "a@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "a@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("a@x", "o")]);
    const b = await deck(theirs, "Deck-B", [K("a@x", "o")]);
    expect(a.e.setPeers([`127.0.0.1:${b.port}`])).toBe(1);
    // Refused the first time and accepted on the other machine, exactly as the
    // two presses go in the product.
    await a.e.round();
    expect(b.e.accept(a.e.status().fp)).toBeTruthy();
    const done = await a.e.round();
    expect(done.map((d: { action: string }) => d.action)).toEqual(["heal"]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);

  it("does not dial the same deck twice when a beacon also found it", async () => {
    // A deck that is both heard and typed would otherwise be worked twice a
    // round and its results counted twice.
    const mine = store([{ num: 2, email: "a@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "a@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [K("a@x", "o")]);
    const b = await deck(theirs, "Deck-B", [K("a@x", "o")]);
    a.e.setPeers([`127.0.0.1:${b.port}`, `127.0.0.1:${b.port}`]);
    await a.e.round();
    expect(b.e.accept(a.e.status().fp)).toBeTruthy();
    const done = await a.e.round();
    expect(done).toHaveLength(1);
  }, 20_000);
});

describe("the address a person reads out to a colleague", () => {
  // Printed in the panel for the field on the other deck, because broadcast
  // dies at the first router and across a VPN an address is the only way in.
  it("is the machine's own, not loopback and not a failed lease", () => {
    expect(localAddresses({ lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }] })).toEqual([]);
    // 169.254 is what a machine gets when DHCP failed — reachable by nobody
    // worth telling about, so it is not offered as though it were.
    expect(localAddresses({ en0: [{ internal: false, family: "IPv4", address: "169.254.1.2" }] })).toEqual([]);
    expect(localAddresses({ en0: [{ internal: false, family: "IPv6", address: "fe80::1" }] })).toEqual([]);
  });

  it("offers EVERY address, because only the person knows which one reaches them", () => {
    // It returned the first and that was wrong the first time somebody checked:
    // the first here is the LAN address and the deck that needed reaching was
    // on a VPN, so the panel offered an address that peer cannot route to and
    // left them to work out why. A list of two is a smaller ask than a wrong
    // answer.
    expect(localAddresses({
      lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
      en1: [{ internal: false, family: "IPv4", address: "192.168.1.82" }],
      utun4: [{ internal: false, family: "IPv4", address: "100.67.32.58" }],
    })).toEqual(["192.168.1.82", "100.67.32.58"]);
  });

  it("says the same address once, however many interfaces claim it", () => {
    expect(localAddresses({
      en0: [{ internal: false, family: "IPv4", address: "10.0.0.5" }],
      bridge0: [{ internal: false, family: "IPv4", address: "10.0.0.5" }],
    })).toEqual(["10.0.0.5"]);
  });

  it("is empty rather than a guess when there is nothing to offer", () => {
    expect(localAddresses({})).toEqual([]);
    expect(localAddresses(null)).toEqual([]);
    expect(localAddresses(undefined).length).toBeGreaterThan(0);
  });

  it("takes node's numeric family as well as its string one", () => {
    // It changed spelling between node versions and this runs on 18 through 22.
    expect(localAddresses({ en0: [{ internal: false, family: 4, address: "10.0.0.5" }] })).toEqual(["10.0.0.5"]);
  });
});

describe("the cadence", () => {
  it("asks often enough to feel live and far less often than a login dies", () => {
    expect(SYNC_MS).toBeGreaterThanOrEqual(30_000);
    expect(SYNC_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("saying no, and meaning it", () => {
  it("stops the asking here and tells the deck that asked", async () => {
    // The two halves of a refusal, and before this neither existed. A deck that
    // asks keeps asking — it dials on its own timer — so dismissing a request
    // took a row off a list the next round put straight back, and the machine
    // that asked could not tell "no" from "not yet": both are one refusal on
    // the wire, and only one of them ever comes right by waiting.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", []);

    // A dials B and is refused, which is what puts it in front of B's owner.
    expect(a.e.addPeer("127.0.0.1", b.port)).toBe(true);
    await a.e.round();
    expect(b.e.status().pending).toHaveLength(1);
    const fpA = a.e.status().fp as string;

    expect(b.e.dismiss(fpA)).toBe(true);
    expect(b.e.status().pending).toHaveLength(0);
    expect(b.e.status().declined).toMatchObject([{ fp: fpA, name: "Deck-A" }]);

    // A dials again, as it will, and now it is TOLD.
    await a.e.round();
    const row = (a.e.status().peers as Array<{ last?: { error?: string } }>)[0];
    expect(row.last?.error).toBe("that deck said no");
    // And B's owner is not asked the same question a second time.
    expect(b.e.status().pending).toHaveLength(0);
  }, 20_000);

  it("takes the no back, so the next dial is a request again", async () => {
    // A refusal nobody can undo is a refusal that outlives the reason for it.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", []);
    a.e.addPeer("127.0.0.1", b.port);
    await a.e.round();
    const fpA = a.e.status().fp as string;
    b.e.dismiss(fpA);

    expect(b.e.allow(fpA)).toBe(true);
    expect(b.e.status().declined).toEqual([]);
    // Nothing to press on either machine: the deck that was declined is still
    // dialling, and the next dial is a request like the first one was.
    await a.e.round();
    expect(b.e.status().pending).toMatchObject([{ fp: fpA, name: "Deck-A" }]);
  }, 20_000);

  it("answers a name it never declined with false rather than with a change", () => {
    const only = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    return deck(only, "Deck-A", []).then(a => {
      expect(a.e.allow("00:00:00:00:00:00")).toBe(false);
      expect(a.e.dismiss("00:00:00:00:00:00")).toBe(false);
      expect(a.e.status().declined).toEqual([]);
    });
  });
});

describe("the suite must not shout on somebody's network", () => {
  it("gives every engine a socket that goes nowhere", () => {
    // The TCP half of these cases is real and should be: two engines, one
    // handshake, a sealed credential, and a mock would only check that the mock
    // agrees with the code it was written from.
    //
    // The UDP half must not be. The beacon broadcasts to 255.255.255.255, so a
    // case left on the default socket announced `Deck-A` and `Stranger` on
    // whatever network the machine was on — and they arrived in a real panel,
    // on a real screen, in the list of decks a person can pair with. Found
    // exactly that way, in a screenshot.
    const src = readFileSync(fileURLToPath(new URL("./lan-engine.test.ts", import.meta.url)), "utf8");
    const builds = [...src.matchAll(/createEngine\(/g)].length;
    const deaf = [...src.matchAll(/createSocket: \(\) => deafSocket\(\)/g)].length;
    expect(deaf, "an engine was built without a deaf socket").toBe(builds);
  });
});
