// The invite: one piece of text that lets a deck pair with this one without
// anybody pressing accept, and the two proofs that ride the handshake for it.
// Moved out of lan-sync.mjs, whose protocol version and name rule it uses;
// like everything there, it is pure — no sockets, no timers, no filesystem.
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
// left open: the first contact is verified rather than believed — for as long
// as the code cannot be guessed, which is why it is 128 random bits and not
// something a person would type (#1137; see inviteCode).
//
// THE TOKEN IS THE SECRET, said plainly rather than implied. Whoever holds it
// can pair with this deck until it expires. It is a door key with a timer, not
// an identifier — which is why it is short-lived, single-purpose, and replaced
// the moment it is used.
import { createHmac, randomBytes } from "node:crypto";
import { cleanName, PROTOCOL } from "./lan-sync.mjs";

/** How long an invite is good for. Long enough to paste into a chat and have
 *  somebody read it, short enough that one left in a channel is not a way in
 *  tomorrow. */
export const INVITE_MS = 10 * 60 * 1000;

/** The most addresses an invite may carry. A machine with a VPN, a second card
 *  and a container bridge has three or four; ten is far past honest and keeps a
 *  hand-built token from being a way to make this deck dial a list. */
export const MAX_INVITE_ADDRS = 10;

/** How many proofs of one invite may fail before it is put away (#1137).
 *
 *  Not a guard on the code — 128 bits is not something a few more tries get
 *  any nearer — but a bound on how long a live invite can be worked at, and a
 *  signal: a token presented wrong this often is circulating in some form
 *  nobody here handed out, and the owner is better off making another. Five
 *  rather than one, because one honest paste can reach the deck at several of
 *  its addresses and an old token pasted by mistake should not cost the new
 *  one. */
export const MAX_WRONG_PROOFS = 5;

/** What the token starts with, so a reader can tell at a glance what they have
 *  been sent and a wrong paste is refused before it is parsed. */
export const INVITE_PREFIX = "ccdeck1.";

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = str => Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** How many random bytes an invite's code is: 128 bits, which is past anything
 *  that can be counted through. See inviteCode. */
export const INVITE_CODE_BYTES = 16;

/** The code in a token this version mints: INVITE_CODE_BYTES in base64url,
 *  which is 22 characters and no padding. */
const CODE = /^[A-Za-z0-9_-]{22}$/;

/** The code in a token an OLDER deck minted: six digits. Read, so a deck of
 *  this version can still join one — never minted, so this deck never holds
 *  one. See readInvite. */
const OLDER_CODE = /^[0-9]{6}$/;

/**
 * The invite's secret: 128 bits from the system's random source, spelled in
 * base64url so it rides in the token as 22 characters.
 *
 * IT WAS SIX DIGITS, "a code somebody could read out loud if they had to", and
 * nobody ever had to: the panel shows the whole token to copy, and `join` reads
 * the code out of the pasted token and nowhere else. Six digits is about twenty
 * bits, which a laptop counts through in a second, and both handshake proofs
 * are made over the code and a transcript that crosses the wire — so the
 * proofs kept the code only as well as it could not be guessed (#1137). A
 * secret nobody types can be as long as it needs to be.
 *
 * The bytes go into the code as they came, with nothing reduced or sampled
 * away, so every bit of it is the random source's.
 */
export function inviteCode(rand = randomBytes) {
  return b64url(rand(INVITE_CODE_BYTES));
}

/** Mint one. `addrs` are already `host:port` strings, because which addresses
 *  this machine has is not a question this file can answer.
 *
 *  Never with an older deck's six digits, even when handed one: a code that
 *  can be counted through, held by this deck, is exactly what #1137 retired.
 *  A code that is not this version's kind is refused rather than used. */
export function mintInvite({ addrs, name, now = Date.now(), code = inviteCode() } = {}) {
  if (typeof code !== "string" || !CODE.test(code)) return null;
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
  //
  // SINCE #1137 THE CODE SAYS IT TOO. A token with this version's code was
  // minted by a deck that proves back, so readInvite asks for the proof from
  // one whether or not `pb` survived the trip. The flag stays for what it
  // always meant; a token without it can only ever lower the bar for a token
  // an older deck minted.
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
  // THIS VERSION'S CODE, OR AN OLDER DECK'S SIX DIGITS. Every deck before
  // #1137 mints six digits and refuses any other code, so a token from one of
  // those still joins here, while a token from this version is refused THERE
  // as not an invite, before that deck dials anything. This deck never mints
  // six digits — see mintInvite — so the older kind only ever names a deck
  // that is older.
  const ours = typeof body.c === "string" && CODE.test(body.c);
  if (!ours && !(typeof body.c === "string" && OLDER_CODE.test(body.c))) return null;
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
    // to what it did before rather than refusing the token. Always so for this
    // version's code, which only a deck that proves back mints.
    provesBack: ours || body.pb === 1,
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
