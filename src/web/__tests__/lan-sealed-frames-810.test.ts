// #810 and #914: what crosses the network between two paired decks after the
// handshake, read the way a machine on the same network reads it — and what each
// end does with a frame that is not the one it expects.
//
// THROUGH A RELAY, NOT A SPY. The engine cases put a plain TCP relay on loopback
// between the two decks and read every line it forwards. That is the vantage
// point #810 is about: somebody on the segment between two machines, who sees
// bytes and nothing else. A spy on `sock.write` would be reading what the code
// meant to send, which is the one thing a capture does not get.
//
// AN OLDER DECK IS THIS CODE WITH `sealFrames: false`. That switch announces
// nothing and seals nothing, which is byte for byte the wire every deck before
// the fix speaks — the challenge is the same 32 hex characters and every frame
// is the same JSON line. The alternative, a copy of the old modules kept in the
// suite, would be three thousand lines that drift.
//
// THE REFUSALS ARE CHECKED AT BOTH LEVELS. `frameChannel` is pure, so every way
// a frame can be wrong is checked against it directly. The socket cases then
// hand the same wrong frames to a real listener and check the part the pure
// function cannot: that the connection ends, and that the handler never saw
// the frame.
//
// Every listener here binds 127.0.0.1 on a port from 4550-4559, and every key
// is made in the case that uses it.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
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

/** Loopback only, and only these. A listener whose preferred port is taken
 *  falls through to one the OS picks, so the cases read the port back rather
 *  than assuming it. */
const PORTS = { relay: 4550, a: 4551, b: 4552, listener: 4553, relay2: 4554, engine: 4555 } as const;

type Frame = Record<string, any>;
type Way = "up" | "down";

const running: Array<{ stop: () => void | Promise<void> }> = [];
afterEach(async () => { for (const r of running.splice(0)) await r.stop(); });

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
  return { e, id, imported, port: e.status().port as number };
}

/** One deck's row for another, as the panel is handed it. */
function peerRow(d: { e: { status: () => { peers: unknown[] } } }, fp: string) {
  return (d.e.status().peers as Frame[]).find(p => (p.peerFp ?? p.fp) === fp);
}

/**
 * A relay on loopback that forwards every line both ways and keeps a copy, so a
 * case reads exactly what a machine between the two decks would. `up` is the
 * dialling deck's half of the conversation, `down` the answering deck's.
 * `edit` sees each line before it is forwarded; the stripping cases below are
 * the only ones that pass one.
 */
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

/** The two announcements: the dialler's `hello` and the answerer's `challenge`. */
function handshakeOf(wire: Array<{ way: Way; line: string }>) {
  const hello = lines(wire, "up").map(l => JSON.parse(l)).find((f: Frame) => f.t === "hello");
  const challenge = lines(wire, "down").map(l => JSON.parse(l)).find((f: Frame) => f.t === "challenge");
  expect(hello, "no hello on the wire").toBeTruthy();
  expect(challenge, "no challenge on the wire").toBeTruthy();
  return { hello, challenge };
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

/** Pair two decks the way a person does — an address typed on one, a press on
 *  the other — through the relay, and forget the refused first attempt so a
 *  case reads only the round that goes through. */
async function paired(dialler: Awaited<ReturnType<typeof deck>>, answerer: Awaited<ReturnType<typeof deck>>) {
  const r = await relay(answerer.port, PORTS.relay);
  expect(dialler.e.addPeer("127.0.0.1", PORTS.relay)).toBe(true);
  await dialler.e.round();
  expect(answerer.e.accept(dialler.id.fp), "the answerer had nothing to accept").toBeTruthy();
  r.wire.splice(0);
  return r;
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
/** What must not be readable on the wire once the handshake is done: every
 *  address, every org, the verbs and fields that name what is being asked for,
 *  and the credential's own marker. */
const SECRETS = [
  "claude1@sapec.md", "claude2@sapec.md", "claude3@sapec.md", "org-1", "org-2", "org-3",
  "manifest", "want", "have", "accounts", "current", "ccdeck2:slot",
];
const HEALED = [["heal", true], ["add", true]];
const verdicts = (done: Array<{ action: string; ok: boolean }>) => done.map(d => [d.action, d.ok]);

describe("a round between two decks of this version, as the network sees it", () => {
  it("carries nothing readable after the handshake, and still heals", async () => {
    const a = await deck(MINE, "Deck-A", SHARED, PORTS.a);
    const b = await deck(THEIRS, "Deck-B", SHARED, PORTS.b);
    const r = await paired(a, b);

    expect(verdicts(await a.e.round())).toEqual(HEALED);
    expect(a.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);

    // Both said they seal, in the one field the handshake binds.
    const { hello, challenge } = handshakeOf(r.wire);
    expect(hello.challenge).toMatch(/^[0-9a-f]{32}\.seal1$/);
    expect(challenge.challenge).toMatch(/^[0-9a-f]{32}\.seal1$/);

    const { up, down } = afterHandshake(r.wire);
    // A question and two repair requests, and an answer to each.
    expect(up.length).toBe(3);
    expect(down.length).toBe(3);
    const seen = [...up, ...down].join("\n");
    for (const s of SECRETS) expect(seen, `"${s}" is readable after the handshake`).not.toContain(s);
    // Not merely scrambled somewhere: every line is one sealed frame and says
    // nothing else — not even which verb it carries.
    for (const line of [...up, ...down]) expect(Object.keys(JSON.parse(line)).sort()).toEqual(["sealed", "tag"]);

    // And what the frames carry still arrives, both ways: the account each
    // deck is on (#914's own check), from the answer and from the question.
    expect(peerRow(a, b.id.fp)?.offers?.current).toEqual({ key: K("claude2@sapec.md", "org-2") });
    expect(peerRow(b, a.id.fp)?.offers?.current).toEqual({ key: K("claude1@sapec.md", "org-1") });
  }, 20_000);
});

describe("a deck of this version and one from before it", () => {
  it("dials the older one: says it seals, is answered plain, and heals as before", async () => {
    const a = await deck(MINE, "New", SHARED, PORTS.a);
    const b = await deck(THEIRS, "Old", SHARED, PORTS.b, { sealFrames: false });
    const r = await paired(a, b);

    expect(verdicts(await a.e.round())).toEqual(HEALED);
    expect(a.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);
    const { hello, challenge } = handshakeOf(r.wire);
    expect(hello.challenge, "the new deck said it seals").toMatch(/\.seal1$/);
    expect(challenge.challenge, "the old deck said nothing").toMatch(/^[0-9a-f]{32}$/);
    // Exactly the frames every deck before this sent: the older one cannot
    // open anything else, so the newer one does not send anything else.
    const { up, down } = afterHandshake(r.wire);
    expect([...up, ...down].map(l => JSON.parse(l).t)).toEqual(["manifest", "want", "want", "manifest", "have", "have"]);
  }, 20_000);

  it("is dialled by the older one: answers plain, and the older one heals as before", async () => {
    const a = await deck(THEIRS, "New", SHARED, PORTS.a);
    const b = await deck(MINE, "Old", SHARED, PORTS.b, { sealFrames: false });
    const r = await paired(b, a);

    expect(verdicts(await b.e.round())).toEqual(HEALED);
    expect(b.imported).toEqual(["ccdeck2:slot-5", "ccdeck2:slot-6"]);
    const { hello, challenge } = handshakeOf(r.wire);
    expect(hello.challenge, "the old deck said nothing").toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.challenge, "the new deck said it seals").toMatch(/\.seal1$/);
    const { up, down } = afterHandshake(r.wire);
    expect([...up, ...down].map(l => JSON.parse(l).t)).toEqual(["manifest", "want", "want", "manifest", "have", "have"]);
    // And the newer deck still learned what the older one offers and is on.
    expect(peerRow(a, b.id.fp)?.offers?.current).toEqual({ key: K("claude1@sapec.md", "org-1") });
  }, 20_000);
});

/**
 * A listener of this version and a caller of this version, sealed, with the
 * caller's writes HELD rather than sent — so a case decides which of the frames
 * the caller sealed reach the listener, and in what order.
 */
async function heldPair() {
  const me = sync.identityFrom("");
  const caller = sync.identityFrom("");
  const heard: Frame[] = [];
  const errors: string[] = [];
  const s = socket.createSyncServer({
    fp: me.fp, pub: me.pub, secret: me.secret, name: "Listener", host: "127.0.0.1", prefer: PORTS.listener,
    trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
    handlers: (msg: Frame, ctx: { send: (o: unknown) => void }) => { heard.push(msg); ctx.send({ t: "pong", saw: msg.t }); },
    onError: (_what: string, err: Error) => errors.push(err.message),
  });
  running.push(s);
  const port = await s.start();
  const peer = await socket.connectToPeer({
    host: "127.0.0.1", port, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller",
  });
  running.push({ stop: () => peer.sock.destroy() });
  const held: string[] = [];
  const write = peer.sock.write.bind(peer.sock);
  peer.sock.write = (d: string) => { held.push(String(d)); return true; };
  const replies: string[] = [];
  let buf = "";
  peer.sock.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) { replies.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  /** The next line the listener sends, or null if none comes within a second. */
  const reply = async () => {
    for (let i = 0; i < 50 && replies.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    return replies.shift() ?? null;
  };
  /** Whether the listener ended the connection within two seconds. */
  const ended = () => new Promise<boolean>(res => {
    if (peer.sock.destroyed) { res(true); return; }
    const t = setTimeout(() => res(false), 2_000);
    peer.sock.once("close", () => { clearTimeout(t); res(true); });
  });
  return { peer, heard, errors, held, deliver: (line: string) => write(line), reply, ended };
}

describe("a sealed frame that is not the one expected ends the connection", () => {
  it("when it was altered on the way", async () => {
    const p = await heldPair();
    p.peer.send({ t: "manifest" });
    const f = JSON.parse(p.held[0]);
    f.sealed = (f.sealed[0] === "A" ? "B" : "A") + f.sealed.slice(1);
    p.deliver(`${JSON.stringify(f)}\n`);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([]);
    expect(p.errors).toContain("a sealed frame did not open");
  });

  it("when its tag was cut short", async () => {
    const p = await heldPair();
    p.peer.send({ t: "manifest" });
    const f = JSON.parse(p.held[0]);
    f.tag = Buffer.from(f.tag, "base64").subarray(0, 4).toString("base64");
    p.deliver(`${JSON.stringify(f)}\n`);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([]);
  });

  it("when it is played a second time", async () => {
    const p = await heldPair();
    p.peer.send({ t: "manifest" });
    p.deliver(p.held[0]);
    expect(p.peer.read(JSON.parse((await p.reply())!))).toEqual({ t: "pong", saw: "manifest" });
    p.deliver(p.held[0]);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([{ t: "manifest" }]);
  });

  it("when two arrive in the wrong order", async () => {
    const p = await heldPair();
    p.peer.send({ t: "manifest" });
    p.peer.send({ t: "want" });
    p.deliver(p.held[1]);
    p.deliver(p.held[0]);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([]);
  });

  it("when it is sent back to the deck that sealed it", async () => {
    const p = await heldPair();
    p.peer.send({ t: "manifest" });
    p.deliver(p.held[0]);
    const back = await p.reply();
    expect(back).toBeTruthy();
    p.deliver(`${back}\n`);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([{ t: "manifest" }]);
  });

  it("when it arrives plain once both ends agreed to seal", async () => {
    const p = await heldPair();
    p.deliver(`${JSON.stringify({ t: "manifest" })}\n`);
    expect(await p.ended()).toBe(true);
    expect(p.heard).toEqual([]);
  });

  it("and at the dialling end too: a plain reply ends the round, and nothing in it is kept", async () => {
    const a = await deck(MINE, "Deck-A", SHARED, PORTS.engine);
    const me = sync.identityFrom("");
    const s = socket.createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Plain", host: "127.0.0.1", prefer: PORTS.listener,
      trusted: () => [{ fp: a.id.fp, pub: a.id.pub, name: "Deck-A" }],
      // Answers around the seal, straight onto the socket, in the clear.
      handlers: (_msg: Frame, ctx: { sock: net.Socket }) => socket.sendFrame(ctx.sock, {
        t: "manifest", accounts: [{ key: K("planted@x", "org-x"), email: "planted@x", alive: false }],
      }),
    });
    running.push(s);
    const port = await s.start();
    expect(a.e.addPeer("127.0.0.1", port)).toBe(true);
    expect(await a.e.round()).toEqual([]);
    const row = peerRow(a, me.fp);
    expect(row?.last?.error).toBe("a reply from that deck did not open");
    expect(row?.offers ?? null).toBeNull();
  }, 20_000);
});

describe("taking the announcement off, between two decks of this version", () => {
  /** A listener and a dial through a relay that passes each line to `edit`. */
  async function through(edit: (line: string, way: Way) => string) {
    const me = sync.identityFrom("");
    const caller = sync.identityFrom("");
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
  /** One field of one frame rewritten on its way through. */
  const rewrite = (t: string, fn: (c: string) => string) => (line: string) => {
    const f = JSON.parse(line);
    if (f.t === t) f.challenge = fn(String(f.challenge));
    return JSON.stringify(f);
  };
  const unmark = (c: string) => c.replace(/\.seal1$/, "");

  it("fails when the dialler's mark is taken off", async () => {
    const edit = rewrite("hello", unmark);
    const { dial, heard, errors } = await through((l, way) => (way === "up" ? edit(l) : l));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("fails when the answerer's mark is taken off", async () => {
    const edit = rewrite("challenge", unmark);
    const { dial, heard, errors } = await through((l, way) => (way === "down" ? edit(l) : l));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("fails when both are taken off, which is what an older pair looks like", async () => {
    const up = rewrite("hello", unmark);
    const down = rewrite("challenge", unmark);
    const { dial, heard, errors } = await through((l, way) => (way === "up" ? up(l) : down(l)));
    await expect(dial).rejects.toThrow("the other deck refused this one's proof");
    expect(errors).toContain("bad proof");
    expect(heard).toEqual([]);
  });

  it("refuses a challenge carrying the transcript's separator, at either end", async () => {
    const bar = (c: string) => `${c}|x`;
    const toCaller = rewrite("challenge", bar);
    const first = await through((l, way) => (way === "down" ? toCaller(l) : l));
    await expect(first.dial).rejects.toThrow("bad challenge");
    await running.splice(0).reduce((p, r) => p.then(() => r.stop()), Promise.resolve());

    const toListener = rewrite("hello", bar);
    const second = await through((l, way) => (way === "up" ? toListener(l) : l));
    await expect(second.dial).rejects.toThrow();
    expect(second.errors).toContain("bad hello");
    expect(second.heard).toEqual([]);
  });
});

describe("the channel itself", () => {
  const A = sync.identityFrom("");
  const B = sync.identityFrom("");
  const key = (t = "transcript") => sync.sessionKey(A.secret, B.pub, t);
  const pair = (k = key()) => ({ c: sync.frameChannel(k, "caller"), l: sync.frameChannel(k, "listener") });

  it("seals each direction under its own key and IV, even for a deck talking to its own key", () => {
    // One fingerprint at both ends — a copied ~/.claude — must not mean one key.
    const self = sync.sessionKey(A.secret, A.pub, "t");
    const keys = sync.frameKeys(self);
    expect(keys.caller.key.equals(keys.listener.key)).toBe(false);
    expect(keys.caller.iv.equals(keys.listener.iv)).toBe(false);
    const { c, l } = pair(self);
    expect(c.wrap({ t: "x" }).sealed).not.toBe(l.wrap({ t: "x" }).sealed);
  });

  it("never seals under one nonce twice: the same frame twice is two different frames", () => {
    const { c } = pair();
    const one = c.wrap({ t: "manifest" });
    const two = c.wrap({ t: "manifest" });
    expect(one.sealed).not.toBe(two.sealed);
    expect(one.tag).not.toBe(two.tag);
  });

  it("opens what the other end sealed, in order, and puts nothing else on the wire", () => {
    const { c, l } = pair();
    const f0 = c.wrap({ t: "manifest", accounts: [] });
    expect(Object.keys(f0).sort()).toEqual(["sealed", "tag"]);
    expect(l.unwrap(f0)).toEqual({ t: "manifest", accounts: [] });
    expect(c.unwrap(l.wrap({ t: "have" }))).toEqual({ t: "have" });
    expect(l.unwrap(c.wrap({ t: "want" }))).toEqual({ t: "want" });
  });

  it("refuses a frame altered, cut short, replayed, reordered, dropped, reflected or from another connection", () => {
    const cases: Record<string, () => unknown> = {
      altered: () => { const { c, l } = pair(); const f = c.wrap({ t: "x" }); return l.unwrap({ ...f, sealed: `${f.sealed[0] === "A" ? "B" : "A"}${f.sealed.slice(1)}` }); },
      "tag altered": () => { const { c, l } = pair(); const f = c.wrap({ t: "x" }); const t = Buffer.from(f.tag, "base64"); t[0] ^= 1; return l.unwrap({ ...f, tag: t.toString("base64") }); },
      "cut short": () => { const { c, l } = pair(); const f = c.wrap({ t: "x" }); return l.unwrap({ ...f, tag: Buffer.from(f.tag, "base64").subarray(0, 4).toString("base64") }); },
      replayed: () => { const { c, l } = pair(); const f = c.wrap({ t: "x" }); l.unwrap(f); return l.unwrap(f); },
      reordered: () => { const { c, l } = pair(); const f0 = c.wrap({ t: "x" }); const f1 = c.wrap({ t: "y" }); void f0; return l.unwrap(f1); },
      dropped: () => { const { c, l } = pair(); l.unwrap(c.wrap({ t: "x" })); c.wrap({ t: "lost" }); return l.unwrap(c.wrap({ t: "z" })); },
      reflected: () => { const { c } = pair(); return c.unwrap(c.wrap({ t: "x" })); },
      "another connection": () => { const other = pair(key("another")); const { l } = pair(); return l.unwrap(other.c.wrap({ t: "x" })); },
      plain: () => { const { l } = pair(); return l.unwrap({ t: "manifest" }); },
      "with a plain field beside it": () => { const { c, l } = pair(); return l.unwrap({ ...c.wrap({ t: "x" }), t: "manifest" }); },
    };
    for (const [name, run] of Object.entries(cases)) expect(run(), name).toBeNull();
  });

  it("refuses everything after the first frame it refused", () => {
    const { c, l } = pair();
    const f0 = c.wrap({ t: "x" });
    expect(l.unwrap({ ...f0, tag: Buffer.alloc(16).toString("base64") })).toBeNull();
    // The genuine frame, in its right place, arriving after the bad one: the
    // connection is over, and there is no second try.
    expect(l.unwrap(f0)).toBeNull();
  });

  it("marks this deck's challenge, not an older deck's, and takes both", () => {
    const ours = sync.challengeFor();
    expect(ours).toMatch(/^[0-9a-f]{32}\.seal1$/);
    expect(sync.sealsFrames(ours)).toBe(true);
    const older = sync.challengeFor({ seals: false });
    expect(older).toMatch(/^[0-9a-f]{32}$/);
    expect(sync.sealsFrames(older)).toBe(false);
    for (const c of [ours, older, randomBytes(16).toString("hex"), "aaaa"]) expect(sync.readChallenge(c), c).toBe(c);
  });

  it("refuses a challenge no deck sends", () => {
    for (const c of ["a|b", `${"a".repeat(32)}.seal1|x`, "", "x".repeat(129), "a b", 7, null, {}]) {
      expect(sync.readChallenge(c), JSON.stringify(c)).toBeNull();
    }
  });

  it("opens a seal only with its whole sixteen-byte tag", () => {
    const k = key();
    const sealed = sync.seal(k, "a credential", "aad");
    expect(sync.open(k, sealed, "aad")).toBe("a credential");
    const short = { ...sealed, tag: Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64") };
    expect(sync.open(k, short, "aad")).toBeNull();
  });
});
