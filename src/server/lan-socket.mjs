// The sockets. Every decision this makes lives in lan-sync.mjs; what is here is
// the plumbing that decision layer refuses to own — a UDP socket that shouts,
// a TCP listener that answers, and the deadlines around both. The shouting
// half is lan-beacon.mjs; this file is the answering and the calling.
//
// TWO SOCKETS, AND NEITHER IS THE DECK'S HTTP SERVER. That server binds
// 127.0.0.1 and stays there. It has a mutation guard that deliberately trusts a
// request carrying no Origin header, so that hook.js and curl keep working —
// correct on loopback, and total exposure the moment the same server answers
// the network. So this feature never asks anybody to run `--host`: it opens its
// own listener, that listener speaks one protocol and nothing else, and it
// serves no frame to anybody who has not proved they hold the key of a deck
// somebody here accepted.
//
// DISCOVERY IS BROADCAST ON A FIXED PORT; THE SYNC LISTENER IS EPHEMERAL and
// says its port in the beacon. One fixed port rather than two is one thing to
// collide with, one firewall dialog, and one number in a support answer.
import net from "node:net";
import {
  challengeFor, cleanName, ephemeralPair, frameChannel, handshakeTranscript,
  mixesEphemeral, proof, proofOk, inviteProof, inviteProofBack, readChallenge,
  readEphemeral, readPub, sealsFrames, sessionKey, trustedPeer,
  MAX_MANIFEST_BYTES,
} from "./lan-sync.mjs";

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
 * And the most any ONE host may take of that, because a budget nobody
 * apportions belongs to whoever grabs it first.
 *
 * The cap above is deliberate and documented and it was not shared out, so a
 * host that did nothing at all could hold the whole of it. Measured against a
 * real listener with a paired caller:
 *
 *     baseline handshake:                OK
 *     with 16 silent sockets held:       REFUSED: peer closed the connection
 *     with 16 idle authed sockets held:  REFUSED, and still refused 11s later
 *
 * No key, no trust, not one byte sent — sixteen TCP connections and silence.
 * Every further connection is destroyed on arrival, a paired deck's included,
 * and re-dialling on a cycle shorter than HANDSHAKE_MS holds it there. Outbound
 * still works, so the shape of it is "this deck becomes unreachable" rather
 * than "sync stops" — but a deck nobody can reach is a deck that has stopped
 * healing logins for everyone pointed at it.
 *
 * FOUR RATHER THAN THE OBVIOUS TWO. One round plus one dial-back is two, and
 * two decks on ONE machine is a supported setup — it is how this gets tested,
 * and `reuseAddr` exists for it — so the honest ceiling from one address is
 * twice that. It still means no single host can take more than a quarter of the
 * table, which is the property that matters.
 */
export const MAX_SOCKETS_PER_HOST = 4;

/**
 * How long a socket may say nothing before it is dropped, at any point.
 *
 * HANDSHAKE_MS covers the part before `authed` and stops there: it is cleared
 * the moment a peer authenticates, and after that a socket had no deadline of
 * any kind — `live` shrank only on close or error. So a paired deck that
 * completed four handshakes and then went quiet held its whole share of the
 * table for as long as its process lived, which makes the budget a permanent
 * lease rather than a rate limit.
 *
 * A round is a request and a response. The caller's own per-frame bell is
 * ROUND_MS (10s) in lan-engine, and a `want` puts a claude-swap subprocess on
 * the far side between the two, so a legitimate gap can approach that. Thirty
 * seconds is three times the longest honest silence and half the gap between
 * rounds, and a round gets a fresh socket anyway — lan-engine destroys it in
 * its own `finally`.
 */
export const IDLE_MS = 30_000;

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
      // A HANDLER THAT THROWS ENDS ITS CONNECTION, NOT THE PROCESS. This runs
      // inside the socket's `data` event, where nothing above catches, so a
      // throw from a frame handler took the whole deck down — and every frame
      // read here has come off the network before anybody is trusted. The
      // handlers are meant never to throw; this is what holds when one does.
      // The error goes on with the refusal, so the next one that hides here is
      // logged with its stack rather than as two words.
      try { onFrame(msg); }
      catch (err) { dead = true; buf = ""; onRefuse("bad frame", err); return; }
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
 * handshake at all. On a sealed connection it is handed each frame already
 * opened, and `ctx.send` seals whatever it is given — see frameChannel.
 * `ctx.sealed` says which kind of connection it is on.
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
  /** Was this deck already told no? A refusal has to be sent rather than
   *  merely held, or the far end reads "declined" and "not answered yet" as one
   *  silent wait — they are the same frame otherwise, and only one of them ever
   *  comes right by waiting. */
  declined = () => false,
  /** Does this deck pair only by invite? Then a deck it has not met, holding no
   *  invite, is told so instead of "pending": nobody here will ever be shown a
   *  request to accept, and a caller left waiting on one waits for good. */
  inviteOnly = () => false,
  /** The invite this deck is currently offering, or null. A caller that proves
   *  it holds the code is somebody the owner handed a token to, so it is paired
   *  on arrival rather than queued behind a press. */
  invite = () => null,
  /** One was used. The caller stores the pairing and retires the invite: a
   *  token that pairs twice is a token worth stealing twice. */
  onInviteUsed,
  /** A connection arrived, before anything about it is known — called with the
   *  address it came from and nothing else.
   *
   *  THIS IS THE ONE MEASUREMENT OF INBOUND THERE IS. Everything else in this
   *  feature that asks "can other decks reach this one" reads a firewall's
   *  configuration and reasons about it, which is a guess wearing a verdict's
   *  clothes: `ufw` does not let an ordinary process read its rules at all. A
   *  socket that was accepted is proof the packets get in, and it costs one
   *  call at the one place every inbound connection already passes through.
   *
   *  Deliberately BEFORE the handshake: a caller that fails to prove itself
   *  still proved the path. Whether the address is this machine's own is the
   *  caller's to judge — see lan-engine, which holds that list. */
  onInbound,
  /** How long a socket may say nothing before it is dropped — see IDLE_MS,
   *  which is what the deck runs on. A parameter only so the suite can drive
   *  the reclaim in a few hundred milliseconds rather than half a minute; a
   *  case that slept for the real value would be thirty seconds of CI per run
   *  and would still only be checking a timer. */
  idleMs = IDLE_MS,
  /** Whether this deck seals every frame after the handshake with a peer that
   *  says it does too — see frameChannel. On in every real deck. False makes
   *  this listener announce nothing and seal nothing, which is the wire every
   *  deck before #810 speaks, and is how the suite plays one. */
  sealFrames = true,
  /** Whether this deck mixes a key pair made for each connection into its key,
   *  with a peer that says it does too — see sessionKey. On in every real
   *  deck. False makes this listener's challenge say only that it seals, which
   *  is the wire of a deck of #810's version, and is how the suite plays one.
   *  It rides on `sealFrames`, as it does on the wire. */
  ephemeral = true,
} = {}) {
  let server = null;
  let cancelStart = null;
  const live = new Set();

  /** Which host a socket came from, in one spelling. Node reports an IPv4 peer
   *  on a dual-stack listener as `::ffff:127.0.0.1`, and two spellings of one
   *  address would be two budgets. Empty for a socket already going away, which
   *  is why the count below only ever matches non-empty ones. */
  const from = sock => sock.remoteAddress?.replace(/^::ffff:/, "") ?? "";

  const onConnection = sock => {
    if (!secret || live.size >= MAX_SOCKETS) { sock.destroy(); return; }
    // AND NOT ALL OF IT TO ONE CALLER. The table is small on purpose; what was
    // missing is that it was not shared out, so the cheapest thing on the
    // network — connect, say nothing — took the whole of it. See
    // MAX_SOCKETS_PER_HOST.
    //
    // An address we cannot read is counted by the total alone rather than
    // lumped together with every other unreadable one: an accepted TCP socket
    // always has a peer, so an empty answer here is a socket already on its way
    // out, and treating those as one host would let a closing connection refuse
    // a real one.
    const here = from(sock);
    if (here) {
      let mine = 0;
      for (const s of live) if (from(s) === here) mine++;
      if (mine >= MAX_SOCKETS_PER_HOST) { sock.destroy(); return; }
    }
    live.add(sock);
    // Before the handshake and before the encoding: what this says is that a
    // packet from somewhere else reached this listener, which is true of a
    // connection that goes on to fail every check after it.
    if (here) { try { onInbound?.(here); } catch { /* a reader, never a gate */ } }
    sock.setEncoding("utf8");
    sock.setNoDelay(true);
    // ARMED HERE RATHER THAN AT `authed`, and that is the point of it: the
    // handshake deadline below is cleared the moment a peer authenticates, and
    // this is the one that is not. It is longer than HANDSHAKE_MS, so it never
    // decides the outcome of a handshake — it is what ends a socket that has
    // gone quiet afterwards, which nothing used to.
    sock.setTimeout(idleMs, () => sock.destroy());

    let authed = false;
    let peerFp = null;
    let peerPub = null;
    let peerName = "";
    let peerPort = null;
    // Whether the caller said it is NOT asking to pair — an invite-only deck
    // reaching an address it already had. See the unknown-deck branch below.
    let peerNoAsk = false;
    let key = null;
    // Carrying this deck's marks — that it seals, and that it mixes a key pair
    // of its own into the key — inside the one field the handshake already
    // binds. See "THE ANNOUNCEMENT RIDES INSIDE THE CHALLENGE" and EPHEMERAL
    // in lan-sync.mjs.
    const myChallenge = challengeFor({ seals: sealFrames, ephemeral });
    let theirChallenge = null;
    /** What the key was derived over, kept so the invite proofs below are made
     *  over the same string rather than rebuilt from its parts — which, once
     *  the ephemeral keys are in it, only the `hello` branch holds all of. */
    let transcript = null;
    /** The sealed channel, once the handshake is done and both challenges said
     *  so; null for a peer that did not, which is answered in the clear exactly
     *  as before. Set once and never changed. */
    let chan = null;
    /** Set by `refuse`, and read first by every frame after it. A refusal is the
     *  end of this socket, and nothing the peer sent in the same write may be
     *  read against whatever state the refusal left half-set. */
    let refused = false;
    /** Called at the moment `authed` turns true, so the first frame after `ok`
     *  in either direction is already the sealed kind. Both challenges are
     *  known by then, and the caller's proof has just said it saw the same two
     *  this end did. */
    const sealedChannel = () =>
      (sealsFrames(myChallenge) && sealsFrames(theirChallenge) ? frameChannel(key, "listener") : null);

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
    const refuse = (why, cause) => {
      refused = true;
      // The thrown error itself when frameReader caught one, so the terminal
      // shows what threw and where rather than only "bad frame".
      onError?.("frame", cause ?? new Error(why));
      const bye = () => { try { sock.destroy(); } catch { /* already gone */ } };
      // SEALED, A REFUSAL IS A CLOSE. Once both ends seal nothing leaves this
      // socket in the clear, not even a word about why — and a peer whose frame
      // would not open has nothing it could do with the word anyway.
      if (chan) { bye(); return; }
      try { sock.write(`${JSON.stringify({ t: "no", why })}\n`, bye); }
      catch { bye(); return; }
      setTimeout(bye, 250).unref?.();
    };

    /** Step 1 of the four, answered: a caller's hello, checked, and this
     *  end's challenge back — with the connection's key derived first. */
    const hello = msg => {
      // A string of letters, digits, `.`, `_` and `-` — a `|` inside it
      // would let the transcript come out the same on both ends while each
      // read a different challenge. See readChallenge.
      if (theirChallenge || !readChallenge(msg.challenge)) return refuse("bad hello");
      const them = readPub(msg.pub);
      // The fingerprint is a hash of the key, so a hello whose two halves
      // disagree is not a deck with a stale field, it is somebody trying to
      // be announced as one deck and prove they are another.
      if (!them || them.fp !== msg.fp) return refuse("bad hello");
      theirChallenge = msg.challenge;
      peerFp = them.fp;
      peerPub = them.pub;
      // THROUGH cleanName, like the beacon and the invite. This path — the
      // handshake — was the one that skipped it, and it is the one that
      // feeds the pairing prompt and cfg.trusted, which lan-deck.mjs writes to
      // prefs.json. So the only bound on the name an operator reads before
      // pressing Accept was the 128 KB frame cap.
      //
      // cleanName caps at MAX_NAME (40) and collapses \s+, which includes
      // U+00A0 — and 200 non-breaking spaces neither collapse in HTML nor
      // offer a break opportunity, so a name of "Alice's laptop at
      // 192.168.1.10 wants to pair" + padding pushed the REAL address out
      // of a fixed 288px column and left a complete, plausible sentence.
      peerName = cleanName(msg.name, "");
      peerPort = Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65_536 ? msg.port : null;
      peerNoAsk = msg.ask === false;
      // MIXED WHEN BOTH CHALLENGES SAY SO, and only then: the two strings
      // the proofs bind decide it, never whether a field turned up. Once
      // both say so, a hello with no usable key is refused rather than
      // answered the old way, because answering the old way is the
      // downgrade. See EPHEMERAL in lan-sync.mjs.
      //
      // A KEY OFFERED IS A KEY ANSWERED, whatever the challenges say, so
      // what this end sends depends only on what it was sent. When the two
      // do not mix, ours goes out and is never used. That happens only
      // between two decks of this version whose challenges somebody edited
      // on the way, and there it takes the dialler on to a proof this end
      // refuses by name — `bad proof`, as for every other edit to a
      // challenge — rather than stopping it one message short. Made here
      // and not when the socket opened, so a connection that never says
      // hello costs what it always did.
      const theirEphemeral = readEphemeral(msg.epk);
      const mixing = mixesEphemeral(myChallenge) && mixesEphemeral(theirChallenge);
      if (mixing && !theirEphemeral) return refuse("bad hello");
      let mine = theirEphemeral && mixesEphemeral(myChallenge) ? ephemeralPair() : null;
      const epk = mine?.pub;
      transcript = mixing
        ? handshakeTranscript(peerFp, fp, theirChallenge, myChallenge, theirEphemeral, epk)
        : handshakeTranscript(peerFp, fp, theirChallenge, myChallenge);
      // A key X25519 cannot use throws in here, and nothing above this
      // handler catches it — see readPub for what that throw used to do.
      try {
        key = sessionKey(secret, peerPub, transcript,
          mixing ? { role: "listener", priv: mine.priv, peer: theirEphemeral } : null);
      } catch {
        return refuse("bad hello");
      } finally {
        // The private half, let go before a byte of the reply is written.
        mine = null;
      }
      sendFrame(sock, { t: "challenge", fp, pub, name, challenge: myChallenge, ...(epk ? { epk } : {}) });
    };

    /**
     * Step 4, and the only way `authed` turns true: sealed from here when both
     * challenges said so, the handshake deadline off, and this deck's own proof
     * sent — with the invite's proof back when the caller held one. `ok` goes
     * out in the clear; the frames after it are the sealed kind.
     */
    const welcome = back => {
      authed = true;
      chan = sealedChannel();
      clearTimeout(deadline);
      sendFrame(sock, {
        t: "ok", fp, name,
        proof: proof(key, {
          challenge: myChallenge, peerChallenge: theirChallenge,
          fromFp: fp, toFp: peerFp, direction: "reply",
        }),
        ...back,
      });
    };

    /** Step 3: the caller's proof, and then who it turns out to be — a deck
     *  somebody here accepted, one holding this deck's invite, or a refusal
     *  that says which. */
    const auth = msg => {
      // A key, too: a challenge on record says a `hello` arrived, not that one
      // was accepted. Unreachable after the guard at the top of the frame
      // handler, and stated anyway, because it is the rule `proof` below
      // depends on.
      if (msg.t !== "auth" || !theirChallenge || !key) return refuse("expected auth");
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
      // AN INVITE THIS DECK HANDED OUT, PRESENTED BACK. Whoever is calling
      // holds a token the owner of this machine copied and sent, which is the
      // same decision the accept button is — made earlier, and made once.
      //
      // The proof is over the transcript, so it is worth nothing to somebody
      // who recorded an earlier exchange, and the code itself never travels.
      //
      // ASKED BEFORE "DO I KNOW THIS DECK", because the two questions are
      // independent and the answer to this one is owed to the caller either
      // way. A caller that sent a code is waiting to be shown one back, and a
      // deck it has ALREADY paired with is not exempt from that — somebody
      // pasting a token into a deck that happens to be paired already would
      // otherwise be told the minter does not hold its own invite.
      // `offer` rather than `live`, which is what this used to be called: the
      // socket table one scope out is also `live`, and widening this block
      // widened the shadow with it.
      const offer = invite();
      // Over the transcript the key came from — the ephemeral keys in it
      // when the two mix — which is the string the dialler proved over too.
      const heldInvite = !!offer && typeof msg.invite === "string"
        && proofOk(inviteProof(offer.code, transcript), msg.invite);
      // AND THE CODE, BACK. The session proof says "I hold the private half
      // of the key I just showed you", which anything with a socket can say.
      // This says "I am the deck whose owner minted that token", which only
      // the minter can — and a caller joining on an invite has no pin to
      // check against, so it is the only thing standing between an invite
      // address and whoever else is reachable there.
      const back = heldInvite ? { inviteProof: inviteProofBack(offer.code, transcript) } : {};
      if (!known) {
        if (heldInvite) {
          // So there is nothing to press: the deck is pinned here.
          onInviteUsed?.({ fp: peerFp, pub: peerPub, name: peerName, port: peerPort, addr: from(sock) });
          welcome(back);
          return;
        }
        // A DECK THIS ONE'S OWNER ALREADY ANSWERED, and the answer was no.
        // It is not asked again here, and — the half a held refusal cannot
        // do — the deck that asked is told, so its own panel can stop saying
        // "waiting" about a question that has been answered.
        if (declined(peerFp)) return refuse("declined");
        // AN INVITE-ONLY DECK, and this caller brought none (a caller that
        // did was paired above). Answered rather than queued: the engine
        // records no request in this mode, so "pending" would leave the other
        // deck's panel saying "waiting for them to say yes" about a question
        // nobody here will ever see. After "declined", which is the more
        // specific answer about this one deck.
        if (inviteOnly()) return refuse("invite only");
        // A CALLER THAT IS NOT ASKING. An invite-only deck still dials the
        // addresses it already had, because an invite-paired deck is one of
        // them; one that turns out not to know it must not become a request
        // here — with the accept switch on, that request would have pinned a
        // deck whose owner said it pairs only by invite.
        if (peerNoAsk) return refuse("not asking");

        // A REAL DECK WE HAVE NOT MET. It finished a handshake, so it is not
        // a port scan, and it told us a name and an address a person can
        // recognise. That is a row with an accept on it, and nothing else
        // happens until somebody presses it.
        onPending?.({
          fp: peerFp, pub: peerPub, name: peerName,
          addr: from(sock),
          // Where it LISTENS, from the hello — not this socket's remote port,
          // which is ephemeral. This is what lets an accept dial back.
          port: peerPort,
        });
        return refuse("pending");
      }

      // And ours, so the caller knows it reached the deck it pinned rather
      // than something standing in the way of one. Plus the invite, when one
      // was presented and held: a deck already on this list is not a reason
      // to leave a caller's question unanswered. Nothing is retired on this
      // path — nobody was paired, because they already were.
      welcome(back);
    };

    sock.on("data", frameReader(msg => {
      // NOTHING AFTER A REFUSAL. The reader hands over every frame in a chunk,
      // and `refuse` destroys the socket without stopping it. So a `hello`
      // refused after its challenge was stored and before a key existed could
      // be followed, in the same write, by an `auth` that reached `proof` with
      // no key: a throw in this handler, and the end of the process.
      if (refused) return;
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
        //
        // AND, FROM #1120, ONE KEY PAIR MORE AT EACH END, made for this
        // connection alone: the caller's public half rides in `hello` as
        // `epk`, ours in `challenge`. Public too, and in the clear too. What
        // they buy is a connection key that is gone once both ends have let go
        // of the private halves, whoever takes either long-term key later —
        // see sessionKey.
        if (msg.t === "hello") return hello(msg);
        return auth(msg);
      }
      // SEALED FROM HERE WHEN BOTH ENDS SAID SO, AND ONLY SEALED. A frame that
      // does not open is refused and the socket goes with it — see
      // frameChannel for what "does not open" covers: altered, replayed,
      // reordered, dropped, sent back, or simply plain. There is no reading it
      // as it stands instead; that fallback would be the downgrade.
      const frame = chan ? chan.unwrap(msg) : msg;
      if (!frame) return refuse("a sealed frame did not open");
      handlers?.(frame, {
        sock, peerFp, key, sealed: !!chan,
        // Where this deck dials the caller BACK. A deck that only ever calls in
        // is one this deck holds no address for, so it could receive nothing —
        // accounts move only toward the deck that dials (see roundWith). The
        // address the caller connected from, and the port it said it listens
        // on, are a dialable pair the engine can add so the next round reaches
        // it. `peerAddr` is the source of this very connection; `peerPort` came
        // from the hello, not the ephemeral source port.
        peerAddr: from(sock),
        peerPort,
        send: obj => sendFrame(sock, chan ? chan.wrap(obj) : obj),
      });
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
      const listener = net.createServer(onConnection);
      server = listener;
      let pending = true;
      const finish = (done, result) => {
        if (!pending) return;
        pending = false;
        if (cancelStart === cancel) cancelStart = null;
        done(result);
      };
      // A close before the listening callback otherwise leaves start() pending
      // forever. Null tells the engine that this startup was cancelled.
      let cancelled = false;
      const cancel = () => { cancelled = true; finish(resolve, null); };
      // A bind that lands after the cancel is closed by its own callback. With
      // a host, `listen` binds after a dns.lookup that current Node drops on
      // close(); a runtime that still binds would leave a listener nobody owns.
      const bound = () => {
        if (cancelled) { try { listener.close(); } catch { /* already closed */ } return; }
        finish(resolve, listener.address()?.port ?? null);
      };
      cancelStart = cancel;
      listener.on("error", err => {
        // A listener can also fail after its initial bind succeeded. Continue
        // reporting those errors while it is the active server.
        if (!pending) {
          if (server === listener) onError?.("listen", err);
          return;
        }
        if (!retried) {
          // Somebody else has it — another deck on this machine, or something
          // unrelated. The pin is not worth failing to start over.
          retried = true;
          onError?.("listen", err);
          try { listener.listen(0, host, bound); } catch { finish(reject, err); }
          return;
        }
        onError?.("listen", err);
        finish(reject, err);
      });
      try { listener.listen(wanted, host, bound); }
      catch (err) { finish(reject, err); }
    }),
    port: () => server?.address()?.port ?? null,
    stop() {
      cancelStart?.();
      for (const s of live) s.destroy();
      live.clear();
      try { server?.close(); } catch { /* not listening */ }
      server = null;
    },
  };
}

/**
 * What each refusal reason means, in a sentence the LAN panel can print.
 *
 * At module scope so it is one object rather than one per frame, and named so
 * the `Object.hasOwn` guard below reads as the rule it is rather than as
 * punctuation. The keys are the protocol's, not a user's.
 */
const REFUSALS = Object.freeze({
  pending: "waiting for the other deck to accept this one",
  declined: "that deck said no",
  "invite only": "that deck pairs only by invite",
  // Sent back to a caller that said it was not asking, so the far end's answer
  // is about the caller's own setting — the same words its own round uses.
  "not asking": "this deck pairs only by invite",
  impostor: "that deck has this one pinned under a different key",
  "bad proof": "the other deck refused this one's proof",
});

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
  /** False when this deck is reaching an address it already had WITHOUT asking
   *  to pair — an invite-only deck's round. Sent only when false, so every other
   *  hello is byte-for-byte what it was, and a deck that predates the field
   *  reads past it the way it reads past `epk`. */
  ask = true,
  /** The public key we pinned for this deck the first time, or null for a deck
   *  we are meeting — an address somebody typed. */
  expectPub = null,
  /** Whether the deck that minted `code` said it will prove it holds one too.
   *  From the token's own `pb`, which is the only way to tell a deck that will
   *  not from a deck that cannot — see mintInvite. False leaves this path
   *  exactly as it shipped, for a token minted by an older deck. */
  inviteProvesBack = false,
  /** Whether this deck seals every frame after the handshake with a deck that
   *  says it does too — see frameChannel. False announces nothing and seals
   *  nothing, exactly as every deck before #810 dials; only the suite asks. */
  sealFrames = true,
  /** Whether this deck mixes a key pair made for the connection into its key,
   *  with a deck that says it does too — see sessionKey. False dials exactly
   *  as a deck of #810's version does; only the suite asks. */
  ephemeral = true,
}) {
  return new Promise((resolve, reject) => {
    const myChallenge = challengeFor({ seals: sealFrames, ephemeral });
    // Made before the other deck is heard from, because the public half goes
    // in the hello. Let go of once the key is derived — unused, when the deck
    // that answers turns out not to mix — and on every way out below.
    let mine = mixesEphemeral(myChallenge) ? ephemeralPair() : null;
    const myEpk = mine?.pub;
    const sock = net.createConnection({ host, port });
    sock.setEncoding("utf8");
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      mine = null;
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
      // `epk` is this connection's key pair, offered: a deck from before #1120
      // reads past a field it does not know, and one of this version answers.
      sendFrame(sock, {
        t: "hello", fp, pub, name, port: myPort, challenge: myChallenge, ...(myEpk ? { epk: myEpk } : {}),
        ...(ask === false ? { ask: false } : {}),
      });
    });

    let theirChallenge = null;
    let theirFp = null;
    let theirPub = null;
    let key = null;
    /** What the key was derived over; the invite proofs are made over it too. */
    let transcript = null;

    /** Step 2, answered: the listener's challenge, checked against the pin,
     *  and this deck's proof back — with the connection's key derived first. */
    const challenge = msg => {
      if (theirFp || !readChallenge(msg.challenge)) return fail(new Error("bad challenge"));
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
      // Mixed when both challenges say so, as at the listener, and then the
      // listener's key is required: a deck of this version that says it
      // mixes and sends no key is not an older deck, it is a deck whose key
      // was taken out on the way. Refused, and never read the old way.
      const mixing = mixesEphemeral(myChallenge) && mixesEphemeral(theirChallenge);
      const theirEphemeral = mixing ? readEphemeral(msg.epk) : null;
      if (mixing && !theirEphemeral) return fail(new Error("bad challenge"));
      transcript = mixing
        ? handshakeTranscript(fp, theirFp, myChallenge, theirChallenge, myEpk, theirEphemeral)
        : handshakeTranscript(fp, theirFp, myChallenge, theirChallenge);
      try {
        key = sessionKey(secret, theirPub, transcript,
          mixing ? { role: "caller", priv: mine.priv, peer: theirEphemeral } : null);
      } catch {
        return fail(new Error("bad challenge"));
      } finally {
        // Used or not, the private half goes now.
        mine = null;
      }
      sendFrame(sock, {
        t: "auth",
        proof: proof(key, {
          challenge: myChallenge, peerChallenge: theirChallenge,
          fromFp: fp, toFp: theirFp, direction: "hello",
        }),
        // Only when joining on an invite. Sent in the same frame as the
        // session proof so a deck that holds a token is paired in one round
        // trip rather than being queued behind somebody else's press.
        ...(code ? { invite: inviteProof(code, transcript) } : {}),
      });
    };

    /** Step 4: the listener's own proof — and the invite's, when this deck is
     *  joining on one — and then the connection, handed to whoever dialled. */
    const ok = msg => {
      // The same deck that gave us the challenge, or nothing: a reply naming a
      // different fingerprint is a second party in the middle of this.
      //
      // AND A CHALLENGE FIRST. `theirFp` is null until one is accepted, so an
      // `ok` sent as the very first frame with `fp: null` matched it — null is
      // null — and walked into `proof` with no key, which throws. Before #1146
      // that throw ended the deck, and this end dials whatever address a beacon
      // announces; since #1146 the reader catches it as "bad frame". Neither is
      // the answer: an `ok` before a challenge is out of order, and says so.
      if (msg.t !== "ok" || !theirFp || !key || msg.fp !== theirFp) return fail(new Error("expected ok"));
      const want = proof(key, {
        challenge: theirChallenge, peerChallenge: myChallenge,
        fromFp: theirFp, toFp: fp, direction: "reply",
      });
      if (!proofOk(want, msg.proof)) return fail(new Error("that deck could not prove its own key"));
      // AND THAT IT IS THE DECK THE INVITE NAMED. The proof above is about a
      // key the responder chose a moment ago; this one is about a code it had
      // to have been given. `join` has no pin to pass, so `expectPub` above is
      // null on this path and this is the only check that distinguishes the
      // deck whose owner minted the token from whatever else is reachable at
      // one of the ten addresses the token happens to carry.
      //
      // The caller giving up here is not the end of the attempt: `join` walks
      // the rest of the list, so a deck answering at a stale or borrowed
      // address costs one failed address instead of winning the whole token.
      if (code && inviteProvesBack) {
        const back = inviteProofBack(code, transcript);
        if (!proofOk(back, msg.inviteProof)) {
          return fail(new Error("that deck does not hold the invite"));
        }
      }
      // Sealed from here when both challenges said so. The listener decided
      // the same at the same moment from the same two strings, and the proof
      // just checked is what says it saw the same two. See frameChannel.
      const chan = sealsFrames(myChallenge) && sealsFrames(theirChallenge) ? frameChannel(key, "caller") : null;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners("close");
      resolve({
        sock, key, sealed: !!chan,
        peerFp: theirFp, peerPub: theirPub, peerName: cleanName(msg.name, ""),
        send: obj => sendFrame(sock, chan ? chan.wrap(obj) : obj),
        /** What a frame from the other end says — or null on a sealed
         *  connection when it does not open, which ends the connection: every
         *  frame after it would fail too. On a connection to a deck from before
         *  #810, a plain frame passes through as it arrived. */
        read: frame => (chan ? chan.unwrap(frame) : frame),
      });
    };

    sock.on("data", frameReader(msg => {
      if (settled) return;
      // A deck that heard us and said no. Each reason is a different problem
      // with a different fix, and until this frame existed they were all one
      // silent close that read as a firewall. See REFUSALS.
      if (msg.t === "no") {
        // `Object.hasOwn`, and here more than anywhere: `msg.why` is a field in
        // a frame written by the OTHER MACHINE, which is the case admin-failure
        // states the rule for (#474). Every member of Object.prototype answers
        // a plain bracket read with an inherited value that is neither nullish
        // nor falsy, so `?? "the other deck refused this handshake"` never
        // fired for one — `{...}["constructor"]` is the Object function itself,
        // and `new Error(Object).message` is the string "function Object() {
        // [native code] }". lan-engine files that as `lastRound.error` and the
        // LAN panel prints it verbatim, so a peer chose what appeared in the
        // user's interface. Asking whether the map has a ROW is the question
        // this read was always trying to ask; no real reason moves.
        return fail(new Error(Object.hasOwn(REFUSALS, msg.why) ? REFUSALS[msg.why]
          : "the other deck refused this handshake"));
      }
      if (msg.t === "challenge") return challenge(msg);
      return ok(msg);
    // A refusal from the reader, with the thrown error as its cause when there
    // was one: the message is the one it always was, and whatever logs the
    // rejection can reach what actually threw.
    }, (why, cause) => fail(cause ? new Error(why, { cause }) : new Error(why))));
  });
}
