// The rules for finding other decks on this network and agreeing who is in the
// group. No sockets, no timers, no filesystem — those live in lan-socket.mjs,
// and everything here is a pure function so the suite can run all of it on one
// machine, which is the only machine there is.
//
// WHAT THIS IS FOR. An account's login dies on a machine that has not used it
// for a while, while the same account stays alive on a machine that has. Today
// the fix is a blob copied out of one deck and pasted into another. This is
// that, without the copying: decks on one network find each other, agree they
// belong to the same group, say which accounts they hold and how fresh each
// one is, and hand over the fresher copy.
//
// WHAT IT IS NOT. Not a way to keep one account working on two machines at
// once — a quota is the account's, not the machine's, so a second machine
// buys no capacity. Not a backup. Not a way to reach a deck across the
// internet: everything here is link-local by construction.
//
// ── the shape of it, and where each piece came from ──────────────────────────
//
// Three shipped systems solve nearly this problem and were read before any of
// it was written, because the failure modes are all in the parts that look
// simple.
//
// SYNCTHING (docs.syncthing.net/specs/localdisco-v4.html) announces on UDP
// with NO authentication in the announcement at all, and puts the trust
// somewhere else entirely: the announcement's only identity claim is a hash of
// the device's long-term key. That is exactly right and it is what this does.
// An announcement is a shout in a room; anything it asserts is a claim by
// whoever shouted.
//
// It also broadcasts on IPv4 rather than multicasting — 255.255.255.255, port
// 21027 — and multicasts only on IPv6. That looked like an oddity and is not:
// consumer switches and access points forward broadcast where they drop
// unregistered multicast groups, so the "modern" choice is the one that fails
// on more real networks. Copied.
//
// And it re-announces IMMEDIATELY on start rather than waiting for the next
// interval, so a deck that just came up appears at once instead of up to a
// minute later. Copied.
//
// LOCALSEND (github.com/localsend/protocol) is the closest thing to this that
// people actually run. Its fingerprint is a hash of a long-term key, used both
// to recognise a peer across restarts and to ignore its own announcements —
// the second of which is not obvious until you watch a deck discover itself.
// Copied.
//
// Its other lesson is about WHERE a check goes. The group secret authenticates
// the channel; LocalSend still puts a separate PIN on the transfer endpoint
// itself, so the sensitive operation carries its own proof rather than
// inheriting one from a session that may be old. See `transferChallenge`.
//
// KDE CONNECT had CVE-2020-26164: several issues in the daemon that listens on
// the LAN, in a design whose protocol was fine. The lesson is not "do TLS
// better", it is that a process listening on a hostile network must do as
// close to nothing as possible before it knows who it is talking to. So
// `readBeacon` refuses on length before it parses, refuses on magic before it
// reads a field, and never allocates anything sized by the packet.
//
// ── what is deliberately NOT here ───────────────────────────────────────────
//
// NO SUBNET SCAN. LocalSend falls back to POSTing to every address on the
// subnet when multicast finds nobody, and it is a defensible choice for
// consumer software. It is a port scan, which on a corporate network is the
// thing that gets a machine quarantined by the very systems that exist to
// notice it. A manual address covers the routed and VPN cases that a scan
// cannot reach anyway, and it costs one text field.
//
// PER-PEER PAIRING, AND THIS REVERSES AN EARLIER DECISION. The first version
// used one group passphrase, on the argument that a fleet of n decks should not
// cost n² pairings. That argument is sound and it was answering the wrong
// question. What two people actually hit on real hardware was this: a
// passphrase that differs by one character produces a closed socket and no
// other symptom, on both machines, with the panel unable to tell them apart
// from a firewall — because a secret is the one value the panel must never
// print, so neither person can check theirs against the other's.
//
// A deck is now identified by its own long-term key, and a peer is somebody
// this deck has been told to trust: an address typed into the panel, or an
// incoming connection somebody pressed accept on. Nothing is shared before that
// press, and the press is a decision about a named machine at a named address
// rather than about a string neither person can see.
//
// TRUST ON FIRST USE, and said plainly rather than implied. The first
// connection to a fingerprint is taken on faith and pinned; every one after it
// is checked against the pin. That stops a stranger replacing a paired deck and
// does not stop somebody standing in the middle of the very first exchange. The
// answer to that is comparing fingerprints out of band, which the panel shows
// and which is the next thing to build.
//
// NO DEPENDENCY. node:crypto has X25519, HKDF, scrypt, AES-256-GCM and
// timingSafeEqual, all of which this needs and none of which it should be
// implementing. The one PAKE package on npm was last published in 2022, has 37
// downloads a week and four dependencies of its own; running unmaintained
// cryptography to protect live credentials is worse than the plain construction
// below.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey,
  createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
  timingSafeEqual,
} from "node:crypto";
import os from "node:os";

/** Marks a packet as ours before anything reads a field of it. Four bytes of
 *  ASCII rather than a number, so a stray packet on the port is recognisable
 *  in a capture as "something else's" rather than as a corrupt one of ours. */
export const MAGIC = "CCDK";

/** The wire format. Bumped when a field changes meaning, never when one is
 *  added — a reader that does not know a field ignores it, which is what makes
 *  a deck a version behind still discoverable. */
export const PROTOCOL = 2;

/** The most a beacon may be. A beacon is a name, a port and two hashes; the
 *  worst realistic case is under 300 bytes. Refusing at 512 before parsing is
 *  the cheapest possible answer to a packet built to be expensive to read. */
export const MAX_BEACON_BYTES = 512;

/** How often a deck announces itself, and how long a peer is remembered as
 *  present after its last one.
 *
 *  30 seconds is Syncthing's floor and it is chosen for the same reason: a
 *  quiet network should not carry more of this than it has to, and a deck that
 *  went away is not urgent news. `PRESENT_MS` is three intervals, so two lost
 *  packets do not make a live deck flicker out of the list. */
export const ANNOUNCE_MS = 30_000;
export const PRESENT_MS = ANNOUNCE_MS * 3 + 5_000;

/** Longest a display name may be, in characters rather than bytes so the limit
 *  means the same thing in every script. A name is chosen by whoever is
 *  shouting, so it is untrusted text: capped here, and never rendered as
 *  anything but text at the other end. */
export const MAX_NAME = 40;

/** Longest a manifest may be. Fifty accounts, each an email, an org id and a
 *  few numbers, comes to roughly 12 KB; this is an order of magnitude over
 *  that and still nothing to allocate by accident. */
export const MAX_MANIFEST_BYTES = 128 * 1024;

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

/**
 * The name a deck shows, cleaned.
 *
 * Control characters go, because this string is written into a log and read in
 * a terminal as well as rendered in a page, and a name carrying an escape
 * sequence is a name that can move a cursor. Whitespace collapses so a peer
 * cannot pad itself into looking like two entries. Empty falls back to the
 * fingerprint, which is never empty and is the honest answer for a deck that
 * did not say who it was.
 */
export function cleanName(raw, fallback = "unnamed deck") {
  if (typeof raw !== "string") return fallback;
  // Escape sequences and NUL, spelled by code point rather than by literal:
  // this string reaches a terminal log as well as a page, and a name carrying
  // an ANSI escape can move a cursor or repaint a line. A literal control
  // character in the source would be invisible to whoever reads this next.
  // And \p{Cf}, the FORMAT class, which the control ranges above do not cover:
  // U+202E RIGHT-TO-LEFT OVERRIDE, U+2066-2069 (the directional isolates),
  // U+200B and U+00AD. A name is drawn in one inline formatting context with
  // the peer's address and the words "wants to pair" (LanSyncSection.tsx:1496),
  // and there is no `dir`, no <bdi> and no `unicode-bidi: isolate` anywhere in
  // the sheet — so an override's scope runs to the end of that line and the
  // address the operator is checking renders reversed. That row's own comment
  // calls the fingerprint "the only value that cannot be chosen by whoever is
  // asking"; the strings beside it should at least not be able to rearrange it.
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped ? [...stripped].slice(0, MAX_NAME).join("") : fallback;
}

// ── this deck's own key ─────────────────────────────────────────────────────

/**
 * Turn a passphrase into the key everything else hangs off.
 *
 * scrypt rather than a plain hash, and the parameters are the point: this is a
 * passphrase a person typed, on a network where anybody can capture the
 * handshake and grind at it offline. N=2^15 costs about 100ms and 32 MB per
 * guess here, which is nothing once per deck start and is the difference
 * between a weak passphrase falling in seconds and falling in weeks.
 *
 * The salt is FIXED and that is deliberate, not an oversight. A per-deck salt
 * would mean two decks with the same passphrase deriving different keys, which
 * is the one thing this must never do. What a salt buys — that one rainbow
 * table cannot cover every deployment — is bought instead by the passphrase
 * being generated at 128 bits by default; a table against a random 128-bit
 * secret is not a thing that exists.
 */
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

// ── the invite ──────────────────────────────────────────────────────────────
//
// ONE PIECE OF TEXT THAT CARRIES EVERYTHING, and it exists because of a real
// afternoon. Two people, two machines, a typed address, and `handshake timed
// out` — because the address on screen was the LAN one and the only route
// between them was a VPN. Neither of them could have known which of the two to
// use; the deck could not know either, and printing both made it their problem.
//
// So the invite carries EVERY address this deck has, and the deck that receives
// it tries them in turn. Nobody has to know which one is routable, because the
// only machine that can find out is the one doing the reaching.
//
// AND IT CARRIES A CODE, which is what turns two presses into one. A deck that
// proves it holds the invite is not a stranger asking to be let in — it is
// somebody the owner of this machine handed a token to. So it is paired on
// arrival and nobody presses accept. That also closes the gap trust-on-first-use
// left open: the first contact is verified rather than believed.
//
// THE TOKEN IS THE SECRET, said plainly rather than implied. Whoever holds it
// can pair with this deck until it expires. It is a door key with a timer, not
// an identifier — which is why it is short-lived, single-purpose, and replaced
// the moment it is used.

/** How long an invite is good for. Long enough to paste into a chat and have
 *  somebody read it, short enough that one left in a channel is not a way in
 *  tomorrow. */
export const INVITE_MS = 10 * 60 * 1000;

/** The most addresses an invite may carry. A machine with a VPN, a second card
 *  and a container bridge has three or four; ten is far past honest and keeps a
 *  hand-built token from being a way to make this deck dial a list. */
export const MAX_INVITE_ADDRS = 10;

/** What the token starts with, so a reader can tell at a glance what they have
 *  been sent and a wrong paste is refused before it is parsed. */
export const INVITE_PREFIX = "ccdeck1.";

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = str => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * A code somebody could read out loud if they had to.
 *
 * Six digits, from rejection sampling rather than modulo — the same argument
 * the word list made and for the same reason: a bias here is a bias in the one
 * number that decides whether a stranger can pair.
 */
export function inviteCode(rand = randomBytes) {
  let out = "";
  while (out.length < 6) {
    for (const b of rand(12)) {
      if (b >= 250) continue;            // 250 = 25 * 10, the largest clean multiple
      out += String(b % 10);
      if (out.length === 6) break;
    }
  }
  return out;
}

/** Mint one. `addrs` are already `host:port` strings, because which addresses
 *  this machine has is not a question this file can answer. */
export function mintInvite({ addrs, name, now = Date.now(), code = inviteCode() } = {}) {
  const list = (Array.isArray(addrs) ? addrs : []).filter(a => typeof a === "string" && a).slice(0, MAX_INVITE_ADDRS);
  if (!list.length) return null;
  const expiresAt = now + INVITE_MS;
  // `pb` IS THE MINTER SAYING IT WILL PROVE THE CODE BACK, and it is here
  // rather than in PROTOCOL because PROTOCOL is the whole wire. A deck of this
  // version answers the handshake with `inviteProofBack`; every deck before it
  // speaks the same PROTOCOL and does not. The joiner has no other way to tell
  // the two apart, and a joiner that demanded the proof from both would break
  // invites exactly across a version boundary — which is when people use them.
  //
  // It is not a security decision the far end gets to make. The token is text
  // the minter handed to the joiner out of band, in the same breath as the
  // code; whoever can rewrite it already holds the code and has no use for
  // this. What the flag can do is say "the deck that minted me is old", and the
  // worst that buys is the behaviour shipped today.
  const body = { v: PROTOCOL, a: list, n: cleanName(name), c: code, x: expiresAt, pb: 1 };
  return { token: INVITE_PREFIX + b64url(Buffer.from(JSON.stringify(body), "utf8")), code, expiresAt };
}

/**
 * Read one somebody pasted, or null.
 *
 * REFUSES BEFORE IT UNDERSTANDS, in the order that costs least: the prefix,
 * then the length, then the decode, then the shape, then the clock. A token is
 * text a person pasted out of a chat window, so it is as untrusted as anything
 * that arrives on a socket — and every failure here is the same answer to the
 * reader, which is "that is not an invite".
 */
export function readInvite(raw, now = Date.now()) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text.startsWith(INVITE_PREFIX)) return null;
  if (text.length > 2048) return null;
  let body = null;
  try { body = JSON.parse(unb64url(text.slice(INVITE_PREFIX.length)).toString("utf8")); }
  catch { return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.v !== PROTOCOL) return null;
  if (typeof body.c !== "string" || !/^[0-9]{6}$/.test(body.c)) return null;
  if (typeof body.x !== "number" || !Number.isFinite(body.x)) return null;
  // Expired is its own answer and the caller says so — "that invite has run
  // out, ask for a new one" is a different instruction from "that is not an
  // invite", and a reader who cannot tell them apart retypes the same thing.
  const expired = body.x <= now;
  const addrs = (Array.isArray(body.a) ? body.a : [])
    .filter(a => typeof a === "string")
    .slice(0, MAX_INVITE_ADDRS)
    .map(a => ({ raw: a, at: a.lastIndexOf(":") }))
    .filter(p => p.at > 0)
    .map(p => ({ addr: p.raw.slice(0, p.at), port: Number(p.raw.slice(p.at + 1)) }))
    .filter(p => p.addr && Number.isInteger(p.port) && p.port > 0 && p.port < 65_536);
  if (!addrs.length) return null;
  return {
    addrs, name: cleanName(body.n), code: body.c, expiresAt: body.x, expired,
    // Whether the deck that minted this will prove it holds the code — see
    // mintInvite. Absent means a deck older than that, and the caller degrades
    // to what it did before rather than refusing the token.
    provesBack: body.pb === 1,
  };
}

/**
 * The proof that a caller is holding the invite, over the same transcript the
 * session key is bound to.
 *
 * Not the code itself on the wire. A code that travelled in the clear would be
 * replayable by anybody who watched one exchange, and this is the value that
 * decides whether a deck is paired without anybody pressing anything.
 */
export function inviteProof(code, transcript) {
  return createHmac("sha256", `ccdeck-invite-v${PROTOCOL}`).update(`${code}|${transcript}`).digest("hex");
}

/**
 * The same proof, the other way round: the deck that MINTED the invite showing
 * the caller it holds the code too.
 *
 * WHY THE CALLER'S PROOF WAS NOT ENOUGH, and it is the whole of #971. The code
 * travelled in one message, caller to listener, and the reply carried a session
 * proof — an HMAC over an ECDH against whatever public key the responder had
 * just presented. That proves the responder holds the private half of the key
 * it just chose. Anything with a socket holds the private half of a key it just
 * chose. `join` passes no pin, by definition, so the impostor check in
 * connectToPeer is inert on this path and whatever answered first was written
 * into the trusted list.
 *
 * A SEPARATE KEY STRING RATHER THAN A DIRECTION FIELD, because the two
 * transcripts are byte-identical — handshakeTranscript takes the caller and the
 * listener in a fixed order, so both sides compute the same string. Reusing
 * `inviteProof` here would let the listener's reply be the caller's own `auth`
 * frame echoed back, which is precisely the party this is meant to exclude.
 */
export function inviteProofBack(code, transcript) {
  return createHmac("sha256", `ccdeck-invite-back-v${PROTOCOL}`).update(`${code}|${transcript}`).digest("hex");
}

// ── the beacon ──────────────────────────────────────────────────────────────

/**
 * What a deck shouts, which anybody on the network can hear.
 *
 * NO ACCOUNTS AND NO SECRET. This is the packet a stranger on the same wifi
 * receives, so what is in it is what a stranger learns: that a ccdeck is here,
 * what it calls itself, and a hash of its public key. Not which Anthropic
 * accounts exist on the machine, not how many, and nothing that could be ground
 * at offline, because there is nothing in it derived from a secret.
 *
 * IT NO LONGER CARRIES A GROUP TAG, and that is the shape of the whole feature
 * changing rather than a field going away. The tag let a deck drop a packet
 * from outside its group before any handshake existed to attack, which is a
 * real property and was worth having — but it only worked when both people
 * held the same passphrase, and a passphrase neither of them can see is exactly
 * what nobody could get right. What replaces it is later and cheaper: a beacon
 * from a deck this one does not trust becomes a row somebody can accept, and
 * nothing at all happens until they do.
 */
/**
 * WHICH MACHINE THIS IS, as opposed to which PROCESS or which KEY.
 *
 * Reported by somebody looking at a colleague's screen: "I appear three or four
 * times". Every one of those rows was honest — a deck's identity is its key, a
 * second deck sharing a config directory is told to take a fresh one
 * (`id-clash`), and a deck heard yesterday stays listed for a day — so a
 * machine that has run the deck a few times becomes a column of itself on
 * everybody else's panel, under one hostname, offering to pair with each.
 *
 * A key cannot answer "same machine?" and was never meant to. This can: it is
 * derived rather than stored, so two processes on one computer agree without
 * coordinating and a first run needs nothing written; and it is HASHED, because
 * a hostname and a home directory carry a person's name and this goes out in
 * the clear to everyone on the network, thirty seconds apart, forever.
 *
 * The home directory is in it so that a copied `~/.claude` — which is how two
 * real machines end up holding one key, and the reason `id-clash` exists —
 * still reads as two machines when the hostnames differ, which they do.
 */
export function hostId({ hostname = os.hostname(), home = os.homedir() } = {}) {
  return createHash("sha256").update(`${machineName(hostname)}\u0000${home}`).digest("hex").slice(0, 12);
}

/**
 * The part of a hostname that names the machine, rather than the network it is
 * on at the moment.
 *
 * macOS answers `os.hostname()` with `Petrus-MacBook-Pro.local` at one moment
 * and `Petrus-MacBook-Pro` at another, and a DHCP server can hang its own
 * domain on the end — `.lan`, `.home`, `.fritz.box`. hostId hashed whatever it
 * was handed, so two decks on one computer started either side of such a change
 * disagreed about which machine they were on. Sharing a key, each read the other
 * as an `id-clash` — the copied-~/.claude case beaconVerdict heals — and one of
 * them took a new key: one machine, two fingerprints, two rows on every
 * colleague's panel. The first label, case folded, is the name the machine
 * keeps through all of that. An address used as a hostname is kept whole,
 * since its first label is only the first octet.
 */
export function machineName(hostname) {
  const h = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  return /^\d+(\.\d+){3}$/.test(h) ? h : h.split(".")[0];
}

export function beaconPayload({ name, fp, port, instance, host }) {
  return {
    m: MAGIC,
    v: PROTOCOL,
    n: cleanName(name),
    f: fp,
    p: port,
    // Randomised at start. Two beacons from one fingerprint with different
    // instance ids mean the deck restarted between them, which is the signal to
    // drop whatever session state was held for it rather than trying to resume
    // into a process that no longer exists. Syncthing's field, same job.
    i: instance,
    // Which MACHINE, so several processes on one computer are one row rather
    // than one row each. Optional on the wire: a deck older than this sends no
    // `h`, and a reader that requires one would stop seeing every deck already
    // installed.
    ...(host ? { h: host } : {}),
  };
}

/**
 * Read a packet off the wire, refusing before understanding.
 *
 * The order is the whole point and it is the CVE-2020-26164 lesson: length
 * first, because that costs nothing; then magic, because that is one string
 * compare; then a parse; then the fields. Nothing here allocates anything
 * sized by the packet, and a packet that fails at any step produces `null`
 * rather than a reason — a listener that explained itself to whoever is
 * probing it would be a listener helping them.
 */
export function readBeacon(buf, { maxBytes = MAX_BEACON_BYTES } = {}) {
  if (!buf || buf.length === 0 || buf.length > maxBytes) return null;
  // One byte before a parse. The payload is JSON, so anything not starting with
  // `{` is somebody else's traffic on the port and costs nothing to refuse —
  // which on a busy network is most of what arrives.
  if (buf[0] !== 0x7b) return null;
  let raw;
  try { raw = JSON.parse(buf.toString("utf8")); }
  catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  if (raw.m !== MAGIC) return null;
  if (raw.v !== PROTOCOL) return null;
  // The TYPE as well as the value. `Number("4319")` is a valid port and this
  // used to take it, which is leniency of exactly the kind this whole reader
  // exists to refuse: a field arriving as a type nobody sends is a field built
  // by hand, and the only safe answer to a hand-built packet is no.
  if (typeof raw.p !== "number" || !Number.isInteger(raw.p) || raw.p < 1 || raw.p > 65_535) return null;
  const port = raw.p;
  if (typeof raw.f !== "string" || !/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/.test(raw.f)) return null;
  if (typeof raw.i !== "string" || !/^[0-9a-f]{8,32}$/.test(raw.i)) return null;
  // Optional, and refused rather than tolerated when it is malformed: a field
  // that decides which rows collapse into one is a field worth being strict
  // about. Absent is fine and means "a deck older than this".
  if (raw.h !== undefined && (typeof raw.h !== "string" || !/^[0-9a-f]{6,32}$/.test(raw.h))) return null;
  return { name: cleanName(raw.n, raw.f), fp: raw.f, port, instance: raw.i, host: raw.h };
}

/**
 * Whether a beacon is one this deck should act on.
 *
 * Three separate refusals and they mean different things, which is why this
 * returns a reason rather than a boolean — the panel says "found a deck that is
 * not in your group" where it would otherwise say nothing at all, and "not in
 * your group" is the single most useful sentence when somebody has mistyped the
 * passphrase on one machine.
 *
 * Self-recognition is by fingerprint, not by address: a deck hears its own
 * broadcast on every interface it owns, and filtering by address would need a
 * list of them that changes when a VPN comes up.
 */
export function beaconVerdict(beacon, { selfFp, selfInstance, selfHost, trusted } = {}) {
  if (!beacon) return "unreadable";
  // ANOTHER DECK ON THIS COMPUTER. Not this process — a different key, honestly
  // its own — and still nothing to pair with: both read one claude-swap store,
  // so neither holds a login the other could heal. It used to be filtered by
  // the address the packet came from, which is true and needs the list of this
  // machine's addresses to be current; the machine's own id needs nothing and
  // is the same answer.
  if (selfHost && beacon.host && beacon.host === selfHost && beacon.fp !== selfFp) return "self";
  if (beacon.fp === selfFp) {
    // OUR OWN NAME, FROM SOMEBODY ELSE'S PROCESS. Two decks sharing a config
    // directory hold the same key — and so does the second machine when
    // somebody copies their ~/.claude across, which people do. Both then file
    // every one of the other's beacons as "that is me" and the two are
    // permanently invisible to each other, with nothing on screen to say why.
    //
    // `instance` is what separates the cases: it is fresh per process, so our
    // own packet carries the instance we are running and another deck's cannot.
    // Told apart here rather than healed here — this function decides, and
    // taking a new key is the engine's to do.
    //
    // AND ONE MACHINE'S OWN TWIN IS NOT A CLASH, which is the whole of a defect
    // reported as "Fiodor pressed yes ten times and it keeps asking". Several
    // decks on one computer share a config directory, so they start with one
    // key; each read the others' beacons as somebody wearing its name, each
    // took a fresh key, each wrote that key to the file the others read — and
    // the loop never settles. Every new key is a new deck to everybody else on
    // the network, so one machine produced a fresh pairing request every few
    // seconds, forever, and accepting one accomplished nothing because the deck
    // that asked no longer existed by the time the answer arrived.
    //
    // Two processes on one computer sharing one key is not a problem to heal.
    // They read one claude-swap store; there is nothing for either to send the
    // other, they never dial each other, and to the rest of the network they
    // are one deck — which is exactly what they are. The clash worth healing is
    // the OTHER one: a `~/.claude` copied to a second machine, where two real
    // decks would otherwise be permanently invisible to each other.
    if (selfInstance && beacon.instance !== selfInstance) {
      return selfHost && beacon.host === selfHost ? "self" : "id-clash";
    }
    return "self";
  }
  // A DECK WE HAVE BEEN TOLD TO TRUST, or one somebody may choose to. There is
  // no third answer any more: the group tag used to sort strangers from peers
  // before a handshake existed, and now every stranger is a row with a name and
  // an address that a person can accept or ignore. Nothing is asked of an
  // unknown deck and nothing is offered to it.
  return Array.isArray(trusted) && trusted.some(t => t.fp === beacon.fp) ? "peer" : "stranger";
}

/** Whether this fingerprint is one somebody has already accepted, and what was
 *  recorded about it — the pinned public key above all, which is what makes a
 *  second connection from the same fingerprint checkable rather than merely
 *  claimed. */
export function trustedPeer(trusted, fp) {
  return (Array.isArray(trusted) ? trusted : []).find(t => t && t.fp === fp) ?? null;
}

/**
 * Add a deck to the trusted list, or update what is known about one.
 *
 * THE PINNED KEY NEVER CHANGES UNDER US. A second entry claiming a fingerprint
 * we already hold with a different public key is not an update, it is a
 * different deck wearing the name — and 48 bits of fingerprint is far past
 * accident, so it is somebody trying. The old entry stands and the caller is
 * told nothing changed.
 */
export function addTrusted(trusted, entry) {
  const list = Array.isArray(trusted) ? trusted : [];
  if (!entry || typeof entry.fp !== "string" || typeof entry.pub !== "string") return { list, added: false };
  const had = trustedPeer(list, entry.fp);
  if (had) {
    if (had.pub !== entry.pub) return { list, added: false };
    return {
      list: list.map(t => (t.fp === entry.fp ? { ...t, name: entry.name ?? t.name } : t)),
      added: false,
    };
  }
  // WHEN, for the panel's "paired since". Only a new pin gets one: a deck that
  // was already trusted keeps whatever date it had, and one pinned before this
  // field existed keeps having none rather than being given today's.
  const at = Number.isFinite(entry.at) && entry.at > 0 ? { at: entry.at } : {};
  return { list: [...list, { fp: entry.fp, pub: entry.pub, name: entry.name ?? "", ...at }], added: true };
}

/** Take one back out. Unpairing stops what has not happened yet and takes back
 *  nothing that has — the same sentence the panel says about a shared login,
 *  and true here for the same reason. */
export function dropTrusted(trusted, fp) {
  return (Array.isArray(trusted) ? trusted : []).filter(t => t && t.fp !== fp);
}

/**
 * The decks worth offering to pair with, out of everything that has ever been
 * heard.
 *
 * THIS LIST WAS A WALL. Every deck ever heard stayed in it forever, and a deck
 * that restarts takes a NEW key — so a machine started and stopped seven times
 * was seven rows, all with the same name, all at the same address, none of them
 * reachable any more. The dialog it filled was unreadable, which is exactly
 * what somebody reported.
 *
 * Three rules, in order:
 *
 * PRESENT ONLY. A deck that has not been heard for a couple of announce
 * intervals is not somewhere you can pair right now, so it is not offered. This
 * is the same window the peer table uses, for the same reason.
 *
 * ONE ROW PER MACHINE. A person reading this sees a name and an address, and
 * two rows carrying the same pair are the same machine to them whatever the
 * fingerprints say. The freshest wins, because it is the one still running.
 *
 * NEWEST FIRST, AND CAPPED. The deck somebody just started is the one they are
 * looking for; a list longer than a screen is a list nobody reads.
 */
export function pairable(strangers, now, { presentMs = PRESENT_MS, limit = 8, mine = [] } = {}) {
  // NOT THIS MACHINE. A deck's own beacon is filtered by fingerprint, which is
  // right and is not enough: a second deck on the same computer is a different
  // process with a different key, so it passes that check honestly and then
  // shows up in the list under this machine's own hostname, at this machine's
  // own address, offering to pair with itself.
  //
  // It was reported from a screenshot — "why myself appear here in list" — and
  // the answer is that the address is the one thing that cannot lie: a beacon
  // arriving FROM an address this machine holds came from this machine. Pairing
  // with it would also buy nothing, because both decks read one claude-swap
  // store and there is nothing for either to heal.
  const own = new Set(Array.isArray(mine) ? mine : []);
  const live = [...(strangers ?? [])]
    .filter(p => p && typeof p.at === "number" && now - p.at <= presentMs)
    .filter(p => !own.has(p.addr))
    .sort((a, b) => b.at - a.at);
  // ONE ROW PER MACHINE. `live` is newest first, so the row that survives is the
  // one that spoke most recently — which is the process somebody is actually
  // running, rather than a key its computer took and abandoned an hour ago.
  //
  // The machine's own id when the far deck sends one, and the old name@address
  // pair when it does not: a deck older than the `h` field is still collapsed
  // as well as it can be rather than not at all.
  const seen = new Set();
  const out = [];
  for (const p of live) {
    const key = p.host ? `host:${p.host}` : `${p.name}@${p.addr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return { shown: out.slice(0, limit), more: Math.max(0, out.length - limit) };
}

// ── the peer table ──────────────────────────────────────────────────────────

/**
 * Fold one heard beacon into what is known, and say whether anything changed.
 *
 * PEERS ARE REMEMBERED, NOT MERELY SEEN. A deck that is switched off should
 * stay in the list with "last seen yesterday" rather than vanishing, because
 * the question the list answers is "who is in my group" and the answer to that
 * does not change when a laptop closes. Presence is a field, not membership.
 *
 * `changed` is returned rather than inferred by the caller so a beacon that
 * says nothing new — which is most of them, one every thirty seconds per peer
 * forever — costs no render and no write.
 *
 * `via` is the route the packet came by: "lan", or "tailscale" for one sent to
 * this machine's tailnet address — see routeOf in tailscale.mjs.
 */
export function notePeer(peers, beacon, addr, now, via = "lan") {
  const prev = peers.get(beacon.fp);
  // ONE MACHINE, TWO ROUTES, AND THE LOCAL ONE WINS WHILE IT ANSWERS. A laptop
  // in the office is heard on the Wi-Fi and over Tailscale in the same half
  // minute, and taking whichever packet came last flipped its address every
  // beacon — each flip a `changed`, and a round dialling a different route each
  // minute. The tailnet address is used only once the local one has gone quiet
  // for as long as presence lasts, which is the laptop having left the building.
  const lanAt = via === "lan" ? now : prev && prev.via !== "tailscale" ? prev.lanAt ?? prev.lastSeen : prev?.lanAt;
  const keepLan = via === "tailscale" && prev && prev.via !== "tailscale" && lanAt != null && now - lanAt < PRESENT_MS;
  const next = {
    fp: beacon.fp,
    name: beacon.name,
    addr: keepLan ? prev.addr : addr,
    via: keepLan ? prev.via ?? "lan" : via,
    lanAt: lanAt ?? null,
    port: beacon.port,
    instance: beacon.instance,
    host: beacon.host,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
    // Kept across a name change so the panel can say "was Laptop-birou", which
    // is what stops a renamed deck reading as a new one that appeared.
    prevName: prev && prev.name !== beacon.name ? prev.name : prev?.prevName,
    // A manual peer stays manual once found by beacon, so removing it from the
    // list means removing the address the user typed rather than waiting for a
    // packet that will re-add it.
    manual: prev?.manual ?? false,
  };
  const changed = !prev
    || prev.name !== next.name
    || prev.addr !== next.addr
    || prev.port !== next.port
    || prev.instance !== next.instance;
  peers.set(beacon.fp, next);
  return { peer: next, changed, restarted: !!prev && prev.instance !== next.instance };
}

/** Whether a peer counts as here right now. Separate from being in the list at
 *  all — see notePeer. */
export function isPresent(peer, now) {
  return peer.lastSeen != null && now - peer.lastSeen < PRESENT_MS;
}

/** How long a deck stays in the list after its last beacon. See stillListed. */
export const FORGET_MS = 24 * 60 * 60_000;

/**
 * Whether a peer still belongs in the list at all.
 *
 * The list answers "who is in my group", and that does not change when a laptop
 * closes — so a deck heard this morning is still there tonight with the time
 * beside it. A day later it is not news that it once existed.
 *
 * WITHOUT THIS the list is a graveyard, and that was measured rather than
 * imagined: on a machine where decks had been restarted a few times, every
 * peer's list held a row per restart, each reporting ECONNREFUSED once a minute
 * against a port nothing had listened on for an hour. A stable deck id stopped
 * new rows appearing; this is what clears the ones that are genuinely gone.
 *
 * A TYPED ADDRESS IS EXEMPT, and that is the whole reason this is a rule rather
 * than a comparison inlined at the call site: an address somebody typed is a
 * decision they made, and a deck that has been off for a week is exactly the
 * case they typed it for. Only the user takes those off.
 */
export function stillListed(peer, now, forgetMs = FORGET_MS) {
  if (peer?.manual) return true;
  return peer?.lastSeen != null && now - peer.lastSeen < forgetMs;
}

/**
 * The list as the panel shows it: present decks first, then by name.
 *
 * Not by last-seen within each group, which was the obvious ordering and is
 * wrong: a list that reorders itself every thirty seconds as beacons land in
 * whatever order the network delivers them is a list nobody can point at.
 * Name is stable, and the presence split is the only thing that should move a
 * row.
 */
export function peerRows(peers, now) {
  return [...peers.values()]
    .map(p => ({ ...p, present: isPresent(p, now) }))
    .sort((a, b) => (Number(b.present) - Number(a.present))
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || a.fp.localeCompare(b.fp));
}

// ── the handshake ───────────────────────────────────────────────────────────

/**
 * The proof a deck offers to show it holds the group passphrase.
 *
 * Challenge-response over the derived key rather than sending anything derived
 * from the passphrase directly, so a recording of one exchange is worth nothing
 * for the next: the challenge is fresh random from the side being convinced.
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

/** Whether a proof is the one expected, compared in constant time for the
 *  reason `beaconVerdict` gives. Length-checked first because timingSafeEqual
 *  throws on a mismatch, and a throw here is a crash rather than a refusal. */
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
 * Wrap a share blob so only the group can read it.
 *
 * AES-256-GCM over the group key with a random 12-byte nonce. The alternative
 * — per-peer keys from the X25519 exchange — is better cryptography and worse
 * for this: it would make the encryption depend on a session that the transfer
 * check above deliberately does not trust, and the thing being protected is
 * already group-wide by definition. Anybody who can decrypt this is somebody
 * the passphrase already admits.
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

// ── which copy wins ─────────────────────────────────────────────────────────

/**
 * The identity of one account, which is NOT its slot number.
 *
 * claude-swap keys on `(email, organizationUuid)` — same email under two orgs
 * is two accounts on purpose — and assigns slots as max+1 per store, so the
 * account that is 4 here is 2 there. Anything keyed on the number would swap
 * the wrong pair the first time two stores had grown in a different order.
 */
export function accountKey(email, orgUuid) {
  return `${String(email ?? "").trim().toLowerCase()}@@${String(orgUuid ?? "")}`;
}

/**
 * What to do about one account, given what I have and what a peer has.
 *
 * TWO OUTCOMES, AND NEITHER OVERWRITES SOMETHING THAT WORKS.
 *
 *   "add"   I do not have this account at all.
 *   "heal"  I have it and claude-swap has quarantined it — refresh token dead,
 *           verified by an invalid_grant from Anthropic rather than guessed
 *           from an expiry field — and the peer's copy is alive.
 *   null    Anything else, which is most of the time.
 *
 * A third outcome was designed and dropped, and the reason is worth keeping
 * because it looks like a feature being given up. It was "replace": take a
 * peer's copy when it is strictly newer than mine, so the freshest copy wins
 * everywhere. Measuring "newer" needs the OAuth payload's `expiresAt`, which
 * means the deck opening a credential — something it does not do, claude-swap
 * owns that — and on macOS that credential is in the Keychain, which a
 * background process cannot reliably read at all.
 *
 * What settled it is not the obstacle. It is that a working credential replaced
 * by a newer working credential changes nothing today. It would only matter if
 * mine were about to die — and a login dies from not being used, so if I am not
 * using it I do not care, and if I am using it the refresh keeps it alive. The
 * whole value is in the account that is already dead.
 *
 * So this never returns an outcome that needs `cswap import --force`, which
 * makes claude-swap's own rule the entire safety property: a plain import skips
 * an account that is present and healthy, and replaces exactly one that is
 * quarantined. A peer cannot overwrite a credential of mine that works, because
 * nothing here ever asks for that.
 */
export function syncAction(mine, theirs) {
  if (!theirs || !theirs.alive) return null;
  if (!mine) return "add";
  return mine.alive ? null : "heal";
}

/**
 * Everything to do this round, over one peer's manifest.
 *
 * Sorted by account key rather than left in manifest order, so two decks
 * reconciling the same pair of stores do the same work in the same sequence —
 * which is what makes a failure halfway through repeatable rather than a
 * different half each time.
 */
export function plan(local, remote) {
  const mine = new Map(local.map(a => [a.key, a]));
  const out = [];
  for (const theirs of remote) {
    const action = syncAction(mine.get(theirs.key), theirs);
    if (action) out.push({ key: theirs.key, email: theirs.email, action });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * What this deck publishes about its own accounts — to the group, and only to
 * the group.
 *
 * Three fields, and `alive` is the only one that is a judgement: it is
 * claude-swap's own verdict on this machine's copy, not a guess. An account
 * this deck cannot use is worth nothing to a peer, so saying so plainly is what
 * stops a peer asking for it.
 *
 * Emails are in it, and the manifest is sealed on its way. This said "in the
 * clear inside the encrypted channel" until #810, and there was no such
 * channel: the handshake derived a key and sealed a credential and a version
 * card with it, and nothing else — so every email in this list crossed the
 * network readable by anybody on it. Between two decks that both seal, every
 * frame after the handshake now is (see frameChannel). Toward a deck from
 * before that it still travels plain, because that deck cannot open anything
 * else, until it updates.
 *
 * Plain emails INSIDE the seal are a deliberate line: a manifest only ever
 * reaches a deck that proved the key somebody here accepted, and the panel has
 * to name the account it is offering to heal. Hashing the email would buy
 * nothing against that reader and would cost the one thing the row needs to say.
 *
 * `shared` is the user's list. An account absent from it is absent from the
 * manifest entirely — not listed as withheld, which would tell the group that
 * an account exists and is being kept back, and that is itself the fact being
 * kept back.
 */
export function manifestFor(accounts, shared) {
  const want = new Set(shared);
  return accounts
    .filter(a => want.has(a.key))
    .map(a => ({ key: a.key, email: a.email, alive: !!a.alive }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Which account this deck is on, as a frame field for the decks it is paired
 * with — or nothing.
 *
 * ONLY ONE IT SHARES IS EVER NAMED. The account a deck works on is named only
 * when it is also in the list the owner ticked, so the promise the share list
 * makes — an unticked account is never told to anybody — holds for this too.
 * On one it does not share, it says `other` and nothing more: a paired deck
 * reads "on another account", which says this machine is working without
 * saying on what.
 *
 * `hidden` is the owner's switch turned off, and that IS said, on purpose: a
 * paired deck then reads "current account hidden" rather than nothing, so the
 * person over there knows this machine is working and chose not to say where.
 * A deck with no account at all says nothing.
 */
export function currentFor(accounts, shared, shareActive) {
  if (shareActive === false) return { current: { hidden: true } };
  const on = accounts.find(a => a.active);
  if (!on) return {};
  return new Set(shared).has(on.key) ? { current: { key: on.key } } : { current: { other: true } };
}
