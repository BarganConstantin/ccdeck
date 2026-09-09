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
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
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
export function newKeypair() {
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
 * to anybody who ever learned the passphrase. This gives forward secrecy for
 * free: the ephemeral halves are gone when the socket is.
 */
export function sessionKey(secret, peerPub, transcript) {
  const priv = createPrivateKey({ key: Buffer.from(secret, "base64"), format: "der", type: "pkcs8" });
  const theirs = createPublicKey({ key: Buffer.from(peerPub, "base64"), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: priv, publicKey: theirs });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0),
    Buffer.from(`ccdeck-lan-v${PROTOCOL}|${transcript}`, "utf8"), 32));
}

/**
 * The string both sides bind their session key to.
 *
 * One definition, used by the caller and the listener, because a transcript the
 * two build differently is a handshake that never agrees and a bug that only
 * appears between two machines. Caller first, always, so the order does not
 * depend on which end is asking.
 */
export function handshakeTranscript(callerFp, listenerFp, callerChallenge, listenerChallenge) {
  return `${callerFp}|${listenerFp}|${callerChallenge}|${listenerChallenge}`;
}

/**
 * A public key somebody sent, or null.
 *
 * It arrives from the network before anything has been agreed, so it is checked
 * for being an X25519 public key at all rather than trusted to be one — a
 * string that is not gets a refusal here instead of a throw three frames later.
 */
export function readPub(raw) {
  if (typeof raw !== "string" || raw.length < 40 || raw.length > 128) return null;
  try {
    const der = Buffer.from(raw, "base64");
    createPublicKey({ key: der, format: "der", type: "spki" });
    return { pub: raw, fp: fingerprint(der) };
  } catch { return null; }
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
  const body = { v: PROTOCOL, a: list, n: cleanName(name), c: code, x: expiresAt };
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
  return { addrs, name: cleanName(body.n), code: body.c, expiresAt: body.x, expired };
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
export function beaconPayload({ name, fp, port, instance }) {
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
  return { name: cleanName(raw.n, raw.f), fp: raw.f, port, instance: raw.i };
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
export function beaconVerdict(beacon, { selfFp, selfInstance, trusted } = {}) {
  if (!beacon) return "unreadable";
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
    return selfInstance && beacon.instance !== selfInstance ? "id-clash" : "self";
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
  return { list: [...list, { fp: entry.fp, pub: entry.pub, name: entry.name ?? "" }], added: true };
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
export function pairable(strangers, now, { presentMs = PRESENT_MS, limit = 8 } = {}) {
  const live = [...(strangers ?? [])]
    .filter(p => p && typeof p.at === "number" && now - p.at <= presentMs)
    .sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const p of live) {
    const key = `${p.name}@${p.addr}`;
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
 */
export function notePeer(peers, beacon, addr, now) {
  const prev = peers.get(beacon.fp);
  const next = {
    fp: beacon.fp,
    name: beacon.name,
    addr,
    port: beacon.port,
    instance: beacon.instance,
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
 */
export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), body: body.toString("base64") };
}

/** The other half. Returns null rather than throwing on every failure — a
 *  wrong tag, a wrong key, a truncated body and a hand-built packet all mean
 *  the same thing to the caller, which is "do not use this". */
export function open(key, { iv, tag, body }, aad) {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
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
 * Emails are in it, in the clear inside the encrypted channel. That is a
 * deliberate line: a manifest only ever reaches a deck that has already proved
 * it holds the passphrase, and the panel has to name the account it is offering
 * to heal. Hashing the email would buy nothing against that reader and would
 * cost the one thing the row needs to say.
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
