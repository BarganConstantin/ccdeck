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
import LanSetupModal from "./LanSetupModal";

/** One deck this one dials, as the status route reports it. */
interface Peer {
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
}

/** A deck that finished a handshake, or was merely heard, and that nobody here
 *  has accepted yet. */
export interface LanStranger { fp: string; name: string; addr: string; port?: number; at: number }

export interface LanStatus {
  enabled: boolean;
  running: boolean;
  name: string;
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
  if (last.error) return WIRE_ANSWERS[last.error] ?? { text: WIRE_FAULTS[last.error] ?? last.error, tone: "bad" };
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
export function parseAddress(raw: string): { addr: string; port: number } | null {
  const s = (raw ?? "").trim();
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) return null;
  const addr = s.slice(0, at).trim();
  const port = Number(s.slice(at + 1).trim());
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
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
  if (p.last?.error) return false;
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
  s: { enabled?: boolean; running?: boolean; peers?: Peer[]; pending?: LanStranger[] } | null,
  now: number,
): { text: string; tone: "bad" | "idle" | "ok" | "wait" } {
  if (!s?.enabled) return { text: "off — this deck is not on the network", tone: "idle" };
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
  const calling = peers.filter(p => p.waiting && !p.last?.error);
  const dialled = peers.filter(p => !calling.includes(p));
  const { online, offline } = rosterSplit(dialled, now);
  const here = online.length + calling.length;
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
  addr: string;
  kind: DeckKind;
  /** What this deck is doing, in the words a person would use. */
  state: string;
  tone: RoundLine["tone"] | "wait";
  /** Drawn as live: the emitter rather than the still dot. */
  here: boolean;
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
 *  said in full in the row's hint. */
const CALLS_IN = "one-way · it calls this deck";

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
  s: { peers?: Peer[]; pending?: LanStranger[]; strangers?: LanStranger[]; declined?: LanStranger[] } | null,
  now: number,
): DeckRow[] {
  if (!s) return [];
  const rows: DeckRow[] = [];
  const seen = new Set<string>();
  const byName = (a: DeckRow, b: DeckRow) => a.name.localeCompare(b.name, undefined, { numeric: true });

  for (const p of s.pending ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    rows.push({
      fp: p.fp, name: p.name || p.fp, addr: p.addr ?? "",
      kind: "asks", state: `wants to pair · ${askedLabel(p.at, now)}`, tone: "wait", here: true,
      hint: `${p.name || p.fp} at ${p.addr} is waiting for an answer.`,
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
        state: line ? line.text : "trying…",
        tone: line ? line.tone : "idle",
        here: false,
        hint: line
          ? `Nothing has answered at ${where} yet — ${line.text}.`
          : `Dialling ${where} every minute until something answers.`,
      });
      continue;
    }
    paired.push({
      fp,
      name: p.manual && !p.met ? where : (p.name || fp),
      addr: p.addr ?? "",
      kind: "paired",
      // The one-way case, said out loud. A deck this one holds no address for
      // heals ITSELF from here and can never heal this one, because a round
      // only ever pulls — see roundWith. "reaches us" was true, cheerful, and
      // hid the half that matters to somebody whose own login has expired.
      state: line ? line.text : here ? "ready" : p.waiting ? CALLS_IN : p.lastSeen != null ? seenLabel(p.lastSeen, now) : "away",
      tone: line ? line.tone : here ? "ok" : "idle",
      here: here || (!!p.waiting && !p.last?.error),
      hint: p.waiting && !line
        ? `${p.name || fp} calls this deck, and this deck has no address to call back on — so it can repair its logins from here, and this deck cannot repair from it. Add its address with + add a deck.`
        : `${p.name || fp}${where ? ` at ${where}` : ""}`,
    });
  }
  rows.push(...paired.sort(byName), ...dialling.sort(byName));

  const nearby: DeckRow[] = [];
  for (const p of s.strangers ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    nearby.push({
      fp: p.fp, name: p.name || p.fp, addr: p.addr ?? "",
      kind: "nearby", state: "not paired yet", tone: "idle", here: true,
      hint: `${p.name || p.fp} at ${p.addr} is on this network and nothing is shared with it.`,
    });
  }
  rows.push(...nearby.sort(byName));

  const declined: DeckRow[] = [];
  for (const p of s.declined ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    declined.push({
      fp: p.fp, name: p.name || p.fp, addr: p.addr ?? "",
      kind: "declined", state: "you said no", tone: "idle", here: false,
      hint: `${p.name || p.fp} asked and was turned away. It is not asking any more.`,
    });
  }
  rows.push(...declined.sort(byName));

  return rows;
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
  /** The block that holds the two ways of reaching a deck that is not on the
   *  list. Shut by default: it is the thing you do once, and the list is the
   *  thing you read every day. */
  const [addOpen, setAddOpen] = useState(false);
  const [addrDraft, setAddrDraft] = useState("");
  const [joinDraft, setJoinDraft] = useState("");
  /** WHICH thing was copied, not WHETHER something was — the block has two copy
   *  buttons and a boolean would light both. */
  const [copied, setCopied] = useState<string | null>(null);
  /** Which addresses a failed join tried, and what each one said. An invite
   *  carries several because nobody knows which routes; when none did, that
   *  list is the only thing the reader can act on. */
  const [tried, setTried] = useState<Array<{ addr: string; why: string }> | null>(null);
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

  const load = useCallback(async () => {
    try {
      const [lan, prefs] = await Promise.all([
        fetch("/api/lan").then(r => r.json()),
        fetch("/api/prefs").then(r => r.json()),
      ]);
      if (!alive.current) return;
      if (lan?.ok) setStatus(lan);
      if (prefs?.ok) setManual(Array.isArray(prefs.prefs?.lan?.manual) ? prefs.prefs.lan.manual : []);
    } catch { /* the deck is down; the connection banner already says so */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // Same cadence the rest of this panel polls at. A request arriving is the
    // point of the section, so it has to show up without a press.
    const iv = window.setInterval(() => { setNow(Date.now()); void load(); }, 5_000);
    return () => { alive.current = false; window.clearInterval(iv); };
  }, [load]);

  const toggle = useCallback(async () => {
    const on = status?.enabled === true;
    if (!claim("switch")) return;
    try {
      const out = await post("/api/prefs", { lan: { enabled: !on } });
      if (!alive.current) return;
      if (out?.ok) setFailure(null);
      else setFailure(writeFailure(on ? "turn this off" : "turn this on", out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure(on ? "turn this off" : "turn this on", null));
    } finally {
      release();
    }
  }, [status?.enabled, load, claim, release]);

  /** Every verb the list has, through the one route that owns them. What each
   *  one MEANS is on the button; what they share is that the fingerprint comes
   *  from what this deck met on the wire and never from the page. */
  const answer = useCallback(async (
    action: "accept" | "dismiss" | "unpair" | "allow",
    fp: string,
    what: string,
  ) => {
    // Tagged per ROW rather than per section: two decks asking at once light
    // only the row that was actually pressed.
    if (!claim(`${action}:${fp}`)) return;
    try {
      const out = await post("/api/lan/peer", { action, fp });
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else setFailure(writeFailure(what, out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure(what, null));
    } finally {
      release();
    }
  }, [load, claim, release]);

  /** Dial an address somebody typed, from now on. The list above is what the
   *  network offers; this is for the deck it cannot offer — another subnet, a
   *  VPN, a firewall in the way. */
  const addAddress = useCallback(async () => {
    const parsed = parseAddress(addrDraft);
    if (!parsed) { setFailure("That is not an address and a port — try 192.168.1.5:54340."); return; }
    if (!claim("add")) return;
    try {
      const entry = `${parsed.addr}:${parsed.port}`;
      const out = await post("/api/prefs", { lan: { manual: [...manual.filter(m => m !== entry), entry] } });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); setAddrDraft(""); onChanged(); }
      else setFailure(writeFailure("add that address", out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure("add that address", null));
    } finally {
      release();
    }
  }, [addrDraft, manual, load, onChanged, claim, release]);

  /** Stop dialling an address that never answered.
   *
   *  Through prefs rather than through /api/lan/peer, because there is nothing
   *  to unpair: no deck was ever met here, and the row's fingerprint is a
   *  placeholder built out of the address. `setPeers` replaces the dial list
   *  wholesale on every prefs write, so filtering the entry out is the whole of
   *  the removal. */
  const dropAddress = useCallback(async (entry: string) => {
    if (!claim(`drop:${entry}`)) return;
    try {
      const out = await post("/api/prefs", { lan: { manual: manual.filter(m => m !== entry) } });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); onChanged(); }
      else setFailure(writeFailure("stop dialling that address", out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure("stop dialling that address", null));
    } finally {
      release();
    }
  }, [manual, load, onChanged, claim, release]);

  /** Make one, or put it away. A deck that cannot be reached from outside has
   *  to be the one PASTING rather than the one minting — see lan-reach.mjs — so
   *  both halves of that exchange are here, side by side. */
  const invite = useCallback(async (action: "make" | "withdraw") => {
    if (!claim(`invite:${action}`)) return;
    try {
      const out = await post("/api/lan/invite", { action });
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); setCopied(null); }
      else setFailure(writeFailure(action === "make" ? "make an invite" : "cancel that invite", out));
    } catch {
      if (alive.current) setFailure(writeFailure(action === "make" ? "make an invite" : "cancel that invite", null));
    } finally {
      release();
    }
  }, [claim, release]);

  const join = useCallback(async () => {
    const token = joinDraft.trim();
    if (!token || !claim("join")) return;
    setTried(null);
    try {
      const out = await post("/api/lan/invite", { action: "join", token });
      if (!alive.current) return;
      if (out?.ok) {
        setStatus(out);
        setJoinDraft("");
        setFailure(null);
        setAddOpen(false);
        onChanged();
      } else {
        // Which addresses were dialled and what each one said. An invite
        // carries several because nobody knows which one routes, and when none
        // did, that list is the only thing the reader can act on.
        setTried(Array.isArray(out?.tried) ? out.tried : null);
        setFailure(writeFailure("use that invite", out));
      }
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure("use that invite", null));
    } finally {
      release();
    }
  }, [joinDraft, load, onChanged, claim, release]);

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

  const copyText = useCallback(async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => { if (alive.current) setCopied(c => (c === tag ? null : c)); }, 1_600);
    } catch {
      setFailure("Could not copy it — select the text and copy it by hand.");
    }
  }, []);

  const on = status?.enabled === true;
  const rows = deckRows(status, now);
  const asks = rows.filter(r => r.kind === "asks");
  const rest = rows.filter(r => r.kind !== "asks");
  const state = sectionState(status, now);
  const paired = rest.filter(r => r.kind === "paired").length;
  const live = status?.invite && status.invite.expiresAt > now ? status.invite : null;

  return (
    <div className="ap-auto ap-lan">
      <div className="ap-auto-head">
        <h3 className="ap-auto-title">Local network</h3>
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
        >
          <i className={on ? "ap-pulse" : "ap-dot"} aria-hidden />
          {on ? "on" : "off"}
        </button>
      </div>

      {/* One verb for one thing, everywhere. The account rows in this panel
          already say `login expired`, so this says expired too — "heal" and
          "dead" were two more words for the same state and a reader scanning
          three of them has to work out that they are one. */}
      <p className="ap-auto-note">Decks you pair with repair each other&apos;s expired logins.</p>

      {/* WHO IS HERE, IN ONE LINE. Every state this section had was legible only
          by reading the whole thing and working it out. This is the panel's own
          answer, the one the freshness column has made on every account row for
          a year: say the state, at the top, in the words a person would use. */}
      {/* Announced, and it was not: the one line that says whether anything is
          working changes under a reader who is looking at a quota three
          sections up, and a screen reader was told nothing at all. `polite`
          rather than `alert` — the request box beside it is the assertive one,
          and two live regions shouting about one event is one too many. */}
      <p className={`ap-lan-status ${state.tone}`} role="status">{state.text}</p>

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
          {rest.length > 0 && (
            <ul className="ap-lan-here">
              {rest.map(p => (
                <li key={`${p.kind}:${p.fp}`} className="ap-lan-who" data-tone={p.tone} title={p.hint}>
                  <i className={p.here ? "ap-pulse" : "ap-dot"} aria-hidden />
                  {/* THE NAME OWNS THE ROW'S WIDTH, and it did not. The state
                      was the flex item that grew and the name the one that
                      shrank, so a machine's identity — the thing a reader is
                      looking for — collapsed to `192.168.1….` while a sentence
                      that changes every minute took the space and wrapped
                      anyway. They are two lines now, and the second one is
                      allowed to be long. */}
                  <span className="ap-lan-who-name">{p.name}</span>
                  <span className="ap-lan-who-when">{p.state}</span>
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
                          window.setTimeout(() => setArmed(a => (a === p.fp ? null : a)), 4_000);
                          return;
                        }
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

          {rest.length === 0 && asks.length === 0 && (
            <p className="ap-lan-fine">
              No other deck yet. Decks on one network usually find each other on their own;
              when that has not happened, <strong>+ add a deck</strong> reaches one by address
              or by invite.
            </p>
          )}

          {/* ONE PRESS THAT IS LOUDER THAN THE REST, and it is the one somebody
              came here for: a login expired on this machine and the deck next
              to it has a working copy. It was half a row wide, beside a control
              that opens a drawer, under a full-width button that opens a dialog
              holding a name field. The weight is the other way round now, and
              nothing was added to do it — two controls gave theirs up. */}
          {paired > 0 && (
            <button type="button" className="ap-manage-btn ap-lan-check" {...pressProps("check")}
              onClick={() => void checkNow()}
              title="Ask every paired deck now for anything this deck's expired logins need, instead of waiting for the next minute">
              {busy === "check" ? "checking…" : "check now"}
            </button>
          )}

          {/* The two things you do once, at the size of things you do once. */}
          <div className="ap-lan-foot">
            <button type="button" className="ap-lan-word" aria-expanded={addOpen} aria-controls="ap-lan-adder"
              onClick={() => setAddOpen(v => !v)}
              title="Reach a deck that has not turned up on its own — by address, or with an invite">
              {addOpen ? "− add a deck" : "+ add a deck"}
            </button>
            <button type="button" className="ap-lan-word" {...pressProps("setup")}
              onClick={() => setSetupOpen(true)}
              title="This deck's name on the network, and which of its logins it offers">
              name &amp; shared logins
            </button>
          </div>

          {addOpen && (
            <div className="ap-lan-adder" id="ap-lan-adder">
              {/* WHY THE LIST IS EMPTY, WHEN THE MACHINE CAN BE ASKED. "Nothing
                  here yet" and "nothing can get in" look identical and are not:
                  the first is answered by waiting and the second never is. What
                  comes first is the way out that needs no firewall rule at all,
                  because a round is one OUTBOUND connection — this deck dialling
                  is the whole of it. */}
              {status?.reach?.blocked && (
                <div className="ap-lan-reach">
                  <p className="lan-warn">{status.reach.text}</p>
                  <p className="lan-note">
                    Nothing here is stuck: a deck that dials out first needs none of this.
                    {" "}<strong>Ask them for an invite and paste it below</strong> — an invite is
                    dialled by whoever pastes it, so on this machine it has to be pasted rather
                    than made. Typing their address below works the same way.
                  </p>
                  {(status.reach.steps ?? []).length > 0 && (
                    <details className="ap-lan-reach-fix">
                      <summary>or let them find this deck on their own</summary>
                      <p className="lan-note">
                        Run this in PowerShell <strong>as Administrator</strong>, then restart the deck.
                        {status.reach.category === "Public" && (
                          <> The first line marks this network as a home or office one — leave it
                          out on a network you do not trust.</>
                        )}
                      </p>
                      <pre className="ap-lan-cmd"><code>{(status.reach.steps ?? []).join("\n")}</code></pre>
                      <button type="button" className="ap-manage-btn" {...pressProps("copy:fix")}
                        onClick={() => void copyText((status.reach?.steps ?? []).join("\n"), "fix")}
                        title="Copy these lines, then paste them into an elevated PowerShell">
                        {copied === "fix" ? "copied" : "copy command"}
                      </button>
                    </details>
                  )}
                </div>
              )}

              <div className="ap-lan-row">
                <span className="ap-lan-label">by address</span>
                <input
                  className="ap-manage-input ap-lan-input"
                  aria-label="Another deck's address"
                  value={addrDraft}
                  placeholder="192.168.1.5:54340"
                  onChange={e => setAddrDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") void addAddress(); }}
                />
                {addrDraft.trim() !== "" && (
                  <button type="button" className="ap-manage-btn" {...pressProps("add")}
                    onClick={() => void addAddress()}
                    title="Try this address every minute, starting now.">add</button>
                )}
              </div>

              <div className="ap-lan-row">
                <span className="ap-lan-label">an invite</span>
                <input
                  className="ap-manage-input ap-lan-input"
                  aria-label="An invite you were sent"
                  value={joinDraft}
                  placeholder="paste one you were sent"
                  spellCheck={false}
                  onChange={e => { setJoinDraft(e.target.value); setTried(null); }}
                  onKeyDown={e => { if (e.key === "Enter") void join(); }}
                />
                {joinDraft.trim() !== "" && (
                  <button type="button" className="ap-manage-btn" {...pressProps("join")}
                    onClick={() => void join()}
                    title="Reach that deck and pair with it. Nobody has to press anything there.">
                    {busy === "join" ? "joining…" : "join"}
                  </button>
                )}
              </div>

              {tried && (
                <div className="ap-lan-tried">
                  <span className="ap-lan-note">
                    Nothing answered at any address in that invite. Check that deck is running
                    and that its Local network switch is on.
                  </span>
                  {tried.map(t => (
                    <span key={t.addr} className="ap-lan-tried-row">
                      <code className="ap-lan-code">{t.addr}</code>
                      <span className="ap-lan-bad">{t.why}</span>
                    </span>
                  ))}
                </div>
              )}

              {live ? (
                <div className="ap-lan-invite">
                  <div className="ap-lan-invite-head">
                    <span className="ap-lan-invite-title">Send this to them</span>
                    <span className="ap-lan-invite-left">{leftLabel(live.expiresAt, now)} left</span>
                  </div>
                  <code className="ap-lan-token">{live.token}</code>
                  <div className="ap-lan-acts">
                    <button type="button" className="ap-manage-btn" {...pressProps("copy")}
                      onClick={() => void copyText(live.token, "invite")}
                      title="Copy it, and send it however you already talk to them">
                      {copied === "invite" ? "copied" : "copy"}
                    </button>
                    <button type="button" className="ap-manage-btn" {...pressProps("invite:withdraw")}
                      onClick={() => void invite("withdraw")}
                      title="Cancel it. Anybody already holding the text can no longer use it.">
                      cancel
                    </button>
                  </div>
                  <p className="ap-lan-note">
                    They paste it and it pairs itself — nothing to press here. It carries every
                    address this deck has, so they do not have to know which one works.
                  </p>
                  <p className="ap-lan-warn">
                    Anyone who gets hold of this text can pair with this deck until it runs out.
                  </p>
                </div>
              ) : (
                <button type="button" className="ap-manage-btn ap-lan-mint" {...pressProps("invite:make")}
                  onClick={() => void invite("make")}
                  title="One piece of text you send them. They paste it and the two decks pair.">
                  make an invite for them
                </button>
              )}
            </div>
          )}

        </>
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
    </div>
  );
}
