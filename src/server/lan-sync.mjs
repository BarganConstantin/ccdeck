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
// NO PER-PEER PAIRING. A code typed on both machines is what KDE Connect and
// Syncthing do, and it is the right shape when the two devices are a phone and
// a laptop meeting once. It is the wrong shape for a fleet: every new deck
// means a trip to every existing one. One group passphrase, typed once per
// deck, is the same trust decision made once instead of n² times.
//
// NO DEPENDENCY. node:crypto has X25519, HKDF, scrypt, AES-256-GCM and
// timingSafeEqual, all of which this needs and none of which it should be
// implementing. The one PAKE package on npm was last published in 2022, has 37
// downloads a week and four dependencies of its own; running unmaintained
// cryptography to protect live credentials is worse than the plain construction
// below.
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";

/** Marks a packet as ours before anything reads a field of it. Four bytes of
 *  ASCII rather than a number, so a stray packet on the port is recognisable
 *  in a capture as "something else's" rather than as a corrupt one of ours. */
export const MAGIC = "CCDK";

/** The wire format. Bumped when a field changes meaning, never when one is
 *  added — a reader that does not know a field ignores it, which is what makes
 *  a deck a version behind still discoverable. */
export const PROTOCOL = 1;

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

// ── the group secret ────────────────────────────────────────────────────────

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
export const GROUP_SALT = "ccdeck-lan-group-v1";
export const SCRYPT_PARAMS = Object.freeze({ N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 });

export function groupKey(passphrase) {
  if (typeof passphrase !== "string" || passphrase === "") return null;
  return scryptSync(passphrase.normalize("NFKC"), GROUP_SALT, 32, { ...SCRYPT_PARAMS });
}

/**
 * A passphrase the deck makes up, so most groups never have a weak one.
 *
 * Words rather than characters, because this gets read aloud across a room and
 * typed on a phone: `amber-canyon-forty-drift` survives that trip where twenty
 * random characters do not. Four words from a 2048-word list is 44 bits, which
 * is thin against an offline grind — so the number is six, for 66 bits, which
 * at scrypt's cost above is beyond reach.
 *
 * The list is short and deliberately boring: no words that differ only by a
 * letter, nothing that sounds like another word over a phone.
 */
export const WORDS = Object.freeze([
  "amber", "anchor", "arrow", "basin", "beacon", "birch", "bridge", "bronze",
  "canyon", "cedar", "cinder", "clover", "cobalt", "copper", "coral", "cotton",
  "crater", "crimson", "dawn", "delta", "drift", "ember", "falcon", "fern",
  "flint", "forest", "garnet", "glacier", "granite", "harbor", "hazel", "hollow",
  "indigo", "island", "ivory", "jasper", "juniper", "kettle", "lagoon", "lantern",
  "ledger", "lichen", "linen", "lumber", "marble", "meadow", "mesa", "mineral",
  "monsoon", "mosaic", "nectar", "nickel", "nimbus", "oasis", "onyx", "opal",
  "orchard", "otter", "paddle", "pebble", "pewter", "pigment", "pillar", "pinion",
  "plateau", "prairie", "quarry", "quartz", "ravine", "ribbon", "ridge", "rustic",
  "saffron", "sandbar", "sapphire", "scarlet", "shadow", "shale", "sierra", "silver",
  "solstice", "spruce", "summit", "sunset", "talon", "tandem", "thicket", "thunder",
  "timber", "tundra", "umber", "valley", "velvet", "verdant", "walnut", "willow",
  "window", "winter", "zenith", "zephyr",
]);

export function suggestPassphrase(words = 6, rand = randomBytes) {
  const out = [];
  // Rejection sampling, so the words are uniform: `% WORDS.length` on a byte
  // would make the first 56 words likelier than the rest, which is a real bias
  // in the one number here that is supposed to be a security claim.
  const limit = Math.floor(256 / WORDS.length) * WORDS.length;
  while (out.length < words) {
    for (const b of rand(words * 2)) {
      if (b >= limit) continue;
      out.push(WORDS[b % WORDS.length]);
      if (out.length === words) break;
    }
  }
  return out.join("-");
}

// ── the beacon ──────────────────────────────────────────────────────────────

/**
 * What a deck shouts, which anybody on the network can hear.
 *
 * NO ACCOUNTS AND NO SECRET. This is the packet a stranger on the same wifi
 * receives, so what is in it is what a stranger learns: that a ccdeck is here,
 * what it calls itself, and two hashes. Not which Anthropic accounts exist on
 * the machine, not how many, not the group passphrase, and nothing derived
 * from the passphrase that could be ground at offline.
 *
 * `group` IS derived from the passphrase, and that needs saying plainly: it is
 * HMAC(groupKey, "beacon-group") — a value that only lets two decks in the same
 * group recognise each other. An eavesdropper sees a 64-bit tag; grinding it
 * back to the passphrase means grinding scrypt, which is exactly the cost that
 * function was chosen for. What it buys is that a deck with the wrong
 * passphrase is not asked a single question — the packet is dropped by
 * comparison, before any handshake exists to attack.
 */
export function beaconPayload({ name, fp, port, group, instance }) {
  return {
    m: MAGIC,
    v: PROTOCOL,
    n: cleanName(name),
    f: fp,
    p: port,
    g: group,
    // Randomised at start. Two beacons from one fingerprint with different
    // instance ids mean the deck restarted between them, which is the signal to
    // drop whatever session state was held for it rather than trying to resume
    // into a process that no longer exists. Syncthing's field, same job.
    i: instance,
  };
}

/** The tag that says "same group as me", without saying what the group is. */
export function groupTag(key) {
  return createHmac("sha256", key).update("beacon-group").digest("hex").slice(0, 16);
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
  if (typeof raw.g !== "string" || !/^[0-9a-f]{16}$/.test(raw.g)) return null;
  if (typeof raw.i !== "string" || !/^[0-9a-f]{8,32}$/.test(raw.i)) return null;
  return { name: cleanName(raw.n, raw.f), fp: raw.f, port, group: raw.g, instance: raw.i };
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
export function beaconVerdict(beacon, { selfFp, selfGroup }) {
  if (!beacon) return "unreadable";
  if (beacon.fp === selfFp) return "self";
  if (!selfGroup) return "no-group";
  // Constant-time, because this compares a value derived from a secret against
  // one an attacker chooses, once per packet, forever. A byte-at-a-time compare
  // here is a genuine oracle: the network lets them send as many as they like.
  const a = Buffer.from(beacon.group, "hex");
  const b = Buffer.from(selfGroup, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "other-group";
  return "peer";
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
 * FRESHNESS IS `expiresAt`, which is the access token's expiry in ms and is
 * written by the OAuth server at every refresh (`now + expires_in`). A copy
 * that was refreshed more recently therefore carries a strictly larger number,
 * and the comparison needs no clock of ours and no trust in theirs.
 *
 * Four outcomes, and three of them are decided by the LOCAL machine's own
 * verdict rather than by anything the peer claims:
 *
 *   "add"     I do not have this account. `cswap import -` adds it.
 *   "heal"    I have it and claude-swap has quarantined it — refresh token
 *             dead, verified by an invalid_grant from Anthropic, not guessed.
 *             A plain import replaces exactly this case (transfer.py, #136).
 *   "replace" Mine works and theirs is strictly newer. This is the only
 *             outcome that needs `--force`, and the only one where a peer can
 *             overwrite something of mine that was not broken.
 *   null      Nothing to do.
 *
 * The strictness matters. `>` rather than `>=` means two decks holding the same
 * credential do not trade it back and forth forever, each seeing the other's as
 * "not older". And a dead peer copy is refused even when mine is dead too:
 * replacing a broken credential with another broken one is churn that looks
 * like repair.
 */
export function syncAction(mine, theirs) {
  if (!theirs || theirs.dead) return null;
  if (!mine) return "add";
  if (mine.dead) return "heal";
  const a = Number(mine.expiresAt);
  const b = Number(theirs.expiresAt);
  if (!Number.isFinite(b)) return null;
  if (!Number.isFinite(a)) return "replace";
  return b > a ? "replace" : null;
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
 * Emails are in it, in the clear (inside the encrypted channel). That is a
 * deliberate line: a manifest is only ever sent to a deck that has already
 * proved it holds the passphrase, and the panel has to name the account it is
 * offering to heal. Hashing the email would buy nothing against that reader and
 * would cost the one thing the row needs to say.
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
    .map(a => ({ key: a.key, email: a.email, expiresAt: a.expiresAt ?? null, dead: !!a.dead }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
