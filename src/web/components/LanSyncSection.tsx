// LAN sync, at the bottom of the Accounts panel, where the accounts it is
// about already are.
//
// WHAT IT IS FOR, in one sentence a reader needs before any of the controls
// make sense: a login dies on the machine that has not used it while the same
// account stays alive on the machine that has, and the fix used to be a blob
// copied out of one deck and pasted into another.
//
// PAIRING, NOT A PASSPHRASE, AND THAT REVERSES AN EARLIER DECISION. The first
// version put every deck holding one group passphrase in one group. The
// argument was that a fleet of n decks should not cost n² pairings, and it was
// answering the wrong question. What two people hit on real hardware was this:
// a passphrase that differs by one character produces a closed socket and no
// other symptom, on both machines — and a secret is the one value a panel must
// never print, so neither of them can check theirs against the other's.
//
// So a deck is reached by address, and the deck at that address asks its own
// owner to accept. The trust decision is a named machine at a named address on
// somebody's screen, rather than a string nobody can see.
//
// AND THEN AN INVITE, which is that decision made in advance. Whoever mints one
// has already chosen who to send it to, so the deck that pastes it is paired on
// arrival and nobody presses anything. The two routes are not alternatives:
// `ask to pair` is for a deck you can SEE, an invite for one you cannot — and
// only the invite works when the machine that cannot be seen is this one, since
// an invite is dialled by whoever pastes it. What decides that is not in this
// file; see lan-reach.mjs.
//
// WHAT THIS SECTION IS NOW. An instrument: is it on, who is paired, what
// happened, and who is asking. Every DECISION moved into LanSetupModal, because
// configuration is something you do twice and looking is something you do every
// day.
//
// WHAT IT REFUSES TO SAY. Not "sharing is revocable". Unpairing stops what has
// not happened yet; a refresh token that has left this machine is gone, and the
// only real revocation is a re-login at Anthropic, which kills the session on
// every machine at once.
import { useCallback, useEffect, useRef, useState } from "react";
import { pressAccepted, pressState } from "../panel-press";
import GuideModal from "./GuideModal";
import { LAN_STEPS, LanIntroArt } from "./guide-art";
import LanAddDeckModal from "./LanAddDeckModal";
import LanPeerModal from "./LanPeerModal";
import LanSetupModal from "./LanSetupModal";

/** What a paired deck says about itself, sealed to paired decks only — see
 *  lan-about.mjs. Any field can be missing, and all of them are from a deck
 *  older than the one that started sending them. */
export interface DeckAbout { version: string | null; os: string | null; arch: string | null; at?: number }

/** One account a paired deck offers, as its last manifest listed it. `alive`
 *  is that deck's verdict on its own copy, not this one's. */
export interface OfferedAccount { key: string; email: string; alive: boolean }

/** One deck this one dials, as the status route reports it. */
export interface Peer {
  fp: string;
  /** The identity this row is really about: a heard deck's own fingerprint, or
   *  the one that answered at a typed address. Null while an address has never
   *  answered, which is the only state where there is nothing to name. */
  peerFp?: string | null;
  name: string;
  addr: string;
  port: number;
  manual?: boolean;
  /** A typed address that has answered at least once, so its name is the name
   *  the deck on the other end gave rather than the address we dialled. */
  met?: boolean;
  /** Somebody here pressed accept on this deck. */
  paired?: boolean;
  /** Paired, and this deck has no address to reach it at — it called us and we
   *  said yes, so it calls and we answer. */
  waiting?: boolean;
  lastSeen?: number;
  last?: { at: number; error?: string; done?: Array<{ email: string; action: string; ok: boolean }> } | null;
  /** What it said about itself. Null until it has, and forever for a deck
   *  older than the one that started saying. */
  about?: DeckAbout | null;
  /** The accounts it offered in its last manifest, and when. Null for a deck
   *  this one has never asked — which includes every deck that only calls in. */
  offers?: { at: number; accounts: OfferedAccount[] } | null;
  /** When somebody here accepted it. Null for a pairing made before this was
   *  kept, and for a row that is not paired. */
  pairedAt?: number | null;
}

/** A deck that finished a handshake, or was merely heard, and that nobody here
 *  has accepted yet. */
export interface LanStranger { fp: string; name: string; addr: string; port?: number; at: number }

export interface LanStatus {
  enabled: boolean;
  running: boolean;
  /** When every paired deck was last asked, from the engine. Null until the
   *  first round. */
  checkedAt?: number | null;
  /** Why there is no listener, on a deck that is switched on. Null every other
   *  time — including while it is still coming up. */
  stalled?: string | null;
  name: string;
  /** Whether this deck asks the machines it finds, and whether a request that
   *  arrives is answered here or answered for you. */
  autoAsk?: boolean;
  autoAccept?: boolean;
  fp: string | null;
  port: number | null;
  addrs: string[];
  shared: string[];
  peers: Peer[];
  trusted: Array<{ fp: string; name: string }>;
  invite: LanInvite | null;
  pending: LanStranger[];
  strangers: LanStranger[];
  /** Decks somebody here said no to. They are not asked again and they are not
   *  offered as somebody to pair with; they are listed, with the one control
   *  that takes the answer back. */
  declined?: LanStranger[];
  /** Filled in by the section from prefs, so the modal can list what this deck
   *  dials without asking for prefs a second time. */
  manualRows?: string[];
  /** Whether other decks can reach this one, when the machine could be asked.
   *  Null on every platform this cannot measure and on the first poll after a
   *  start, and both mean the same thing: say nothing. See lan-reach.mjs. */
  reach?: LanReach | null;
  /** This deck's own card, so a peer's version can be read against it. */
  about?: DeckAbout | null;
  /** What somebody here calls other decks, by fingerprint. Applied to every
   *  name this section and the request dialog draw — see deckRows. */
  aliases?: Record<string, string>;
}

/** What lan-reach.mjs concluded, and the command it would have somebody paste.
 *  `steps` is text and only text — nothing here runs, for the reason
 *  relay-guard.mjs wrote down. */
export interface LanReach {
  blocked: boolean;
  why: string;
  category: string;
  alias: string;
  text?: string;
  steps?: string[];
}

/** The accounts this deck holds, in the shape the panel already has them. */
export interface LanAccount { key: string; email: string; alive: boolean }

/** How long ago, in the panel's own vocabulary. Seconds are not printed: a
 *  beacon lands every thirty of them, so "12s ago" would be a number that
 *  changes while you read it and means nothing different from "now". */
export function seenLabel(lastSeen: number | undefined, now: number): string {
  if (lastSeen == null) return "not seen";
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 90) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** What the last round with one peer did: the sentence, and which of the three
 *  things it is. */
export interface RoundLine { text: string; tone: "bad" | "idle" | "ok" }

/**
 * The two refusals that are ANSWERS rather than faults.
 *
 * Both arrive as `last.error`, which is otherwise the network failing, and
 * drawn in that vocabulary they read as breakage: "could not reach it —
 * waiting for the other deck to accept this one" describes a deck that was
 * reached perfectly and is waiting on a person. The row a reader scans for is
 * the one that is wrong, so the two states nobody can fix by fixing anything
 * have to stop wearing the costume of the ones they can.
 *
 * Keyed on the wire's own sentence, which lan-socket.mjs builds — the two files
 * are one protocol and this is the panel's half of it.
 */
const WIRE_ANSWERS: Record<string, RoundLine> = {
  "waiting for the other deck to accept this one": { text: "waiting for them to say yes", tone: "idle" },
  "that deck said no": { text: "it said no", tone: "bad" },
};

/**
 * The faults, in words somebody who does not know what a handshake is can act
 * on — and the prefix that used to carry them, gone.
 *
 * `could not reach it — handshake timed out` is two clauses, an em dash and a
 * protocol noun, in a row that is one line high and 190px wide: it wrapped, and
 * the wrap is what pushed the machine's own name off the row. Every word of the
 * prefix is now said by the row itself — the mark is red and the sentence sits
 * under the name it is about — so what is left to say is what happened.
 *
 * Anything not listed passes through verbatim. A sentence this file has never
 * seen is more useful whole than replaced by a guess, and lan-socket.mjs is
 * free to add one without this map lying about it.
 */
/**
 * The errno codes Node puts in front of an address, said as a thing that
 * happened rather than as a syscall.
 *
 * `connect ECONNREFUSED 192.168.1.229:65059` is what a row was drawing, in
 * three wrapped lines, in a 190px column — the code, the address and the port
 * of a machine whose name is already the first line of the same row. The
 * address is a detail, and details belong on the hover: the row's `title`
 * carries the sentence whole, and the row says what happened.
 */
const FAULT_CODES: Record<string, string> = {
  ECONNREFUSED: "not listening",
  EHOSTUNREACH: "no route to it",
  ENETUNREACH: "no network here",
  ETIMEDOUT: "no answer",
  ECONNRESET: "it hung up",
  EHOSTDOWN: "it is down",
  ENOTFOUND: "name not found",
  EACCES: "blocked here",
  EPIPE: "it hung up",
};

/** What to draw for one failure: the sentence this file knows, the code Node
 *  wrapped in one, or — for anything neither of those — the text itself, whole.
 *  A message this file has never seen is more useful than a guess. */
export function faultText(error: string): string {
  const known = WIRE_FAULTS[error];
  if (known) return known;
  const code = /\b(E[A-Z]{3,})\b/.exec(error)?.[1];
  return (code && FAULT_CODES[code]) || error;
}

const WIRE_FAULTS: Record<string, string> = {
  "handshake timed out": "no answer",
  "peer closed the connection": "it hung up",
  "peer went quiet": "it stopped mid-sentence",
  "bad reply": "it answered with nonsense",
  "no manifest": "it would not say what it has",
  "bad challenge": "it answered as somebody else",
  "a different deck is answering at that address": "a different deck is at that address",
  "that deck could not prove its own key": "it could not prove who it is",
  "the other deck refused this one's proof": "it would not take this deck's word",
  "the other deck refused this handshake": "it turned this deck away",
  "that deck has this one pinned under a different key": "it knows this deck by another key",
};

/**
 * What the last round with one peer did, as a line and a tone.
 *
 * An error is said plainly and is not translated into reassurance: a deck that
 * cannot be reached is a deck that cannot heal anything, and a row that said
 * "waiting" over a refused handshake would be the panel lying about a thing the
 * user can fix on the other machine.
 *
 * THE TONE TRAVELS WITH THE SENTENCE, where it can be tested, rather than being
 * inferred from the string by a stylesheet that cannot. This list is the whole
 * readout of whether the feature works, and the one thing anybody scans a list
 * like this for is which row is wrong.
 */
export function roundLabel(last: Peer["last"], now: number): RoundLine | null {
  if (!last) return null;
  if (last.error) return WIRE_ANSWERS[last.error] ?? { text: faultText(last.error), tone: "bad" };
  const done = last.done ?? [];
  // NOT "nothing to do", which reads two ways and one of them is alarming: a
  // reader cannot tell it from "nothing is shared, so there was nothing to
  // send". Two decks whose logins all work is the steady state of this feature
  // and the sentence says so.
  if (!done.length) return { text: `all logins fine · ${seenLabel(last.at, now)}`, tone: "idle" };
  const ok = done.filter(d => d.ok);
  const verb = ok.length === 1 ? "login" : "logins";
  return ok.length === done.length
    // "arrived", because a round only ever pulls: roundWith dials, reads the
    // other deck's manifest and imports. Nothing leaves this deck on a round it
    // started, and "took 2 accounts" left which way it went to the reader.
    ? { text: `${ok.length} ${verb} arrived · ${seenLabel(last.at, now)}`, tone: "ok" }
    // Some moved and some did not, which is neither a clean round nor a failure
    // to reach the deck. It reads as the partial thing it is.
    : { text: `${ok.length} of ${done.length} logins arrived · ${seenLabel(last.at, now)}`, tone: "bad" };
}

/**
 * An address somebody typed, or null.
 *
 * Deliberately strict about the PORT and loose about the host: a host can be a
 * name, an IPv4, or a bracketed IPv6, and this side cannot tell a typo from a
 * hostname it has never heard of — the network will. A port is a number in a
 * known range, and getting that wrong means dialling nothing forever, which is
 * a row that reports an error every minute and can never come right.
 *
 * The last colon splits, not the first, so `[fe80::1]:5000` keeps its address.
 */
/** How often to ask the deck about the network while it IS on the network.
 *  A pairing request arriving is the point of this section and of the dialog in
 *  App, so both ask at the same cadence and it is a short one. */
export const LAN_POLL_ON_MS = 5_000;

/** …and while it is not.
 *
 *  Nothing can arrive: no beacon is running, nobody can dial in, `pending`
 *  cannot become anything and the peer list cannot change. The only event this
 *  cadence has to catch is somebody switching it on in another tab. Right after
 *  a switch-on nothing can arrive instantly either — a peer has to hear the
 *  beacon first, which is up to thirty seconds — so a poller that is a minute
 *  late to speed up is a minute late for nothing. */
export const LAN_POLL_OFF_MS = 60_000;

/** The shortest gap between arming `unpair` and confirming it that counts as
 *  two decisions. A double-click on the right end of a row armed the verb and
 *  confirmed it in one gesture, and its second press lands before anybody
 *  could have read `sure?` — so a press sooner than this is not an answer. */
export const CONFIRM_GAP_MS = 400;

export function parseAddress(raw: string): { addr: string; port: number } | null {
  const s = (raw ?? "").trim();
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) return null;
  const addr = s.slice(0, at).trim();
  const port = Number(s.slice(at + 1).trim());
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  // AN UNBRACKETED IPv6 ADDRESS SPLITS ON THE WRONG COLON. `fe80::1` parsed as
  // the host `fe80:` on port 1 — a well-formed entry pointing at nothing, which
  // the list then reports as a failure every minute and no correction can fix,
  // because there is nothing visibly wrong with what was typed. Refused here so
  // the dialog can say which of the two forms this deck dials.
  if (addr.includes(":") && !(addr.startsWith("[") && addr.endsWith("]"))) return null;
  return { addr, port };
}

/**
 * Why a write did not happen, in words rather than in silence.
 *
 * Every one of these was silence. The distinction matters because the two cases
 * fail for completely different causes and lead to completely different next
 * moves: a deck that answered `bad_request` has a panel bug behind it, and a
 * deck that answered nothing at all has stopped.
 */
export function writeFailure(what: string, out: { ok?: boolean; reason?: string } | null): string {
  if (out == null) return `Could not ${what} — the deck did not answer.`;
  return out.reason
    ? `Could not ${what} — the deck refused it (${out.reason}).`
    : `Could not ${what}.`;
}

/** Two lists of account keys, same members or not. Order is not meaning here:
 *  the server stores what it is sent, and the panel sends a Set. */
export function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every(k => seen.has(k));
}

/** What this deck is offering, and until when. */
export interface LanInvite { token: string; expiresAt: number }

/** A countdown a person reads while somebody else is reading the token out. */
export function leftLabel(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Is this deck reachable right now?
 *
 * TWO DIFFERENT KINDS OF EVIDENCE, and neither is available for both kinds of
 * peer. A deck found by broadcast says so every thirty seconds, so a recent
 * `lastSeen` is the answer. A deck reached by address never beacons at all, so
 * the only evidence is whether the last round got through — which is exactly
 * what a person means by "is it up".
 *
 * A round that failed is offline whatever the beacon says: a deck this one can
 * hear and cannot talk to is not somewhere you can send an account.
 */
export function isOnline(p: Peer, now: number): boolean {
  // A REFUSAL THAT WAS AN ANSWER IS NOT A FAILURE TO REACH. `waiting for the
  // other deck to accept this one` and `that deck said no` arrive on the same
  // `last.error` channel as a dead socket, and treating them as unreachable put
  // three decks that were plainly there under `this deck cannot reach any of
  // its 3 decks` — while each row said `last online now` two words later.
  // Reported from a screenshot of exactly that contradiction.
  if (p.last?.error && !WIRE_ANSWERS[p.last.error]) return false;
  if (p.last?.at && now - p.last.at < ONLINE_MS) return true;
  if (p.lastSeen != null && now - p.lastSeen < ONLINE_MS) return true;
  return false;
}

/** Three beacon intervals plus slack, the same window the peer table uses to
 *  decide a deck is still present. Two lost packets do not put somebody
 *  offline. */
export const ONLINE_MS = 95_000;

/** Who is here now, and how many are not. The panel shows the first and counts
 *  the second — a list of machines that are switched off is a list nobody
 *  reads, and it is what made this section feel like a settings page. */
export function rosterSplit(peers: Peer[], now: number): { online: Peer[]; offline: Peer[] } {
  const online: Peer[] = [];
  const offline: Peer[] = [];
  for (const p of peers ?? []) (isOnline(p, now) ? online : offline).push(p);
  return { online, offline };
}

/**
 * THE ONE LINE THAT SAYS WHAT IS HAPPENING, which is the thing this section did
 * not have.
 *
 * Every other state was legible only by reading the whole section and working
 * it out — is it on, is anybody there, did the last round do anything, is that
 * invite still good. The panel's own doctrine has had the answer since the
 * freshness column: put the state in a sentence, at the top, in the vocabulary
 * a person would use.
 *
 * The tone travels with it for the same reason roundLabel's does: a stylesheet
 * cannot tell "nobody yet" from "it broke", and those are the two states a
 * reader most needs told apart.
 */
export function sectionState(
  s: { enabled?: boolean; running?: boolean; stalled?: string | null; peers?: Peer[]; pending?: LanStranger[] } | null,
  now: number,
): { text: string; tone: "bad" | "idle" | "ok" | "wait" } {
  // NOT "off". Nothing has been asked yet, and a line that says the feature is
  // switched off before the first answer arrives is a wrong answer given
  // confidently — the switch beside it is drawn from the same missing data.
  if (!s) return { text: "checking…", tone: "idle" };
  // NOTHING, WHILE IT IS OFF. The switch beside it already says so, in the one
  // place a person looks to change it, and the subtitle under the heading says
  // what the feature is for. A sentence that only restates a control the eye has
  // already read is a line of type charging rent for nothing — and this one sat
  // under a switch it could not disagree with.
  if (!s.enabled) return { text: "", tone: "idle" };
  // A DEAD END HAS TO SAY SO. `starting…` was drawn for as long as the process
  // lived when the bind failed — a second deck on one machine takes the first
  // one's port — and a state that cannot resolve and will not say why leaves
  // the reader waiting for the one thing that never comes.
  if (s.stalled) return { text: `could not start — ${s.stalled}`, tone: "bad" };
  if (!s.running) return { text: "starting…", tone: "wait" };
  const asking = (s.pending ?? []).length;
  if (asking) {
    // Somebody is waiting on a person at this keyboard, and that outranks every
    // other state this line can report.
    return {
      text: asking === 1 ? "1 deck is waiting for your answer" : `${asking} decks are waiting for your answer`,
      tone: "wait",
    };
  }
  // THREE BUCKETS, NOT TWO, AND THE THIRD IS WHY THIS LINE USED TO LIE.
  //
  // An address this deck has never reached is not a deck that is away — it is a
  // string somebody typed that may never have been a deck at all, and counting
  // it as an unreachable peer let one typo report the whole fleet as broken.
  //
  // And a deck that CALLS IN is not away either. lan-engine.mjs synthesizes a
  // row for every deck we accepted and hold no address for; it is never dialled,
  // so `last` stays null and `lastSeen` never arrives, so `isOnline` is false
  // for it forever. The old line therefore drew `no paired deck is reachable` in
  // the warning ink over a pairing that was working perfectly — the far deck
  // dials in, and its own row said `reaches us` two lines below.
  const peers = (s.peers ?? []).filter(p => p.paired !== false || p.met);
  if (!peers.length) return { text: "no deck paired yet", tone: "idle" };
  // A DECK THAT CALLS IN IS PRESENT ONLY IF IT HAS CALLED. Being paired is a
  // thing that happened once; a machine that has been switched off for an hour
  // is still paired, and counting it as ready was this line's second lie about
  // the same row. What it has to go on is when it last spoke — lan-engine.mjs
  // times every authenticated frame — held to the same window a beacon is.
  const waiting = peers.filter(p => p.waiting);
  const dialled = peers.filter(p => !p.waiting);
  const calling = waiting.filter(p => !p.last?.error && p.lastSeen != null && now - p.lastSeen < ONLINE_MS);
  const { online, offline: notAnswering } = rosterSplit(dialled, now);
  const offline = [...notAnswering, ...waiting.filter(p => !calling.includes(p))];
  const here = online.length + calling.length;
  // REACHED, AND WAITING ON A PERSON. Every one of them answered — they are as
  // present as a deck can be — and none of them can move a login until somebody
  // at that machine presses accept. Neither `ready` nor `cannot reach` is true
  // of that, and the line said the second one over three healthy machines.
  const unanswered = online.filter(p => p.last?.error === "waiting for the other deck to accept this one");
  if (here && unanswered.length === here) {
    return {
      text: here === 1
        ? "1 deck found · waiting for them to accept"
        : `${here} decks found · waiting for them to accept`,
      tone: "wait",
    };
  }
  if (!here) {
    // Named and directional. "Not reachable" says nothing about which side
    // cannot do what, and a reader who does not know the answer cannot act.
    return {
      text: offline.length === 1
        ? "this deck cannot reach the one it is paired with"
        : `this deck cannot reach any of its ${offline.length} decks`,
      tone: "bad",
    };
  }
  const ready = here === 1 ? "1 deck ready" : `${here} decks ready`;
  return { text: offline.length ? `${ready} · ${offline.length} away` : ready, tone: "ok" };
}

/**
 * WHEN THE LAST ROUND RAN, in a phrase rather than in a timestamp.
 *
 * `seenLabel` answers "now" inside its first ninety seconds, which is right
 * everywhere it is used as a column and wrong the moment a verb is put in front
 * of it: `checked now` reads for half a beat as an instruction rather than as a
 * report. Only that one value needs the extra word — `checked 3m ago` is
 * already a sentence.
 */
export function checkedLabel(at: number | null | undefined, now: number, busy: boolean): string {
  if (busy) return "checking…";
  if (at == null) return "not checked yet";
  const when = seenLabel(at, now);
  return when === "now" ? "checked just now" : `checked ${when}`;
}

/** How long a request has been waiting. Coarser than the peer clock on purpose:
 *  the answer is a press, and "4m ago" changes nothing about whether to make
 *  it. */
export function askedLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** One line in the panel's list of machines. */
export type DeckKind = "asks" | "paired" | "dialling" | "nearby" | "declined";

export interface DeckRow {
  fp: string;
  name: string;
  /** The name that deck gives itself, present only when somebody here gave it
   *  another one — so `name` is what to draw everywhere and this is what the
   *  deck's own dialog says under it. */
  self?: string;
  addr: string;
  kind: DeckKind;
  /** What this deck is doing, in the words a person would use. */
  state: string;
  tone: RoundLine["tone"] | "wait";
  /** Drawn as live: the emitter rather than the still dot. */
  here: boolean;
  /** Nothing to report: online, and the last round found nothing to repair.
   *  The sentence still exists — a screen reader is read it, and it is what
   *  `.vis-hidden` is for — it is simply not drawn, because a line every
   *  healthy row carries identically is a line that cannot be scanned. */
  quiet?: boolean;
  /** The whole of it, for the hover and the accessible name — a row is 190px
   *  wide and a sentence that fits there cannot also explain a direction. */
  hint: string;
}

/** A deck that is paired, holds no address here, and reaches this one by
 *  calling it.
 *
 *  `one-way` first, because that is the word a reader can act on without
 *  knowing anything about sockets, and the whole sentence has to fit the 190px
 *  it is given — the honest long form ran to two lines on every row that wore
 *  it, in a list where three of them can be true at once. What it costs is
 *  said in full in the row's hint.
 *
 *  WHEN it last called is the other half, and the half that was missing. This
 *  deck does not dial such a peer and does not hear a beacon from it, so being
 *  PAIRED was the only thing the row knew — and a Windows deck that had been
 *  closed for an hour still drew live, with the section counting it as ready.
 *  Reported from a screenshot of exactly that. lan-engine.mjs times every
 *  authenticated frame now, so the row can say the one thing that matters about
 *  a machine nothing here can reach: whether it has been in touch. */
function callsIn(lastSeen: number | undefined, now: number): { text: string; here: boolean } {
  if (lastSeen == null) return { text: "one-way · has not called yet", here: false };
  const fresh = now - lastSeen < ONLINE_MS;
  return {
    text: fresh ? "online · one-way, it calls in" : `one-way · last online ${seenLabel(lastSeen, now)}`,
    here: fresh,
  };
}

/**
 * WHETHER IT IS THERE NOW, AND WHEN IT LAST WAS.
 *
 * The row said what the last ROUND did — `all logins fine · 3m ago` — and a
 * reader looking at a list of machines is asking something simpler first: is
 * that one on? A time on its own does not answer it either; `12m ago` is a
 * number with no noun, and it was doing the work of both.
 *
 * So presence leads and the detail follows it. `online` is the word, and the
 * moment it is not true the same slot says when it last was — which is the
 * thing somebody wants when the machine they need is switched off.
 */
export function presenceLabel(p: Peer, here: boolean, now: number): string {
  if (here) return "online";
  if (p.lastSeen != null) return `last online ${seenLabel(p.lastSeen, now)}`;
  // Never once. Two different nevers, and the difference is whose move it is:
  // an address this deck dials has never answered, and a deck that calls in has
  // never called.
  return p.waiting ? "has not called yet" : "never reached";
}

/**
 * EVERY DECK ON ONE LIST, which is the whole of this redesign.
 *
 * The five things a machine on the network can be to this one lived in four
 * places: a request was in the panel, a paired deck in the panel's roster, a
 * deck nearby was two clicks into a dialog, an address somebody typed was
 * indistinguishable from a paired deck, and a deck somebody had said no to was
 * nowhere at all. So "who is out there and what is happening with them" — the
 * only question anybody opens this section to ask — could not be answered by
 * looking at any one surface.
 *
 * They are one list because they are one question. What differs between them is
 * the sentence under the name and the verb on the end, and that is exactly what
 * a list is for.
 *
 * THE ORDER IS WHAT IS OWED TO WHOM, AND THEN IT IS ALPHABETICAL. A request is
 * somebody waiting on an answer from this keyboard, so it is first; then the
 * decks that are paired, then the addresses still being tried, then machines
 * nearby, then the ones already answered. WITHIN a kind the order is by name
 * and never by liveness — sorting the paired decks by whether they answered
 * last made a row change position between two five-second polls on a lost
 * beacon, in a list somebody is scanning for one machine.
 */
export function deckRows(
  s: {
    peers?: Peer[]; pending?: LanStranger[]; strangers?: LanStranger[]; declined?: LanStranger[];
    aliases?: Record<string, string>;
  } | null,
  now: number,
): DeckRow[] {
  if (!s) return [];
  const rows: DeckRow[] = [];
  const seen = new Set<string>();
  const byName = (a: DeckRow, b: DeckRow) => a.name.localeCompare(b.name, undefined, { numeric: true });
  // WHAT SOMEBODY HERE CALLS IT, when they have said. Keyed by fingerprint, so
  // it follows the machine rather than the name the machine gives itself — and
  // that name is kept as `self`, for the one surface that says both. Sorting
  // and the duplicate check below both read the name that is drawn.
  const aliases = s.aliases ?? {};
  const named = (fp: string | null | undefined, own: string): { name: string; self?: string } => {
    const given = fp ? aliases[fp] : undefined;
    return given && given !== own ? { name: given, self: own } : { name: own };
  };

  for (const p of s.pending ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    const n = named(p.fp, p.name || p.fp);
    rows.push({
      fp: p.fp, name: n.name, ...(n.self ? { self: n.self } : {}), addr: p.addr ?? "",
      kind: "asks", state: `wants to pair · ${askedLabel(p.at, now)}`, tone: "wait", here: true,
      hint: `${n.name} at ${p.addr} is waiting for an answer.`,
    });
  }

  const paired: DeckRow[] = [];
  const dialling: DeckRow[] = [];
  for (const p of s.peers ?? []) {
    const fp = p.peerFp ?? p.fp;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    const line = roundLabel(p.last, now);
    const here = isOnline(p, now);
    const where = p.addr ? `${p.addr}:${p.port}` : "";
    // AN ADDRESS THAT HAS NEVER ANSWERED IS NOT A PAIRED DECK. It wore the
    // paired row and the paired verb, and `unpair` on it named a fingerprint
    // built out of the address — which matches nothing this deck ever met, so
    // the one control on the row answered `could not unpair that deck`. One
    // typo made a row that failed every minute and could not be removed.
    if (!p.paired && p.manual && !p.met) {
      dialling.push({
        fp: where, name: where || p.name || fp, addr: p.addr ?? "",
        kind: "dialling",
        // No presence clause: the row IS "an address nothing has answered at",
        // so saying it twice is the panel repeating itself.
        state: line ? line.text.replace(/ · .*$/, "") : "trying…",
        tone: line ? line.tone : "idle",
        here: false,
        hint: p.last?.error
          ? `Nothing has answered at ${where} yet — ${p.last.error}.`
          : `Dialling ${where} until something answers.`,
      });
      continue;
    }
    // The one-way case, said out loud. A deck this one holds no address for
    // heals ITSELF from here and can never heal this one, because a round only
    // ever pulls — see roundWith. "reaches us" was true, cheerful, and hid the
    // half that matters to somebody whose own login has expired.
    const called = p.waiting ? callsIn(p.lastSeen, now) : null;
    const present = called ? called.here : here;
    // Presence first, then whatever the last round has to add — and the round's
    // own clock is dropped when the row is online, because `online` already
    // dates it and two timestamps in 190px is one too many.
    const said = !called && line
      ? (present ? `online · ${line.text.replace(/ · .*$/, "")}` : `${line.text.replace(/ · .*$/, "")} · ${presenceLabel(p, present, now)}`)
      : called ? called.text
      : presenceLabel(p, present, now);
    // A deck that has been reached and is waiting on a PERSON is neither fine
    // nor broken, and painting it as a fault made three healthy machines read
    // as a network problem. The tone follows what a reader can do about it:
    // nothing here, something over there.
    const answered = p.last?.error ? WIRE_ANSWERS[p.last.error] : null;
    // THE STEADY STATE IS SILENCE. Every healthy row said `online · all logins
    // fine` — the same twenty-four characters under every name, in a list whose
    // whole job is to make the odd row findable. The dot already says online and
    // says it in a shape as well as a colour; what is left is a round that found
    // nothing to do, which is the state a reader learns by there being nothing
    // to read. A round that MOVED something still says so, and so does every
    // failure, every wait and every machine that is not there.
    const quiet = !called && present && !p.last?.error && !(p.last?.done ?? []).length;
    // An address nothing has answered at has no identity to hang a name on.
    const n = p.manual && !p.met ? { name: where } : named(fp, p.name || fp);
    paired.push({
      fp,
      name: n.name,
      ...(n.self ? { self: n.self } : {}),
      addr: p.addr ?? "",
      kind: "paired",
      state: said,
      quiet,
      tone: answered ? (answered.tone === "bad" ? "bad" : "wait")
        : line ? line.tone
        : present ? "ok" : "idle",
      // NOT "paired, therefore here". Being paired says what happened once; it
      // says nothing about whether that machine is switched on now, and drawing
      // it live on that evidence is the panel inventing a fact.
      here: called ? called.here : here,
      hint: called
        ? `${n.name} calls this deck, and this deck has no address to call back on — so it can repair its logins from here, and this deck cannot repair from it. ${
            p.lastSeen == null ? "It has not called since this deck started." : `It last called ${seenLabel(p.lastSeen, now)}.`
          } Add its address with the + at the top of this section to reach it either way.`
        // The whole sentence, verbatim, including the address and the code the
        // row is too narrow to carry. This is where somebody looks when the
        // short form is not enough.
        : `${n.name}${where ? ` at ${where}` : ""}${p.last?.error ? ` — ${p.last.error}` : ""}`,
    });
  }
  rows.push(...paired.sort(byName), ...dialling.sort(byName));

  const nearby: DeckRow[] = [];
  for (const p of s.strangers ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    const n = named(p.fp, p.name || p.fp);
    nearby.push({
      fp: p.fp, name: n.name, ...(n.self ? { self: n.self } : {}), addr: p.addr ?? "",
      kind: "nearby", state: "not paired yet", tone: "idle", here: true,
      hint: `${n.name} at ${p.addr} is on this network and nothing is shared with it.`,
    });
  }
  rows.push(...nearby.sort(byName));

  const declined: DeckRow[] = [];
  for (const p of s.declined ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    const n = named(p.fp, p.name || p.fp);
    declined.push({
      fp: p.fp, name: n.name, ...(n.self ? { self: n.self } : {}), addr: p.addr ?? "",
      kind: "declined", state: "you said no", tone: "idle", here: false,
      hint: `${n.name} asked and was turned away. It is not asking any more.`,
    });
  }
  rows.push(...declined.sort(byName));

  // TWO MACHINES WITH ONE NAME ARE TWO ROWS A READER CANNOT TELL APART, and the
  // name is a string somebody typed — two colleagues who never renamed their
  // deck have the same one, and so does one person's laptop before and after a
  // reinstall. The address is what differs, so it is drawn under the name of
  // exactly the rows that need it, and of no others: a list where every row
  // carries an address to guard against a collision that usually is not there
  // has paid for all of them.
  const times = new Map<string, number>();
  for (const r of rows) times.set(r.name, (times.get(r.name) ?? 0) + 1);
  for (const r of rows) {
    if ((times.get(r.name) ?? 0) < 2 || !r.addr) continue;
    r.state = r.quiet || !r.state ? r.addr : `${r.addr} · ${r.state}`;
    r.quiet = false;
  }

  return rows;
}

/** A list of decks with the names somebody here gave them — deckRows' rule,
 *  for the surfaces that are not a row: the request dialog over the canvas. */
export function withAliases<T extends { fp: string; name: string }>(
  list: T[],
  aliases: Record<string, string> | null | undefined,
): T[] {
  if (!aliases) return list;
  return list.map(p => (aliases[p.fp] ? { ...p, name: aliases[p.fp] } : p));
}

/** What one row was built from, for that deck's own dialog. */
export interface RowSource { peer?: Peer | null; stranger?: LanStranger | null }

/** The peer or stranger behind a row, out of the same status the row came
 *  from and matched the way deckRows keyed it — so the dialog and the row can
 *  never be about two different machines. */
export function rowSource(s: LanStatus | null, row: DeckRow): RowSource {
  if (!s) return {};
  switch (row.kind) {
    case "paired": return { peer: (s.peers ?? []).find(p => (p.peerFp ?? p.fp) === row.fp) ?? null };
    case "dialling": return { peer: (s.peers ?? []).find(p => p.manual && !p.met && `${p.addr}:${p.port}` === row.fp) ?? null };
    case "nearby": return { stranger: (s.strangers ?? []).find(p => p.fp === row.fp) ?? null };
    case "declined": return { stranger: (s.declined ?? []).find(p => p.fp === row.fp) ?? null };
    case "asks": return { stranger: (s.pending ?? []).find(p => p.fp === row.fp) ?? null };
  }
}

/** Two versions against each other: negative when `a` is older, positive when
 *  newer, 0 when they match — and null when either is not a version this can
 *  read, so the dialog prints the number alone rather than guessing. Only the
 *  three numbers count; a pre-release tag is not something a reader compares. */
export function versionOrder(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a ?? "");
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b ?? "");
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * One login another deck offers, and what it would do HERE.
 *
 * The engine's rules, said in words. A copy that does not work there moves
 * nothing. One this deck lacks arrives on the next round, whatever this deck
 * shares. One that is expired here is repaired only if this deck shares it
 * too — a heal replaces a slot, so it needs this deck's own tick, and an add
 * does not (see roundWith). The last case is the one worth the warning ink:
 * it is the only one somebody here can fix, and the fix is a tick.
 *
 * TWO CELLS, NOT A SENTENCE. This was one string — `works there · works here`,
 * `broken there · not on this deck` — and a reader had to take it left to
 * right and hold both halves to see which one they could act on. It is a 2×2
 * fact (their copy × this deck's), so it is returned as two, and the dialog
 * puts each in its own column. What that buys is a single left edge under
 * `here`: the column somebody scans, because `here` is the only half anything
 * on this screen can change — a round only ever pulls.
 *
 * `note` is what HAPPENS NEXT, and it is null for every state where the
 * answer is "nothing". So the note exists on exactly the rows worth reading,
 * and it is the note — not the state — that carries the ink.
 */
export function offerLine(
  theirs: OfferedAccount,
  mine: LanAccount | null,
  sharedHere: boolean,
): { there: string; here: string; note: string | null; tone: "ok" | "wait" | "bad" | "idle" } {
  const here = !mine ? "not on this deck" : mine.alive ? "works here" : "expired here";
  if (!theirs.alive) {
    // BOTH COPIES GONE is the one state with no repair anywhere, and it used
    // to wear the same warning ink as the state that is fixed with one tick.
    // Warn ink says act; this one says the act is not here, so it names the
    // only thing that does work — the words the accounts panel already uses.
    const note = mine && !mine.alive ? "neither copy works — sign in again here" : null;
    return { there: "broken there", here, note, tone: note ? "bad" : "idle" };
  }
  // `here` stays what IS, and the note says what WILL BE. The old string put
  // `arrives here next round` in the state slot, which left a reader unable to
  // tell the present from the promise.
  if (!mine) return { there: "works there", here, note: "arrives next round", tone: "wait" };
  if (mine.alive) return { there: "works there", here, note: null, tone: "ok" };
  return sharedHere
    ? { there: "works there", here, note: "repairs next round", tone: "wait" }
    : { there: "works there", here, note: "share it to repair", tone: "bad" };
}

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

export default function LanSyncSection({ accounts, onChanged }: {
  accounts: LanAccount[];
  /** The roster changed under us — a healed account is a different row. */
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [manual, setManual] = useState<string[]>([]);
  /** WHICH control is working, not WHETHER one is — the tagged slot #518 wrote
   *  for this panel, which this section was spelling as one boolean.
   *
   *  It read the same to the eye only because nothing painted `aria-busy`. Now
   *  that something does, a shared boolean would light the switch, `setup…` and
   *  every accept at once on a press of any one of them — six controls claiming
   *  to be working when one is. The tag is what makes `pressState` able to tell
   *  "yours" from "somebody else's", which is the whole of the rule. */
  const [busy, setBusy] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  /** Which unpair is armed. The account rows above have made an irreversible
   *  press cost a second deliberate one since the panel was written; this row
   *  is the same act against a different noun. */
  const [armed, setArmed] = useState<string | null>(null);
  /** When `armed` was set, so a double-click cannot be its own confirmation —
   *  see CONFIRM_GAP_MS. */
  const armedAt = useRef(0);
  /** The dialog that holds the two ways of reaching a deck the network could
   *  not offer. A DIALOG RATHER THAN A DRAWER IN THIS COLUMN: an address is
   *  monospace, an invite is 140 characters and the firewall block is a
   *  paragraph and a shell command — unfolded in 288px they turned a list of
   *  machines into a form with a list on top of it. */
  const [addOpen, setAddOpen] = useState(false);
  /** The four pictures that say what this section is for and what to do on
   *  each machine. Opened from a press only — the card while the section is
   *  off, and the word under an empty list — never from a flag. */
  const [guideOpen, setGuideOpen] = useState(false);
  /** Whether the decks that are not on are showing. Shut by default and kept
   *  for the session only: which decks are off changes while you watch, and a
   *  remembered fold would be about a list that no longer exists. */
  const [foldOpen, setFoldOpen] = useState(false);
  /** The one thing this section could not say. See writeFailure. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Read by the press guard rather than the state, because `busy` is a render
   *  behind: two clicks in the same frame both see `null` and both fire. */
  const busyRef = useRef<string | null>(null);

  /** Take the section's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => {
    busyRef.current = null;
    if (alive.current) setBusy(null);
  }, []);
  /** Inert while somebody else is working; busy and still focusable while it is
   *  your own request. Spread rather than written out per control, so there is
   *  one answer rather than one per button. */
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  /** The cadence to use next, decided by the answer that just came back. Held
   *  in a ref rather than in state because it steers a timer rather than a
   *  render, and a re-render per tick is what this whole change is against. */
  const every = useRef<number>(LAN_POLL_ON_MS);

  const load = useCallback(async () => {
    try {
      const [lan, prefs] = await Promise.all([
        fetch("/api/lan").then(r => r.json()),
        fetch("/api/prefs").then(r => r.json()),
      ]);
      if (!alive.current) return;
      if (lan?.ok) setStatus(lan);
      if (prefs?.ok) setManual(Array.isArray(prefs.prefs?.lan?.manual) ? prefs.prefs.lan.manual : []);
      every.current = lan?.enabled === true ? LAN_POLL_ON_MS : LAN_POLL_OFF_MS;
    } catch { /* the deck is down; the connection banner already says so */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    // A TIMEOUT CHAIN, NOT AN INTERVAL, so the cadence can change without the
    // effect being torn down and rebuilt.
    //
    // Five seconds while the network is ON: a pairing request arriving is the
    // point of this section, and it has to show up without a press. A minute
    // while it is OFF, where five seconds buys nothing at all — no beacon is
    // running, nobody can dial in, `pending` cannot become anything, and the
    // peer list cannot change. The only thing that can happen is somebody
    // turning it on in ANOTHER tab, and a minute is soon enough to notice that.
    //
    // Measured before this: three requests every five seconds, forever, for a
    // section reading "off — this deck is not on the network". Fifty-two
    // thousand a day.
    let timer = 0;
    const tick = async () => {
      setNow(Date.now());
      await load();
      if (alive.current) timer = window.setTimeout(tick, every.current);
    };
    void tick();
    return () => { alive.current = false; window.clearTimeout(timer); };
  }, [load]);

  const toggle = useCallback(async () => {
    const on = status?.enabled === true;
    if (!claim("switch")) return;
    try {
      const out = await post("/api/prefs", { lan: { enabled: !on } });
      if (!alive.current) return;
      if (out?.ok) {
        setFailure(null);
        // NOBODY GOES ON THE NETWORK WITHOUT HAVING SEEN WHAT GOES WITH THEM.
        // Switching on puts this deck's name in a beacon every other machine
        // hears and offers whichever logins the share list already holds — two
        // facts that lived one press deeper, behind `name & shared logins`, so
        // the ordinary way to turn this on was to turn it on and never look.
        // Every time and not only the first: what is shared changes between one
        // switch-on and the next, and a dialog shown once is a dialog about a
        // list that has since moved.
        //
        // OFF→ON ONLY, AND FROM THE PRESS RATHER THAN FROM `status.enabled`.
        // Reading the flag instead would pop this in front of somebody who
        // pressed nothing — on a reload, on the first poll of a deck that was
        // already on, or when the server switched it on by itself.
        if (!on) setSetupOpen(true);
      } else {
        setFailure(writeFailure(on ? "turn this off" : "turn this on", out));
      }
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure(on ? "turn this off" : "turn this on", null));
    } finally {
      release();
    }
  }, [status?.enabled, load, claim, release]);

  /** Every verb the list has, through the one route that owns them. What each
   *  one MEANS is on the button; what they share is that the fingerprint comes
   *  from what this deck met on the wire and never from the page.
   *
   *  Answers with the sentence it put in the failure line, or null — so a
   *  deck's own dialog, which sits over that line, can say it where it is. */
  const answer = useCallback(async (
    action: "accept" | "dismiss" | "unpair" | "allow",
    fp: string,
    what: string,
  ): Promise<string | null> => {
    // Tagged per ROW rather than per section: two decks asking at once light
    // only the row that was actually pressed.
    if (!claim(`${action}:${fp}`)) return null;
    let said: string | null = null;
    try {
      const out = await post("/api/lan/peer", { action, fp });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else { said = writeFailure(what, out); setFailure(said); }
      await load();
    } catch {
      said = writeFailure(what, null);
      if (alive.current) setFailure(said);
    } finally {
      release();
    }
    return said;
  }, [load, claim, release]);

  /** Stop dialling an address that never answered.
   *
   *  Through prefs rather than through /api/lan/peer, because there is nothing
   *  to unpair: no deck was ever met here, and the row's fingerprint is a
   *  placeholder built out of the address. `setPeers` replaces the dial list
   *  wholesale on every prefs write, so filtering the entry out is the whole of
   *  the removal. */
  const dropAddress = useCallback(async (entry: string): Promise<string | null> => {
    if (!claim(`drop:${entry}`)) return null;
    let said: string | null = null;
    try {
      const out = await post("/api/prefs", { lan: { manual: manual.filter(m => m !== entry) } });
      if (!alive.current) return null;
      if (out?.ok) { setFailure(null); onChanged(); }
      else { said = writeFailure("stop dialling that address", out); setFailure(said); }
      await load();
    } catch {
      said = writeFailure("stop dialling that address", null);
      if (alive.current) setFailure(said);
    } finally {
      release();
    }
    return said;
  }, [manual, load, onChanged, claim, release]);

  /** Which deck's own dialog is open, by the fingerprint its row is keyed on.
   *  A key rather than a row, so the dialog redraws from every poll — and a
   *  deck that changes kind under it, asked and then paired, stays open on the
   *  same machine. */
  const [peerOpen, setPeerOpen] = useState<string | null>(null);

  /** Give a deck a name of this deck's own, or take it back with "". Its own
   *  dialog is the only caller, so the answer is the sentence to show there
   *  rather than a line in the section behind it. */
  const rename = useCallback(async (fp: string, name: string): Promise<string | null> => {
    if (!claim(`alias:${fp}`)) return "Something else is still being saved. Try again in a moment.";
    try {
      const out = await post("/api/lan/peer", { action: "alias", fp, name });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); return null; }
      return writeFailure("rename that deck", out);
    } catch {
      return writeFailure("rename that deck", null);
    } finally {
      release();
    }
  }, [claim, release]);

  /** One deck, now, from its own dialog. A deck that only calls in has no
   *  address here, and the route says so rather than reporting a round that
   *  asked nobody. */
  const checkOne = useCallback(async (fp: string): Promise<string | null> => {
    if (!claim(`check:${fp}`)) return null;
    try {
      const out = await post("/api/lan/sync", { fp });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); onChanged(); return null; }
      return out?.reason === "no_address"
        ? "There is no address here to call it on. It calls this deck, and it is up to date each time it does."
        : writeFailure("check that deck", out);
    } catch {
      return writeFailure("check that deck", null);
    } finally {
      release();
    }
  }, [claim, release, onChanged]);

  /** Ask every paired deck now rather than at the next tick — for somebody who
   *  has just fixed a login on the other machine and does not want to wait a
   *  minute to see it arrive. */
  const checkNow = useCallback(async () => {
    if (!claim("check")) return;
    try {
      const out = await post("/api/lan/sync", {});
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else setFailure(writeFailure("check the other decks", out));
      onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure("check the other decks", null));
    } finally {
      release();
    }
  }, [claim, release, onChanged]);

  const on = status?.enabled === true;
  const rows = deckRows(status, now);
  // The deck whose dialog is open, found again in every poll's rows. When it
  // is gone — unpaired and not heard since, or an address whose answer just
  // gave it an identity — the dialog closes rather than drawing a machine that
  // is no longer on the list.
  const openRow = peerOpen ? rows.find(r => r.fp === peerOpen) ?? null : null;
  useEffect(() => {
    if (peerOpen && status && !openRow) setPeerOpen(null);
  }, [peerOpen, status, openRow]);
  const asks = rows.filter(r => r.kind === "asks");
  const rest = rows.filter(r => r.kind !== "asks");
  // WHAT IS ON, AND THEN EVERYTHING ELSE. The list answers "who can I use right
  // now", and a machine that is off, or nearby and unpaired, or one somebody
  // said no to, is not an answer to that — it is context, and context does not
  // belong at the same size as the thing itself.
  //
  // WHAT IS NOT HIDDEN IS A PROBLEM. A deck that cannot be reached is exactly
  // the row a reader is scanning for, so folding it away silently would undo
  // the whole point of the tone: the fold COUNTS them, in the warning ink, and
  // one press opens it. A count in the right colour is a smaller lie than no
  // count at all — it is not a lie at all.
  const live = rest.filter(r => r.here);
  const folded = rest.filter(r => !r.here);
  const troubled = folded.filter(r => r.tone === "bad").length;
  // Nothing to lead with means nothing to fold behind: an empty list over a
  // `3 more` is a list that has hidden all of itself.
  const showFolded = foldOpen || live.length === 0;
  const state = sectionState(status, now);
  const paired = rest.filter(r => r.kind === "paired").length;

  return (
    <div className="ap-auto ap-lan">
      <div className="ap-auto-head">
        <h3 className="ap-auto-title">Local network</h3>
        {/* THE ROUND, BESIDE THE SWITCH. It was a full-width button at the foot
            of the section, under the list it refreshes and under a tooltip that
            covered it — and it is the panel's own idiom for exactly this act:
            the accounts header has carried a `↻` since it was written. A glyph
            up here is also the honest size for it, now that the line under the
            title says when the last one ran and most readers will never need to
            press it at all. */}
        {/* THREE ACTS AND A STATE, and the three are one icon family.
            They were `+`, `↻` and `⚙` — three Unicode codepoints out of three
            different blocks, drawn by whichever installed font happened to
            cover each one. Measured, that is 8.7x7.4, 9.8x9.9 and 7.2x7.2 of
            ink in a row of three 24px buttons: the round a third taller than
            the cog beside it, and two different font-sizes here trying to
            correct for it. An icon is drawn, not typed. These are authored at
            the app's own small-icon spec — 13px on a 14 viewBox, 1.3 stroke,
            round caps — which is what the topbar's five and the browser-watch
            modal's cog already are.

            The plus itself was `+ add a deck` at the foot, in the panel's
            word-button costume, beside settings it has nothing to do with. The
            accounts header two sections up has kept a plus for adding one since
            it was written. */}
        {on && (
          <button type="button" className="glyph-btn ap-lan-plus"
            onClick={() => setAddOpen(true)}
            aria-label="Add a deck"
            title="Reach a deck that has not turned up on its own — by address, or with an invite">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M7 2.2v9.6M2.2 7h9.6" />
            </svg>
          </button>
        )}
        {on && paired > 0 && (
          <button type="button" className="glyph-btn ap-lan-check" {...pressProps("check")}
            onClick={() => void checkNow()}
            aria-label={busy === "check" ? "Checking every paired deck" : "Check every paired deck now"}
            title="Ask every paired deck now for anything this deck's expired logins need, instead of waiting for the next round">
            {/* Open at the top right, with the head on the end that comes back
                round — the arc reads as a return rather than as a circle with a
                nick in it, which is what a 300° sweep at this size becomes. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
              <path d="M11.9 2.6v3.7h-3.6" />
            </svg>
          </button>
        )}
        {/* AND THE SETTINGS, on the same row as the three controls that are also
            about this deck rather than about the machines on the list. It was
            `name & sharing` at the foot — a phrase naming a dialog's two fields,
            which is a caption rather than a control, and the last thing left
            down there beside a timestamp. A cog is what every application on
            this machine uses for the same door. */}
        {on && (
          <button type="button" className="glyph-btn ap-lan-set" {...pressProps("setup")}
            onClick={() => setSetupOpen(true)}
            aria-label="This deck's name and shared logins"
            title="This deck's name on the network, and which of its logins it offers">
            {/* SLIDERS, NOT A COG, and the reason is what came back from the
                render. The browser-watch modal draws its settings as a circle
                with eight straight radial spokes, and at 13px that is the
                universal brightness glyph — a sun, in a row about a network.
                Reusing it would have been reuse of a drawing that says the
                wrong thing, next to a plus and a round where the wrong thing is
                readable. A gear with real teeth is mush at this size; two rails
                and two knobs is the shape that stays a setting all the way
                down. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M1.8 4.7h10.4M1.8 9.3h10.4" />
              <circle cx="9.1" cy="4.7" r="1.6" fill="var(--panel)" />
              <circle cx="4.9" cy="9.3" r="1.6" fill="var(--panel)" />
            </svg>
          </button>
        )}
        {/* A track and a knob, like every other switch in this app now — the
            shape lives on `.ap-auto-state`, and the reasoning with it. */}
        <button
          type="button"
          className={`ap-auto-state${on ? " live" : ""}`}
          role="switch"
          aria-checked={on}
          aria-label="Local network sync"
          {...pressProps("switch")}
          onClick={() => void toggle()}
          title={on
            ? "Stop talking to other decks. Nothing is shared while this is off."
            : "Let the decks you pair with repair this one's expired logins"}
        />
      </div>

      {/* WHAT IT IS FOR, WHILE IT IS NOT DOING IT. The sentence answers one
          question — should I turn this on — and a deck that is already on has
          answered it. Left in place it was a line of explanation over a working
          list, on the surface whose whole complaint was that it looked like a
          settings page.

          One verb for one thing, everywhere. The account rows in this panel
          already say `login expired`, so this says expired too — "heal" and
          "dead" were two more words for the same state and a reader scanning
          three of them has to work out that they are one. */}
      {/* AND NOW IT IS A PICTURE AS WELL, and a door. The sentence was the only
          thing a reader deciding whether to turn this on was given, and the
          report was that nobody could tell from it what would happen or what
          to do on the other machine. The drawing says the first half at a
          glance; the press opens the guide that says the rest. */}
      {!on && (
        <button type="button" className="ap-lan-intro" onClick={() => setGuideOpen(true)}
          title="Four pictures: what this does, and what to do on each machine">
          <LanIntroArt />
          <span className="ap-lan-intro-text">Paired machines repair each other&apos;s expired logins.</span>
          <span className="ap-lan-intro-go">See how it works</span>
        </button>
      )}

      {/* WHO IS HERE, IN ONE LINE. Every state this section had was legible only
          by reading the whole thing and working it out. This is the panel's own
          answer, the one the freshness column has made on every account row for
          a year: say the state, at the top, in the words a person would use. */}
      {/* Announced, and it was not: the one line that says whether anything is
          working changes under a reader who is looking at a quota three
          sections up, and a screen reader was told nothing at all. `polite`
          rather than `alert` — the request box beside it is the assertive one,
          and two live regions shouting about one event is one too many. */}
      {/* EMPTY WHEN THERE IS NOTHING WRONG, and empty rather than absent. `N
          decks ready · M away` is the state this feature is in almost all the
          time, and the list underneath says the same thing better: the green
          rows ARE the ready ones and the fold counts the rest. What the line is
          for is every other answer — off, starting, could not start, somebody is
          waiting for you, nothing can be reached — and those are worth a
          sentence.

          The element stays in the DOM with the text taken out, because a live
          region has to exist before its content changes to be announced
          reliably; one inserted at the moment it has something to say is one
          several screen readers say nothing about. An empty <p> draws no line
          box, so it costs no height, and `:empty` takes its margin too. */}
      <p className={`ap-lan-status ${state.tone}`} role="status">
        {state.tone === "ok" ? "" : state.text}
      </p>

      {failure && (
        <div className="ap-failure" role="alert">
          <span className="ap-failure-text">{failure}</span>
          <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}

      {on && (
        <>
          {/* THE REQUEST, AND IT COMES FIRST. Somebody dialled this deck without
              an invite and is waiting; until this is answered nothing moves
              between them. Announced, because it arrives while the reader is
              three sections up looking at a quota — and it also arrives as a
              dialog in front of the canvas, for the reader who is not in this
              panel at all. */}
          {asks.length > 0 && (
            <div className="ap-lan-asks" role="alert">
              {asks.map(p => (
                <div key={p.fp} className="ap-lan-ask">
                  <span className="ap-lan-ask-what">
                    <strong className="ap-lan-peer-name">{p.name}</strong>
                    {" at "}<code className="ap-lan-code">{p.addr}</code>
                    {" wants to pair"}
                  </span>
                  {/* PRINTED, NOT HOVERED. The one security decision in this
                      feature is whether the machine asking is the one you think
                      it is, and the only value that cannot be chosen by whoever
                      is asking is this. It lived in `title=` — a mouse-only,
                      one-second-delayed, screen-reader-silent place — so on the
                      surface that answers most requests it could not be checked
                      at all. The dialog that opens over the deck has printed it
                      since it was written; this is the same fact on the row
                      that does the same job. */}
                  <span className="ap-lan-ask-fp">
                    fingerprint <code className="ap-lan-code">{p.fp}</code>
                  </span>
                  <span className="ap-lan-ask-acts">
                    <button type="button" className="ap-manage-btn" {...pressProps(`accept:${p.fp}`)}
                      onClick={() => void answer("accept", p.fp, "accept that deck")}
                      title={`Talk to this deck from now on. Its fingerprint is ${p.fp} — check it matches the one on their screen before you accept.`}>
                      accept
                    </button>
                    <button type="button" className="ap-manage-btn" {...pressProps(`dismiss:${p.fp}`)}
                      onClick={() => void answer("dismiss", p.fp, "decline that request")}
                      title="Say no. Nothing is shared, and that deck is told rather than left waiting.">
                      decline
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* EVERY OTHER MACHINE, ON ONE LIST. Paired, nearby, and the ones
              already said no to — one row each, with the sentence that says
              what is happening and the one control that changes it. They were
              three lists in two surfaces, and the question a reader has is one
              question. See deckRows. */}
          {(showFolded ? [...live, ...folded] : live).length > 0 && (
            <ul className="ap-lan-here">
              {/* The ones that are on stay at the top when the fold opens.
                  Sorting the whole list by presence would move a row between
                  two five-second polls on a lost beacon; sorting the two GROUPS
                  moves a row only when the thing it reports actually changed. */}
              {(showFolded ? [...live, ...folded] : live).map((p, i) => (
                // NO TOOLTIP. The long sentence it carried — the address, the
                // raw error, why a one-way deck cannot be repaired from — is in
                // the deck's own dialog now: one press away and read to a screen
                // reader, instead of a second late and over the rows below.
                <li key={`${p.kind}:${p.fp}`} className="ap-lan-who" data-tone={p.tone}>
                  <i className={p.here ? "ap-pulse" : "ap-dot"} aria-hidden />
                  {/* THE NAME OWNS THE ROW'S WIDTH, and it did not. The state
                      was the flex item that grew and the name the one that
                      shrank, so a machine's identity — the thing a reader is
                      looking for — collapsed to `192.168.1….` while a sentence
                      that changes every minute took the space and wrapped
                      anyway. They are two lines now, and the second one is
                      allowed to be long.

                      AND THE ROW IS THE DOOR. The button is laid over the whole
                      row, under the verb, so a press anywhere on it opens that
                      machine's dialog and the keyboard's ring goes round the
                      row. The name drawn here is the same words the button
                      says, so a screen reader is told them once, by the
                      button. */}
                  <span className="ap-lan-who-name" aria-hidden>{p.name}</span>
                  {/* Described by the row's own sentence, which sits outside the
                      button: a row reached with Tab is announced with what is
                      happening to that machine, not with its name alone. */}
                  <button type="button" className="ap-lan-who-open" aria-haspopup="dialog"
                    aria-describedby={`lan-who-state-${i}`}
                    onClick={() => setPeerOpen(p.fp)}>
                    <span className="vis-hidden">{p.name}, details</span>
                  </button>
                  {/* One node, two presentations. A row with nothing to report
                      keeps its sentence for anybody being read the list and
                      spends no line on it — `.vis-hidden` is out of flow, and
                      the stylesheet gives such a row a single grid track. */}
                  <span id={`lan-who-state-${i}`} className={p.quiet ? "vis-hidden" : "ap-lan-who-when"}>{p.state}</span>
                  {p.kind === "nearby" && (
                    <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`accept:${p.fp}`)}
                      onClick={() => void answer("accept", p.fp, "reach that deck")}
                      aria-label={`Ask ${p.name} to pair`}
                      title={`Send ${p.name} a request. Somebody at that machine has to accept it before anything is shared. Its fingerprint is ${p.fp}.`}>
                      ask
                    </button>
                  )}
                  {p.kind === "paired" && (
                    // ARMED, like the account row's own remove. Unpairing is
                    // the one thing in this section that cannot be undone from
                    // this section — the other deck has to ask again and
                    // somebody has to answer — and it sat one stray click away,
                    // once per row, in the loudest ink on the surface.
                    <button type="button"
                      className={`ap-manage-btn ap-lan-do danger${armed === p.fp ? " armed" : ""}`}
                      {...pressProps(`unpair:${p.fp}`)}
                      onClick={() => {
                        if (armed !== p.fp) {
                          setArmed(p.fp);
                          armedAt.current = Date.now();
                          window.setTimeout(() => setArmed(a => (a === p.fp ? null : a)), 4_000);
                          return;
                        }
                        // A double-click is one decision, not two: its second
                        // press lands before anybody could have read `sure?`.
                        if (Date.now() - armedAt.current < CONFIRM_GAP_MS) return;
                        setArmed(null);
                        void answer("unpair", p.fp, "unpair that deck");
                      }}
                      aria-label={armed === p.fp ? `Confirm unpairing ${p.name}` : `Unpair ${p.name}`}
                      title={armed === p.fp
                        ? "Press again to stop talking to this deck. Logins it already has stay with it."
                        : "Stop talking to this deck from now on"}>
                      {armed === p.fp ? "sure?" : "unpair"}
                    </button>
                  )}
                  {p.kind === "dialling" && (
                    <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`drop:${p.fp}`)}
                      onClick={() => void dropAddress(p.fp)}
                      aria-label={`Stop dialling ${p.name}`}
                      title="Stop trying this address. Nothing was ever paired here.">
                      stop
                    </button>
                  )}
                  {p.kind === "declined" && (
                    <button type="button" className="ap-manage-btn ap-lan-do" {...pressProps(`allow:${p.fp}`)}
                      onClick={() => void answer("allow", p.fp, "let that deck ask again")}
                      aria-label={`Let ${p.name} ask again`}
                      title="Take the no back. That deck is still trying, so the request comes round again on its own.">
                      allow
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* THE LAST LINE OF THE SECTION, and it holds the two things that are
              true of the list rather than of any deck on it: how much of it is
              folded away, and when it was last asked. They were two lines and a
              boundary apart, each alone on its own row — one word on the left,
              one figure below it, and nothing between them but sixteen pixels.
              One row, two ends, and the section stops there. */}
          {((live.length > 0 && folded.length > 0) || (on && paired > 0)) && (
          <div className="ap-lan-tail">
          {/* The count of what is not on, in the ink that says whether any of it
              matters. A chevron rather than a plus: this is one list with a
              part of it folded, not a second thing to open. */}
          {live.length > 0 && folded.length > 0 && (
            <button type="button" className="ap-lan-word ap-lan-more" aria-expanded={foldOpen}
              onClick={() => setFoldOpen(v => !v)}
              title={foldOpen
                ? "Show only the decks that are on"
                : `Show the ${folded.length} deck${folded.length === 1 ? "" : "s"} that are not answering right now`}>
              <span className={`ap-lan-chev${foldOpen ? " open" : ""}`} aria-hidden>›</span>
              {/* Open, the control offers the reverse of what it did — `2 more`
                  over two rows that are already showing is a label describing
                  the press before last. */}
              {foldOpen ? "fewer" : `${folded.length} more`}
              {!foldOpen && troubled > 0 && (
                <span className="ap-lan-more-bad">
                  {" · "}{troubled} not answering
                </span>
              )}
            </button>
          )}
            {on && paired > 0 && (
              <span className="ap-lan-checked">{checkedLabel(status?.checkedAt, now, busy === "check")}</span>
            )}
          </div>
          )}

          {rest.length === 0 && asks.length === 0 && (
            <>
              <p className="ap-lan-fine">
                No other deck yet. Decks on one network usually find each other on their own;
                when that has not happened, <strong>+</strong> at the top of this section
                reaches one by address or by invite.
              </p>
              {/* The moment somebody has switched this on and is waiting for a
                  first machine is the moment they most want to know what the
                  other machine has to do. */}
              <button type="button" className="ap-lan-word ap-lan-how" onClick={() => setGuideOpen(true)}>
                How it works
              </button>
            </>
          )}

        </>
      )}

      {addOpen && status && (
        <LanAddDeckModal
          status={status}
          manual={manual}
          onClose={() => setAddOpen(false)}
          onChanged={() => { void load(); onChanged(); }}
        />
      )}

      {guideOpen && (
        <GuideModal
          title="How Local network works"
          steps={LAN_STEPS}
          // The guide ends on the act it was describing, while there is one to
          // do. It goes through the same toggle the switch does, so the setup
          // dialog still opens on the press that puts this deck on the network.
          finish={on ? undefined : { label: "Turn it on", act: () => { setGuideOpen(false); void toggle(); } }}
          onClose={() => setGuideOpen(false)}
        />
      )}

      {setupOpen && status && (
        <LanSetupModal
          status={{ ...status, manualRows: manual }}
          accounts={accounts}
          manual={manual}
          onClose={() => setSetupOpen(false)}
          onChanged={() => { void load(); onChanged(); }}
        />
      )}

      {openRow && status && (
        <LanPeerModal
          row={openRow}
          source={rowSource(status, openRow)}
          status={status}
          accounts={accounts}
          now={now}
          busy={busy}
          onClose={() => setPeerOpen(null)}
          onRename={name => rename(openRow.fp, name)}
          onCheck={() => checkOne(openRow.fp)}
          // The row's own verb, through the row's own call — see the row.
          onVerb={() => {
            switch (openRow.kind) {
              case "paired": return answer("unpair", openRow.fp, "unpair that deck");
              case "nearby": return answer("accept", openRow.fp, "reach that deck");
              case "declined": return answer("allow", openRow.fp, "let that deck ask again");
              case "dialling": return dropAddress(openRow.fp);
              default: return Promise.resolve(null);
            }
          }}
          // What this deck offers is this deck's setting, not that deck's —
          // so the door to it closes this dialog on the way through.
          onSettings={() => { setPeerOpen(null); setSetupOpen(true); }}
        />
      )}
    </div>
  );
}
