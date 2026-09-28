// What two decks say to each other once one has dialled the other: the key
// each deck is known by and the fingerprint it goes by, the key two decks agree
// for one connection, the proofs made over it, and the seal on a login, on a
// card and on every frame after the handshake. And PROTOCOL, the wire's
// version, which every key, proof and seal here is derived under. Moved out of
// lan-sync.mjs, which re-exports all of it; the beacon there takes PROTOCOL
// from here, because this file cannot import from the one that re-exports it.
// Like everything there it is pure — no sockets, no timers, no filesystem —
// and why it is built on node:crypto alone is in that file's header.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey,
  createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** The wire format. Bumped when a field changes meaning, never when one is
 *  added — a reader that does not know a field ignores it, which is what makes
 *  a deck a version behind still discoverable. */
export const PROTOCOL = 2;

// ── identity ────────────────────────────────────────────────────────────────

/**
 * What a deck calls itself on the wire, given its long-term public key.
 *
 * A hash of the key rather than the key: it is short enough to read out over a
 * phone, it is stable across restarts, and — the part that matters — it is the
 * only identity claim in a beacon that cannot be forged, because a deck that
 * cannot do the handshake cannot use somebody else's fingerprint for anything.
 *
 * Twelve hex characters, in threes. 48 bits is far past what an accident
 * reaches on one network, and a person can compare four groups at a glance
 * where they cannot compare sixty-four characters. Syncthing and LocalSend both
 * make the same trade at a similar length.
 */
export function fingerprint(publicKeyRaw) {
  const hex = createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 12);
  return hex.replace(/(.{3})(?=.)/g, "$1-");
}

// ── this deck's own key ─────────────────────────────────────────────────────

/**
 * A deck's own long-term identity.
 *
 * X25519, because the only thing it is ever used for is agreeing a session key
 * with a peer — never a signature — and node has it built in. The private half
 * lives in prefs.json, which is written 0600 for exactly this reason; the
 * public half is what a peer pins, and its fingerprint is what a person
 * compares.
 */
function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    secret: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/**
 * The keypair on disk, or a fresh one when there is none or it is unusable.
 *
 * A corrupt secret is not an error anybody can act on mid-session, and refusing
 * to start would take the whole feature away over one bad string — so it is
 * replaced. The cost of replacing it is stated rather than hidden: this deck
 * gets a new fingerprint, so every peer that had pinned the old one sees a
 * stranger and asks its owner to accept again.
 */
export function identityFrom(secret) {
  if (typeof secret === "string" && secret !== "") {
    try {
      const priv = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" });
      const pub = createPublicKey(priv).export({ type: "spki", format: "der" });
      return { secret, pub: pub.toString("base64"), fp: fingerprint(pub), fresh: false };
    } catch { /* unusable; fall through and make one */ }
  }
  const made = newKeypair();
  return { ...made, fp: fingerprint(Buffer.from(made.pub, "base64")), fresh: true };
}

/**
 * The key two decks use for one connection, and for nothing else.
 *
 * X25519 to a shared secret, then HKDF over the transcript — both fingerprints
 * and both challenges, in a fixed order — so the key is bound to THIS exchange.
 * A recording of an old one derives a different key and proves nothing.
 *
 * PER CONNECTION, never stored. The old design sealed credentials under one
 * long-lived group key, which meant a single recorded transfer stayed readable
 * to anybody who ever learned the passphrase.
 *
 * AND FORWARD-SECRET BETWEEN TWO DECKS THAT BOTH SAY SO, which until #1120 no
 * connection was. Without `ephemeral` this is the key every deck derived
 * before: X25519 between the two decks' LONG-TERM keys, over a transcript
 * whose every field crossed the network in the clear. So whoever recorded a
 * connection and later took either deck's private key — a 0600 file, and also
 * a file that rides along in backups and in a `~/.claude` somebody copied —
 * could derive that connection's key and open all of it: every frame after the
 * handshake, the version card, and each credential a `have` carried, logins
 * since rotated or removed included, and the other deck's half of the
 * conversation with them.
 *
 * With `ephemeral`, each end also brings a key pair made for this connection
 * alone (ephemeralPair), and the key is HKDF over four X25519 results rather
 * than one. Which four is Noise's KK pattern (noiseprotocol.org/noise.html
 * §7.5): both static keys known in advance, `-> e, es, ss` and `<- e, ee, se`.
 * How they are combined is Signal's X3DH (§2.2, §3.3): concatenated in a fixed
 * order, each a fixed 32 bytes so no two orderings read alike, into one HKDF —
 * without X3DH's run of 0xFF bytes in front, which it needs only because its
 * keys also sign, and a deck's never do. HKDF's info is the transcript, the
 * way TLS 1.3 derives every secret over the transcript of the handshake that
 * made it (RFC 8446 §7.1).
 *
 *   ss  static × static — the one term there was, and still what makes the key
 *       need a long-term key at all: whoever held both ephemeral halves and
 *       neither static key would have ee, es and se, and not this.
 *   ee  ephemeral × ephemeral — the forward secrecy, which is #1120. Neither
 *       deck keeps its half past this call (see lan-socket.mjs), so once a
 *       connection is over, no key anybody still holds — both long-term keys
 *       included — recomputes this one.
 *   es  the dialler's ephemeral × the answerer's static key, and
 *   se  the dialler's static key × the answerer's ephemeral. Neither adds
 *       forward secrecy; each stops a stolen key being worn as SOMEBODY ELSE,
 *       which ss cannot. Whoever holds B's private key computes DH(b, A) just
 *       as A does, so with ss and ee alone they could dial B as A — or as any
 *       deck B has paired — and B would prove itself to them and hand over
 *       every login it shares. With se they need A's key or B's ephemeral as
 *       well, and hold neither. es is the same guard the other way round, for
 *       a deck whose own key is stolen and which dials out. Noise calls it
 *       resistance to key-compromise impersonation (§7.7, source property 2).
 *
 * `role` says which end this is — "caller" for the deck that dialled — because
 * each end computes es and se from different halves and both must land in the
 * same place. Named by who dialled and never by fingerprint, for frameKeys'
 * reason: a copied ~/.claude gives both ends one fingerprint.
 *
 * Its own label in the info string, so a key from this schedule and one from
 * the other are never the same key, whatever two transcripts look like. The
 * four results are zeroed as soon as HKDF has read them; the ephemeral private
 * half never leaves the KeyObject it was made in, and nothing writes it
 * anywhere. That is all the forgetting a JavaScript process can promise, and
 * it is what forward secrecy asks of it: nothing of the ephemeral side left to
 * find once the connection is gone.
 *
 * THROWS on a key X25519 cannot use: a type other than X25519, which readPub
 * now refuses before this, or one of the few low-order points, whose shared
 * secret is all zeros (RFC 7748 §6.1) and which OpenSSL refuses rather than
 * returns. The socket layer refuses the handshake when it does.
 */
export function sessionKey(secret, peerPub, transcript, ephemeral = null) {
  const priv = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" });
  const theirs = createPublicKey({ key: Buffer.from(peerPub, "base64"), format: "der", type: "spki" });
  if (!ephemeral) {
    const shared = diffieHellman({ privateKey: priv, publicKey: theirs });
    return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0),
      Buffer.from(`ccdeck-lan-v${PROTOCOL}|${transcript}`, "utf8"), 32));
  }
  const { role, priv: mine, peer } = ephemeral;
  if (role !== "caller" && role !== "listener") throw new Error(`no such end: ${role}`);
  const theirsNow = createPublicKey({ key: Buffer.from(peer, "base64"), format: "der", type: "spki" });
  const made = [];
  const dh = (privateKey, publicKey) => {
    const out = diffieHellman({ privateKey, publicKey });
    made.push(out);
    return out;
  };
  try {
    const ss = dh(priv, theirs);
    const ee = dh(mine, theirsNow);
    const mineWithTheirStatic = dh(mine, theirs);
    const staticWithTheirs = dh(priv, theirsNow);
    const [es, se] = role === "caller"
      ? [mineWithTheirStatic, staticWithTheirs]
      : [staticWithTheirs, mineWithTheirStatic];
    const ikm = Buffer.concat([ss, ee, es, se]);
    made.push(ikm);
    return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0),
      Buffer.from(`ccdeck-lan-v${PROTOCOL}|${EPHEMERAL}|${transcript}`, "utf8"), 32));
  } finally {
    for (const b of made) b.fill(0);
  }
}

/**
 * The string both sides bind their session key to.
 *
 * One definition, used by the caller and the listener, because a transcript the
 * two build differently is a handshake that never agrees and a bug that only
 * appears between two machines. Caller first, always, so the order does not
 * depend on which end is asking.
 *
 * BOTH EPHEMERAL KEYS TOO, when the two decks mix them (#1120), as they
 * arrived. Not only inside ee: this string is HKDF's info in sessionKey, and
 * each proof is an HMAC under the key that comes out, so the proofs the static
 * keys make cover these two strings by name. A middleman who swaps either key
 * for one of their own has changed what one end proves over, and that end's
 * proof fails at the other whatever the arithmetic would have done. Noise
 * mixes every public key it sends into its handshake hash for the same reason
 * (§5.3). Base64 has no `|`, and readEphemeral takes a key only in the one
 * spelling its bytes encode to, so no field can spill into the next.
 *
 * Given at all, both are written. One missing prints as `undefined` and
 * matches nothing at the other end; it does not fall back to the four-field
 * string, because a transcript that quietly dropped a key is the downgrade this
 * is here to refuse.
 */
export function handshakeTranscript(callerFp, listenerFp, callerChallenge, listenerChallenge,
  callerEphemeral, listenerEphemeral) {
  const fixed = `${callerFp}|${listenerFp}|${callerChallenge}|${listenerChallenge}`;
  return callerEphemeral === undefined && listenerEphemeral === undefined
    ? fixed
    : `${fixed}|${callerEphemeral}|${listenerEphemeral}`;
}

/**
 * A public key somebody sent, or null.
 *
 * It arrives from the network before anything has been agreed, so it is checked
 * for being an X25519 public key at all rather than trusted to be one — a
 * string that is not gets a refusal here instead of a throw three frames later.
 *
 * AN X25519 KEY, NOT MERELY A KEY, and until #1120 it only checked the second.
 * Any SPKI parsed, so an Ed25519 or a P-256 key came through as a deck's
 * public key, and the throw this promised to prevent happened one line later,
 * in sessionKey: `Incompatible key types for Diffie-Hellman`, inside the
 * listener's `data` handler, before anybody was trusted. Nothing catches a
 * throw there. Measured on Node 24 with a listener in a process of its own:
 * one `hello` carrying an Ed25519 key, and the process exited with code 1.
 * No deck has ever sent anything but X25519 (newKeypair), so no deck is
 * refused by this.
 */
export function readPub(raw) {
  const der = x25519(raw);
  return der ? { pub: raw, fp: fingerprint(der) } : null;
}

/**
 * An ephemeral public key somebody sent, or null: checked exactly as readPub
 * checks a static one, and then held to one spelling.
 *
 * The spelling matters here and not for a static key, which only ever reaches
 * the transcript as its fingerprint. This string goes in as it arrived, among
 * fields joined by `|` with no lengths, and base64 decoding skips what it does
 * not understand, `|` included — so a key that decoded to the right bytes
 * could still carry a separator. Only the exact text those bytes encode to is
 * taken.
 */
export function readEphemeral(raw) {
  const der = x25519(raw);
  return der && der.toString("base64") === raw ? raw : null;
}

/** The DER of an X25519 public key, from the base64 a deck sends, or null. */
function x25519(raw) {
  if (typeof raw !== "string" || raw.length < 40 || raw.length > 128) return null;
  try {
    const der = Buffer.from(raw, "base64");
    return createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType === "x25519" ? der : null;
  } catch { return null; }
}

/**
 * A key pair for one connection and no other (#1120).
 *
 * The private half stays the KeyObject it was made as — never exported, never
 * a string, which JavaScript could not wipe — and the end that made it lets go
 * of it the moment sessionKey has used it. The public half is what travels, as
 * the same base64 SPKI a static key travels as.
 */
export function ephemeralPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { priv: privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

// ── the handshake ───────────────────────────────────────────────────────────

/**
 * The proof a deck offers to show it holds the private half of the key it
 * announced — the key a paired deck pinned for it.
 *
 * Challenge-response over the derived key rather than sending anything derived
 * from that private key directly, so a recording of one exchange is worth
 * nothing for the next: the challenge is fresh random from the side being
 * convinced.
 *
 * BOTH SIDES PROVE. The obvious version has the caller prove itself to the
 * listener, which stops a stranger reading a manifest and stops nothing else —
 * a stranger can still stand up a listener, wait for a real deck to connect,
 * and be handed one. So the response covers a challenge from each side and the
 * initiator checks the answer with the same care.
 *
 * The transcript is in the MAC, not just the challenges. Without it the same
 * proof is valid on a different port, for a different peer, in a different
 * direction — three distinct ways for a recording to be replayed somewhere it
 * was not made.
 */
export function proof(key, { challenge, peerChallenge, fromFp, toFp, direction }) {
  return createHmac("sha256", key)
    .update(`ccdeck-lan-v${PROTOCOL}|${direction}|${fromFp}|${toFp}|${challenge}|${peerChallenge}`)
    .digest("hex");
}

/** Whether a proof is the one expected, compared in constant time so how much
 *  of a guess matched is not something a caller can time. Length-checked first
 *  because timingSafeEqual throws on a mismatch, and a throw here is a crash
 *  rather than a refusal. */
export function proofOk(expected, offered) {
  if (typeof offered !== "string" || offered.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(offered, "utf8"));
}

/**
 * A fresh challenge for the sensitive operation, separate from the session.
 *
 * LocalSend's lesson, and the reason this exists rather than the transfer
 * riding on the handshake: a session proves who connected, at the moment they
 * connected. A credential leaving the machine is a different question, asked
 * later, sometimes much later — a long-lived connection that was authenticated
 * an hour ago is not a statement about now. So the transfer carries its own
 * round trip, over the same key, naming the account being asked for.
 */
export function transferChallenge(key, { nonce, accountKey, fromFp, toFp }) {
  return createHmac("sha256", key)
    .update(`ccdeck-lan-transfer-v${PROTOCOL}|${fromFp}|${toFp}|${accountKey}|${nonce}`)
    .digest("hex");
}

// ── the payload ─────────────────────────────────────────────────────────────

/**
 * Seal something so only the deck on the other end of one connection can read
 * it — a login, a card, and through frameChannel every frame.
 *
 * AES-256-GCM under a key that connection derived, with a random 12-byte
 * nonce. It sealed under one long-lived group key once, and sessionKey's note
 * says why that stopped.
 *
 * The additional data binds the ciphertext to the two decks and the account, so
 * a blob captured on one exchange cannot be replayed into another as if it were
 * about something else.
 *
 * `iv` IS RANDOM UNLESS THE CALLER OWNS A COUNTER, and exactly one does. A
 * random 96-bit nonce is safe for the handful of seals a connection makes this
 * way; frameChannel seals every frame of a connection and derives each nonce
 * from the frame's number instead, so that a repeat is impossible rather than
 * unlikely and a frame's place in the conversation is part of what its tag
 * proves. Nothing else passes one.
 */
export function seal(key, plaintext, aad, iv = randomBytes(12)) {
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), body: body.toString("base64") };
}

/** The other half. Returns null rather than throwing on every failure — a
 *  wrong tag, a wrong key, a truncated body and a hand-built packet all mean
 *  the same thing to the caller, which is "do not use this".
 *
 *  THE TAG IS ALL SIXTEEN BYTES OR NOTHING. Without `authTagLength` node takes
 *  whatever length `setAuthTag` is handed, down to four bytes — measured on
 *  Node 24: a tag cut to its first four bytes opened, with nothing but a
 *  DEP0182 warning on stderr to say so. A 32-bit tag is one forgery in four
 *  billion tries instead of none, on the value that decides whether a frame or
 *  a credential is genuine. `seal` has only ever written sixteen, so no deck of
 *  any version is refused by this. */
export function open(key, { iv, tag, body }, aad) {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The additional data a credential is sealed under: which deck it leaves,
 * which deck it is for, and which account it is — the binding `seal` above
 * describes, as the one string both ends must build alike. The deck answering
 * a `want` seals under it and the deck that asked opens under it, so a
 * difference between the two is not an error anywhere: it is a login that
 * never opens, reported as "could not open" about a peer that did nothing
 * wrong.
 */
export function credentialAad(fromFp, toFp, key) {
  return `${fromFp}->${toFp}|${key}`;
}

// ── the frames after the handshake ──────────────────────────────────────────
//
// SEALED, EVERY ONE, AND UNTIL #810 NONE OF THEM WAS. The handshake proves both
// keys and derives one for the connection, and that key sealed exactly two
// things: the credential inside `have`, and the version card. Everything else
// was a JSON line on a TCP socket. Captured through a relay on loopback between
// two engines of the version before this, the round that healed one account
// and added another read, after `ok`:
//
//   {"t":"manifest","accounts":[{"key":"claude1@sapec.md@@org-1","email":"claude1@sapec.md","alive":true},…],"current":{"key":"claude1@sapec.md@@org-1"}}
//   {"t":"want","key":"claude2@sapec.md@@org-2","nonce":"…","proof":"…"}
//   {"t":"have","key":"claude2@sapec.md@@org-2","sealed":{…}}
//
// So anybody on the same network segment could read every address a deck
// shares, which of its copies are broken, which one the machine is on, and
// which one is being repaired. No credential left that way and nobody could
// pose as a deck; what leaked was which accounts are on which machines, which
// is the one thing the share list promises to tell nobody else. And it was not
// only readable: nothing after `ok` carried a MAC, so a manifest could be
// rewritten in flight and the panel would draw whatever it was handed.
//
// ONE KEY PER DIRECTION, AND A COUNTER FOR A NONCE. Both ends start from the
// same session key, so a single frame key would have both of them sealing frame
// 0, frame 1, … under one key — and AES-GCM under a repeated nonce hands over
// the XOR of the two plaintexts and the means to forge. So each direction gets
// its own key and its own IV out of HKDF, the way sessionKey gets its own, and
// the labels name the direction by ROLE rather than by fingerprint: two decks
// holding one key (a copied ~/.claude) have one fingerprint between them, and a
// label built from it would be the same label twice. The nonce is the IV XORed
// with the frame's number, which is TLS 1.3's per-record nonce (RFC 8446 §5.3)
// over its per-direction write key and write IV (§7.3).
//
// THE NUMBER IS NEVER SENT. Each end counts what it has sealed and what it has
// opened, and opens the next frame under the number it expects next. A frame
// played twice, two frames swapped, one dropped from the middle, one lifted
// from another connection, or one sent back to the deck that sealed it — each
// is opened under the wrong number or the wrong key, its tag does not match,
// and the connection ends. There is no second try: a channel that has refused
// one frame refuses every one after it, and the socket goes with it.
//
// THE ANNOUNCEMENT RIDES INSIDE THE CHALLENGE, and that is the whole defence
// against being talked back down to plain text. An older deck has to keep
// working, so a peer that says nothing about sealing is answered in the clear —
// which makes "says nothing" exactly what a middleman would try to arrange. A
// flag of its own in `hello` or `challenge` is a flag nobody signs: the proofs
// cover the two fingerprints and the two challenges and nothing else, and an
// older deck will never cover more. Delete the flag both ways and each end sees
// a peer older than it is. Fold the flag into a new kind of proof and each end
// falls back to the old kind for the peer it now believes is old — the same
// round, readable, with nothing on either side to say so.
//
// The challenge is the one field every deck already binds. It goes verbatim
// into the transcript sessionKey derives from, and into both proofs. So a deck
// of this version marks its own (`<32 hex>.seal1`), an older deck carries that
// as the opaque string it always took, and a middleman who takes the mark off
// either challenge leaves the two ends deriving different keys: the caller's
// proof fails at the listener and the handshake ends before a frame is sent.
// TLS 1.3 puts its downgrade sentinel in ServerHello.random for the same reason
// (RFC 8446 §4.1.3) — it is the field the older handshake already covers.
//
// WHICH IS WHY A `|` IN A CHALLENGE IS REFUSED. The transcript joins its four
// fields with `|` and no lengths, so a middleman who could put one inside a
// challenge could move characters from one challenge into the other and leave
// both ends agreeing on the transcript, and so on the key, while each read a
// different challenge from its peer than the one that peer sent. Every deck
// sends hex, so a deck of this version takes letters, digits, `.`, `_` and `-`
// and refuses anything else before it derives a key from it.
//
// WHAT IT DOES NOT HIDE: how long each frame is and when it was sent — a
// manifest of ten accounts is longer than one of two. And it is exactly as
// strong as the session key it starts from; see sessionKey for what that is.

/** What a deck of this version appends to its challenge to say it seals every
 *  frame after the handshake. A word with a number rather than a bit, so a
 *  later frame format is a new word an older deck simply does not recognise. */
export const SEALS = "seal1";

/**
 * What a deck of this version ends the random part of its challenge with, to
 * say it mixes a key pair made for the connection into the connection's key
 * (#1120; see sessionKey): the four bytes of "eph1" in ASCII, which in the hex
 * a challenge is written in is `65706831`.
 *
 * IN THE CHALLENGE FOR THE REASON `.seal1` IS, and stripped it fails the same
 * way. Mixing needs a new field — each end's ephemeral public key, `epk` — and
 * an older deck binds nothing but the fingerprints and the two challenges. So
 * a deck that took "no `epk`" to mean "an older peer" would be taken back to a
 * key with no forward secrecy by anybody who deleted the field both ways, with
 * both proofs still good. The mark goes where both proofs already reach: each
 * end decides from the two challenges, each end's own challenge is the one it
 * binds, and a middleman who takes the mark off either leaves the two ends on
 * different transcripts — and on different schedules — so the dialler's proof
 * fails at the listener before a frame is sent. And once both challenges say
 * so, a missing or unusable `epk` is refused, never read as an older deck.
 *
 * IN THE RANDOM PART RATHER THAN AS A WORD, which is TLS 1.3's own answer to
 * the same problem: its downgrade sentinel is a fixed value in the last bytes
 * of ServerHello.random (RFC 8446 §4.1.3), a field the older handshake already
 * covers and reads as nothing but random. Here that keeps a challenge the
 * shape #810 gave it — 32 hex characters and `.seal1` — which #810's decks
 * send too and its suite pins. It costs 32 of the 128 random bits, and 96 is
 * still no challenge anybody sees twice. And a deck from #810 whose sixteen
 * random bytes happen to end in these four, one handshake in 2^32, reads as a
 * deck that mixes and sent no key: that round is refused rather than
 * downgraded, and the next one has a new challenge.
 */
export const EPHEMERAL = "eph1";
const EPHEMERAL_HEX = Buffer.from(EPHEMERAL, "ascii").toString("hex");
const MIXES = new RegExp(`^[0-9a-f]{24}${EPHEMERAL_HEX}\\.`);

/** Letters, digits, `.`, `_` and `-`, bounded. Ours are 38 characters and an
 *  older deck's are 32; the bound is only there so a challenge is never the
 *  largest thing a stranger can make this hash. */
const CHALLENGE = /^[0-9A-Za-z._-]{1,128}$/;

/** This deck's challenge for one connection: twelve fresh random bytes and the
 *  four that say it mixes, then the mark that says it seals. A deck speaking as
 *  one of #810's version sends sixteen random bytes and the mark, and one from
 *  before #810 sixteen random bytes and nothing, which is how the suite plays
 *  each. Mixing rides on sealing: no deck was ever released that did one
 *  without the other, so `seals: false` says neither. */
export function challengeFor({ seals = true, ephemeral = seals } = {}) {
  if (!seals) return randomBytes(16).toString("hex");
  const nonce = ephemeral
    ? `${randomBytes(12).toString("hex")}${EPHEMERAL_HEX}`
    : randomBytes(16).toString("hex");
  return `${nonce}.${SEALS}`;
}

/** A challenge a peer sent, or null for one no deck sends — see "WHICH IS WHY
 *  A `|` IN A CHALLENGE IS REFUSED" above. */
export function readChallenge(raw) {
  return typeof raw === "string" && CHALLENGE.test(raw) ? raw : null;
}

/** Whether the deck that made this challenge said it seals. */
export function sealsFrames(challenge) {
  return typeof challenge === "string" && challenge.endsWith(`.${SEALS}`);
}

/** Whether the deck that made this challenge said it mixes a key pair of its
 *  own into the connection's key — see EPHEMERAL. Only in a challenge that
 *  says it seals as well, so a deck from before #810, whose challenge is
 *  sixteen random bytes and nothing else, can never be taken for one. */
export function mixesEphemeral(challenge) {
  return sealsFrames(challenge) && MIXES.test(challenge);
}

/** Which way a frame is going, named by who dialled — never by fingerprint,
 *  for the reason above. */
const WAY = Object.freeze({ caller: "caller->listener", listener: "listener->caller" });

/**
 * The key and IV each end seals its own frames with, from one connection's
 * session key.
 *
 * HKDF like sessionKey, one label per direction and per purpose: `key` and `iv`
 * are separate expansions rather than one long one cut in two, the way RFC 8446
 * §7.3 takes a write key and a write IV from one traffic secret.
 */
export function frameKeys(key) {
  const derive = (way, what, length) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0),
    Buffer.from(`ccdeck-lan-v${PROTOCOL}|frames|${way}|${what}`, "utf8"), length));
  const one = way => ({ way, key: derive(way, "key", 32), iv: derive(way, "iv", 12) });
  return { caller: one(WAY.caller), listener: one(WAY.listener) };
}

/** Frame n's nonce: its direction's IV, XORed with n as a 64-bit big-endian
 *  number in the last eight bytes (RFC 8446 §5.3). */
function frameNonce(iv, n) {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(n), 4);
  for (let i = 0; i < out.length; i++) out[i] ^= iv[i];
  return out;
}

/**
 * One end of a sealed connection: wrap what this end sends, unwrap what the
 * other end sent — in order, once each.
 *
 * `role` is which end this is: "caller" for the deck that dialled, "listener"
 * for the deck that answered. Each end seals under its own direction's key and
 * opens under the other's, so a frame only ever opens at the deck it was sealed
 * for.
 *
 * On the wire a frame is `{ sealed, tag }` and nothing else — not the verb, not
 * the number, not the nonce. The number is the one each end already expects,
 * and a frame that is not the one expected, or that carries anything beside
 * those two fields, does not open.
 */
export function frameChannel(key, role) {
  if (role !== "caller" && role !== "listener") throw new Error(`no such end: ${role}`);
  const keys = frameKeys(key);
  const out = keys[role];
  const inn = keys[role === "caller" ? "listener" : "caller"];
  let sent = 0;
  let opened = 0;
  let broken = false;
  // The number goes in the additional data as well as the nonce. The nonce
  // alone binds it; this says so in the one place a reader looks for what a
  // tag covers, and it survives anybody changing how the nonce is built.
  const aad = (way, n) => `ccdeck-lan-v${PROTOCOL}|frame|${way}|${n}`;
  return {
    wrap(obj) {
      // 2^53 frames is not a connection anybody holds open — a round is a
      // handful — but a counter that wrapped would be a nonce used twice, and
      // refusing is cheaper than arguing about it.
      if (!Number.isSafeInteger(sent + 1)) throw new Error("this connection has sealed all it may");
      const n = sent++;
      const { tag, body } = seal(out.key, JSON.stringify(obj), aad(out.way, n), frameNonce(out.iv, n));
      return { sealed: body, tag };
    },
    unwrap(frame) {
      if (broken) return null;
      const shaped = !!frame && typeof frame === "object" && !Array.isArray(frame)
        && Object.keys(frame).length === 2 && typeof frame.sealed === "string" && typeof frame.tag === "string";
      const text = shaped
        ? open(inn.key, { iv: frameNonce(inn.iv, opened).toString("base64"), tag: frame.tag, body: frame.sealed },
          aad(inn.way, opened))
        : null;
      let msg = null;
      if (text != null) { try { msg = JSON.parse(text); } catch { msg = null; } }
      // A record, which is what frameReader asks of a plain frame: a sealed
      // array is no more a frame than an unsealed one.
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { broken = true; return null; }
      opened++;
      return msg;
    },
  };
}
