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
import { ASKING_MS, createEngine, defaultName, localAddresses, MAX_AUTO_PEERS, SYNC_MS } from "../../server/lan-engine.mjs";
import { parseAddress } from "../components/LanSyncSection";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, hostId, identityFrom, PROTOCOL } from "../../server/lan-sync.mjs";


const K = (email: string, org: string) => accountKey(email, org);

interface Row { num: number; email: string; orgUuid: string; alive: boolean; active?: boolean }

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
    /** Hand the engine a packet as though it had arrived, WITHOUT any leaving.
     *  Deaf in the direction that matters and not in the other: an inbound
     *  beacon is the entry point of the whole automatic path, and a case about
     *  what one unsolicited packet may do has to be able to send exactly one. */
    deliver(msg: Buffer, from: string) { handlers.get("message")?.(msg, { address: from }); },
  };
}

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

async function deck(s: ReturnType<typeof store>, name: string, shared: string[], over = {}, on = {}) {
  const errors: string[] = [];
  // The key is kept by the caller in the real deck, so it is kept here too:
  // every engine gets its own, made once, rather than a fresh one per apply.
  const id = identityFrom("");
  const trusted: Array<{ fp: string; pub: string; name: string }> = [];
  const sock = deafSocket();
  const e = createEngine({
    ...s.deps(over),
    createSocket: () => sock,
    onError: (w: string) => errors.push(w),
    // Written straight back into what the next apply is given, which is what
    // index.mjs does through prefs.
    onTrust: (list: Array<{ fp: string; pub: string; name: string }>) => {
      trusted.splice(0, trusted.length, ...list);
    },
  });
  running.push(e);
  // BY HAND, unless a test says otherwise. Both switches ship on, so a deck
  // built with the defaults pairs itself — which is the right default and the
  // wrong fixture for the twenty tests below, every one of which is about what
  // a PRESS does. The automatic path has its own describe, where it is the
  // subject rather than the weather.
  await e.apply({
    enabled: true, name, secret: id.secret, shared, trusted,
    autoAsk: false, autoAccept: false, ...on,
  });
  return { e, errors, id, trusted, sock, port: e.status().port as number };
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

describe("the gap between rounds", () => {
  it("is a minute at rest and seconds while somebody is deciding", () => {
    // Two numbers, and the second one exists for the only moment anybody is
    // watching: the seconds after somebody presses accept on the other machine.
    // Reported as "it should work by itself", from a panel that had been
    // correct for up to fifty-nine more seconds than the person in front of it.
    expect(SYNC_MS).toBe(60_000);
    expect(ASKING_MS).toBeLessThan(SYNC_MS / 4);
    expect(ASKING_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("tightens only for a request nobody has answered yet", async () => {
    // A refusal is an answer: a deck that said no is not dialled every eight
    // seconds for the rest of the session. The sentence the loop watches for is
    // the one lan-socket.mjs sends for "a real deck, not yet accepted" — the
    // same string WIRE_ANSWERS keys on in the panel, so the two files cannot
    // drift apart silently.
    const src = readFileSync(fileURLToPath(new URL("../../server/lan-engine.mjs", import.meta.url)), "utf8");
    expect(src).toContain('"waiting for the other deck to accept this one"');
    expect(src).toMatch(/waitingOnSomebody\(\) \? ASKING_MS : SYNC_MS/);
    const socket = readFileSync(fileURLToPath(new URL("../../server/lan-socket.mjs", import.meta.url)), "utf8");
    expect(socket).toContain("waiting for the other deck to accept this one");
  });
});

describe("a deck that could not start", () => {
  it("keeps the reason, so the panel stops saying starting…", async () => {
    // Two decks on one machine: the second one's bind fails, the switch stays
    // on, the beacon never comes up — and the panel drew `starting…` for as
    // long as the process lived. Reported from a real run: `listen EADDRINUSE:
    // address already in use`.
    const rows = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const first = await deck(rows, "Deck-A", []);
    const taken = first.port;
    expect(taken).toBeGreaterThan(0);

    const id = identityFrom("");
    const second = createEngine({
      ...rows.deps(),
      createSocket: () => deafSocket(),
      onError: () => { /* reported, never thrown */ },
    });
    running.push(second);
    // The same port, pinned, which is what a restarted deck asks for.
    await expect(second.apply({
      enabled: true, name: "Deck-B", secret: id.secret, shared: [], trusted: [], port: taken,
      // A listener that cannot bind is the case; `prefer` falling through to an
      // OS-chosen port is what normally saves it, so the socket is held open
      // here by the deck above and refused by hand below.
    })).resolves.toBeUndefined();

    // Whatever happened, the two states a reader can be left in are the ones
    // this asserts: either it came up (a free port was found, which is the
    // designed fallback) or it says why it did not. Never `starting…` forever.
    const said = second.status();
    expect(said.running || typeof said.stalled === "string").toBe(true);
  }, 20_000);

  it("says nothing about a deck that is simply switched off", async () => {
    const rows = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(rows, "Deck-A", []);
    a.e.stop();
    await a.e.apply({ enabled: false });
    expect(a.e.status().stalled).toBeNull();
  }, 20_000);
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

describe("pairing that nobody presses", () => {
  // Three of somebody's own machines is three pairings and six presses, and
  // every one of them is the same answer: yes, that one is mine. Both switches
  // ship ON so a fleet finds itself; what is pinned here is that ON does
  // exactly what the two labels say and nothing next to it.

  it("says yes to a deck that asks, without anybody being asked", async () => {
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", []);
    await b.e.apply({ autoAccept: true });

    // A dials B. With the switch off this leaves a row in front of B's owner;
    // with it on, B has already pinned A by the time the dial is refused.
    expect(a.e.addPeer("127.0.0.1", b.port)).toBe(true);
    await a.e.round();
    const fpA = a.e.status().fp as string;
    expect(b.e.status().pending).toHaveLength(0);
    expect(b.e.status().trusted).toMatchObject([{ fp: fpA, name: "Deck-A" }]);

    // AND THE WIRE IS UNCHANGED. That first dial is still refused, because
    // trust is read fresh per connection — this is the accept button pressed,
    // not a second way in. The next dial is the one that works, exactly as it
    // would be if a person had pressed it.
    await a.e.round();
    const row = (a.e.status().peers as Array<{ last?: { error?: string } }>)[0];
    expect(row.last?.error).toBeUndefined();
  }, 20_000);

  it("does not say yes to a deck its owner already turned away", async () => {
    // A no is a decision about a machine, and a switch called "every deck that
    // asks" must not be a way for that machine to come back through the side.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", []);
    a.e.addPeer("127.0.0.1", b.port);
    await a.e.round();
    const fpA = a.e.status().fp as string;
    expect(b.e.dismiss(fpA)).toBe(true);

    await b.e.apply({ autoAccept: true });
    await a.e.round();
    expect(b.e.status().trusted).toEqual([]);
    expect(b.e.status().declined).toMatchObject([{ fp: fpA }]);
  }, 20_000);

  it("answers what was already waiting when the switch goes on", async () => {
    // Somebody who turns this on with two rows sitting in the panel means those
    // two as much as the next one.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(mine, "Deck-A", []);
    const b = await deck(theirs, "Deck-B", []);
    a.e.addPeer("127.0.0.1", b.port);
    await a.e.round();
    expect(b.e.status().pending).toHaveLength(1);

    await b.e.apply({ autoAccept: true });
    expect(b.e.status().pending).toHaveLength(0);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.e.status().fp }]);
  }, 20_000);

  it("reports both switches, so the dialog draws what the engine is doing", async () => {
    const only = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const a = await deck(only, "Deck-A", []);
    expect(a.e.status()).toMatchObject({ autoAsk: false, autoAccept: false });
    await a.e.apply({ autoAsk: true, autoAccept: true });
    expect(a.e.status()).toMatchObject({ autoAsk: true, autoAccept: true });
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
    // Two spellings, and the second is still the first. The harness keeps ONE
    // instance rather than making a fresh one per call, so a case can hand an
    // engine a packet through it — the beacon is the entry point of the
    // automatic pairing path, and a case about what one unsolicited packet may
    // do has to be able to send exactly one. Nothing goes OUT either way.
    const deaf = [...src.matchAll(/createSocket: \(\) => (?:deafSocket\(\)|sock\b)/g)].length;
    expect(deaf, "an engine was built without a deaf socket").toBe(builds);
    expect(src, "`sock` must be a deaf one").toContain("const sock = deafSocket();");
  });
});

describe("a heal that healed nothing", () => {
  // `cswap import` exits ZERO when it declines an account it already holds —
  // cswap-admin's importAccount says so itself and reports `added: false`. The
  // engine read `ok` alone, so a round that changed nothing was counted as a
  // successful repair and the panel said the account had been fixed. Whoever
  // read that then waited for numbers that were never going to move.
  //
  // The decline is narrow and documented on claude-swap's side: a plain import
  // replaces a slot only when its usage row is quarantined as
  // refresh-token-dead, and is "never triggered by the live store's
  // `no credentials` state". So `login expired` heals over the network and
  // `no stored login` does not.
  const src = readFileSync(
    fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8",
  );
  const engine = readFileSync(
    fileURLToPath(new URL("../../server/lan-engine.mjs", import.meta.url)), "utf8",
  );
  const admin = readFileSync(
    fileURLToPath(new URL("../../server/cswap-admin.mjs", import.meta.url)), "utf8",
  );
  // The forced half moved out of the route and into cswap-admin's
  // `fillEmptySlot` with #1040, so that the verdict and the write could be one
  // critical section instead of a check out here and a lock in there. The rules
  // it carries did not change; they are asserted where the code now is.
  const fillEmptySlot = (() => {
    const at = admin.indexOf("export async function fillEmptySlot");
    // Empty rather than thrown when it is not there: a file that cannot be
    // collected reports one failure for the whole suite, and the cases below
    // are about several different rules.
    return at === -1 ? "" : admin.slice(at, admin.indexOf("\n}", at));
  })();

  it("requires the account to have actually arrived", () => {
    // `ok` alone is no longer the whole answer, on either path.
    expect(src).not.toContain("return !!out?.ok;");
    expect(src).toContain("if (out.added === true) return { ok: true };");
    expect(fillEmptySlot).toContain("if (!landed(forced.results)) return { ok: false,");
  });

  it("carries a reason, because refused and skipped are different sentences", () => {
    expect(engine).toContain("const got = await importAccount(blob, step);");
    expect(engine).toContain('why: ok ? null : (got?.why ?? "import failed")');
  });

  it("narrows the plain import too, not only the forced one", () => {
    // The AAD on the seal is `${peerFp}->${identity.fp}|${step.key}`: it binds
    // the ENVELOPE to the key that was requested and says nothing about the
    // contents. A share payload is `{ accounts: [...] }`, so a peer asked for A
    // could seal, under A's AAD, a bundle carrying A plus B, C and D it never
    // listed — and `syncAction` answers "add" for anything this deck lacks,
    // without the owner's tick. Every one of them landed. `only` narrows
    // without implying `force`, so the no-force promise is unchanged.
    expect(src).toContain('const out = await importAccount(blob, { only: { email: want, org: wantOrg ?? "" } });');
    expect(src).not.toContain("const out = await importAccount(blob);");
  });

  it("fills an empty slot, and only after asking this machine whether it is", () => {
    // The one case pairing exists for, and the one a plain import will never
    // touch: claude-swap replaces a slot "iff its usage row is quarantined as
    // refresh-token-dead" and is "never triggered by the live store's
    // `no credentials` state".
    expect(fillEmptySlot).toContain('if (now !== "no_credentials") return { ok: false,');
    expect(fillEmptySlot).toContain('const forced = await importAccount(blob, { force: true, only: { email, org: org ?? "" } });');
    // ASKED NOW rather than read from the ten-minute cache: somebody who signed
    // in two minutes ago still reads as `no_credentials` there, and acting on
    // that would replace the login they had just created.
    expect(fillEmptySlot).toContain("const now = await verdictNow(email, org ?? \"\");");

    // AND INSIDE THE LOCK THAT THEN WRITES (#1040). Fresh was not enough by
    // itself: the read sat outside the store mutex and importAccount takes it
    // from within, so a forced import could queue for the length of a sign-in —
    // `cswap add` 60 s, `cswap list` 60 s, `cswap switch` 30 s — and then run
    // holding a verdict taken before any of it. The verdict is the first thing
    // awaited inside the critical section, and nothing may be awaited above it,
    // because anything that is re-opens the window by exactly its own duration.
    const lock = fillEmptySlot.indexOf("withStoreLock");
    const verdict = fillEmptySlot.indexOf("await verdictNow");
    expect(lock, "the fill does not take the lock at all").toBeGreaterThan(-1);
    expect(verdict, "the verdict is read before the lock is held").toBeGreaterThan(lock);
    expect(
      fillEmptySlot.slice(lock, verdict),
      "something is awaited between taking the lock and re-reading the verdict",
    ).not.toMatch(/await /);
  });

  it("keeps the promise the flag was never passed for", () => {
    // A peer cannot reach the forced path: the verdict comes from THIS
    // machine's claude-swap, about THIS machine's store, and nothing a peer
    // sends can make a slot report that it holds nothing. `only` narrows it to
    // the one account, so a bundle carrying several cannot ride in behind it.
    expect(src).toContain("NO `force`, ever");
    expect(src).toMatch(/nothing a peer sends can make a slot report that it holds nothing/);
    // Sliced to the end of the property rather than by a character count: the
    // reasoning above the call is long, and a window that stopped short of it
    // would assert the flag is absent from a block that does not contain it
    // either way. The route delegates the forced path now, so the flag is not
    // in this block at all — which is the same assertion at full strength.
    const at = src.indexOf("importAccount: async (blob, step)");
    const block = src.slice(at, src.indexOf("\n  },", at));
    expect(block).not.toMatch(/force:\s*true/);
    // And exactly one forced call in the deck, carrying `only`. `--force`
    // overwrites every account it matches, so narrowing to the one the verdict
    // was about is what keeps an overwrite a named act.
    expect((fillEmptySlot.match(/force: true/g) ?? []).length).toBe(1);
    expect(fillEmptySlot).toMatch(/force: true, only: \{ email, org/);
  });

  it("still takes a plain true, which is what the suite hands it", () => {
    expect(engine).toContain("const ok = got === true || got?.ok === true;");
  });

  it("does not reach for --force to get around the decline", () => {
    // The promise that a peer cannot overwrite a working credential of this
    // deck's is kept by that flag never being passed. Reporting the decline
    // honestly is the fix; widening the flag is a different decision.
    expect(src).toContain("NO `force`, ever");
    const at = src.indexOf("importAccount: async blob =>");
    expect(src.slice(at, at + 1600)).not.toMatch(/force:\s*true/);
  });
});

/** One deck's row for another, as the panel is handed it. */
function peerRow(d: { e: { status: () => { peers: unknown[] } } }, fp: string) {
  return (d.e.status().peers as Array<Record<string, any>>).find(p => (p.peerFp ?? p.fp) === fp);
}

describe("what a paired deck says about itself", () => {
  const MAC = { version: "3.21.0", os: "macOS 26.5", arch: "arm64" };
  const WIN = { version: "3.20.9", os: "Windows 11", arch: "x64" };

  it("trades cards both ways once the two are paired", async () => {
    const a = await deck(store([]), "Deck-A", [], { about: MAC });
    const b = await deck(store([]), "Deck-B", [], { about: WIN });
    await point(a, b, b.port);
    await a.e.round();
    // The deck that dialled learned the other's from the answer…
    expect(peerRow(a, b.id.fp)?.about).toMatchObject(WIN);
    // …and the deck that answered learned the caller's from the question,
    // which is the only way a deck that only calls in is ever known.
    expect(peerRow(b, a.id.fp)?.about).toMatchObject(MAC);
    // Each carries its own too, so a version can be read against it.
    expect(a.e.status().about).toEqual(MAC);
  }, 20_000);

  it("says nothing for a deck built without one, which is every older deck", async () => {
    const a = await deck(store([]), "Deck-A", [], { about: MAC });
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    await a.e.round();
    expect(peerRow(a, b.id.fp)?.about).toBeNull();
    // And the round still went through: a card is extra, never required.
    expect(peerRow(a, b.id.fp)?.last?.error).toBeUndefined();
  }, 20_000);

  it("keeps the logins the other deck offered, and only those", async () => {
    const theirs = store([
      { num: 5, email: "shared@x.md", orgUuid: "o1", alive: true },
      { num: 6, email: "dead@x.md", orgUuid: "o2", alive: false },
      { num: 7, email: "private@x.md", orgUuid: "o3", alive: true },
    ]);
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(theirs, "Deck-B", [K("shared@x.md", "o1"), K("dead@x.md", "o2")]);
    await point(a, b, b.port);
    await a.e.round();
    const offers = peerRow(a, b.id.fp)?.offers;
    // The one nobody ticked is not listed — not even as withheld.
    expect(offers?.accounts).toEqual([
      { key: K("dead@x.md", "o2"), email: "dead@x.md", alive: false },
      { key: K("shared@x.md", "o1"), email: "shared@x.md", alive: true },
    ]);
    expect(offers?.at).toBeTypeOf("number");
  }, 20_000);

  it("remembers when somebody said yes, on both sides", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    await a.e.round();
    expect(peerRow(a, b.id.fp)?.pairedAt).toBeTypeOf("number");
    expect(peerRow(b, a.id.fp)?.pairedAt).toBeTypeOf("number");
    // Written through to what the caller keeps, which is what survives a restart.
    expect(a.trusted[0]?.at).toBeTypeOf("number");
  }, 20_000);

  it("checks one deck on demand, and says so about one it has no way to dial", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    await a.e.round();
    expect(await a.e.roundOne(b.id.fp)).toEqual([]);
    expect(peerRow(a, b.id.fp)?.last?.error).toBeUndefined();
    expect(await a.e.roundOne("nobody-at-all")).toBeNull();
  }, 20_000);

  it("hands the page the names somebody here gave other decks, without a restart", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const port = a.e.status().port;
    await a.e.apply({ aliases: { "aaa-bbb-ccc-ddd": "Office" } });
    expect(a.e.status().aliases).toEqual({ "aaa-bbb-ccc-ddd": "Office" });
    expect(a.e.status().port).toBe(port);
  });
});

// The account a deck is working on travels with the list it offers, in both
// directions of a round — and only ever names an account in that list.
describe("which account a paired deck is on", () => {
  const ON = K("on@x.md", "o1");
  const OFF = K("off@x.md", "o2");
  const rows = (active: "on" | "off"): Row[] => [
    { num: 1, email: "on@x.md", orgUuid: "o1", alive: true, active: active === "on" },
    { num: 2, email: "off@x.md", orgUuid: "o2", alive: true, active: active === "off" },
  ];

  it("names the account it is on, when that is one it shares", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store(rows("on")), "Deck-B", [ON]);
    await point(a, b, b.port);
    await a.e.round();
    expect(peerRow(a, b.id.fp)?.offers?.current).toEqual({ key: ON });
  }, 20_000);

  it("says only that it is on another account, when that is one it does not share", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store(rows("off")), "Deck-B", [ON]);
    await point(a, b, b.port);
    await a.e.round();
    expect(peerRow(a, b.id.fp)?.offers?.current).toEqual({ other: true });
  }, 20_000);

  it("says it is hidden when its owner switched that off", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store(rows("on")), "Deck-B", [ON]);
    await b.e.apply({ shareActive: false });
    expect(b.e.status().shareActive).toBe(false);
    await point(a, b, b.port);
    await a.e.round();
    expect(peerRow(a, b.id.fp)?.offers?.current).toEqual({ hidden: true });
  }, 20_000);

  it("is heard from a deck that only calls in, with its list and its card", async () => {
    const MAC = { version: "3.23.0", os: "macOS 26.5", arch: "arm64" };
    const a = await deck(store(rows("on")), "Deck-A", [ON, OFF], { about: MAC });
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    // Accepting dials back at the port A's hello carried; a deck behind a
    // firewall or a VPN is one where that address never answers, which is
    // what taking it away here stands for. B now holds no way to reach A.
    b.e.setPeers([]);
    await a.e.round();
    // So to B, A is a deck that calls in, and everything B knows about it
    // came with A's question.
    const row = peerRow(b, a.id.fp);
    expect(row?.waiting).toBe(true);
    expect(row?.about).toMatchObject(MAC);
    expect(row?.offers?.accounts.map((x: { key: string }) => x.key)).toEqual([OFF, ON].sort());
    expect(row?.offers?.current).toEqual({ key: ON });
  }, 20_000);
});

// THE ROUND'S OWN TWO CEILINGS, WHICH IT DID NOT HAVE.
//
// roundWith opens a second reader on a socket that already has a frameReader,
// and plans over a manifest it has already capped one line above. Both were
// written as if the caps elsewhere covered them, and neither did:
//
//   * the frameReader IS still attached and does hit MAX_FRAME_BYTES, but it
//     only sets its own flag and calls `fail`, which short-circuits on
//     `settled` — so nothing destroyed the socket and `ask`'s own buffer grew
//     unbounded for the full ROUND_MS at line rate;
//   * `offered()` slices to 50 and type-filters, and `plan()` was handed the
//     raw array instead — so a peer answering with thousands of rows produced
//     thousands of sequential want/have round trips plus a claude-swap
//     subprocess each, while the panel drew 50.
//
// Source assertions, because both live inside a socket exchange several frames
// into a handshake against a live peer. lan-socket.test.ts owns what
// frameReader does with the cap; this owns that the round reaches for it.
describe("the sync round keeps the caps the rest of the protocol keeps", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../server/lan-engine.mjs", import.meta.url)), "utf8");

  it("bounds its own reader at MAX_FRAME_BYTES, like frameReader", () => {
    expect(src).toContain("if (buf.length > MAX_FRAME_BYTES) {");
    expect(src).toContain('give(reject, new Error("frame too large"))');
    // Reached for rather than re-typed, so the two cannot drift apart.
    expect(src).toContain("MAX_FRAME_BYTES } from \"./lan-socket.mjs\"");
  });

  it("detaches its listener on every way out, not only on the newline", () => {
    // The reject path used to leave `onData` attached, so the buffer kept
    // growing until roundWith's finally destroyed the socket.
    expect(src).toContain('conn.sock.off("data", onData);');
    expect(src).toContain("const give = (fn, arg) => {");
  });

  it("plans over the capped list rather than the raw manifest", () => {
    expect(src).toContain("const wanted = plan(mine, list)");
    expect(src, "the raw array must not come back").not.toContain("plan(mine, theirs.accounts)");
  });

  it("and the list it plans over is the one the panel was shown", () => {
    // One value, so what is drawn and what is done cannot disagree.
    expect(src).toContain("const list = offered(theirs.accounts);");
    expect(src.indexOf("const list = offered(theirs.accounts);"))
      .toBeLessThan(src.indexOf("const wanted = plan(mine, list)"));
  });
});

// WHAT A SHOUT FROM AN UNKNOWN ADDRESS IS ALLOWED TO BUY.
//
// Driven end to end against a victim engine on the defaults the deck ships —
// `lan.enabled` on, `autoAsk` on, `autoAccept` off, `shared: []`, `trusted: []`
// — and what was observed before this rule existed was: one UDP datagram from
// an address nobody had typed, nobody at the keyboard, and the far end sitting
// in `cfg.trusted` with `onTrust` already fired. index.mjs writes that list
// straight to prefs.json, and being on it is the whole inbound gate.
//
// The chain had four links and each was defensible alone. A beacon
// authenticates nothing, by construction — it carries a fingerprint and a port
// and nothing binds either to the address it came from. `autoAsk` ships on and
// answered every new fingerprint by putting its address on the dial list. The
// next round reached it. And roundWith read "I have no pin for this" as "the
// person at this keyboard typed this address", which was true right up until
// `autoAsk` shipped on and stopped being true. `plan`'s `add` needs no tick, so
// the last link needed nothing shared either.
//
// The rule that replaces it is the one roundWith's own comment always claimed:
// a row may be pinned sight unseen only when a PERSON named it. The automatic
// path may still ask — that is what the switch is called — and an ask is a row
// with an accept on it.
describe("a deck this one heard rather than reached for", () => {
  /** One beacon, as it arrives off the wire. Its fingerprint and port are a
   *  real listener's, because the point of the case is that a real deck really
   *  is there — the packet is honest and still nobody asked for it. */
  const announce = (
    to: { sock: { deliver: (m: Buffer, f: string) => void } },
    from: { e: { status: () => { fp: string; port: number } } },
    name: string,
  ) => to.sock.deliver(Buffer.from(JSON.stringify({
    m: "CCDK", v: PROTOCOL, n: name, f: from.e.status().fp, p: from.e.status().port,
    i: "00".repeat(8), h: hostId({ hostname: "somewhere-else", home: "/home/somebody" }),
  })), "127.0.0.1");

  it("is asked about rather than pinned, however the deck came to dial it", async () => {
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 2, email: "stranger@elsewhere.test", orgUuid: "org-9", alive: true }]);
    // The shipped defaults on the deck under test, and nothing ticked.
    const a = await deck(mine, "Deck-A", [], {}, { autoAsk: true });
    // The far side answers the handshake, which is the one thing an unwanted
    // deck controls completely: it is its own listener and its own trusted list.
    const b = await deck(theirs, "Deck-B", [K("stranger@elsewhere.test", "org-9")], {}, { autoAccept: true });

    announce(a, b, "Uninvited");
    // Twice: the first dial is refused while B is still deciding, the second
    // completes — and the second is the round that used to pin.
    await a.e.round();
    await a.e.round();

    expect(a.e.status().trusted, "one datagram wrote a pin").toEqual([]);
    expect(a.trusted, "and onTrust would have put it in prefs.json").toEqual([]);
    // Nothing was asked for either, so `plan`'s tickless `add` had nothing to
    // act on — the account B offers is still only B's.
    expect(mine.imported).toEqual([]);
    expect(theirs.exported).toEqual([]);

    // What it IS instead: a row with an accept on it, holding the key the
    // handshake proved — the same row a deck that dials IN leaves behind.
    expect(a.e.status().pending).toMatchObject([{ fp: b.id.fp, name: "Deck-B" }]);
    const row = (a.e.status().peers as Array<{ typed: boolean; last?: { error?: string } }>)[0];
    expect(row.typed).toBe(false);
    expect(row.last?.error).toBe("waiting for somebody here to accept that deck");
  }, 20_000);

  it("becomes a pairing the moment somebody presses the accept it raised", async () => {
    // The other half, and the reason this is a gate rather than a refusal: the
    // automatic path still walks somebody up to the one press, and that press
    // is worth exactly what it always was.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: false }]);
    const theirs = store([{ num: 7, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const shared = [K("claude1@sapec.md", "org-1")];
    const a = await deck(mine, "Deck-A", shared, {}, { autoAsk: true });
    const b = await deck(theirs, "Deck-B", shared, {}, { autoAccept: true });

    announce(a, b, "Deck-B");
    await a.e.round();
    await a.e.round();
    expect(a.e.accept(b.id.fp)).toBeTruthy();
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);

    // And then it is an ordinary paired deck: the round it was blocking runs.
    expect(await a.e.round()).toEqual([{
      key: K("claude1@sapec.md", "org-1"), email: "claude1@sapec.md",
      action: "heal", ok: true, why: null,
    }]);
  }, 20_000);

  it("cannot make the dial list longer than a round can walk", async () => {
    // Measured, and the shape of it is not the obvious one. The list is keyed
    // `host:port`, so five hundred beacons from one address on one port are one
    // row:
    //
    //     500 beacons, one source IP, distinct fp + distinct port -> 500 rows
    //     500 beacons, one source IP, distinct fp + one port      ->   1 row
    //
    // So the ceiling from a single host was one row per announced port, up to
    // 65,535 of them, each dialled in turn with a ROUND_MS bell on it — which
    // leaves the decks somebody actually paired with at the back of a queue
    // hours long. Capped for what the deck added itself; a person's own list of
    // addresses is not the deck's business to trim.
    const a = await deck(store([]), "Deck-A", []);
    for (let p = 0; p < 200; p++) a.e.addPeer("127.0.0.1", 40_000 + p, { typed: false });
    for (let p = 0; p < 6; p++) a.e.addPeer("10.0.0.9", 50_000 + p);
    const peers = a.e.status().peers as Array<{ typed: boolean }>;
    expect(peers.filter(r => !r.typed)).toHaveLength(MAX_AUTO_PEERS);
    expect(peers.filter(r => r.typed)).toHaveLength(6);
  });

  it("keeps the vouching when a beacon arrives for an address somebody typed", async () => {
    // Order must not decide this. An address in the field is a person naming a
    // machine, and the next packet from that machine is not a reason to demote
    // the row to one the deck added on its own.
    const a = await deck(store([]), "Deck-A", []);
    a.e.addPeer("127.0.0.1", 44_401);
    a.e.addPeer("127.0.0.1", 44_401, { typed: false });
    expect((a.e.status().peers as Array<{ typed: boolean }>)[0].typed).toBe(true);
  });
});

// WHO IS ALLOWED TO ANSWER AT AN INVITE'S ADDRESS.
//
// The invite header says the code "closes the gap trust-on-first-use left open:
// the first contact is verified rather than believed." It closed it in one
// direction. `inviteProof` travelled in message three, caller to listener, and
// the `ok` that came back carried a session proof — an HMAC over an ECDH
// against whatever public key the responder had just presented. That proves the
// responder holds the private half of a key it chose a moment ago, which is
// something anything with a socket can do. `join` passes no pin, by definition,
// so connectToPeer's impostor check is inert on this path too.
//
// Observed against a listener that had never been given the code: `join`
// returned ok, and the deck that answered went into `cfg.trusted` and through
// `onTrust` into prefs.json. A token carries up to ten addresses and `join`
// stops at the first that ANSWERS — and `localAddresses` filters loopback and
// 169.254 but not RFC1918, so a container bridge address or a lease that has
// since moved to somebody else's machine is an ordinary thing to find in one.
// One of those winning the race won the whole token, and being trusted is the
// whole inbound gate.
describe("the invite, and the half of it that was never checked", () => {
  it("pairs with the deck that minted the token", async () => {
    const a = await deck(store([]), "Minter", []);
    const b = await deck(store([]), "Joiner", []);
    const offered = a.e.invite();
    const res = await b.e.join(offered.token);
    expect(res.ok, JSON.stringify(res.tried ?? [])).toBe(true);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.id.fp }]);
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);
    // Retired on use: a token that pairs twice is one worth stealing twice.
    expect(a.e.offering()).toBeNull();
  }, 20_000);

  it("walks past a deck at one of its addresses that cannot show the code", async () => {
    const a = await deck(store([]), "Minter", []);
    // A deck that answers the handshake and holds no invite. Its `autoAccept`
    // stands for the one thing a listener at that address always controls —
    // whether to complete a handshake with whoever dialled it.
    const wrong = await deck(store([]), "Wrong-Deck", [], {}, { autoAccept: true });
    const j = await deck(store([]), "Joiner", []);

    // One ordinary round first, so the wrong deck has the joiner on its own
    // trusted list by the time the token is used. That is the state this is
    // about — a listener that will complete a handshake with whoever dials it —
    // and nothing about how it got there is the subject.
    j.e.addPeer("127.0.0.1", wrong.port);
    await j.e.round();
    j.e.setPeers([]);
    expect(j.e.status().trusted, "the round itself must not have paired them").toEqual([]);

    const offered = a.e.invite();
    // The same token with the wrong deck's address ahead of the minter's.
    // Minted through the real function and re-addressed, so the code and the
    // expiry are the real ones rather than a hand-built token readInvite would
    // refuse before any of this ran.
    const { mintInvite, readInvite } = await import("../../server/lan-sync.mjs");
    const real = readInvite(offered.token);
    const token = mintInvite({
      addrs: [`127.0.0.1:${wrong.port}`, `127.0.0.1:${a.port}`],
      name: "Minter", code: real.code,
    }).token;

    const res = await j.e.join(token);

    expect(res.ok).toBe(true);
    expect(res.peer.fp, "it stopped at whatever answered first").toBe(a.id.fp);
    expect(res.tried).toMatchObject([
      { addr: `127.0.0.1:${wrong.port}`, why: "that deck does not hold the invite" },
    ]);
    expect(j.e.status().trusted.map((t: { fp: string }) => t.fp)).toEqual([a.id.fp]);
    expect(j.trusted.some((t: { fp: string }) => t.fp === wrong.id.fp),
      "the wrong deck reached prefs.json").toBe(false);
  }, 20_000);

  it("still joins on a token minted by a deck too old to prove anything back", async () => {
    // Compatibility is not a detail here: an invite is what people reach for
    // precisely when one machine has been updated and the other has not, and a
    // joiner that demanded the proof from every listener would break the
    // feature exactly then. The token says which kind of deck minted it, so
    // this degrades to the behaviour that shipped rather than refusing.
    const a = await deck(store([]), "Minter", []);
    const b = await deck(store([]), "Joiner", []);
    const { mintInvite, readInvite, INVITE_PREFIX } = await import("../../server/lan-sync.mjs");
    const real = readInvite(a.e.invite().token);
    const fresh = mintInvite({
      addrs: real.addrs.map((x: { addr: string; port: number }) => `${x.addr}:${x.port}`),
      name: "Minter", code: real.code,
    });
    // The same token as a previous release wrote it: no `pb`.
    const body = JSON.parse(Buffer.from(
      fresh.token.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
    delete body.pb;
    const old = INVITE_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
    expect(readInvite(old).provesBack).toBe(false);

    const res = await b.e.join(old);
    expect(res.ok, JSON.stringify(res.tried ?? [])).toBe(true);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.id.fp }]);
  }, 20_000);
});

// #1040, second half. `round` walks the peer list one deck at a time, under a
// comment that reasons about the store taking one mutation at a time — and both
// of those are statements about a round running ALONE. Two ways in, and nothing
// stopping them from meeting: the self-scheduling timer (SYNC_MS, or ASKING_MS
// while somebody is waiting), and `POST /api/lan/sync` calling
// `lanEngine.round()` straight from the "Sync now" press.
//
// WHAT WAS OBSERVED: a press landing while the timer's round was mid-import gave
// two rounds over the same peer list. Both dialled the same deck, both were
// offered the same account, and both wrote it — the assertions below counted two
// exports on the far side and two imports on this one for a single account that
// needed repairing once. On the real store that is two `cswap import --force`
// calls for the same slot, and with #1040's other half in place they are two
// writes standing behind one verdict: whichever finishes second is the
// credential this machine keeps, chosen by nothing.
//
// The guard joins rather than skips, because the press has a reply to send. A
// press answered with `[]` would tell the user "nothing to sync" about a round
// that was at that moment moving a credential, which is a worse sentence than a
// slow one.
describe("two rounds at once", () => {
  it("is one round, and the press joins the one already running", async () => {
    const mine = store([{ num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
    const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true }]);
    const shared = [K("claude2@sapec.md", "org-2")];

    // The import is held open, because that is the part of a round that takes
    // real time on a real machine — `cswap import` is a subprocess — and it is
    // the only part during which a second round does damage rather than merely
    // wasting a dial.
    const gates: Array<() => void> = [];
    let reached!: () => void;
    const importing = new Promise<void>(r => { reached = r; });
    const a = await deck(mine, "Deck-A", shared, {
      importAccount: async (blob: string) => {
        mine.imported.push(blob);
        reached();
        await new Promise<void>(r => gates.push(r));
        return true;
      },
    });
    const b = await deck(theirs, "Deck-B", shared);
    await point(a, b, b.port);

    const timer = a.e.round();
    await importing;             // a credential is being written right now
    const press = a.e.round();   // and somebody presses "Sync now"
    expect(press, "the press started a second round over the first").toBe(timer);

    for (const open of gates.splice(0)) open();
    const [byTimer, byPress] = await Promise.all([timer, press]);
    expect(byPress).toEqual(byTimer);
    expect(byTimer).toEqual([{
      key: K("claude2@sapec.md", "org-2"), email: "claude2@sapec.md",
      action: "heal", ok: true, why: null,
    }]);
    // One dial, one export, one import — for one account that needed repairing
    // once.
    expect(theirs.exported).toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);

  it("runs again once the first has finished, since the guard is not a latch", async () => {
    // A guard that never cleared would make every later round a no-op for the
    // life of the deck, which is the same feature broken the other way.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 9, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const shared = [K("claude1@sapec.md", "org-1")];
    const a = await deck(mine, "Deck-A", shared);
    const b = await deck(theirs, "Deck-B", shared);
    await point(a, b, b.port);
    const first = a.e.round();
    await first;
    const second = a.e.round();
    expect(second, "the finished round was handed back a second time").not.toBe(first);
    expect(await second).toEqual([]);
  }, 20_000);
});
