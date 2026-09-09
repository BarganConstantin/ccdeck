// The sockets. Every decision this makes lives in lan-sync.mjs; what is here is
// the plumbing that decision layer refuses to own — a UDP socket that shouts,
// a TCP listener that answers, and the deadlines around both.
//
// TWO SOCKETS, AND NEITHER IS THE DECK'S HTTP SERVER. That server binds
// 127.0.0.1 and stays there. It has a mutation guard that deliberately trusts a
// request carrying no Origin header, so that hook.js and curl keep working —
// correct on loopback, and total exposure the moment the same server answers
// the network. So this feature never asks anybody to run `--host`: it opens its
// own listener, that listener speaks one protocol and nothing else, and it
// refuses every frame from anybody who has not proved they hold the group
// passphrase.
//
// DISCOVERY IS BROADCAST ON A FIXED PORT; THE SYNC LISTENER IS EPHEMERAL and
// says its port in the beacon. One fixed port rather than two is one thing to
// collide with, one firewall dialog, and one number in a support answer.
//
// A DECK HEARS ITSELF. Measured, not assumed: a broadcast to 255.255.255.255
// comes back to every socket on the sending machine bound to that port, from
// the machine's own LAN address rather than from loopback. That is what makes
// two decks on one machine find each other — which is how this gets tested at
// all — and it is why self-recognition is by fingerprint rather than by
// address.
import dgram from "node:dgram";
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  beaconPayload, beaconVerdict, groupTag, notePeer, proof, proofOk, readBeacon,
  ANNOUNCE_MS, MAX_BEACON_BYTES, MAX_MANIFEST_BYTES,
} from "./lan-sync.mjs";

/** The one fixed port in the feature. Out of the deck's HTTP range (4317-4400)
 *  so a beacon can never be mistaken for a deck's own traffic, and unassigned:
 *  45317 reads as "4317, elsewhere", which is what a person tracing this in a
 *  firewall log needs it to say. */
export const DISCOVERY_PORT = 45_317;

/** How long a connection has to finish the handshake before it is dropped. A
 *  handshake is two round trips on a local network — single-digit
 *  milliseconds — so five seconds is generous for a slow machine and short
 *  enough that holding sockets open costs an attacker something. */
export const HANDSHAKE_MS = 5_000;

/** The most one frame may be, and the most a peer may hold open.
 *
 *  Frames are JSON lines. The largest legitimate one is a manifest; the cap is
 *  an order of magnitude over the biggest real store, and the buffer is
 *  ABANDONED rather than grown past it — a socket that keeps sending without a
 *  newline is trying to make this allocate, and the answer is to stop reading
 *  rather than to read faster. */
export const MAX_FRAME_BYTES = MAX_MANIFEST_BYTES;

/** Concurrent connections from all peers together. Small on purpose: the real
 *  number is one per peer per minute, and anything above this is either a bug
 *  in a peer or somebody holding sockets open to see what happens. */
export const MAX_SOCKETS = 16;

/**
 * The shouting half.
 *
 * `reuseAddr` is not a convenience: without it a second deck on the same
 * machine cannot bind the discovery port at all, and two decks on one machine
 * is both a real setup and the only way this gets tested here.
 *
 * Errors are reported, never thrown. A machine with no route, a firewall that
 * refuses the bind, an interface that comes and goes with a VPN — none of them
 * is a reason for the deck to fall over, and all of them are reasons for the
 * panel to be able to say what happened.
 */
export function createBeacon({
  port, name, fp, key, onPeer, onError, now = Date.now,
  // Injected so the suite can drive this with a socket it controls. CI runners
  // are not a network: GitHub's have no broadcast domain worth the name, and a
  // test that quietly skipped there would be a test that stopped testing
  // without saying so. The REAL socket is exercised by hand, two decks on one
  // machine, which works because a broadcast comes back to its own host.
  createSocket = opts => dgram.createSocket(opts),
} = {}) {
  const group = key ? groupTag(key) : null;
  // Randomised per process. Two beacons from one fingerprint with different
  // instance ids mean the deck restarted between them, which is the signal to
  // drop any session held for it rather than resume into a process that is gone.
  const instance = randomBytes(8).toString("hex");
  const peers = new Map();
  let sock = null;
  let timer = null;

  const payload = () => Buffer.from(JSON.stringify(beaconPayload({ name, fp, port, group, instance })));

  const announce = () => {
    if (!sock || !group) return;
    // 255.255.255.255 rather than a multicast group, and rather than the
    // subnet's own broadcast address. The subnet-directed form needs the
    // netmask of whichever interface the packet leaves by, which changes when a
    // VPN comes up; the limited broadcast needs nothing and is what Syncthing
    // sends for the same reason.
    sock.send(payload(), DISCOVERY_PORT, "255.255.255.255", err => {
      // ENETUNREACH and EACCES are what a machine with no network, or a
      // firewall, says. Both are states the panel reports rather than crashes.
      if (err) onError?.("announce", err);
    });
  };

  const start = () => new Promise(resolve => {
    sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", err => { onError?.("socket", err); });
    sock.on("message", (msg, rinfo) => {
      // Everything about whether to care lives in lan-sync.mjs. This hands it
      // the bytes and the address and does what it is told.
      if (msg.length > MAX_BEACON_BYTES) return;
      const beacon = readBeacon(msg);
      const verdict = beaconVerdict(beacon, { selfFp: fp, selfGroup: group });
      if (verdict !== "peer") { if (verdict === "other-group") onError?.("other-group", null); return; }
      const noted = notePeer(peers, beacon, rinfo.address, now());
      if (noted.changed || noted.restarted) onPeer?.(noted);
    });
    sock.bind(DISCOVERY_PORT, "0.0.0.0", () => {
      try { sock.setBroadcast(true); } catch (err) { onError?.("broadcast", err); }
      // Immediately, not on the next tick. Syncthing's rule: a deck that just
      // came up should appear now rather than up to thirty seconds later, which
      // is the difference between "it works" and "it seems broken" for anybody
      // who starts two decks and watches.
      announce();
      timer = setInterval(announce, ANNOUNCE_MS);
      timer.unref?.();
      resolve();
    });
  });

  return {
    start,
    announce,
    peers,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      try { sock?.close(); } catch { /* already closed */ }
      sock = null;
    },
  };
}

/**
 * Read newline-delimited JSON off a socket, refusing to be made to allocate.
 *
 * The cap is on the UNTERMINATED buffer rather than on a frame that arrived,
 * which is the distinction that matters: a peer that sends a megabyte with no
 * newline in it is not sending a large frame, it is sending nothing at all,
 * expensively. Past the cap this stops reading and hands the caller a refusal
 * — it does not keep buffering in the hope a newline turns up.
 */
export function frameReader(onFrame, onRefuse, max = MAX_FRAME_BYTES) {
  let buf = "";
  let dead = false;
  return chunk => {
    if (dead) return;
    buf += chunk;
    if (buf.length > max) { dead = true; buf = ""; onRefuse("frame too large"); return; }
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { dead = true; buf = ""; onRefuse("not json"); return; }
      // `typeof [] === "object"`, so an array walks straight past the obvious
      // check and reaches a handler that reads `msg.t` off it — undefined, and
      // then whatever that handler does with a frame that has no type. A frame
      // is a record; anything else is refused.
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        dead = true; buf = ""; onRefuse("not an object"); return;
      }
      onFrame(msg);
      if (dead) return;
    }
  };
}

/** One line out. Kept in one place so nothing forgets the newline the reader
 *  above is waiting for. */
export function sendFrame(sock, obj) {
  try { sock.write(`${JSON.stringify(obj)}\n`); } catch { /* peer went away */ }
}

/**
 * The answering half.
 *
 * WHAT IT DOES BEFORE IT KNOWS WHO IS CALLING, in order, and the order is the
 * whole security argument: accept, arm a deadline, read at most one frame, and
 * check a proof. No manifest, no account, no store read, nothing that touches
 * claude-swap, until `authed` is true. KDE Connect's CVE-2020-26164 was several
 * issues in a daemon whose protocol was fine, and this is the shape that
 * lesson has.
 *
 * `handlers` is called only with authenticated frames, and it never sees the
 * handshake at all.
 */
export function createSyncServer({ fp, name, key, handlers, onError, host = "0.0.0.0" } = {}) {
  let server = null;
  const live = new Set();

  const onConnection = sock => {
    if (!key || live.size >= MAX_SOCKETS) { sock.destroy(); return; }
    live.add(sock);
    sock.setEncoding("utf8");
    sock.setNoDelay(true);

    let authed = false;
    let peerFp = null;
    const myChallenge = randomBytes(16).toString("hex");
    let theirChallenge = null;

    // Armed before the first byte is read, and cleared only by a completed
    // handshake. A socket that connects and says nothing is the cheapest
    // possible way to hold a resource, so it is also the first one closed.
    const deadline = setTimeout(() => { if (!authed) sock.destroy(); }, HANDSHAKE_MS);
    deadline.unref?.();

    const done = () => { clearTimeout(deadline); live.delete(sock); };
    sock.on("close", done);
    sock.on("error", err => { done(); onError?.("peer", err); });

    const refuse = why => { onError?.("frame", new Error(why)); sock.destroy(); };

    sock.on("data", frameReader(msg => {
      if (!authed) {
        // FOUR MESSAGES, and the order is chosen so that a stranger who merely
        // connects receives nothing derived from the group key.
        //
        //   1. caller  -> hello,     its fingerprint and a fresh challenge
        //   2. us      -> challenge, a random number and nothing else
        //   3. caller  -> auth,      a proof over both challenges
        //   4. us      -> ok,        our name, and our proof over both
        //
        // The tempting three-message version has us answer the hello with our
        // proof already in it. That hands anybody who opens a socket a MAC over
        // values they chose, forever, for free. Here they get a random number:
        // to obtain any keyed material they have to produce a valid proof
        // first, which is the thing they do not have.
        if (msg.t === "hello") {
          if (theirChallenge || typeof msg.fp !== "string" || typeof msg.challenge !== "string") {
            return refuse("bad hello");
          }
          theirChallenge = msg.challenge;
          peerFp = msg.fp;
          // Our fingerprint travels with the challenge. It is already in
          // every beacon we broadcast, so this tells an unauthenticated caller
          // nothing new — and without it the caller cannot name us in its
          // proof, which would leave the transcript covering only one of the
          // two decks and one recorded proof valid at every deck in the group.
          sendFrame(sock, { t: "challenge", fp, challenge: myChallenge });
          return;
        }
        if (msg.t !== "auth" || !theirChallenge) return refuse("expected auth");
        const want = proof(key, {
          challenge: theirChallenge, peerChallenge: myChallenge,
          fromFp: peerFp, toFp: fp, direction: "hello",
        });
        // A recording of a previous exchange fails here, because `myChallenge`
        // was made when this socket opened and has never been sent before.
        if (!proofOk(want, msg.proof)) return refuse("bad proof");
        authed = true;
        clearTimeout(deadline);
        // And ours, so the caller knows it reached a deck in its own group
        // rather than something standing in the way of one.
        sendFrame(sock, {
          t: "ok", fp, name,
          proof: proof(key, {
            challenge: myChallenge, peerChallenge: theirChallenge,
            fromFp: fp, toFp: peerFp, direction: "reply",
          }),
        });
        return;
      }
      handlers?.(msg, { sock, peerFp, send: obj => sendFrame(sock, obj) });
    }, refuse));
  };

  return {
    start: () => new Promise((resolve, reject) => {
      server = net.createServer(onConnection);
      server.on("error", err => { onError?.("listen", err); reject(err); });
      // Port 0: the OS picks, and the beacon carries whichever it picked. One
      // fixed port in this feature is enough to collide with.
      server.listen(0, host, () => resolve(server.address().port));
    }),
    port: () => server?.address()?.port ?? null,
    stop() {
      for (const s of live) s.destroy();
      live.clear();
      try { server?.close(); } catch { /* not listening */ }
      server = null;
    },
  };
}

/**
 * The calling half: connect, prove, be proved to, then talk.
 *
 * BOTH SIDES PROVE, and the second half is the one that is easy to skip. A
 * handshake where only the caller proves itself stops a stranger reading a
 * manifest and stops nothing else — a stranger can still stand up a listener on
 * the announced port, wait for a real deck to dial it, and be handed whatever
 * that deck was going to say. So this checks the reply with the same care the
 * server checks the hello, and gives up if it does not hold.
 */
export function connectToPeer({ host, port, fp, key, timeoutMs = HANDSHAKE_MS }) {
  return new Promise((resolve, reject) => {
    const myChallenge = randomBytes(16).toString("hex");
    const sock = net.createConnection({ host, port });
    sock.setEncoding("utf8");
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => fail(new Error("handshake timed out")), timeoutMs);
    timer.unref?.();

    sock.on("error", fail);
    sock.on("close", () => fail(new Error("peer closed the connection")));
    sock.on("connect", () => {
      // No proof in the hello: the caller cannot cover a challenge it has not
      // been given, and a proof over an empty one would be a proof that means
      // nothing. It goes in message three.
      sendFrame(sock, { t: "hello", fp, challenge: myChallenge });
    });

    let theirChallenge = null;
    let theirFp = null;
    sock.on("data", frameReader(msg => {
      if (settled) return;
      if (msg.t === "challenge") {
        if (theirFp || typeof msg.challenge !== "string" || typeof msg.fp !== "string") {
          return fail(new Error("bad challenge"));
        }
        theirChallenge = msg.challenge;
        theirFp = msg.fp;
        sendFrame(sock, {
          t: "auth",
          proof: proof(key, {
            challenge: myChallenge, peerChallenge: theirChallenge,
            fromFp: fp, toFp: theirFp, direction: "hello",
          }),
        });
        return;
      }
      // The same deck that gave us the challenge, or nothing: a reply naming a
      // different fingerprint is a second party in the middle of this.
      if (msg.t !== "ok" || msg.fp !== theirFp) return fail(new Error("expected ok"));
      const want = proof(key, {
        challenge: theirChallenge, peerChallenge: myChallenge,
        fromFp: theirFp, toFp: fp, direction: "reply",
      });
      if (!proofOk(want, msg.proof)) return fail(new Error("peer could not prove the group"));
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners("close");
      resolve({ sock, peerFp: msg.fp, peerName: msg.name, send: obj => sendFrame(sock, obj) });
    }, fail));
  });
}
