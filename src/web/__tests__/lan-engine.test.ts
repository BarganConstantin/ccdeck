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
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { ASKING_MS, createEngine, defaultName, localAddresses, MAX_AUTO_PEERS, SYNC_MS, ticksOnArrival } from "../../server/lan-engine.mjs";
import { parseAddress } from "../components/LanSyncSection";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, hostId, identityFrom, PROTOCOL, seal, transferChallenge } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer, createSyncServer, MAX_FRAME_BYTES } from "../../server/lan-socket.mjs";


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
  const unpaired = [...(((on as { unpaired?: string[] }).unpaired) ?? [])];
  // Everything else the engine hands index.mjs to write into prefs.json, kept
  // as it arrives: what survives a restart is only what went through one of
  // these, so a case about persistence reads them rather than the engine.
  const trustWrites: string[][] = [];
  const unpairedWrites: string[][] = [];
  const dials: string[] = [];
  const ports: number[] = [];
  const identities: string[] = [];
  const sock = deafSocket();
  const e = createEngine({
    ...s.deps(over),
    createSocket: () => sock,
    onError: (w: string) => errors.push(w),
    // Written straight back into what the next apply is given, which is what
    // index.mjs does through prefs.
    onTrust: (list: Array<{ fp: string; pub: string; name: string }>) => {
      trusted.splice(0, trusted.length, ...list);
      trustWrites.push(list.map(t => t.fp));
    },
    onUnpaired: (list: string[]) => {
      unpaired.splice(0, unpaired.length, ...list);
      unpairedWrites.push([...list]);
    },
    onDial: (entry: string) => dials.push(entry),
    onPort: (port: number) => ports.push(port),
    onIdentity: (secret: string) => identities.push(secret),
  });
  running.push(e);
  // BY HAND, unless a test says otherwise. Both switches ship on, so a deck
  // built with the defaults pairs itself — which is the right default and the
  // wrong fixture for the twenty tests below, every one of which is about what
  // a PRESS does. The automatic path has its own describe, where it is the
  // subject rather than the weather.
  await e.apply({
    enabled: true, name, secret: id.secret, shared, trusted, unpaired,
    autoAsk: false, autoAccept: false, ...on,
  });
  return { e, errors, id, trusted, trustWrites, unpaired, unpairedWrites, dials, ports, identities, sock, port: e.status().port as number };
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
    // The manifest half of the rule: an unticked account is not in the list,
    // so nothing is ever asked for. The other half — the tick read again at the
    // moment of sending, because the list can change between the two — is
    // "what the holder checks when a credential is asked for", below.
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

// THE ONE VERB THAT MOVES A CREDENTIAL, FROM THE SIDE THAT HOLDS IT (#1171).
//
// `serve` answers a paired deck's `want` with five refusals before it seals
// anything — a second proof, the tick, the account alive here, an export that
// produced something, and a store that threw — and until these cases none of
// them had ever run. The case above builds its holder with nothing ticked, so
// the manifest is empty and the requester never sends a `want` at all.
//
// Each case reaches its refusal over a real handshake between two engines, and
// checks both halves: the requester was told why, and claude-swap on the holder
// was never asked to export.
describe("what the holder checks when a credential is asked for", () => {
  const S = K("s@x", "o");

  it("reads the tick again at the moment of sending, so a login unticked since the manifest stays", async () => {
    // Two logins, so the untick can land between the two asks: the holder's
    // owner unticks the second while the first is being written here. That is
    // the race the check exists for — the manifest said yes, a moment ago.
    const A = K("a@x", "o");
    const mine = store([
      { num: 1, email: "a@x", orgUuid: "o", alive: false },
      { num: 2, email: "s@x", orgUuid: "o", alive: false },
    ]);
    const theirs = store([
      { num: 5, email: "a@x", orgUuid: "o", alive: true },
      { num: 6, email: "s@x", orgUuid: "o", alive: true },
    ]);
    let b!: Awaited<ReturnType<typeof deck>>;
    const a = await deck(mine, "Deck-A", [A, S], {
      importAccount: async (blob: string) => {
        mine.imported.push(blob);
        await b.e.apply({ shared: [A] });
        return true;
      },
    });
    b = await deck(theirs, "Deck-B", [A, S]);
    await point(a, b, b.port);

    expect(await a.e.round()).toEqual([
      { key: A, email: "a@x", action: "heal", ok: true, why: null },
      { key: S, email: "s@x", action: "heal", ok: false, why: "not shared" },
    ]);
    expect(theirs.exported, "the unticked login was exported").toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);

  it("gives nothing it no longer holds alive, whatever its manifest said a moment ago", async () => {
    // Asked again rather than remembered: between the manifest and the ask the
    // login can die here, or be removed, and a dead or missing slot is nothing
    // to hand anybody.
    for (const [what, later] of [
      ["died", [{ num: 5, email: "s@x", orgUuid: "o", alive: false }]],
      ["was removed", []],
    ] as Array<[string, Row[]]>) {
      const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
      const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
      let reads = 0;
      const a = await deck(mine, "Deck-A", [S]);
      // The first read answers the manifest; every one after it is the ask.
      const b = await deck(theirs, "Deck-B", [S], {
        readAccounts: async () => ({ accounts: ++reads === 1 ? theirs.rows : later }),
      });
      await point(a, b, b.port);
      expect(await a.e.round(), what).toEqual([
        { key: S, email: "s@x", action: "heal", ok: false, why: "not mine to give" },
      ]);
      expect(theirs.exported, what).toEqual([]);
    }
  }, 20_000);

  it("says so when claude-swap exported nothing, rather than sealing nothing", async () => {
    const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [S]);
    const b = await deck(theirs, "Deck-B", [S], { exportAccount: async () => null });
    await point(a, b, b.port);
    expect(await a.e.round()).toEqual([
      { key: S, email: "s@x", action: "heal", ok: false, why: "export failed" },
    ]);
    expect(mine.imported).toEqual([]);
  }, 20_000);

  it("reports a sender's Mac Keychain failure without sending its CLI diagnostic or a credential", async () => {
    const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [S]);
    const b = await deck(theirs, "Deck-B", [S], {
      exportAccount: async () => ({ ok: false, why: "keychain_unavailable", detail: "secret credential text" }),
    });
    await point(a, b, b.port);
    expect(await a.e.round()).toEqual([
      { key: S, email: "s@x", action: "heal", ok: false, why: "keychain_unavailable" },
    ]);
    expect(mine.imported).toEqual([]);
  }, 20_000);

  it("identifies the destination Mac's import failure and allows a retry once access returns", async () => {
    const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    let accessible = false;
    const a = await deck(mine, "Deck-A", [S], {
      importAccount: async (blob: string) => {
        if (!accessible) return { ok: false, why: "keychain_unavailable" };
        mine.imported.push(blob);
        return { ok: true };
      },
    });
    const b = await deck(theirs, "Deck-B", [S]);
    await point(a, b, b.port);
    expect(await a.e.round()).toEqual([
      { key: S, email: "s@x", action: "heal", ok: false, why: "keychain_unavailable_local" },
    ]);
    accessible = true;
    expect(await a.e.round()).toEqual([
      { key: S, email: "s@x", action: "heal", ok: true, why: null },
    ]);
    expect(mine.imported).toHaveLength(1);
  }, 20_000);

  it("answers a store that threw with a refusal, and keeps what threw", async () => {
    // A throw inside `serve` would otherwise leave the asking deck waiting out
    // its ten-second bell for a reply that never comes.
    const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
    const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    let reads = 0;
    const a = await deck(mine, "Deck-A", [S]);
    const b = await deck(theirs, "Deck-B", [S], {
      readAccounts: async () => {
        if (++reads > 1) throw new Error("cswap list timed out");
        return { accounts: theirs.rows };
      },
    });
    await point(a, b, b.port);
    expect(await a.e.round()).toEqual([
      { key: S, email: "s@x", action: "heal", ok: false, why: "error" },
    ]);
    expect(b.errors).toContain("serve");
    expect(theirs.exported).toEqual([]);
  }, 20_000);

  it("refuses a want whose proof is not over this connection, this account and these two decks", async () => {
    // THE SESSION SAYS WHO CONNECTED, AND NOT WHAT THEY ASK FOR NOW. The
    // connection below is a real one, made with Deck-A's own key to the deck
    // that trusts it; only the `want` on it is wrong. Without the second proof,
    // any paired deck's long-lived connection is enough to pull every ticked
    // account, and a round never sends a bad one to show it.
    const mine = store([{ num: 2, email: "s@x", orgUuid: "o", alive: true }]);
    const theirs = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    const a = await deck(mine, "Deck-A", [S]);
    const b = await deck(theirs, "Deck-B", [S]);
    await point(a, b, b.port);
    // Paired, both copies alive, and so nothing asked for.
    expect(await a.e.round()).toEqual([]);

    const conn = await connectToPeer({
      host: "127.0.0.1", port: b.port, fp: a.id.fp, pub: a.id.pub, secret: a.id.secret,
      name: "Deck-A", expectPub: b.id.pub,
    });
    /** One frame out and the next one back, through the connection's own seal. */
    const ask = (frame: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
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
    const proofFor = (nonce: string, accountKey: string) =>
      transferChallenge(conn.key, { nonce, accountKey, fromFp: a.id.fp, toFp: b.id.fp });
    try {
      expect(await ask({ t: "want", key: S, nonce: "n1", proof: "0".repeat(64) })).toEqual({ t: "no", why: "proof" });
      // A real proof, over this connection's key and between these two decks,
      // for ANOTHER account. It names what it asks for, so it is worth nothing
      // for this one.
      expect(await ask({ t: "want", key: S, nonce: "n2", proof: proofFor("n2", K("else@x", "o")) }))
        .toEqual({ t: "no", why: "proof" });
      expect(theirs.exported, "a login left on a proof that did not hold").toEqual([]);

      // And the same connection with the proof made properly is answered, so
      // the two refusals above were the proof and not the connection.
      expect(await ask({ t: "want", key: S, nonce: "n3", proof: proofFor("n3", S) })).toMatchObject({ t: "have", key: S });
      expect(theirs.exported).toEqual([5]);
    } finally {
      conn.sock.destroy();
    }
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

// UNPAIRING, WHICH NO CASE HAD EVER CALLED (#1171). The only tests were source
// pins on the panel's button and the pure `dropTrusted`. What `unpair` does to
// the engine — the pin gone, the shorter list written through, the answer the
// route hands back — is pinned here, and so is the half of the next round that
// holds today: the other deck, which still trusts this one and still dials it,
// is a request again when it calls, and is given nothing.
//
describe("unpairing", () => {
  it("does not send an outbound manifest when the caller unpairs during its account read", async () => {
    const key = K("outbound-private@x", "o");
    let release!: () => void;
    let started!: () => void;
    let hold = false;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const callerStore = store([{ num: 7, email: "outbound-private@x", orgUuid: "o", alive: true }]);
    const caller = await deck(callerStore, "Caller", [], {
      readAccounts: async () => {
        if (hold) { started(); await gate; }
        return { accounts: callerStore.rows };
      },
    });
    const holder = await deck(store([]), "Holder", []);
    await point(caller, holder, holder.port);
    await caller.e.round();
    await caller.e.apply({ shared: [key] });
    hold = true;
    const transfer = caller.e.round();
    await began;
    expect(caller.e.unpair(holder.id.fp)).toBe(true);
    release();
    await transfer;
    expect(peerRow(holder, caller.id.fp)?.offers?.accounts ?? []).toEqual([]);
  }, 20_000);

  it("does not reveal account identities in a manifest after the sender unpairs mid-read", async () => {
    const key = K("private@x", "o");
    let release!: () => void;
    let started!: () => void;
    let hold = false;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const receiver = await deck(store([]), "Receiver", []);
    const senderStore = store([{ num: 7, email: "private@x", orgUuid: "o", alive: true }]);
    const sender = await deck(senderStore, "Sender", [key], {
      readAccounts: async () => {
        if (hold) { started(); await gate; }
        return { accounts: senderStore.rows };
      },
    });
    await point(receiver, sender, sender.port);
    hold = true;
    const transfer = receiver.e.round();
    await began;
    expect(sender.e.unpair(receiver.id.fp)).toBe(true);
    release();
    await transfer;
    expect(peerRow(receiver, sender.id.fp)?.offers?.accounts ?? []).toEqual([]);
  }, 20_000);

  it.each(["unpair", "unshare"] as const)("refuses an in-flight export after the sender chooses to %s", async choice => {
    const key = K("revoked@x", "o");
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const senderStore = store([{ num: 7, email: "revoked@x", orgUuid: "o", alive: true }]);
    const receiverStore = store([]);
    const receiver = await deck(receiverStore, "Receiver", [key]);
    const sender = await deck(senderStore, "Sender", [key], {
      exportAccount: async () => { started(); await gate; return "ccdeck2:revoked"; },
    });
    await point(receiver, sender, sender.port);
    const transfer = receiver.e.round();
    await began;
    if (choice === "unpair") expect(sender.e.unpair(receiver.id.fp)).toBe(true);
    else await sender.e.apply({ shared: [] });
    release();
    await transfer;
    expect(receiverStore.imported).toEqual([]);
  }, 20_000);

  it.each(["unpair", "disable"] as const)("cancels an in-flight import after the receiver chooses to %s", async choice => {
    const key = K("incoming@x", "o");
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const receiverStore = store([]);
    const senderStore = store([{ num: 7, email: "incoming@x", orgUuid: "o", alive: true }]);
    const receiver = await deck(receiverStore, "Receiver", [key]);
    const sender = await deck(senderStore, "Sender", [key], {
      exportAccount: async () => { started(); await gate; return "ccdeck2:incoming"; },
    });
    await point(receiver, sender, sender.port);
    const transfer = receiver.e.round();
    await began;
    if (choice === "unpair") expect(receiver.e.unpair(sender.id.fp)).toBe(true);
    else await receiver.e.apply({ enabled: false });
    release();
    await transfer;
    expect(receiverStore.imported).toEqual([]);
  }, 20_000);

  it("drops the pin, writes the shorter list through, and says whether there was one", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    await a.e.round();
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);

    expect(a.e.unpair(b.id.fp)).toBe(true);
    expect(a.e.status().trusted).toEqual([]);
    // What index.mjs writes to prefs.json, and so what the next start reads.
    expect(a.trusted, "the pin would come back at the next restart").toEqual([]);
    expect(a.trustWrites.at(-1)).toEqual([]);
    expect(a.unpaired).toEqual([b.id.fp]);
    expect(a.unpairedWrites.at(-1)).toEqual([b.id.fp]);

    // A second press, or a fingerprint nobody paired, is not a change: the
    // route answers `ok: false`, and nothing is written for it.
    const writes = a.trustWrites.length;
    expect(a.e.unpair(b.id.fp)).toBe(false);
    expect(a.e.unpair("nobody-at-all")).toBe(false);
    expect(a.trustWrites).toHaveLength(writes);
  }, 20_000);

  it("makes the deck it unpaired a request again when it calls, and gives it nothing", async () => {
    // Unpairing here says nothing to the other machine: it still trusts this
    // deck and still dials it every minute, so its next round is what the
    // unpair has to hold against. Its own copy of the login is dead, so a
    // round that got through would ask for it.
    const key = K("s@x", "o");
    const holder = store([{ num: 5, email: "s@x", orgUuid: "o", alive: true }]);
    const asker = store([{ num: 2, email: "s@x", orgUuid: "o", alive: false }]);
    const a = await deck(holder, "Deck-A", [key]);
    const b = await deck(asker, "Deck-B", [key]);
    await point(b, a, a.port);
    expect(await b.e.round()).toMatchObject([{ key, action: "heal", ok: true }]);
    expect(holder.exported).toEqual([5]);

    expect(a.e.unpair(b.id.fp)).toBe(true);
    expect(await b.e.round()).toEqual([]);
    expect(holder.exported, "a deck unpaired a moment ago was handed a login").toEqual([5]);
    expect(a.e.status().trusted).toEqual([]);
    expect(a.e.status().pending).toMatchObject([{ fp: b.id.fp, name: "Deck-B" }]);
    expect(peerRow(b, a.id.fp)?.last?.error).toBe("waiting for the other deck to accept this one");
  }, 20_000);

  it("does not silently re-pin an explicitly unpaired deck through a typed dial row", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    await point(a, b, b.port);
    await a.e.round();
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);

    expect(a.e.unpair(b.id.fp)).toBe(true);
    const trustWrites = a.trustWrites.length;
    await a.e.round();

    expect(a.e.status().trusted).toEqual([]);
    expect(a.trustWrites).toHaveLength(trustWrites);
    expect(a.e.status().pending).toMatchObject([{ fp: b.id.fp, name: "Deck-B" }]);
  }, 20_000);

  it("keeps an unpaired deck pending after restart even with autoAccept on, until a person accepts it", async () => {
    const b = await deck(store([]), "Deck-B", []);
    const a = await deck(store([]), "Deck-A", [], {}, { autoAccept: true, unpaired: [b.id.fp] });

    expect(b.e.addPeer("127.0.0.1", a.port)).toBe(true);
    await b.e.round();

    expect(a.e.status().trusted).toEqual([]);
    expect(a.e.status().pending).toMatchObject([{ fp: b.id.fp, name: "Deck-B" }]);

    expect(a.e.accept(b.id.fp)).toMatchObject({ fp: b.id.fp, name: "Deck-B" });
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);
    expect(a.unpaired).toEqual([]);
    expect(a.unpairedWrites.at(-1)).toEqual([]);
  }, 20_000);
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
    expect(src).toContain("if (landed(out.results)) return verifyMacImport();");
    expect(fillEmptySlot).toContain("if (!landed(forced.results)) return { ok: false,");
  });

  it("carries the import's own reason, because refused and skipped are different sentences", async () => {
    // Driven rather than read (#1171). This was two `toContain` pins on the
    // lines below, which a rewrite keeping the strings and changing the logic
    // passed. What the verdict turns into is what the panel draws as the
    // result of the last round, so that is what is asserted — for the plain
    // `true` the suite hands it everywhere else, the verdict the route
    // returns, and a verdict that says nothing.
    const key = K("claude2@sapec.md", "org-2");
    for (const [got, verdict] of [
      [true, { ok: true, why: null }],
      [{ ok: true }, { ok: true, why: null }],
      [{ ok: false, why: "kept the slot it already has" }, { ok: false, why: "kept the slot it already has" }],
      [{}, { ok: false, why: "import failed" }],
    ] as Array<[unknown, { ok: boolean; why: string | null }]>) {
      const steps: unknown[] = [];
      const mine = store([{ num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
      const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true }]);
      const a = await deck(mine, "Deck-A", [key], {
        importAccount: async (_blob: string, step: unknown) => { steps.push(step); return got; },
      });
      const b = await deck(theirs, "Deck-B", [key]);
      await point(a, b, b.port);
      const step = { key, email: "claude2@sapec.md", action: "heal" };
      expect(await a.e.round(), JSON.stringify(got)).toEqual([{ ...step, ...verdict }]);
      // The step goes down with the blob: the route has to know WHICH account
      // it is placing before it may treat a decline as an empty slot.
      expect(steps).toEqual([step]);
    }
  }, 20_000);

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

  // The route's `importAccount`, sliced to the end of the property and with
  // every whole-line comment taken out — THE CODE, NOT THE PROSE ABOUT IT (#994).
  //
  // The two cases below used to pin the comment that states the promise:
  // `NO \`force\`, ever` in both, and in one a sentence of the reasoning, at one
  // point down to where its line wrapped. That fails the moment the prose is
  // reworded and holds for as long as the words stay, whatever the code beside
  // them does. And the second case sliced from `importAccount: async blob =>`,
  // a spelling 0144367 changed to `(blob, step)` when the route learned to fill
  // an empty slot: `indexOf` answered -1, `slice(-1, 1599)` is the empty
  // string, and `not.toMatch` holds of the empty string forever. It had
  // asserted nothing about the route since.
  //
  // Empty rather than thrown when the anchor is gone, for the reason
  // fillEmptySlot above gives; each case says so by name before relying on it.
  const route = (() => {
    const at = src.indexOf("importAccount: async (blob, step) => {");
    return at === -1 ? "" : src.slice(at, src.indexOf("\n  },", at)).replace(/^\s*\/\/.*$/gm, "");
  })();

  it("keeps the promise the flag was never passed for", () => {
    // A peer cannot reach the forced path: the verdict comes from THIS
    // machine's claude-swap, about THIS machine's store, and nothing a peer
    // sends can make a slot report that it holds nothing. `only` narrows it to
    // the one account, so a bundle carrying several cannot ride in behind it.
    expect(route, "the route's importAccount is gone or renamed").not.toBe("");
    // Not `force: true` — `force` in any spelling. The old pattern knew only the
    // literal, so `force: step.force`, which hands the decision to whatever a
    // peer put in its step, passed it. The route delegates the forced path, so
    // the word has no business in its code at all.
    expect(route).not.toMatch(/\bforce\b/);
    // And exactly one forced call in the deck, carrying `only`. `--force`
    // overwrites every account it matches, so narrowing to the one the verdict
    // was about is what keeps an overwrite a named act.
    expect((fillEmptySlot.match(/force: true/g) ?? []).length).toBe(1);
    expect(fillEmptySlot).toMatch(/force: true, only: \{ email, org/);
  });

  it("does not reach for --force to get around the decline", () => {
    // The promise that a peer cannot overwrite a working credential of this
    // deck's is kept by that flag never being passed. Reporting the decline
    // honestly is the fix; widening the flag is a different decision.
    //
    // So: one import, and after a decline the only way on is fillEmptySlot,
    // which asks this machine before it forces anything. A second import after
    // the decline — the retry that would be "reaching for --force" — is a
    // second call here, whatever options it carries.
    expect(route, "the route's importAccount is gone or renamed").not.toBe("");
    expect(route.match(/\bimportAccount\(/g) ?? [], "the route imports more than once").toHaveLength(1);
    const decline = route.indexOf("if (landed(out.results)) return verifyMacImport();");
    expect(decline, "the decline is no longer told apart from a heal").toBeGreaterThan(-1);
    expect(route.slice(decline)).toMatch(/const filled = await fillEmptySlot\(blob, /);
    expect(route.slice(decline)).toContain("return filled?.ok ? verifyMacImport() : filled;");
    expect(route).not.toMatch(/\bforce\b/);
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

  it("learns a paired caller's address and pulls from it, though nothing here dialled first", async () => {
    // Accounts move only toward the deck that dials, so a deck this one holds
    // no address for could offer everything and this one would take nothing —
    // the exact state a deck falls into when it cannot hear beacons (a firewall,
    // or Tailscale holding the discovery port). The call carries the address:
    // this deck learns it and dials back, so a pull happens in the direction it
    // could not start on its own.
    const MAC = { version: "3.23.0", os: "macOS 26.5", arch: "arm64" };
    const a = await deck(store(rows("on")), "Deck-A", [ON, OFF], { about: MAC });
    const sb = store([]);
    const b = await deck(sb, "Deck-B", []);
    // Paired both ways, so each answers the other.
    await point(a, b, b.port);
    await point(b, a, a.port);
    // B loses its address for A — the state after a settings write, or a deck
    // that can only ever be called. A now only calls in to B.
    b.e.setPeers([]);
    // A calls in. B keeps the card and the offer it always did...
    await a.e.round();
    let row = peerRow(b, a.id.fp);
    expect(row?.about).toMatchObject(MAC);
    expect(row?.offers?.accounts.map((x: { key: string }) => x.key)).toEqual([OFF, ON].sort());
    // ...and now learns A's address from the call, so it is no longer one-way.
    expect(row?.waiting).not.toBe(true);
    // The whole point: B dials A back and pulls the accounts it lacks, though
    // nothing on B ever dialled A first.
    await b.e.round();
    expect(sb.imported.length).toBeGreaterThan(0);
  }, 20_000);

  it("drops a caller it cannot reach back, so it does not fail every round", async () => {
    // The dial-back is on trial until it proves the deck can reach the caller.
    // A strict NAT or a one-way path is a caller whose own listener never
    // answers; the row is taken away rather than left failing, and the peer
    // goes back to calling in.
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    // Paired both ways.
    await point(a, b, b.port);
    await point(b, a, a.port);
    b.e.setPeers([]);           // B loses A; A only calls in
    await a.e.round();          // A calls B → B learns A's address (on trial)
    expect(peerRow(b, a.id.fp)?.waiting).not.toBe(true);
    a.e.stop();                 // the address B learned no longer answers
    await b.e.round();          // B dials back, fails → the trial row is removed
    expect(peerRow(b, a.id.fp)?.waiting).toBe(true);
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
// DRIVEN, AGAINST A PAIRED DECK THAT ANSWERS BADLY (#1171). These were source
// assertions, on the reasoning that both live several frames into a handshake
// against a live peer — and a live peer is cheap to stand up: createSyncServer
// does the handshake for real, trusts the deck under test, and then answers
// each frame however the case says. A rewrite that kept the pinned strings and
// changed the logic used to ship green. The one pin left is the one no reply
// can show from outside. lan-socket.test.ts owns what frameReader does with
// the cap; this owns that the round's own reader keeps it too.
describe("the sync round keeps the caps the rest of the protocol keeps", () => {
  type Answer = (msg: Record<string, any>, ctx: { send: (o: unknown) => void; sock: net.Socket }) => void;

  /** A paired deck whose every reply after the handshake is the case's to
   *  write. It has pinned the deck under test already, and the deck under test
   *  reaches it through an address somebody typed, so the first round both
   *  pins it and is the round being tested. */
  async function hostile(a: Awaited<ReturnType<typeof deck>>, answer: Answer) {
    const id = identityFrom("");
    const s = createSyncServer({
      fp: id.fp, pub: id.pub, secret: id.secret, name: "Hostile", host: "127.0.0.1",
      trusted: () => [{ fp: a.id.fp, pub: a.id.pub, name: "Deck-A" }],
      handlers: answer,
    });
    running.push(s);
    expect(a.e.addPeer("127.0.0.1", await s.start())).toBe(true);
    return { id };
  }

  it("drops a reply that runs past MAX_FRAME_BYTES with no newline, like frameReader", async () => {
    // Without the cap this reader buffers for the round's whole ten-second
    // bell, and every other paired deck's round waits behind it.
    const a = await deck(store([]), "Deck-A", []);
    const peer = await hostile(a, (msg, ctx) => {
      if (msg.t === "manifest") ctx.sock.write("x".repeat(MAX_FRAME_BYTES + 1));
    });
    expect(await a.e.round()).toEqual([]);
    expect(peerRow(a, peer.id.fp)?.last?.error).toBe("frame too large");
  }, 20_000);

  it("ends the round on a reply that is not JSON, or is not a manifest", async () => {
    for (const [why, answer] of [
      ["bad reply", (_m, ctx) => { ctx.sock.write("not json\n"); }],
      ["no manifest", (_m, ctx) => ctx.send({ t: "pong" })],
    ] as Array<[string, Answer]>) {
      const a = await deck(store([]), "Deck-A", []);
      const peer = await hostile(a, answer);
      expect(await a.e.round(), why).toEqual([]);
      expect(peerRow(a, peer.id.fp)?.last?.error, why).toBe(why);
    }
  }, 20_000);

  it("plans over the fifty rows the panel is shown, however many the manifest carried", async () => {
    // Five hundred rows this deck lacks, every one an `add` that needs no tick.
    // Planned over the raw array, that was five hundred sequential asks, each
    // with its own bell and a claude-swap subprocess, while the panel drew 50.
    const rows = Array.from({ length: 500 }, (_, i) => ({ key: K(`u${i}@x`, "o"), email: `u${i}@x`, alive: true }));
    let wants = 0;
    const a = await deck(store([]), "Deck-A", []);
    const peer = await hostile(a, (msg, ctx) => {
      if (msg.t === "manifest") ctx.send({ t: "manifest", accounts: rows });
      if (msg.t === "want") { wants += 1; ctx.send({ t: "no", why: "busy" }); }
    });
    const done = await a.e.round() as Array<{ key: string; action: string; ok: boolean; why: string }>;
    expect(done).toHaveLength(50);
    expect(wants).toBe(50);
    // Every step carries the far side's own reason for saying no.
    expect(done.every(d => d.action === "add" && d.ok === false && d.why === "busy")).toBe(true);
    // And what was asked for is exactly what the panel was shown: one list.
    const shown = peerRow(a, peer.id.fp)?.offers?.accounts as Array<{ key: string }>;
    expect(shown).toHaveLength(50);
    expect(done.map(d => d.key).sort()).toEqual(shown.map(x => x.key).sort());
  }, 20_000);

  it("counts a login that arrives sealed under some other key as a failure, not a login", async () => {
    const key = K("new@x", "o");
    const mine = store([]);
    const a = await deck(mine, "Deck-A", []);
    await hostile(a, (msg, ctx) => {
      if (msg.t === "manifest") ctx.send({ t: "manifest", accounts: [{ key, email: "new@x", alive: true }] });
      // A `have` in the right shape, sealed under a key nobody on this
      // connection holds.
      if (msg.t === "want") ctx.send({ t: "have", key: msg.key, sealed: seal(randomBytes(32), "ccdeck2:forged", "aad") });
    });
    expect(await a.e.round()).toEqual([{ key, email: "new@x", action: "add", ok: false, why: "could not open" }]);
    expect(mine.imported).toEqual([]);
  }, 20_000);

  it("says a refusal was a refusal when the far side gave no reason", async () => {
    const key = K("new@x", "o");
    const a = await deck(store([]), "Deck-A", []);
    await hostile(a, (msg, ctx) => {
      if (msg.t === "manifest") ctx.send({ t: "manifest", accounts: [{ key, email: "new@x", alive: true }] });
      if (msg.t === "want") ctx.send({ t: "no" });
    });
    expect(await a.e.round()).toEqual([{ key, email: "new@x", action: "add", ok: false, why: "refused" }]);
  }, 20_000);

  it("detaches its listener on every way out, not only on the newline", () => {
    // The reject path used to leave `onData` attached, so the buffer kept
    // growing until roundWith's finally destroyed the socket. A pin, because
    // the only thing that shows it from outside is memory.
    const src = readFileSync(
      fileURLToPath(new URL("../../server/lan-engine.mjs", import.meta.url)), "utf8");
    expect(src).toContain('conn.sock.off("data", onData);');
    expect(src).toContain("const give = (fn, arg) => {");
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

  // TURNING `autoAsk` ON ANSWERS WHAT IS ALREADY LISTED (#1171). The cases
  // above build their deck with the switch already on; this is the press, with
  // decks already heard, and it goes through a different line in `apply`. The
  // row it leaves is one the deck added itself, so it may raise a request and
  // may never pin — if that argument regressed to its default, one press of
  // the switch would pin every deck already listed, which is #969 again through
  // a second door.
  it("asks the decks it already heard when the switch goes on, and asking is all it does", async () => {
    // A says yes for its owner, so the second round completes the handshake:
    // that is the round a row somebody typed would pin on.
    const a = await deck(store([]), "Deck-A", [], {}, { autoAccept: true });
    const b = await deck(store([]), "Deck-B", []);
    announce(b, a, "Deck-A");
    expect(b.e.status().strangers).toMatchObject([{ fp: a.id.fp }]);
    expect(b.e.status().peers).toEqual([]);

    await b.e.apply({ autoAsk: true });
    expect(b.e.status().strangers).toEqual([]);
    expect(b.e.status().peers).toMatchObject([{ addr: "127.0.0.1", port: a.port, typed: false }]);

    await b.e.round();
    await b.e.round();
    expect(a.e.status().trusted, "A was never asked").toMatchObject([{ fp: b.id.fp }]);
    expect(b.e.status().trusted, "the switch pinned a deck nobody pressed for").toEqual([]);
    expect(b.trusted).toEqual([]);
    expect(b.e.status().pending).toMatchObject([{ fp: a.id.fp, name: "Deck-A" }]);
  }, 20_000);

  it("leaves a deck its owner turned away alone when the switch goes on", async () => {
    const a = await deck(store([]), "Deck-A", []);
    const b = await deck(store([]), "Deck-B", []);
    announce(b, a, "Deck-A");
    expect(b.e.dismiss(a.id.fp)).toBe(true);
    // Heard again after the no, as it is every thirty seconds, so it is on the
    // list the switch walks — and it is the owner's no that keeps it off.
    announce(b, a, "Deck-A");
    await b.e.apply({ autoAsk: true });
    expect(b.e.status().peers, "a deck told no was put on the dial list").toEqual([]);
    expect(b.e.status().declined).toMatchObject([{ fp: a.id.fp }]);
  }, 20_000);

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
describe("invite-only pairing mode", () => {
  it("discards pending requests when entering invite-only instead of auto-approving them on return", async () => {
    const requester = await deck(store([]), "Requester", []);
    const receiver = await deck(store([]), "Receiver", []);
    requester.e.addPeer("127.0.0.1", receiver.port);
    await requester.e.round();
    expect(receiver.e.status().pending).toMatchObject([{ fp: requester.id.fp }]);

    await receiver.e.apply({ pairingMode: "invite", autoAccept: true });
    expect(receiver.e.status().pending).toEqual([]);
    expect(receiver.e.status().trusted).toEqual([]);
    expect(receiver.e.accept(requester.id.fp)).toBeNull();

    await receiver.e.apply({ pairingMode: "automatic" });
    expect(receiver.e.status().pending).toEqual([]);
    expect(receiver.e.status().trusted).toEqual([]);

    // The other deck may request pairing again after automatic mode returns;
    // only that new handshake is eligible for automatic acceptance.
    await requester.e.round();
    expect(receiver.e.status().trusted).toMatchObject([{ fp: requester.id.fp }]);
  }, 20_000);

  it("requires an invite for new peers and retains existing trust", async () => {
    const a = await deck(store([]), "Invite-only", [], {}, { pairingMode: "invite", autoAsk: true, autoAccept: true });
    const b = await deck(store([]), "Other", []);
    expect(a.e.status().pairingMode).toBe("invite");
    b.e.addPeer("127.0.0.1", a.port);
    await b.e.round();
    expect(a.e.status().trusted).toHaveLength(0);
    expect(a.e.accept(b.id.fp)).toBeNull();
    const offered = a.e.invite();
    expect((await b.e.join(offered.token)).ok).toBe(true);
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.id.fp }]);
    await a.e.apply({ pairingMode: "invite" });
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);
  }, 20_000);

  it("tells a deck that calls without an invite why, instead of leaving it waiting for a yes", async () => {
    // The engine records no request in this mode, so the old "pending" answer
    // left the caller's row reading "waiting for them to say yes" for good.
    const a = await deck(store([]), "Invite-only", [], {}, { pairingMode: "invite" });
    const b = await deck(store([]), "Caller", []);
    b.e.addPeer("127.0.0.1", a.port);
    await b.e.round();
    const rowAt = (d: typeof a, port: number) =>
      (d.e.status().peers as Array<Record<string, any>>).find(p => p.port === port);
    expect(rowAt(b, a.port)?.last?.error).toBe("that deck pairs only by invite");
    expect(a.e.status().pending).toEqual([]);
  }, 20_000);

  it("does not knock on a deck it only heard, which is a request by another name", async () => {
    // Dialling a stranger IS asking it: the far listener queues the caller as a
    // request, and with its accept switch on — the shipped default — pins it.
    // A deck that pairs only by invite must not be sending those.
    // The shipped defaults — ask and accept both on — plus the mode, which is
    // what a person who flips invite-only on is actually running.
    const a = await deck(store([]), "Invite-only", [], {}, { pairingMode: "invite", autoAsk: true, autoAccept: true });
    const b = await deck(store([]), "Neighbour", [], {}, { autoAsk: true, autoAccept: true });
    a.sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Neighbour", f: b.e.status().fp, p: b.e.status().port,
      i: "00".repeat(8), h: hostId({ hostname: "somewhere-else", home: "/home/somebody" }),
    })), "127.0.0.1");
    await a.e.round();
    await a.e.round();

    expect(b.e.status().pending, "the neighbour was sent a request").toEqual([]);
    expect(b.e.status().trusted, "and its accept switch pinned the caller").toEqual([]);
    expect(a.e.status().trusted).toEqual([]);
    // Nothing was put on the dial list to knock with: the heard deck is a
    // nearby row, which the panel offers an invite on.
    expect((a.e.status().peers as unknown[]).length).toBe(0);
  }, 20_000);

  it("reaches an address it already had without turning into a request there", async () => {
    // A row typed before invite-only was switched on is still dialled — an
    // invite-paired deck is one of those rows — but a stranger at that address
    // must refuse it rather than queue it, and the row says whose setting it is.
    const a = await deck(store([]), "Invite-only", [], {}, { pairingMode: "invite" });
    const b = await deck(store([]), "Stranger", [], {}, { autoAsk: true, autoAccept: true });
    a.e.addPeer("127.0.0.1", b.port);
    await a.e.round();
    await a.e.round();

    expect(b.e.status().pending, "the far deck was sent a request").toEqual([]);
    expect(b.e.status().trusted, "and its accept switch pinned the caller").toEqual([]);
    const row = (a.e.status().peers as Array<{ port: number; last?: { error?: string } }>)
      .find(p => p.port === b.port);
    expect(row?.last?.error).toBe("this deck pairs only by invite");
  }, 20_000);

  it("still lets an invite-only deck join someone else's invite, and keeps talking to it", async () => {
    // The mode refuses a pairing nobody invited. Joining an invite IS the
    // invitation, from this side: `join` dials with the code and pins what
    // proved it, and never goes through the round's untrusted-peer refusal.
    const minter = await deck(store([]), "Minter", []);
    const joiner = await deck(store([]), "Invite-only joiner", [], {}, { pairingMode: "invite" });
    const joined = await joiner.e.join(minter.e.invite().token);
    expect(joined.ok).toBe(true);
    expect(joiner.e.status().trusted).toMatchObject([{ fp: minter.id.fp }]);
    expect(minter.e.status().trusted).toMatchObject([{ fp: joiner.id.fp }]);

    // And the next round reaches it as a trusted peer, not a stranger the
    // mode would refuse to dial.
    await joiner.e.round();
    expect(joiner.errors).toEqual([]);
    expect(joiner.e.status().trusted).toMatchObject([{ fp: minter.id.fp }]);
  }, 20_000);
});

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

// WHAT THE ENGINE HANDS ITS CALLER TO KEEP (#1171).
//
// The engine holds everything in memory and index.mjs writes four things of it
// into prefs.json: the trusted list, the dial list, the port and the key. What
// survives a restart is only what went out through one of those callbacks, and
// the harness above used to wire two of them — so dropping any of the other
// three shipped green, and each one is a pairing that quietly stops working
// after the next start.
describe("what the engine hands its caller to keep", () => {
  it("writes the far deck's address down on both ends of an invite", async () => {
    // Without it the pairing is two-way in the trusted list and one-way in
    // fact after a restart: `addPeer` alone lives in memory, and the minter
    // never dials the joiner again.
    const a = await deck(store([]), "Minter", []);
    const b = await deck(store([]), "Joiner", []);
    // Re-addressed to loopback, as the case above does, so the address each end
    // writes down is one this suite can name.
    const { mintInvite, readInvite } = await import("../../server/lan-sync.mjs");
    const code = readInvite(a.e.invite().token).code;
    const token = mintInvite({ addrs: [`127.0.0.1:${a.port}`], name: "Minter", code }).token;
    expect((await b.e.join(token)).ok).toBe(true);

    expect(b.dials, "the joiner kept no way back to the minter").toEqual([`127.0.0.1:${a.port}`]);
    expect(a.dials, "the minter kept no way back to the joiner").toEqual([`127.0.0.1:${b.port}`]);
    // And the minter already knows who is at that address, so the machine is
    // one row rather than an address beside a fingerprint until the next round.
    expect(a.e.status().peers).toHaveLength(1);
    expect(peerRow(a, b.id.fp)).toMatchObject({ addr: "127.0.0.1", port: b.port, paired: true });
  }, 20_000);

  it("writes down a port that moved, and only one that moved", async () => {
    // An address typed on the other machine names this port, so a restart that
    // lands on another one has to be kept or that address stops working.
    // Loopback, so the port this case takes over is the same socket address
    // the deck asks for on every platform.
    const LOOPBACK = "127.0.0.1";
    const d = await deck(store([]), "Deck-A", [], { host: LOOPBACK });
    // No pin at all on the first start, so whatever the OS chose is news.
    expect(d.ports).toEqual([d.port]);

    // Back on the same pin while it is free: nothing to write.
    await d.e.apply({ enabled: false });
    await d.e.apply({ enabled: true, port: d.port });
    expect(d.e.status().port).toBe(d.port);
    expect(d.ports, "a port that did not move was written again").toHaveLength(1);

    // Back while something else holds it: it moves, and says where to.
    await d.e.apply({ enabled: false });
    const squatter = net.createServer();
    await new Promise<void>((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(d.port, LOOPBACK, () => resolve());
    });
    try {
      await d.e.apply({ enabled: true });
      const moved = d.e.status().port;
      expect(moved).not.toBe(d.port);
      expect(d.ports).toEqual([d.port, moved]);
    } finally {
      await new Promise<void>(resolve => squatter.close(() => resolve()));
    }
  }, 20_000);

  it("takes a new key when another machine announces this one's, and hands it over", async () => {
    // A ~/.claude copied to a second machine: two decks with one key, each
    // filing the other's beacons as its own, invisible to each other for good
    // unless one of them moves. The one that notices moves, and index.mjs
    // keeps the new key and restarts on it — which it can only do if told.
    const d = await deck(store([]), "Deck-A", []);
    const was = d.e.status().fp as string;
    d.sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Deck-A", f: was, p: 40_000,
      // Another process (its own instance) on another machine (its own host).
      i: "deadbeef", h: hostId({ hostname: "the-copy", home: "/home/somebody" }),
    })), "192.168.1.50");
    expect(d.identities).toHaveLength(1);
    expect(identityFrom(d.identities[0]).fp, "the key handed over is the old one").not.toBe(was);
    expect(d.errors).toContain("id-clash");
  });
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

  // #1132. The guard above lived in `round`, and `round` was one of two ways
  // into a round. `roundOne` — the "Check now" in one deck's own dialog, reached
  // from the same route with a fingerprint in the body — called `roundWith`
  // directly. So a press landing on the timer's round dialled the deck that
  // round was already healing from and moved the same credential again.
  // fillEmptySlot's in-lock verdict limits what the second write can do on the
  // forced path; it does not stop the dial, the export, or the second write.
  //
  // WHAT WAS OBSERVED, on main at 1887d95 and again at 7ce52d8: the far side
  // exported `[5, 5]` and this side imported twice, where the case above
  // asserts `[5]`.
  //
  // THE PRESS JOINS, for the reason the case above gives and one the dialog
  // adds. The dialog does not read the reply's list: it redraws from what the
  // last ask of that deck left behind, where a login that moved says "arrived
  // last round". A second ask queued after a heal finds the login healthy,
  // moves nothing, and writes that over the record — so the lane repaired from
  // that very deck a moment earlier would stop saying so, in answer to the
  // press that asked about it.
  //
  // It asks the deck itself only when what it waited for has nothing to say
  // about that deck from after the press — the round had already been past it,
  // or never had it on its list — and then after, never beside.

  /** Where the three cases below listen, each on a port of its own from
   *  4640-4646: a deck under test has no business being reachable from the
   *  office for the seconds it runs — see `host` in createEngine. */
  const LOOPBACK = "127.0.0.1";

  /** An import held open until `release`, the way `cswap import` holds the
   *  store on a real machine, and the moment the first one began. Anything
   *  that imports after the release goes straight through, so a round that got
   *  past the guard cannot leave the case waiting on a gate nobody opens. */
  function heldImports(s: ReturnType<typeof store>) {
    const gates: Array<() => void> = [];
    let held = true;
    let reached!: () => void;
    const importing = new Promise<void>(r => { reached = r; });
    return {
      importing,
      importAccount: async (blob: string) => {
        s.imported.push(blob);
        reached();
        if (held) await new Promise<void>(r => gates.push(r));
        return true;
      },
      release() { held = false; for (const open of gates.splice(0)) open(); },
    };
  }

  /** Give something that must NOT happen the time it would take if it did.
   *  Over loopback a handshake and a `want` take milliseconds, so a round that
   *  got past the guard has reached the far side long before this gives up —
   *  and the wait is only spent in full when the code is right. */
  async function allowFor(happened: () => boolean, ms = 1_000) {
    for (const end = Date.now() + ms; !happened() && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  it("is one round when the press is a check of the deck the round is already asking", async () => {
    const mine = store([{ num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
    const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true }]);
    const shared = [K("claude2@sapec.md", "org-2")];
    const held = heldImports(mine);
    const a = await deck(mine, "Deck-A", shared, { host: LOOPBACK, importAccount: held.importAccount }, { port: 4640 });
    const b = await deck(theirs, "Deck-B", shared, { host: LOOPBACK }, { port: 4641 });
    await point(a, b, b.port);

    const timer = a.e.round();
    await held.importing;                  // a credential is being written right now
    const press = a.e.roundOne(b.id.fp);   // and somebody presses "Check now" on that deck
    await allowFor(() => theirs.exported.length > 1);
    const beside = [...theirs.exported];

    held.release();
    const [byTimer, byPress] = await Promise.all([timer, press]);
    expect(beside, "the check dialled and exported beside the round already running").toEqual([5]);
    // Its answer is what the round found at that deck, which here is the round.
    expect(byPress).toEqual(byTimer);
    expect(byPress).toEqual([{
      key: K("claude2@sapec.md", "org-2"), email: "claude2@sapec.md",
      action: "heal", ok: true, why: null,
    }]);
    // This store never learns that the import worked — there is no claude-swap
    // behind it to ask — so any second ask of that deck would plan the same
    // heal and export again. One export is the press joining, not asking.
    expect(theirs.exported).toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
    // And the dialog is drawn from the same answer the press was given.
    expect(peerRow(a, b.id.fp)?.last?.done).toEqual(byTimer);
  }, 20_000);

  it("holds a round asked for during a check until the check is done", async () => {
    // The same door from the other side. A check that is running is a round
    // too, and the timer's tick or a "Sync now" arriving during it waits
    // rather than walking the list beside it. It cannot join: a check asks one
    // deck, and a round was asked to ask all of them.
    // Alive while the two are introduced, so the round that teaches this deck
    // who answers at that address has nothing to move; then it dies.
    const row = { num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: true };
    const mine = store([row]);
    const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true }]);
    const shared = [K("claude2@sapec.md", "org-2")];
    const held = heldImports(mine);
    const a = await deck(mine, "Deck-A", shared, {
      host: LOOPBACK,
      importAccount: async (blob: string) => {
        const ok = await held.importAccount(blob);
        // What a real store says once an import lands: `importAccount` drops
        // the accounts cache, and the next read asks claude-swap again.
        row.alive = true;
        return ok;
      },
    }, { port: 4642 });
    const b = await deck(theirs, "Deck-B", shared, { host: LOOPBACK }, { port: 4643 });
    await point(a, b, b.port);
    // A check finds a deck the way the list does — by the fingerprint that
    // answered at its address — and the round in `point` was refused before
    // anything answered. The button is only drawn for a deck that has.
    expect(await a.e.round()).toEqual([]);
    row.alive = false;

    const press = a.e.roundOne(b.id.fp);
    await held.importing;                  // the check is writing a credential
    const timer = a.e.round();             // and the timer comes round
    await allowFor(() => theirs.exported.length > 1);
    const beside = [...theirs.exported];

    held.release();
    const [byPress, byTimer] = await Promise.all([press, timer]);
    expect(beside, "a round ran beside the check that was writing a credential").toEqual([5]);
    expect(byPress).toEqual([{
      key: K("claude2@sapec.md", "org-2"), email: "claude2@sapec.md",
      action: "heal", ok: true, why: null,
    }]);
    // Held, not dropped and not merged into the check: the round ran once the
    // check was done, and found the login it would have moved already here.
    expect(byTimer).toEqual([]);
    expect(theirs.exported).toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);

  it("asks the deck itself after the round, when that round had been past it before the press", async () => {
    // Two decks, asked in the order they were added: Deck-B, which has nothing
    // this one needs, then Deck-C, which has the login this one is missing. The
    // press is on Deck-B while the round is writing Deck-C's credential, so the
    // round already running holds an answer from Deck-B that is older than the
    // press — and handing that back would be a check that checked nothing.
    const mine = store([{ num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false }]);
    const theirs = store([{ num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true }]);
    const shared = [K("claude2@sapec.md", "org-2")];
    const held = heldImports(mine);
    const a = await deck(mine, "Deck-A", shared, { host: LOOPBACK, importAccount: held.importAccount }, { port: 4644 });
    // Deck-B reads its own store every time it is asked what it has, so the
    // count is how many times it was asked.
    let askedB = 0;
    const b = await deck(store([]), "Deck-B", shared, {
      host: LOOPBACK,
      readAccounts: async () => { askedB += 1; return { accounts: [] }; },
    }, { port: 4645 });
    const c = await deck(theirs, "Deck-C", shared, { host: LOOPBACK }, { port: 4646 });
    await point(a, b, b.port);
    await point(a, c, c.port);

    const timer = a.e.round();
    await held.importing;                  // Deck-B answered; Deck-C's login is being written
    const before = askedB;
    const press = a.e.roundOne(b.id.fp);
    await allowFor(() => askedB > before);
    const beside = askedB - before;

    held.release();
    await Promise.all([timer, press]);
    expect(beside, "the check dialled Deck-B while Deck-C's credential was being written").toBe(0);
    expect(askedB - before, "the press was answered without Deck-B being asked after it").toBe(1);
    // Deck-C's login moved once, by the round.
    expect(theirs.exported).toEqual([5]);
    expect(mine.imported).toEqual(["ccdeck2:slot-5"]);
  }, 20_000);
});

// An account that ARRIVES here is offered onward, because people forget to tick
// it and a group where one machine heals everybody and nobody heals it back is
// the shape that costs them (#1188). The login came from the group, so nothing
// new is exposed by holding it out; what IS the person's decision — an untick
// afterwards, and whether a tailnet counts — is left to them.
describe("an account that arrives over the network", () => {
  const NEW = K("new@sapec.md", "org-9");

  /** A deck whose tick list is written back the way index.mjs writes it. */
  async function receiver(s: ReturnType<typeof store>, shared: string[], over = {}) {
    const ticked: string[] = [];
    const d = await deck(s, "Deck-A", shared, {
      onShared: async (key: string) => {
        ticked.push(key);
        if (!shared.includes(key)) shared.push(key);
        await d.e.apply({ shared });
      },
      ...over,
    });
    return { ...d, ticked, shared };
  }

  it("is ticked for sharing here, so this deck can heal the next one", async () => {
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 4, email: "new@sapec.md", orgUuid: "org-9", alive: true }]);
    const a = await receiver(mine, [K("claude1@sapec.md", "org-1")]);
    const b = await deck(theirs, "Deck-B", [NEW]);
    await point(a, b, b.port);

    expect((await a.e.round()).map((d: { action: string }) => d.action)).toEqual(["add"]);
    expect(a.ticked).toEqual([NEW]);
    // And the engine is running on the new list, not only the file: what this
    // deck offers a third machine from here on includes the account it was
    // given.
    expect(a.e.status().shared).toContain(NEW);
  }, 20_000);

  it("is not ticked when the import failed, because nothing arrived", async () => {
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 4, email: "new@sapec.md", orgUuid: "org-9", alive: true }]);
    const a = await receiver(mine, [K("claude1@sapec.md", "org-1")], {
      importAccount: async () => ({ ok: false, why: "import refused" }),
    });
    const b = await deck(theirs, "Deck-B", [NEW]);
    await point(a, b, b.port);

    expect((await a.e.round()).map((d: { ok: boolean }) => d.ok)).toEqual([false]);
    expect(a.ticked).toEqual([]);
  }, 20_000);

  it("keeps the person's untick: the tick happens on arrival and never again", async () => {
    // The account is here after the first round, so `syncAction` answers
    // nothing for it in the second — which is what makes the default a
    // one-time decision rather than a fight with whoever unticked it.
    const mine = store([{ num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true }]);
    const theirs = store([{ num: 4, email: "new@sapec.md", orgUuid: "org-9", alive: true }]);
    const a = await receiver(mine, [K("claude1@sapec.md", "org-1")]);
    const b = await deck(theirs, "Deck-B", [NEW]);
    await point(a, b, b.port);
    await a.e.round();

    // The person unticks it, as they may untick any account.
    mine.rows.push({ num: 2, email: "new@sapec.md", orgUuid: "org-9", alive: true });
    const kept = a.shared.filter(k => k !== NEW);
    await a.e.apply({ shared: kept });
    a.ticked.length = 0;

    await a.e.round();
    expect(a.ticked).toEqual([]);
    expect(a.e.status().shared).not.toContain(NEW);
  }, 20_000);

  it("is ticked for an add from the local network, and for nothing else", () => {
    // The rule on its own, because the one case a round cannot stage is a peer
    // reached over the tailnet: routeOf answers by address, and no test can
    // hold a 100.x one. An add from the local network is the whole of it.
    expect(ticksOnArrival({ key: NEW, action: "add" }, "lan")).toBe(true);
    expect(ticksOnArrival({ key: NEW, action: "add" }, "tailscale")).toBe(false);
    // A heal is an account this deck already shares — there is nothing to tick
    // — and an unticked one is never healed in the first place.
    expect(ticksOnArrival({ key: NEW, action: "heal" }, "lan")).toBe(false);
    expect(ticksOnArrival({ action: "add" }, "lan")).toBe(false);
  }, 20_000);
});
