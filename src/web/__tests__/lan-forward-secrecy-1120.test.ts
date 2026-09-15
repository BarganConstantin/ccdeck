// #1120: what a recording of two paired decks is worth to somebody who later
// holds both of their long-term keys — and what each end does when the part of
// the handshake that makes it worth nothing is taken off, taken out or swapped
// on the way.
//
// THE PROPERTY, TRIED THE WAY IT WOULD BE TRIED. A relay on loopback between
// the two decks keeps every line it forwards, which is what a machine on the
// segment between them sees. Each case then does what whoever later took both
// decks' private keys could do with that recording: derive every key the two
// long-term keys give over the transcript the recording spells out, and try
// each on the frames. None may open. Where a case can hold the connection's
// own key, the same frames are opened under it first, so what was recorded is
// the real conversation and not a capture of something else.
//
// AN OLDER DECK IS THIS CODE WITH A SWITCH, as in lan-sealed-frames-810.test.ts:
// `ephemeral: false` is a deck of #810's version — it seals, and does not mix —
// and `sealFrames: false` is one from before #810, which that file covers.
//
// THE EDITS A RELAY MAKES ARE THE ONES A DEFENCE HAS TO SURVIVE — a mark taken
// off, a key taken out, a key swapped for another, a key no deck sends — and
// each case checks that the defence held: the handshake ends, the listener
// says why, and the handler never sees a frame.
//
// Every listener here binds 127.0.0.1 on a port from 4580-4589, and every key
// is made in the case that uses it.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
// Namespaces rather than named imports, so a case that reaches for something
// the fix adds fails as that case, on its own assertion, instead of taking the
// whole file down at link time when the fix is taken out.
// @ts-expect-error — plain .mjs server module, no types
import * as engineMod from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as sync from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as socket from "../../server/lan-socket.mjs";

const K = (email: string, org: string): string => sync.accountKey(email, org);

/** Loopback only, and only these. */
const PORTS = { relay: 4580, a: 4581, b: 4582, listener: 4583, relay2: 4584 } as const;

type Frame = Record<string, any>;
type Way = "up" | "down";
type Id = { secret: string; pub: string; fp: string };

const running: Array<{ stop: () => void | Promise<void> }> = [];
afterEach(async () => { for (const r of running.splice(0)) await r.stop(); });
const stopAll = () => running.splice(0).reduce((p, r) => p.then(() => r.stop()), Promise.resolve());

/** A challenge that says it seals and mixes: twelve random bytes, "eph1" in
 *  hex, and the seal mark. */
const MIXING = /^[0-9a-f]{24}65706831\.seal1$/;
/** One of #810's: sixteen random bytes and the seal mark. */
const SEALING = /^[0-9a-f]{32}\.seal1$/;

/** The X25519 point u = 0. It is in the curve's small-order subgroup, so every
 *  private key agrees an all-zero secret with it (RFC 7748 §6.1), and OpenSSL
 *  refuses to. No deck sends it; a listener has to survive being sent it. */
const LOW_ORDER = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.alloc(32)]).toString("base64");
const spki = (k: KeyObject): string => k.export({ type: "spki", format: "der" }).toString("base64");
const freshPub = (): string => spki(generateKeyPairSync("x25519").publicKey);

/** The UDP half goes nowhere — see lan-engine.test.ts, where a suite on the
 *  default socket announced its fixtures to a real office. */
function deafSocket() {
  return {
    on() { /* nothing arrives */ },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
  };
}

interface Row { num: number; email: string; orgUuid: string; alive: boolean; active?: boolean }

async function deck(rows: Row[], name: string, shared: string[], port: number, over: Record<string, unknown> = {}) {
  const id = sync.identityFrom("");
  const imported: string[] = [];
  const e = engineMod.createEngine({
    readAccounts: async () => ({ accounts: rows }),
    exportAccount: async (num: number) => `ccdeck2:slot-${num}`,
    importAccount: async (blob: string) => { imported.push(blob); return true; },
    createSocket: () => deafSocket(),
    host: "127.0.0.1",
    ...over,
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared, trusted: [], port, autoAsk: false, autoAccept: false });
  return { e, id: id as Id, imported, port: e.status().port as number };
}

/** A relay on loopback that forwards every line both ways and keeps a copy.
 *  `up` is the dialling deck's half, `down` the answering deck's; `edit` sees
 *  each line before it is forwarded, and what it returns is what is sent and
 *  what is kept. */
async function relay(target: number, port: number, edit: (line: string, way: Way) => string = l => l) {
  const wire: Array<{ way: Way; line: string }> = [];
  const socks = new Set<net.Socket>();
  const server = net.createServer(inbound => {
    const outbound = net.createConnection({ host: "127.0.0.1", port: target });
    socks.add(inbound);
    socks.add(outbound);
    const pipe = (from: net.Socket, to: net.Socket, way: Way) => {
      let buf = "";
      from.setEncoding("utf8");
      from.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = edit(buf.slice(0, i), way);
          buf = buf.slice(i + 1);
          wire.push({ way, line });
          to.write(`${line}\n`);
        }
      });
      from.on("close", () => to.destroy());
      from.on("error", () => to.destroy());
    };
    pipe(inbound, outbound, "up");
    pipe(outbound, inbound, "down");
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(port, "127.0.0.1", () => res()); });
  const r = {
    wire,
    stop: () => new Promise<void>(res => { for (const s of socks) s.destroy(); server.close(() => res()); }),
  };
  running.push(r);
  return r;
}

const lines = (wire: Array<{ way: Way; line: string }>, way: Way) => wire.filter(w => w.way === way).map(w => w.line);
const frames = (wire: Array<{ way: Way; line: string }>, way: Way): Frame[] => lines(wire, way).map(l => JSON.parse(l));

/** The dialler's `hello` and the answerer's `challenge`. */
function handshakeOf(wire: Array<{ way: Way; line: string }>) {
  const hello = frames(wire, "up").find(f => f.t === "hello");
  const challenge = frames(wire, "down").find(f => f.t === "challenge");
  expect(hello, "no hello on the wire").toBeTruthy();
  expect(challenge, "no challenge on the wire").toBeTruthy();
  return { hello: hello as Frame, challenge: challenge as Frame };
}

/** Everything after the handshake: the dialler's lines after its `auth`, and
 *  the answerer's after its `ok`. */
function afterHandshake(wire: Array<{ way: Way; line: string }>) {
  const up = lines(wire, "up");
  const down = lines(wire, "down");
  const upAt = up.findIndex(l => JSON.parse(l).t === "auth");
  const downAt = down.findIndex(l => JSON.parse(l).t === "ok");
  expect(upAt, "the dialler never finished the handshake").toBeGreaterThanOrEqual(0);
  expect(downAt, "the answerer never finished the handshake").toBeGreaterThanOrEqual(0);
  return { up: up.slice(upAt + 1), down: down.slice(downAt + 1) };
}

/** Pair two decks the way a person does, through the relay, and forget the
 *  refused first attempt so a case reads only the round that goes through. */
async function paired(dialler: Awaited<ReturnType<typeof deck>>, answerer: Awaited<ReturnType<typeof deck>>) {
  const r = await relay(answerer.port, PORTS.relay);
  expect(dialler.e.addPeer("127.0.0.1", PORTS.relay)).toBe(true);
  await dialler.e.round();
  expect(answerer.e.accept(dialler.id.fp), "the answerer had nothing to accept").toBeTruthy();
  r.wire.splice(0);
  return r;
}

async function until(ok: () => boolean, ms = 2_000) {
  for (let waited = 0; !ok() && waited < ms; waited += 20) await new Promise(r => setTimeout(r, 20));
  expect(ok(), "waited, and it never came").toBe(true);
}

/**
 * Every key the two long-term keys give over what a recording of one
 * connection holds.
 *
 * The static secret — which either deck's private key computes on its own —
 * through HKDF over the transcript the recording spells out, both with and
 * without the two ephemeral public keys it carries; and the new schedule with
 * each deck's long-term key standing in for the ephemeral half nobody kept.
 * Whoever holds both keys has ss, es and se of the real key as well. What
 * none of these has is ee, which needs an ephemeral private half, and neither
 * deck kept one.
 */
function keysFromLongTermKeys(caller: Id, listener: Id, hello: Frame, challenge: Frame): Buffer[] {
  const four = sync.handshakeTranscript(hello.fp, challenge.fp, hello.challenge, challenge.challenge);
  const six = sync.handshakeTranscript(hello.fp, challenge.fp, hello.challenge, challenge.challenge, hello.epk, challenge.epk);
  const priv = (id: Id) => createPrivateKey({ key: Buffer.from(id.secret, "base64"), format: "der", type: "pkcs8" });
  return [
    ...[four, six].flatMap((t: string) => [
      sync.sessionKey(caller.secret, listener.pub, t),
      sync.sessionKey(listener.secret, caller.pub, t),
    ]),
    sync.sessionKey(caller.secret, listener.pub, six, { role: "caller", priv: priv(caller), peer: challenge.epk ?? listener.pub }),
    sync.sessionKey(listener.secret, caller.pub, six, { role: "listener", priv: priv(listener), peer: hello.epk ?? caller.pub }),
  ];
}

const MINE: Row[] = [
  { num: 1, email: "claude1@sapec.md", orgUuid: "org-1", alive: true, active: true },
  { num: 2, email: "claude2@sapec.md", orgUuid: "org-2", alive: false },
];
const THEIRS: Row[] = [
  { num: 5, email: "claude2@sapec.md", orgUuid: "org-2", alive: true, active: true },
  { num: 6, email: "claude3@sapec.md", orgUuid: "org-3", alive: true },
];
const SHARED = [K("claude1@sapec.md", "org-1"), K("claude2@sapec.md", "org-2"), K("claude3@sapec.md", "org-3")];
const HEALED = [["heal", true], ["add", true]];
const verdicts = (done: Array<{ action: string; ok: boolean }>) => done.map(d => [d.action, d.ok]);

describe("a recording of two decks of this version, once both long-term keys are known", () => {
  it("opens under the key the connection used, and under nothing the two long-term keys give", async () => {
    const listener = sync.identityFrom("") as Id;
    const caller = sync.identityFrom("") as Id;
    const ACCOUNT = K("claude2@sapec.md", "org-2");
    const s = socket.createSyncServer({
      fp: listener.fp, pub: listener.pub, secret: listener.secret, name: "Listener", host: "127.0.0.1",
      prefer: PORTS.listener,
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      // A login, sealed under the connection's key the way lan-engine seals
      // one inside `have`, so the recording holds what #1120 is about.
      handlers: (msg: Frame, ctx: { send: (o: unknown) => void; key: Buffer; peerFp: string }) => ctx.send({
        t: "have", key: msg.key, sealed: sync.seal(ctx.key, "ccdeck2:a-login", `${listener.fp}->${ctx.peerFp}|${msg.key}`),
      }),
    });
    running.push(s);
    const port = await s.start();
    const r = await relay(port, PORTS.relay);
    const peer = await socket.connectToPeer({
      host: "127.0.0.1", port: PORTS.relay, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller",
    });
    running.push({ stop: () => peer.sock.destroy() });
    peer.send({ t: "want", key: ACCOUNT });
    await until(() => lines(r.wire, "down").length >= 3);

    const { hello, challenge } = handshakeOf(r.wire);
    const { up, down } = afterHandshake(r.wire);
    const want = JSON.parse(up[0]);
    const have = JSON.parse(down[0]);
    const aad = `${listener.fp}->${caller.fp}|${ACCOUNT}`;

    // The recording is the real conversation: the connection's own key opens
    // both frames, and the login inside the answer.
    expect(sync.frameChannel(peer.key, "listener").unwrap(want)).toEqual({ t: "want", key: ACCOUNT });
    const answer = sync.frameChannel(peer.key, "caller").unwrap(have);
    expect(sync.open(peer.key, answer.sealed, aad)).toBe("ccdeck2:a-login");

    // And nothing both long-term keys give opens any of it.
    for (const k of keysFromLongTermKeys(caller, listener, hello, challenge)) {
      expect(sync.frameChannel(k, "listener").unwrap(want), "a frame the dialler sealed opened").toBeNull();
      expect(sync.frameChannel(k, "caller").unwrap(have), "a frame the answerer sealed opened").toBeNull();
      expect(sync.open(k, answer.sealed, aad), "the login opened").toBeNull();
    }
  });

  it("makes a new key pair at both ends for every connection, and both challenges say so", async () => {
    const listener = sync.identityFrom("") as Id;
    const caller = sync.identityFrom("") as Id;
    const s = socket.createSyncServer({
      fp: listener.fp, pub: listener.pub, secret: listener.secret, name: "Listener", host: "127.0.0.1",
      prefer: PORTS.listener, trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }], handlers: () => {},
    });
    running.push(s);
    const port = await s.start();
    const r = await relay(port, PORTS.relay);
    for (let i = 0; i < 2; i++) {
      const peer = await socket.connectToPeer({
        host: "127.0.0.1", port: PORTS.relay, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller",
      });
      peer.sock.destroy();
    }
    const sent = [...frames(r.wire, "up").filter(f => f.t === "hello"), ...frames(r.wire, "down").filter(f => f.t === "challenge")];
    expect(sent).toHaveLength(4);
    for (const f of sent) {
      expect(f.challenge, `${f.t} did not say it mixes`).toMatch(MIXING);
      expect(sync.readEphemeral(f.epk), `${f.t} carried no usable key`).toBe(f.epk);
      expect([caller.pub, listener.pub], `${f.t} sent a long-term key as its ephemeral one`).not.toContain(f.epk);
    }
    expect(new Set(sent.map(f => f.epk)).size, "a key pair was used twice").toBe(4);
  });

  it("heals a round between two engines, and nothing the two long-term keys give opens a frame of it", async () => {
    const a = await deck(MINE, "Deck-A", SHARED, PORTS.a);
    const b = await deck(THEIRS, "Deck-B", SHARED, PORTS.b);
    const r = await paired(a, b);

    expect(verdicts(await a.e.round())).toEqual(HEALED);
    expect(a.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);

    const { hello, challenge } = handshakeOf(r.wire);
    const { up, down } = afterHandshake(r.wire);
    expect(up.length).toBe(3);
    expect(down.length).toBe(3);
    for (const k of keysFromLongTermKeys(a.id, b.id, hello, challenge)) {
      expect(sync.frameChannel(k, "listener").unwrap(JSON.parse(up[0])), "a frame the dialler sealed opened").toBeNull();
      expect(sync.frameChannel(k, "caller").unwrap(JSON.parse(down[0])), "a frame the answerer sealed opened").toBeNull();
    }
    expect(hello.challenge).toMatch(MIXING);
    expect(challenge.challenge).toMatch(MIXING);
  }, 20_000);
});

describe("a deck of this version and one of #810's, which seals and does not mix", () => {
  /** The key every deck derived before #1120, from the static keys and the
   *  four-field transcript — what "carry on exactly as today" means. */
  const today = (caller: Id, listener: Id, hello: Frame, challenge: Frame) => sync.sessionKey(caller.secret, listener.pub,
    sync.handshakeTranscript(hello.fp, challenge.fp, hello.challenge, challenge.challenge));

  it("dials the older one: offers a key, is sent none back, and heals sealed under today's key", async () => {
    const a = await deck(MINE, "New", SHARED, PORTS.a);
    const b = await deck(THEIRS, "Older", SHARED, PORTS.b, { ephemeral: false });
    const r = await paired(a, b);

    expect(verdicts(await a.e.round())).toEqual(HEALED);
    expect(a.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);
    const { hello, challenge } = handshakeOf(r.wire);
    expect(hello.challenge, "the new deck said it mixes").toMatch(MIXING);
    expect(typeof hello.epk, "the new deck offered a key").toBe("string");
    expect(challenge.challenge, "the older deck said it seals, and nothing more").toMatch(SEALING);
    expect(challenge).not.toHaveProperty("epk");

    const { up, down } = afterHandshake(r.wire);
    for (const line of [...up, ...down]) expect(Object.keys(JSON.parse(line)).sort()).toEqual(["sealed", "tag"]);
    const k = today(a.id, b.id, hello, challenge);
    expect(sync.frameChannel(k, "listener").unwrap(JSON.parse(up[0]))?.t).toBe("manifest");
    expect(sync.frameChannel(k, "caller").unwrap(JSON.parse(down[0]))?.t).toBe("manifest");
  }, 20_000);

  it("is dialled by the older one: sends no key to a deck that offered none, and heals under today's key", async () => {
    const a = await deck(THEIRS, "New", SHARED, PORTS.a);
    const b = await deck(MINE, "Older", SHARED, PORTS.b, { ephemeral: false });
    const r = await paired(b, a);

    expect(verdicts(await b.e.round())).toEqual(HEALED);
    expect(b.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);
    const { hello, challenge } = handshakeOf(r.wire);
    expect(hello.challenge, "the older deck said it seals, and nothing more").toMatch(SEALING);
    expect(hello).not.toHaveProperty("epk");
    expect(challenge.challenge, "the new deck said it mixes").toMatch(MIXING);
    expect(challenge, "the new deck answered a key nobody offered").not.toHaveProperty("epk");

    const { up, down } = afterHandshake(r.wire);
    for (const line of [...up, ...down]) expect(Object.keys(JSON.parse(line)).sort()).toEqual(["sealed", "tag"]);
    const k = today(b.id, a.id, hello, challenge);
    expect(sync.frameChannel(k, "listener").unwrap(JSON.parse(up[0]))?.t).toBe("manifest");
    expect(sync.frameChannel(k, "caller").unwrap(JSON.parse(down[0]))?.t).toBe("manifest");
  }, 20_000);
});

describe("between two decks of this version, the mark taken off or a key taken out or swapped", () => {
  /** A listener, and a dial to it through a relay that passes each line to `edit`. */
  async function through(edit: (line: string, way: Way) => string) {
    const me = sync.identityFrom("") as Id;
    const caller = sync.identityFrom("") as Id;
    const heard: Frame[] = [];
    const errors: string[] = [];
    const s = socket.createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Listener", host: "127.0.0.1", prefer: PORTS.listener,
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      handlers: (msg: Frame) => { heard.push(msg); },
      onError: (_what: string, err: Error) => errors.push(err.message),
    });
    running.push(s);
    const port = await s.start();
    await relay(port, PORTS.relay2, edit);
    const dial = socket.connectToPeer({
      host: "127.0.0.1", port: PORTS.relay2, fp: caller.fp, pub: caller.pub, secret: caller.secret,
      name: "Caller", timeoutMs: 3_000,
    });
    return { dial, heard, errors };
  }
  /** One frame of one type changed on its way through, going one way. */
  const bend = (way: Way, t: string, fn: (f: Frame) => void) => (line: string, w: Way) => {
    if (w !== way) return line;
    const f = JSON.parse(line);
    if (f.t === t) fn(f);
    return JSON.stringify(f);
  };
  /** The four bytes that say "mixes", overwritten, which leaves a challenge
   *  exactly the shape one of #810's decks sends. */
  const unmark = (f: Frame) => { f.challenge = String(f.challenge).replace(/65706831(?=\.seal1$)/, "00000000"); };

  it("fails the proof when the dialler's mark is taken off", async () => {
    const { dial, heard, errors } = await through(bend("up", "hello", unmark));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("fails the proof when the answerer's mark is taken off", async () => {
    const { dial, heard, errors } = await through(bend("down", "challenge", unmark));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("fails the proof when both are taken off, which is what a pair of #810's decks looks like", async () => {
    const up = bend("up", "hello", unmark);
    const down = bend("down", "challenge", unmark);
    const { dial, heard, errors } = await through((l, way) => down(up(l, way), way));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("refuses the handshake when either key is taken out and the marks are left", async () => {
    const drop = (f: Frame) => { delete f.epk; };
    const fromHello = await through(bend("up", "hello", drop));
    await expect(fromHello.dial).rejects.toThrow("the other deck refused this handshake");
    expect(fromHello.errors).toContain("bad hello");
    expect(fromHello.heard).toEqual([]);
    await stopAll();

    const fromChallenge = await through(bend("down", "challenge", drop));
    await expect(fromChallenge.dial).rejects.toThrow("bad challenge");
    expect(fromChallenge.heard).toEqual([]);
  });

  it("fails the proof when either key is swapped for another", async () => {
    const swap = (f: Frame) => { f.epk = freshPub(); };
    for (const [way, t] of [["up", "hello"], ["down", "challenge"]] as const) {
      const { dial, heard, errors } = await through(bend(way, t, swap));
      await expect(dial, `the key in ${t}`).rejects.toThrow("the other deck refused this one's proof");
      expect(errors).toContain("bad proof");
      expect(heard).toEqual([]);
      await stopAll();
    }
  });

  it("refuses a key X25519 cannot use, in either half of a hello, and goes on answering", async () => {
    const me = sync.identityFrom("") as Id;
    const caller = sync.identityFrom("") as Id;
    const heard: Frame[] = [];
    const errors: string[] = [];
    const s = socket.createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Listener", host: "127.0.0.1", prefer: PORTS.listener,
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      handlers: (msg: Frame) => { heard.push(msg); },
      onError: (_what: string, err: Error) => errors.push(err.message),
    });
    running.push(s);
    const port = await s.start();
    let change: (f: Frame) => void = () => {};
    await relay(port, PORTS.relay2, bend("up", "hello", f => change(f)));
    const dial = () => socket.connectToPeer({
      host: "127.0.0.1", port: PORTS.relay2, fp: caller.fp, pub: caller.pub, secret: caller.secret,
      name: "Caller", timeoutMs: 3_000,
    });
    const ed = spki(generateKeyPairSync("ed25519").publicKey);
    const wearing = (pub: string) => (f: Frame) => { f.pub = pub; f.fp = sync.fingerprint(Buffer.from(pub, "base64")); };
    const cases: Record<string, (f: Frame) => void> = {
      "a long-term key that is Ed25519": wearing(ed),
      "a long-term key at a low-order point": wearing(LOW_ORDER),
      "an ephemeral key that is Ed25519": f => { f.epk = ed; },
      "an ephemeral key at a low-order point": f => { f.epk = LOW_ORDER; },
      "an ephemeral key with a separator inside it": f => { f.epk = `${String(f.epk).slice(0, 20)}|${String(f.epk).slice(20)}`; },
    };
    for (const [name, fn] of Object.entries(cases)) {
      change = fn;
      await expect(dial(), name).rejects.toThrow("the other deck refused this handshake");
    }
    expect(errors.filter(e => e === "bad hello")).toHaveLength(Object.keys(cases).length);

    // Still there, and still a listener: the same caller, unchanged, gets in.
    change = () => {};
    const peer = await dial();
    running.push({ stop: () => peer.sock.destroy() });
    expect(peer.peerFp).toBe(me.fp);
    expect(heard).toEqual([]);
  }, 30_000);
});

describe("the key and the mark, on their own", () => {
  const A = sync.identityFrom("") as Id;
  const B = sync.identityFrom("") as Id;
  const C = sync.identityFrom("") as Id;

  it("agrees at both ends from four X25519 results, and needs every half it mixes", () => {
    const eA = sync.ephemeralPair();
    const eB = sync.ephemeralPair();
    const t = sync.handshakeTranscript(A.fp, B.fp, "c1", "c2", eA.pub, eB.pub);
    const caller = sync.sessionKey(A.secret, B.pub, t, { role: "caller", priv: eA.priv, peer: eB.pub });
    const listener = sync.sessionKey(B.secret, A.pub, t, { role: "listener", priv: eB.priv, peer: eA.pub });
    expect(caller.equals(listener), "the two ends derived different keys").toBe(true);
    expect(caller).toHaveLength(32);
    // Not the key the long-term keys give by themselves over the same string.
    expect(caller.equals(sync.sessionKey(A.secret, B.pub, t)), "it is the static key").toBe(false);
    // Another ephemeral half at either end is another key.
    const eX = sync.ephemeralPair();
    expect(caller.equals(sync.sessionKey(A.secret, B.pub, t, { role: "caller", priv: eX.priv, peer: eB.pub }))).toBe(false);
    expect(caller.equals(sync.sessionKey(A.secret, B.pub, t, { role: "caller", priv: eA.priv, peer: eX.pub }))).toBe(false);
    // Both ephemeral halves and the wrong long-term key: another key. It
    // needs a static key as well as the ephemerals.
    expect(caller.equals(sync.sessionKey(C.secret, B.pub, t, { role: "caller", priv: eA.priv, peer: eB.pub }))).toBe(false);
    // Which end is which is part of it: es and se do not trade places.
    expect(caller.equals(sync.sessionKey(A.secret, B.pub, t, { role: "listener", priv: eA.priv, peer: eB.pub }))).toBe(false);
    // And a deck talking to its own key — a copied ~/.claude — still agrees.
    const self = (role: string, priv: KeyObject, peer: string) => sync.sessionKey(A.secret, A.pub, t, { role, priv, peer });
    expect(self("caller", eA.priv, eB.pub).equals(self("listener", eB.priv, eA.pub))).toBe(true);
  });

  it("binds both ephemeral keys into the transcript, in order, and never drops one quietly", () => {
    const four = sync.handshakeTranscript("fpA", "fpB", "c1", "c2");
    const six = sync.handshakeTranscript("fpA", "fpB", "c1", "c2", "EA", "EB");
    expect(six).not.toBe(four);
    expect(six).not.toBe(sync.handshakeTranscript("fpA", "fpB", "c1", "c2", "EB", "EA"));
    expect(sync.handshakeTranscript("fpA", "fpB", "c1", "c2", "EA", undefined)).not.toBe(four);
    // The same four X25519 results over two strings that differ only in one
    // key's name are two keys: the proofs cover the keys by name, not only
    // through the arithmetic.
    const eA = sync.ephemeralPair();
    const eB = sync.ephemeralPair();
    const eph = { role: "caller", priv: eA.priv, peer: eB.pub };
    const real = sync.handshakeTranscript(A.fp, B.fp, "c1", "c2", eA.pub, eB.pub);
    const named = sync.handshakeTranscript(A.fp, B.fp, "c1", "c2", freshPub(), eB.pub);
    expect(sync.sessionKey(A.secret, B.pub, real, eph).equals(sync.sessionKey(A.secret, B.pub, named, eph))).toBe(false);
  });

  it("marks this deck's challenge inside its random part, and reads the mark only beside the seal", () => {
    const ours = sync.challengeFor();
    expect(ours).toMatch(MIXING);
    expect(sync.mixesEphemeral(ours)).toBe(true);
    expect(sync.sealsFrames(ours)).toBe(true);
    expect(sync.readChallenge(ours)).toBe(ours);
    expect(sync.challengeFor({ ephemeral: false })).toMatch(SEALING);
    const older = sync.challengeFor({ seals: false });
    expect(older).toMatch(/^[0-9a-f]{32}$/);
    expect(sync.mixesEphemeral(older)).toBe(false);

    const hex24 = "0123456789abcdef01234567";
    expect(sync.mixesEphemeral(`${hex24}65706831.seal1`)).toBe(true);
    for (const c of [
      `${hex24}65706831`, `${hex24}00000000.seal1`, `${hex24.toUpperCase()}65706831.seal1`,
      `${hex24.slice(1)}65706831.seal1`, `x${hex24}65706831.seal1`, "", 7, null,
    ]) expect(sync.mixesEphemeral(c), String(c)).toBe(false);
  });

  it("takes an ephemeral key only as an X25519 key, spelled as its bytes encode, and a long-term one only as X25519", () => {
    const e = sync.ephemeralPair();
    expect(sync.readEphemeral(e.pub)).toBe(e.pub);
    const ed = spki(generateKeyPairSync("ed25519").publicKey);
    const p256 = spki(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey);
    const refused: Array<[string, unknown]> = [
      ["Ed25519", ed], ["P-256", p256],
      ["a separator inside", `${e.pub.slice(0, 20)}|${e.pub.slice(20)}`],
      ["a space on the end", `${e.pub} `], ["no padding", e.pub.replace(/=+$/, "")],
      ["not a string", 7], ["absent", undefined],
    ];
    for (const [name, raw] of refused) expect(sync.readEphemeral(raw), name).toBeNull();
    expect(sync.readPub(ed), "an Ed25519 key read as a deck's").toBeNull();
    expect(sync.readPub(p256), "a P-256 key read as a deck's").toBeNull();
    expect(sync.readPub(A.pub)?.fp).toBe(A.fp);
  });
});
