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
  beaconPayload, beaconVerdict, handshakeTranscript, notePeer, proof, proofOk,
  inviteProof, readBeacon, readPub, sessionKey, trustedPeer,
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

/** The shortest gap between two "I am here too" replies to a stranger. Long
 *  enough that a burst of decks starting together cannot make a storm, short
 *  enough that starting two decks by hand feels instant. */
export const REPLY_COOLDOWN_MS = 2_000;

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
  port, name, fp, onPeer, onStranger, onError, onIdClash, now = Date.now,
  /** The decks somebody has accepted, read fresh each packet so an accept takes
   *  effect immediately rather than at the next restart. */
  trusted = () => [],
  // Injected so the suite can drive this with a socket it controls. CI runners
  // are not a network: GitHub's have no broadcast domain worth the name, and a
  // test that quietly skipped there would be a test that stopped testing
  // without saying so. The REAL socket is exercised by hand, two decks on one
  // machine, which works because a broadcast comes back to its own host.
  createSocket = opts => dgram.createSocket(opts),
} = {}) {
  // Randomised per process. Two beacons from one fingerprint with different
  // instance ids mean the deck restarted between them, which is the signal to
  // drop any session held for it rather than resume into a process that is gone.
  const instance = randomBytes(8).toString("hex");
  const peers = new Map();
  let sock = null;
  let timer = null;
  /** When this deck last answered a deck it had not heard, so answering cannot
   *  become a storm, and which decks it has already answered — without the
   *  second, a deck that is never accepted is answered again on every packet
   *  for as long as both are running. */
  let repliedAt = 0;
  const answered = new Set();

  const payload = () => Buffer.from(JSON.stringify(beaconPayload({ name, fp, port, instance })));

  const announce = () => {
    if (!sock) return;
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
      const verdict = beaconVerdict(beacon, { selfFp: fp, selfInstance: instance, trusted: trusted() });
      // ANSWER A DECK WE HAVE NEVER HEARD, once, WHOEVER IT IS — and that last
      // part is the change. It used to answer only a deck already in the group,
      // which was fine when a group existed. Now the first thing a new deck has
      // to become is a row on somebody's screen, and it cannot become one if
      // this deck never tells it that it exists.
      //
      // Measured on two real decks before any of this: deck 1 saw deck 2 the
      // instant it started and deck 2 saw nobody, because deck 1's own
      // immediate announce went out before deck 2 was listening. Thirty seconds
      // of an empty list is how a working feature reads as broken.
      //
      // At most once every few seconds, because the obvious version is a shout
      // storm: two decks answering each other's answers forever. A new pair
      // converges in two extra packets.
      const newToUs = beacon && verdict !== "self" && verdict !== "id-clash" && verdict !== "unreadable"
        && !peers.has(beacon.fp) && !answered.has(beacon.fp);
      if (newToUs && now() - repliedAt > REPLY_COOLDOWN_MS) {
        repliedAt = now();
        answered.add(beacon.fp);
        announce();
      }
      if (verdict !== "peer") {
        // Another deck is using this one's key — see beaconVerdict. Reported
        // rather than fixed here: this file carries packets, and choosing a new
        // identity for the deck belongs to whoever stores it.
        if (verdict === "id-clash") onIdClash?.();
        // A DECK NOBODY HAS ACCEPTED. It is not refused and not silently
        // dropped: it is a name and an address on the same network, which is a
        // row somebody can accept. Nothing is asked of it and nothing is
        // offered to it until they do.
        if (verdict === "stranger") {
          onStranger?.({ fp: beacon.fp, name: beacon.name, addr: rinfo.address, port: beacon.port, at: now() });
        }
        return;
      }
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
export function createSyncServer({
  fp, pub, name, secret, handlers, onError, host = "0.0.0.0", prefer = 0,
  /** The peers somebody has accepted, read fresh on every connection so an
   *  accept takes effect on the next one rather than on the next restart. */
  trusted = () => [],
  /** A deck we have never been told to trust, which finished the handshake and
   *  is therefore a real deck rather than a port scan. The panel turns this
   *  into a row with an accept on it. */
  onPending,
  /** The invite this deck is currently offering, or null. A caller that proves
   *  it holds the code is somebody the owner handed a token to, so it is paired
   *  on arrival rather than queued behind a press. */
  invite = () => null,
  /** One was used. The caller stores the pairing and retires the invite: a
   *  token that pairs twice is a token worth stealing twice. */
  onInviteUsed,
} = {}) {
  let server = null;
  const live = new Set();

  const onConnection = sock => {
    if (!secret || live.size >= MAX_SOCKETS) { sock.destroy(); return; }
    live.add(sock);
    sock.setEncoding("utf8");
    sock.setNoDelay(true);

    let authed = false;
    let peerFp = null;
    let peerPub = null;
    let peerName = "";
    let peerPort = null;
    let key = null;
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

    /**
     * Refuse, and SAY SO, which cost two people twenty minutes.
     *
     * This used to destroy the socket without a word, so the caller's only
     * evidence was `peer closed the connection` — true, and useless. Every
     * reason here is a different problem with a different fix, and the caller
     * cannot tell them apart from the outside.
     *
     * It leaks nothing an attacker did not have. "I do not know you" is what
     * the silent close already said, and the fingerprints involved are in every
     * beacon this deck broadcasts.
     *
     * DESTROY, NOT END, and the difference is a caller that never reads. `end`
     * is a FIN, and a peer whose socket is paused — connected, refusing to
     * read, which is exactly the shape of a caller trying to cost something —
     * never notices a FIN and holds the socket open. The callback orders the
     * two: destroying before the write flushes would throw away the sentence
     * that is the whole point. The timer is the backstop for a peer whose
     * receive window is full and whose callback therefore never comes.
     */
    const refuse = why => {
      onError?.("frame", new Error(why));
      const bye = () => { try { sock.destroy(); } catch { /* already gone */ } };
      try { sock.write(`${JSON.stringify({ t: "no", why })}\n`, bye); }
      catch { bye(); return; }
      setTimeout(bye, 250).unref?.();
    };

    sock.on("data", frameReader(msg => {
      if (!authed) {
        // FOUR MESSAGES, and the order is chosen so that a stranger who merely
        // connects receives nothing derived from a key.
        //
        //   1. caller  -> hello,     its fingerprint, its public key, a challenge
        //   2. us      -> challenge, ours, and a random number
        //   3. caller  -> auth,      a proof over the whole transcript
        //   4. us      -> ok,        our name, and our proof over the same
        //
        // BOTH PUBLIC KEYS TRAVEL IN THE CLEAR and that is fine: a public key
        // is public, and the fingerprint in the beacon is a hash of this exact
        // value. What the exchange establishes is that whoever is on the other
        // end holds the private half of the key they claimed — which is the
        // only thing a pin can later be checked against.
        if (msg.t === "hello") {
          if (theirChallenge || typeof msg.challenge !== "string") return refuse("bad hello");
          const them = readPub(msg.pub);
          // The fingerprint is a hash of the key, so a hello whose two halves
          // disagree is not a deck with a stale field, it is somebody trying to
          // be announced as one deck and prove they are another.
          if (!them || them.fp !== msg.fp) return refuse("bad hello");
          theirChallenge = msg.challenge;
          peerFp = them.fp;
          peerPub = them.pub;
          peerName = typeof msg.name === "string" ? msg.name : "";
          peerPort = Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65_536 ? msg.port : null;
          key = sessionKey(secret, peerPub, handshakeTranscript(peerFp, fp, theirChallenge, myChallenge));
          sendFrame(sock, { t: "challenge", fp, pub, name, challenge: myChallenge });
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

        // WHO IS THIS, and it is the only question left. The handshake proves
        // they hold the key they claimed; the trusted list says whether anybody
        // here ever agreed to talk to it.
        const known = trustedPeer(trusted(), peerFp);
        if (known && known.pub !== peerPub) {
          // The fingerprint we pinned, presented with a different key. 48 bits
          // is far past accident, so this is somebody wearing a paired deck's
          // name — refused loudly rather than quietly re-pinned.
          return refuse("impostor");
        }
        if (!known) {
          // AN INVITE THIS DECK HANDED OUT, PRESENTED BACK. Whoever is calling
          // holds a token the owner of this machine copied and sent, which is
          // the same decision the accept button is — made earlier, and made
          // once. So there is nothing to press: the deck is pinned here.
          //
          // The proof is over the transcript, so it is worth nothing to
          // somebody who recorded an earlier exchange, and the code itself
          // never travels.
          const live = invite();
          if (live && typeof msg.invite === "string") {
            const want = inviteProof(live.code, handshakeTranscript(peerFp, fp, theirChallenge, myChallenge));
            if (proofOk(want, msg.invite)) {
              onInviteUsed?.({ fp: peerFp, pub: peerPub, name: peerName, port: peerPort,
                addr: sock.remoteAddress?.replace(/^::ffff:/, "") ?? "" });
              authed = true;
              clearTimeout(deadline);
              sendFrame(sock, {
                t: "ok", fp, name,
                proof: proof(key, {
                  challenge: myChallenge, peerChallenge: theirChallenge,
                  fromFp: fp, toFp: peerFp, direction: "reply",
                }),
              });
              return;
            }
          }
          // A REAL DECK WE HAVE NOT MET. It finished a handshake, so it is not
          // a port scan, and it told us a name and an address a person can
          // recognise. That is a row with an accept on it, and nothing else
          // happens until somebody presses it.
          onPending?.({
            fp: peerFp, pub: peerPub, name: peerName,
            addr: sock.remoteAddress?.replace(/^::ffff:/, "") ?? "",
            // Where it LISTENS, from the hello — not this socket's remote port,
            // which is ephemeral. This is what lets an accept dial back.
            port: peerPort,
          });
          return refuse("pending");
        }

        authed = true;
        clearTimeout(deadline);
        // And ours, so the caller knows it reached the deck it pinned rather
        // than something standing in the way of one.
        sendFrame(sock, {
          t: "ok", fp, name,
          proof: proof(key, {
            challenge: myChallenge, peerChallenge: theirChallenge,
            fromFp: fp, toFp: peerFp, direction: "reply",
          }),
        });
        return;
      }
      handlers?.(msg, { sock, peerFp, key, send: obj => sendFrame(sock, obj) });
    }, refuse));
  };

  return {
    /**
     * Listen, on the same port as last time when that is still possible.
     *
     * IT ASKED FOR PORT 0 EVERY TIME, and the reasoning was sound in isolation:
     * the beacon carries whichever port the OS picked, so nothing needs a fixed
     * one and a fixed one is a thing to collide with. But the beacon is exactly
     * what does not arrive when this feature is hardest to set up — a router
     * or a firewall in the way is the whole reason the panel has an address
     * field — and then the address somebody typed on the other machine stopped
     * working the next time this deck restarted, with `handshake timed out` and
     * nothing to say the port had simply moved.
     *
     * So the caller keeps one and hands it back, and a port already taken falls
     * straight through to 0 rather than refusing to start. The pin is a
     * preference, never a requirement.
     */
    start: () => new Promise((resolve, reject) => {
      const wanted = Number.isInteger(prefer) && prefer > 0 && prefer < 65_536 ? prefer : 0;
      let retried = wanted === 0;
      server = net.createServer(onConnection);
      server.on("error", err => {
        if (!retried) {
          // Somebody else has it — another deck on this machine, or something
          // unrelated. The pin is not worth failing to start over.
          retried = true;
          onError?.("listen", err);
          try { server.listen(0, host, () => resolve(server.address().port)); } catch { reject(err); }
          return;
        }
        onError?.("listen", err);
        reject(err);
      });
      server.listen(wanted, host, () => resolve(server.address().port));
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
export function connectToPeer({
  host, port, fp, pub, secret, name, myPort = null, code = null, timeoutMs = HANDSHAKE_MS,
  /** The public key we pinned for this deck the first time, or null for a deck
   *  we are meeting — an address somebody typed. */
  expectPub = null,
}) {
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
      // `port` is where WE listen, which is not the port this socket came from
      // — that one is ephemeral and useless to dial. Without it a deck can
      // accept an incoming request and still have no way to reach back, so the
      // pairing is mutual on paper and one-way in fact.
      sendFrame(sock, { t: "hello", fp, pub, name, port: myPort, challenge: myChallenge });
    });

    let theirChallenge = null;
    let theirFp = null;
    let theirPub = null;
    let key = null;
    sock.on("data", frameReader(msg => {
      if (settled) return;
      // A deck that heard us and said no. Each reason is a different problem
      // with a different fix, and until this frame existed they were all one
      // silent close that read as a firewall.
      if (msg.t === "no") {
        return fail(new Error({
          pending: "waiting for the other deck to accept this one",
          impostor: "that deck has this one pinned under a different key",
          "bad proof": "the other deck refused this one's proof",
        }[msg.why] ?? "the other deck refused this handshake"));
      }
      if (msg.t === "challenge") {
        if (theirFp || typeof msg.challenge !== "string") return fail(new Error("bad challenge"));
        const them = readPub(msg.pub);
        if (!them || them.fp !== msg.fp) return fail(new Error("bad challenge"));
        // THE PIN, CHECKED BEFORE ANYTHING ELSE. A deck we have paired with is
        // this key and no other; a key that does not match is not a peer whose
        // details changed, it is a different machine at the same address.
        if (expectPub && expectPub !== them.pub) {
          return fail(new Error("a different deck is answering at that address"));
        }
        theirChallenge = msg.challenge;
        theirFp = them.fp;
        theirPub = them.pub;
        key = sessionKey(secret, theirPub, handshakeTranscript(fp, theirFp, myChallenge, theirChallenge));
        sendFrame(sock, {
          t: "auth",
          proof: proof(key, {
            challenge: myChallenge, peerChallenge: theirChallenge,
            fromFp: fp, toFp: theirFp, direction: "hello",
          }),
          // Only when joining on an invite. Sent in the same frame as the
          // session proof so a deck that holds a token is paired in one round
          // trip rather than being queued behind somebody else's press.
          ...(code ? { invite: inviteProof(code, handshakeTranscript(fp, theirFp, myChallenge, theirChallenge)) } : {}),
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
      if (!proofOk(want, msg.proof)) return fail(new Error("that deck could not prove its own key"));
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners("close");
      resolve({
        sock, key,
        peerFp: theirFp, peerPub: theirPub, peerName: msg.name,
        send: obj => sendFrame(sock, obj),
      });
    }, fail));
  });
}
