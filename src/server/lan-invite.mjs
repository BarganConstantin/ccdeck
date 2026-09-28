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
// left open: the first contact is verified rather than believed.
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
