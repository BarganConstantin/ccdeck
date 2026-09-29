// The calling half: dial a deck, prove this one, check that deck's proof back,
// and hand over the connection — with the sentence each refusal from the far
// end is read as. Lifted out of lan-socket.mjs, which re-exports it; the
// answering half stays there, and the line both halves speak is lan-lines.mjs's.
import net from "node:net";
import { cleanName } from "./lan-sync.mjs";
import {
  challengeFor, ephemeralPair, frameChannel, handshakeTranscript, mixesEphemeral, proof, proofOk, readChallenge,
  readEphemeral, readPub, sealsFrames, sessionKey,
} from "./lan-wire.mjs";
import { inviteProof, inviteProofBack } from "./lan-invite.mjs";
import { frameReader, sendFrame, HANDSHAKE_MS } from "./lan-lines.mjs";

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
  "wrong invite": "that deck did not take this invite — ask them for a new one",
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
        // The challenge the far end made for this connection, so a deck that
        // reached its own key can ask its own listener whether it made it —
        // see `issued` in lan-socket.mjs.
        peerChallenge: theirChallenge,
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
