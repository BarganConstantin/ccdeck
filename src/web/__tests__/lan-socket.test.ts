  it("reports a deck nobody has accepted, instead of dropping it", async () => {
    // THE OPPOSITE OF WHAT THIS USED TO DO. A packet from outside the group was
    // dropped and counted; there is no outside any more. A deck shouting on the
    // same network is a name and an address, which is a row somebody accepts —
    // and it is not in `peers`, so nothing is asked of it and nothing offered.
    const sock = fakeSocket();
    const { b, seen, strangers } = beaconOn(sock);
    await b.start();
    sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Stranger", f: "aaa-bbb-ccc-ddd", p: 4319, i: "deadbeef",
    })), "192.168.1.99");
    expect(seen).toHaveLength(0);
    expect(b.peers.size).toBe(0);
    expect(strangers).toHaveLength(1);
    expect(strangers[0]).toMatchObject({ fp: "aaa-bbb-ccc-ddd", name: "Stranger", addr: "192.168.1.99", port: 4319 });
    b.stop();
  });

// The plumbing under the rules: a socket that shouts, a listener that answers,
// and the deadlines around both.
//
// TWO KINDS OF TEST IN HERE, DELIBERATELY.
//
// The TCP half runs for real, on loopback, both ends in this process. There is
// nothing to fake — a listener and a caller are both ours, the handshake is the
// thing being checked, and a mock of either would only be checking that the
// mock agrees with the code it was written from.
//
// The UDP half runs against an injected socket. A CI runner is not a network:
// GitHub's has no broadcast domain worth the name, and a test that skipped
// itself there would be a test that stopped testing without saying so. The real
// socket is exercised by hand, two decks on one machine, which works because a
// broadcast to 255.255.255.255 comes back to every socket on the sending host —
// measured before any of this was written, and the reason self-recognition is
// by fingerprint rather than by address.
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
// @ts-expect-error — plain .mjs server modules, no types
import { fingerprint, hostId, identityFrom, readBeacon, ANNOUNCE_MS, PROTOCOL } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server modules, no types
import {
  connectToPeer, createBeacon, createSyncServer, frameReader, sendFrame,
  DISCOVERY_PORT, HANDSHAKE_MS, MAX_FRAME_BYTES, MAX_SOCKETS,
} from "../../server/lan-socket.mjs";

/** One caller and one listener for the whole file. Identities are the point of
 *  the handshake now, so they are made once and reused rather than regenerated
 *  per test — an X25519 keypair is cheap and a hundred of them are not. */
const CALLER = identityFrom("");
const STRANGER = identityFrom("");

/** Everything a case opened, closed even when it failed — a leaked listener
 *  holds a port and the next case picks a different one and passes for the
 *  wrong reason. */
const opened: Array<{ stop: () => void }> = [];
afterEach(() => { for (const o of opened.splice(0)) o.stop(); });

function server(over: Record<string, unknown> = {}) {
  const me = identityFrom("");
  const heard: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const pending: Record<string, unknown>[] = [];
  // Trusting CALLER by default, because most of what this file tests is what
  // happens BETWEEN two decks that have already been paired. The pairing itself
  // has its own block below, which passes an empty list.
  const s = createSyncServer({
    fp: me.fp, pub: me.pub, secret: me.secret, name: "Server-Deck",
    trusted: () => [{ fp: CALLER.fp, pub: CALLER.pub, name: "Caller-Deck" }],
    onPending: (e: Record<string, unknown>) => pending.push(e),
    handlers: (msg: Record<string, unknown>, ctx: { send: (o: unknown) => void }) => {
      heard.push(msg);
      ctx.send({ t: "pong", saw: msg.t });
    },
    onError: (what: string) => errors.push(what),
    host: "127.0.0.1",
    ...over,
  });
  opened.push(s);
  return { s, fp: me.fp, pub: me.pub, heard, errors, pending };
}

/** The caller's own identity, spread into connectToPeer. */
const caller = () => ({ fp: CALLER.fp, pub: CALLER.pub, secret: CALLER.secret, name: "Caller-Deck" });
/** A deck nobody has accepted, for the half of the file about being refused. */
const stranger = () => ({ fp: STRANGER.fp, pub: STRANGER.pub, secret: STRANGER.secret, name: "Stranger-Deck" });

describe("two decks in one group, talking", () => {
  it("completes the handshake and knows who it reached", async () => {
    const { s, fp } = server();
    const port = await s.start();
    const peer = await connectToPeer({ host: "127.0.0.1", port, ...caller() });
    expect(peer.peerFp).toBe(fp);
    expect(peer.peerName).toBe("Server-Deck");
    peer.sock.destroy();
  });

  it("carries frames once, and only once, both are proved", async () => {
    const { s, heard } = server();
    const port = await s.start();
    const peer = await connectToPeer({ host: "127.0.0.1", port, ...caller() });
    const back = new Promise<string>(res => peer.sock.on("data", (d: string) => res(d.trim())));
    peer.send({ t: "manifest" });
    expect(JSON.parse(await back)).toEqual({ t: "pong", saw: "manifest" });
    expect(heard).toEqual([{ t: "manifest" }]);
    peer.sock.destroy();
  });

  it("gives the listener an ephemeral port, so the only fixed one is discovery", async () => {
    // One fixed port in the feature is one thing to collide with, one firewall
    // dialog and one number in a support answer. The beacon carries the rest.
    const { s } = server();
    const port = await s.start();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(DISCOVERY_PORT);
    expect(s.port()).toBe(port);
  });
});

describe("the port it listens on", () => {
  it("takes the one it had last time, so a typed address survives a restart", async () => {
    // It asked the OS for a new port every start, which is invisible while
    // broadcast works — and broadcast not working is the entire reason the
    // panel has an address field. The address somebody typed on the other
    // machine stopped working at the next restart, with `handshake timed out`
    // and nothing to say the port had simply moved.
    const first = server();
    const port = await first.s.start();
    first.s.stop();
    await new Promise(r => setTimeout(r, 120));
    const again = server({ prefer: port });
    expect(await again.s.start()).toBe(port);
  });

  it("falls through to any free port rather than refusing to start", async () => {
    // Two decks on one machine, or something unrelated holding it. The pin is a
    // preference and never a requirement: a deck that would not start because
    // its remembered port was busy is a worse failure than a moved port.
    const held = server();
    const port = await held.s.start();
    const second = server({ prefer: port });
    const got = await second.s.start();
    expect(got).toBeGreaterThan(0);
    expect(got).not.toBe(port);
  });

  it("still asks the OS when it has no port to remember", async () => {
    const { s } = server({ prefer: 0 });
    expect(await s.start()).toBeGreaterThan(0);
  });
});

describe("a caller nobody has accepted", () => {
  it("is told it is waiting on a person, not fighting a firewall", async () => {
    // THIS IS THE DEFECT THE WHOLE REDESIGN CAME OUT OF. The listener used to
    // destroy the socket without a word, so the caller's only evidence was
    // `peer closed the connection` — true, useless, and it reads as a firewall.
    // Two people spent twenty minutes on one that was fine.
    //
    // It leaks nothing. "I do not know you" is what the silent close already
    // said, and the fingerprints involved are in every beacon this deck sends.
    const { s, pending } = server({ trusted: () => [] });
    const port = await s.start();
    await expect(connectToPeer({ host: "127.0.0.1", port, ...stranger(), timeoutMs: 1500 }))
      .rejects.toThrow(/waiting for the other deck to accept/);
    // And the other deck now has something to accept: a real deck that finished
    // a handshake, with a name and an address a person can recognise.
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ fp: STRANGER.fp, pub: STRANGER.pub, name: "Stranger-Deck" });
  });

  it("is told it was told no, rather than being left to wait on an answer that came", async () => {
    // A refusal that is only HELD is a refusal the other machine cannot see:
    // the frame for "nobody has answered yet" and the frame for "somebody said
    // no" were the same one, so a declined deck drew "waiting for the other
    // deck to accept this one" for as long as it kept dialling — and it dials
    // on its own timer, so that is forever.
    const { s, pending } = server({ trusted: () => [], declined: () => true });
    const port = await s.start();
    await expect(connectToPeer({ host: "127.0.0.1", port, ...stranger(), timeoutMs: 1500 }))
      .rejects.toThrow(/that deck said no/);
    // And it is not asked here a second time. The whole point of keeping the
    // name is that the person who answered is not asked the same question every
    // minute by a deck that cannot hear the answer.
    expect(pending).toHaveLength(0);
  });

  it("is let in once somebody accepts it, and not before", async () => {
    let trusted: Array<Record<string, unknown>> = [];
    const { s } = server({ trusted: () => trusted });
    const port = await s.start();
    await expect(connectToPeer({ host: "127.0.0.1", port, ...stranger(), timeoutMs: 1500 })).rejects.toThrow();
    trusted = [{ fp: STRANGER.fp, pub: STRANGER.pub, name: "Stranger-Deck" }];
    const peer = await connectToPeer({ host: "127.0.0.1", port, ...stranger(), timeoutMs: 1500 });
    expect(peer.peerName).toBe("Server-Deck");
    peer.sock.destroy();
  });

  it("is refused as an impostor when it wears a paired deck's fingerprint", async () => {
    // The pinned key is the load-bearing half. A fingerprint we hold, presented
    // with a different key, is not a peer whose details changed — 48 bits is far
    // past accident, so it is somebody trying.
    const { s } = server({
      trusted: () => [{ fp: STRANGER.fp, pub: CALLER.pub, name: "not really" }],
    });
    const port = await s.start();
    await expect(connectToPeer({ host: "127.0.0.1", port, ...stranger(), timeoutMs: 1500 }))
      .rejects.toThrow(/pinned under a different key/);
  });

  it("refuses the caller too, when the deck answering is not the one it pinned", async () => {
    // Both directions, and the second is the one that is easy to skip: a
    // handshake where only the listener checks stops a stranger reading a
    // manifest and stops nothing else.
    const { s } = server();
    const port = await s.start();
    await expect(connectToPeer({
      host: "127.0.0.1", port, ...caller(), timeoutMs: 1500, expectPub: STRANGER.pub,
    })).rejects.toThrow(/a different deck is answering at that address/);
  });

  it("says which refusal it is, in a constant, with nothing keyed in it", async () => {
    // A listener that said which byte of the proof went wrong, or echoed
    // anything derived from a key, would hand out what the four-message
    // handshake exists to withhold.
    const frames: Record<string, unknown>[] = [];
    const { s, fp } = server({ trusted: () => [] });
    const port = await s.start();
    await new Promise<void>(resolve => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sendFrame(sock, { t: "hello", fp: STRANGER.fp, pub: STRANGER.pub, challenge: randomBytes(16).toString("hex") });
      });
      sock.setEncoding("utf8");
      sock.on("data", frameReader((msg: Record<string, unknown>) => {
        frames.push(msg);
        if (msg.t === "challenge") { sendFrame(sock, { t: "auth", proof: "0".repeat(64) }); return; }
        sock.destroy();
        resolve();
      }, () => resolve()));
      sock.on("close", () => resolve());
    });
    const no = frames.find(f => f.t === "no");
    expect(no, "the refusal is said, not merely performed by closing").toBeTruthy();
    expect(no!.why).toBe("bad proof");
    expect(Object.keys(no!).sort()).toEqual(["t", "why"]);
    expect(JSON.stringify(no)).not.toContain(fp);
  });

  it("refuses a hello whose fingerprint and key disagree", async () => {
    // The fingerprint IS a hash of the key, so a hello whose two halves do not
    // match is not a deck with a stale field — it is somebody announced as one
    // deck trying to prove they are another.
    const frames: Record<string, unknown>[] = [];
    const { s } = server({ trusted: () => [] });
    const port = await s.start();
    await new Promise<void>(resolve => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
        sendFrame(sock, { t: "hello", fp: CALLER.fp, pub: STRANGER.pub, challenge: "a".repeat(32) });
      });
      sock.setEncoding("utf8");
      sock.on("data", frameReader((msg: Record<string, unknown>) => { frames.push(msg); }, () => resolve()));
      sock.on("close", () => resolve());
    });
    expect(frames.find(f => f.t === "no")?.why).toBe("bad hello");
  });

  it("is never handed anything a key made, just for connecting", async () => {
    // The whole reason the handshake is four messages rather than three. A
    // listener that answered `hello` with its own proof would hand anybody who
    // opens a socket a MAC over values they chose, for free, forever — an
    // offline grind, refreshed on demand. What a stranger gets is a random
    // number.
    const { s } = server();
    const port = await s.start();
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    sock.setEncoding("utf8");
    const first = await new Promise<Record<string, unknown>>((res, rej) => {
      sock.on("error", rej);
      sock.on("connect", () => sendFrame(sock, { t: "hello", fp: CALLER.fp, pub: CALLER.pub, challenge: "aaaa" }));
      sock.on("data", (d: string) => res(JSON.parse(d.trim())));
    });
    expect(first.t).toBe("challenge");
    expect(Object.keys(first).sort()).toEqual(["challenge", "fp", "name", "pub", "t"]);
    expect(first).not.toHaveProperty("proof");
    // And what it DOES carry is already public: the fingerprint is in every
    // beacon, the public key is what that fingerprint hashes, and the name is
    // in the beacon too. None of it is a leak; all of it is what lets the
    // caller name us in its own proof and pin us afterwards.
    expect(typeof first.fp).toBe("string");
    expect(typeof first.pub).toBe("string");
    sock.destroy();
  });

  it("gets nothing at all when the deck has no passphrase set", async () => {
    const { s } = server({ secret: null });
    const port = await s.start();
    await expect(connectToPeer({ host: "127.0.0.1", port, ...caller(), timeoutMs: 1000 }))
      .rejects.toThrow();
  });
});

describe("a caller who is trying to cost something", () => {
  it("is dropped for saying nothing at all", async () => {
    // The cheapest way to hold a resource is to connect and wait. So the
    // deadline is armed before the first byte is read and cleared only by a
    // finished handshake.
    const { s } = server();
    const port = await s.start();
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    const closed = new Promise<void>(res => sock.on("close", () => res()));
    await expect(Promise.race([
      closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("still open")), HANDSHAKE_MS + 2000)),
    ])).resolves.toBeUndefined();
  }, HANDSHAKE_MS + 5000);

  // THE CLIENT HAS TO READ, and that is a change worth writing down. These two
  // used to attach no `data` handler at all and wait for `close`, which worked
  // while the refusal was a bare `destroy` on a socket with nothing buffered.
  // The refusal says which check failed now, and a paused socket holding unread
  // bytes never emits `close` however the other end goes away — so a test that
  // does not read is testing node's backpressure, not this listener. Every real
  // caller reads: `connectToPeer` is the only one there is.
  const refusedFrom = (send: (s: net.Socket) => void, port: number) =>
    new Promise<Record<string, unknown> | null>(resolve => {
      let seen: Record<string, unknown> | null = null;
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.setEncoding("utf8");
      sock.on("data", frameReader((msg: Record<string, unknown>) => { seen = msg; }, () => {}));
      sock.on("close", () => resolve(seen));
      sock.on("error", () => { /* the reset that follows the refusal */ });
      sock.on("connect", () => send(sock));
    });

  it("is dropped for saying something that is not the handshake", async () => {
    const { s, errors } = server();
    const port = await s.start();
    const said = await refusedFrom(sock => sendFrame(sock, { t: "manifest" }), port);
    expect(said).toEqual({ t: "no", why: "expected auth" });
    expect(errors).toContain("frame");
    // And the listener is still a listener: a refusal is not a wound.
    const peer = await connectToPeer({ host: "127.0.0.1", port, ...caller() });
    peer.sock.destroy();
  });

  it("cannot skip the challenge by sending the auth first", async () => {
    const { s } = server();
    const port = await s.start();
    // `expected auth` rather than `bad proof`: with no challenge there is
    // nothing to check a proof against, so no proof was wrong. The two are
    // different problems with different fixes and the wire says which.
    expect(await refusedFrom(sock => sendFrame(sock, { t: "auth", proof: "0".repeat(64) }), port))
      .toEqual({ t: "no", why: "expected auth" });
  });

  it("frees its own socket even when the caller never reads the refusal", async () => {
    // The caller that is trying to cost something does not read, and cannot be
    // made to. What matters is that the LISTENER is not the one holding a
    // socket: it writes, resets, and forgets, so a run of these cannot fill the
    // MAX_SOCKETS table and lock a deck out of its own group.
    const { s } = server();
    const port = await s.start();
    const held: net.Socket[] = [];
    for (let i = 0; i < MAX_SOCKETS + 4; i++) {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.setEncoding("utf8");           // deliberately no data handler
      sock.on("error", () => { /* reset */ });
      sock.on("connect", () => sendFrame(sock, { t: "manifest" }));
      held.push(sock);
    }
    await new Promise(r => setTimeout(r, 400));
    const peer = await connectToPeer({ host: "127.0.0.1", port, ...caller(), timeoutMs: 2000 });
    expect(peer.peerFp).toBeTruthy();
    peer.sock.destroy();
    for (const sock of held) sock.destroy();
  });

  it("cannot hold more sockets than the deck will keep", async () => {
    // The real number is one per peer per minute. Anything above the cap is a
    // bug in a peer or somebody watching what happens.
    const { s } = server();
    const port = await s.start();
    const socks = Array.from({ length: MAX_SOCKETS + 4 }, () => net.createConnection({ port, host: "127.0.0.1" }));
    const closes = socks.map(so => new Promise<boolean>(res => {
      so.on("close", () => res(true));
      setTimeout(() => res(false), 1200);
    }));
    const results = await Promise.all(closes);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(4);
    for (const so of socks) so.destroy();
  }, 10_000);
});

describe("reading frames off a socket", () => {
  const collect = () => {
    const frames: Record<string, unknown>[] = [];
    const refusals: string[] = [];
    return { frames, refusals, read: frameReader((f: Record<string, unknown>) => frames.push(f), (w: string) => refusals.push(w)) };
  };

  it("takes several frames out of one chunk", () => {
    const c = collect();
    c.read('{"t":"a"}\n{"t":"b"}\n');
    expect(c.frames).toEqual([{ t: "a" }, { t: "b" }]);
  });

  it("waits for the rest of a frame split across chunks", () => {
    const c = collect();
    c.read('{"t":');
    expect(c.frames).toEqual([]);
    c.read('"a"}\n');
    expect(c.frames).toEqual([{ t: "a" }]);
  });

  it("abandons a buffer that is being grown rather than sent", () => {
    // The cap is on the UNTERMINATED buffer, which is the distinction that
    // matters: a megabyte with no newline in it is not a large frame, it is
    // nothing at all, expensively. Past the cap this stops reading rather than
    // reading faster.
    const c = collect();
    c.read("x".repeat(MAX_FRAME_BYTES + 1));
    expect(c.refusals).toEqual(["frame too large"]);
    // And it stays stopped: more data after a refusal is not a second chance.
    c.read('{"t":"a"}\n');
    expect(c.frames).toEqual([]);
    expect(c.refusals).toHaveLength(1);
  });

  it("refuses a line that is not JSON, and one that is not an object", () => {
    const a = collect();
    a.read("not json\n");
    expect(a.refusals).toEqual(["not json"]);
    const b = collect();
    b.read("[1,2,3]\n");
    expect(b.refusals).toEqual(["not an object"]);
    const c = collect();
    c.read("null\n");
    expect(c.refusals).toEqual(["not an object"]);
  });

  it("skips a blank line rather than treating it as a frame", () => {
    const c = collect();
    c.read('\n\n{"t":"a"}\n');
    expect(c.frames).toEqual([{ t: "a" }]);
    expect(c.refusals).toEqual([]);
  });
});

// ── the beacon, against a socket the test owns ──────────────────────────────

/** Enough of a dgram socket for the beacon to work: it records what was sent
 *  and lets a case deliver a packet as though the network had. */
function fakeSocket() {
  const sent: Array<{ msg: Buffer; port: number; addr: string }> = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let broadcast = false;
  return {
    sent,
    get broadcast() { return broadcast; },
    deliver(msg: Buffer, address: string) { handlers.get("message")?.(msg, { address }); },
    on(ev: string, fn: (...args: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_port: number, _host: string, cb: () => void) { cb(); },
    setBroadcast(v: boolean) { broadcast = v; },
    send(msg: Buffer, port: number, addr: string, cb?: (e: Error | null) => void) {
      sent.push({ msg, port, addr });
      cb?.(null);
    },
    close() { /* nothing to release */ },
  };
}

function beaconOn(sock: ReturnType<typeof fakeSocket>, over: Record<string, unknown> = {}) {
  const fp = fingerprint(randomBytes(32));
  const seen: Array<Record<string, unknown>> = [];
  const strangers: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const b = createBeacon({
    port: 51234, name: "MacBook", fp,
    trusted: () => (over.trustedFps as string[] ?? []).map(f => ({ fp: f, pub: "x" })),
    onStranger: (e: Record<string, unknown>) => strangers.push(e),
    onPeer: (n: Record<string, unknown>) => seen.push(n),
    onError: (what: string) => errors.push(what),
    createSocket: () => sock,
    ...over,
  });
  return { b, fp, seen, strangers, errors };
}

describe("shouting, and hearing", () => {
  it("announces the moment it starts, not on the next interval", async () => {
    // A deck that just came up should appear now rather than up to thirty
    // seconds later — which is the difference between "it works" and "it seems
    // broken" for anybody who starts two decks and watches. Syncthing's rule.
    const sock = fakeSocket();
    const { b } = beaconOn(sock);
    await b.start();
    expect(sock.sent).toHaveLength(1);
    b.stop();
  });

  it("shouts to the limited broadcast address, on the one fixed port", async () => {
    // Not a multicast group: consumer switches forward broadcast where they
    // drop unregistered groups. Not the subnet-directed form either — that
    // needs the netmask of whichever interface the packet leaves by, which
    // changes when a VPN comes up.
    const sock = fakeSocket();
    const { b } = beaconOn(sock);
    await b.start();
    expect(sock.sent[0].addr).toBe("255.255.255.255");
    expect(sock.sent[0].port).toBe(DISCOVERY_PORT);
    expect(sock.broadcast).toBe(true);
    b.stop();
  });

  it("shouts as soon as it is on, because there is nothing left to keep quiet about", async () => {
    // It used to stay silent until a passphrase existed, on the grounds that a
    // deck with no group had nobody to find. There are no groups now: a beacon
    // says a deck is here and hashes a PUBLIC key, and what it finds is
    // strangers somebody can accept. Silence would only mean nobody ever gets
    // the chance.
    const sock = fakeSocket();
    const { b } = beaconOn(sock);
    await b.start();
    expect(sock.sent).toHaveLength(1);
    b.stop();
  });

  it("hears a deck it was told to trust, and remembers where it came from", async () => {
    const sock = fakeSocket();
    const theirs = beaconOn(fakeSocket());
    const { b, seen } = beaconOn(sock, { trustedFps: [theirs.fp] });
    await b.start();
    await theirs.b.start();
    sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Desktop", f: theirs.fp, p: 4319, i: "0badc0de",
    })), "192.168.1.42");
    expect(seen).toHaveLength(1);
    expect(b.peers.get(theirs.fp).addr).toBe("192.168.1.42");
    expect(b.peers.get(theirs.fp).name).toBe("Desktop");
    b.stop(); theirs.b.stop();
  });

  it("ignores the copy of its own shout that comes back", async () => {
    // Measured on a real network: a broadcast returns to every socket on the
    // sending host, from that host's LAN address rather than from loopback. So
    // filtering by address would not have worked, and this is why the rule is
    // about the fingerprint.
    const sock = fakeSocket();
    const { b, seen } = beaconOn(sock);
    await b.start();
    sock.deliver(sock.sent[0].msg, "192.168.1.82");
    expect(seen).toHaveLength(0);
    expect(b.peers.size).toBe(0);
    b.stop();
  });

  it("drops a packet that is not ours without a word", async () => {
    const sock = fakeSocket();
    const { b, seen, errors } = beaconOn(sock);
    await b.start();
    for (const junk of ["", "hello", "{}", '{"m":"OTHR"}']) sock.deliver(Buffer.from(junk), "10.0.0.1");
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(0);
    b.stop();
  });

  it("puts its own name, port and machine in what it sends, and nothing more", async () => {
    const sock = fakeSocket();
    const { b, fp } = beaconOn(sock);
    await b.start();
    const out = readBeacon(sock.sent[0].msg);
    expect(out).toEqual({ name: "MacBook", fp, port: 51234, instance: out.instance, host: out.host });
    // The machine id is a HASH and stays one: a hostname and a home directory
    // carry a person's name, and this goes out in the clear to everyone on the
    // network every thirty seconds.
    expect(out.host).toMatch(/^[0-9a-f]{12}$/);
    expect(out.host).toBe(hostId());
    expect(sock.sent[0].msg.toString()).not.toContain(hostId({ hostname: "x", home: "y" }));
    for (const leak of [os.hostname(), os.homedir()]) {
      expect(sock.sent[0].msg.toString(), leak).not.toContain(leak);
    }
    b.stop();
  });

  it("gives one computer one id however many decks it runs, and two computers two", () => {
    // Derived rather than stored, so two processes on one machine agree without
    // coordinating and a first run needs nothing written down.
    expect(hostId({ hostname: "iMac", home: "/Users/c" })).toBe(hostId({ hostname: "iMac", home: "/Users/c" }));
    // A copied ~/.claude is how two real machines end up holding one key, which
    // is what id-clash exists for. The hostname is what still tells them apart.
    expect(hostId({ hostname: "iMac", home: "/Users/c" }))
      .not.toBe(hostId({ hostname: "MacBook", home: "/Users/c" }));
    expect(hostId({ hostname: "iMac", home: "/Users/c" }))
      .not.toBe(hostId({ hostname: "iMac", home: "/Users/d" }));
  });

  it("says so when another deck is wearing its name", async () => {
    // Two decks sharing a config directory, or a ~/.claude copied to a second
    // machine. Reported rather than fixed here: this file carries packets, and
    // choosing a new name belongs to whoever stores it.
    const sock = fakeSocket();
    const clashes: number[] = [];
    const { b, fp } = beaconOn(sock, { onIdClash: () => clashes.push(1) });
    await b.start();
    // Our own fingerprint, from a process that is not ours.
    sock.deliver(Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Twin", f: fp, p: 4319, i: "ffffffff",
    })), "192.168.1.99");
    expect(clashes).toHaveLength(1);
    expect(b.peers.size, "a clashing deck was filed as a peer").toBe(0);
    // And our own packet coming back is still just our own packet.
    sock.deliver(sock.sent[0].msg, "192.168.1.82");
    expect(clashes).toHaveLength(1);
    b.stop();
  });

  it("answers a deck it has never seen, so the second one to start is not blind", async () => {
    // Measured on two real decks before this existed: deck 1 saw deck 2 the
    // instant it started and deck 2 saw nobody, because deck 1's own immediate
    // announce went out before deck 2 was listening. Thirty seconds of an empty
    // list is how a working feature reads as broken.
    const sock = fakeSocket();
    const { b } = beaconOn(sock);
    await b.start();
    expect(sock.sent).toHaveLength(1);
    const stranger = beaconOn(fakeSocket());
    await stranger.b.start();
    const packet = Buffer.from(JSON.stringify({
      m: "CCDK", v: PROTOCOL, n: "Desktop", f: stranger.fp, p: 4319, i: "0badc0de",
    }));
    sock.deliver(packet, "192.168.1.42");
    expect(sock.sent, "a stranger got no answer").toHaveLength(2);
    // And only for a stranger. The obvious version of this is a shout storm:
    // two decks answering each other's answers forever.
    sock.deliver(packet, "192.168.1.42");
    expect(sock.sent, "a deck we already knew was answered again").toHaveLength(2);
    b.stop(); stranger.b.stop();
  });

  it("keeps announcing on its own clock", async () => {
    const sock = fakeSocket();
    const { b } = beaconOn(sock);
    await b.start();
    expect(ANNOUNCE_MS).toBeGreaterThanOrEqual(30_000);
    b.announce();
    expect(sock.sent).toHaveLength(2);
    b.stop();
  });
});
