// The rules for finding other decks on this network and agreeing who is in the
// group. No sockets, no timers, no filesystem — those live in lan-beacon.mjs and
// lan-socket.mjs, and everything here is a pure function so the suite can run
// all of it on one machine, which is the only machine there is.
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
import { createHash } from "node:crypto";
import os from "node:os";
// What two decks say once one has dialled the other — the keys, the proofs and
// the seals — is lan-wire.mjs's, and so is PROTOCOL, which the beacon below
// carries: every label there is derived under it, and that file cannot import
// from this one, which re-exports it. Re-exported, so what imports them from
// here still does.
import { PROTOCOL } from "./lan-wire.mjs";
export {
  challengeFor, credentialAad, ephemeralPair, fingerprint, frameChannel, frameKeys, handshakeTranscript,
  identityFrom, mixesEphemeral, open, proof, proofOk, readChallenge, readEphemeral, readPub, seal, sealsFrames,
  sessionKey, transferChallenge,
  EPHEMERAL, PROTOCOL, SEALS,
} from "./lan-wire.mjs";
// Which copy of a login wins, what a deck tells its peers about the logins it
// holds, and why one did not move, read nothing of the beacon below or of the
// wire — see lan-copies.mjs. Re-exported, so what imports them from here still
// does.
export {
  accountKey, currentFor, heardCurrent, manifestFor, offered, onePerKey, peerWhy, plan, slotFor, syncAction,
  HERE, SENDER_UNREADABLE,
} from "./lan-copies.mjs";

/** Marks a packet as ours before anything reads a field of it. Four bytes of
 *  ASCII rather than a number, so a stray packet on the port is recognisable
 *  in a capture as "something else's" rather than as a corrupt one of ours. */
export const MAGIC = "CCDK";

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

// ── the beacon ──────────────────────────────────────────────────────────────

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
 * Whether a beacon is one this deck should act on, and if not, why not.
 *
 * A reason rather than a boolean, because each answer asks for something
 * different: a packet that is not a beacon, this deck's own echo, or another
 * deck on this computer is nothing to act on; a deck wearing this one's key
 * (`id-clash`) is a key to replace; a paired deck is a peer to note; and a
 * stranger is a row somebody can accept.
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
