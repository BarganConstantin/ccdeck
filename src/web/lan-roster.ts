// Who is out there, and what the section says about them.
//
// Lifted out of LanSyncSection.tsx unchanged. Every machine this deck knows of
// — a request, a paired deck, an address still being tried, a deck nearby, one
// somebody said no to — becomes one row here, with presence decided once, in
// isOnline, and read by everything that counts: the list, the status line
// under the switch, the way-in row at the foot of the accounts, and the peek
// beside it. The dialogs find the machine behind a row with rowSource, from the
// same status the row came from. None of it touches React.
import { type RoundLine, roundLabel, seenLabel, WIRE_ANSWERS } from "./lan-round";
import type { LanRoute, LanStatus, LanStranger, Peer } from "./lan-types";

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
  s: {
    enabled?: boolean; running?: boolean; stalled?: string | null; peers?: Peer[]; pending?: LanStranger[];
    /** Read for the names the list folds machines by — see deckRows. */
    aliases?: Record<string, string>;
  } | null,
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
  // Asked of calledLately, which is what draws that deck's row live, so the
  // line and the row cannot count one machine two ways (#1690).
  const present = (p: Peer) => (p.waiting ? calledLately(p.lastSeen, now) : isOnline(p, now));
  // REACHED, AND WAITING ON A PERSON. Every one of them answered — they are as
  // present as a deck can be — and none of them can move a login until somebody
  // at that machine presses accept. Neither `ready` nor `cannot reach` is true
  // of that, and the line said the second one over three healthy machines.
  const asksToBeAccepted = (p: Peer) => !p.waiting && p.last?.error === "waiting for the other deck to accept this one";
  // AND IT COUNTS MACHINES, NOT KEYS, because the list does (#1802). One Mac
  // paired under three keys — two deck starts and a key it held before — is
  // one row there, and the line said `cannot reach any of its 3 decks` over
  // it. So the decks are grouped by the list's own rule first: a machine is
  // here when any of its decks is, and waiting on a person only when every one
  // of its decks that is here is waiting.
  const aliases = s.aliases ?? {};
  let here = 0, unanswered = 0, offline = 0;
  for (const machine of machines(peers, p => pairedName(p, p.peerFp ?? p.fp, aliases).name, p => p.addr ?? "")) {
    const on = machine.filter(present);
    if (!on.length) { offline++; continue; }
    here++;
    if (on.every(asksToBeAccepted)) unanswered++;
  }
  if (here && unanswered === here) {
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
      text: offline === 1
        ? "this deck cannot reach the one it is paired with"
        : `this deck cannot reach any of its ${offline} decks`,
      tone: "bad",
    };
  }
  const ready = here === 1 ? "1 deck ready" : `${here} decks ready`;
  return { text: offline ? `${ready} · ${offline} away` : ready, tone: "ok" };
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
  /** Other paired decks with this row's name at this row's address — one
   *  machine running more than one deck — folded into it and listed in its
   *  dialog. See oneRowPerMachine. */
  twins?: DeckRow[];
  /** Reached over this person's tailnet rather than the local network. */
  via?: LanRoute;
}

/**
 * Is a deck that calls in here? It is when it has called inside the window a
 * beacon is held to, and that is the whole rule — both the row (callsIn) and
 * the line under the switch (sectionState) ask it.
 *
 * NOT ITS LAST ROUND. A deck this one holds no address for is never dialled,
 * so a round it carries is left over from when it still was — heard and not
 * reached, then silent for a day, then calling in. The line used to refuse it
 * for that error while the row drew it live, and said `this deck cannot reach
 * the one it is paired with` over a row saying `online · one-way, it calls in`
 * (#1690).
 */
function calledLately(lastSeen: number | undefined, now: number): boolean {
  return lastSeen != null && now - lastSeen < ONLINE_MS;
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
  const fresh = calledLately(lastSeen, now);
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
function presenceLabel(p: Peer, here: boolean, now: number): string {
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
 *
 * What each kind of row SAYS is its own function's, below this one — askingRow,
 * diallingRow, pairedRow, nearbyRow, declinedRow. This decides who is on the
 * list, once each, and in what order.
 */
export function deckRows(
  s: {
    peers?: Peer[]; pending?: LanStranger[]; strangers?: LanStranger[]; declined?: LanStranger[];
    aliases?: Record<string, string>;
    /** Read for the one word a nearby row says: what pairing it takes. */
    pairingMode?: "automatic" | "invite";
  } | null,
  now: number,
): DeckRow[] {
  if (!s) return [];
  const rows: DeckRow[] = [];
  const seen = new Set<string>();
  const byName = (a: DeckRow, b: DeckRow) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const aliases = s.aliases ?? {};

  for (const p of s.pending ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    rows.push(askingRow(p, aliases, now));
  }

  const paired: DeckRow[] = [];
  const dialling: DeckRow[] = [];
  for (const p of s.peers ?? []) {
    const fp = p.peerFp ?? p.fp;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    // AN ADDRESS THAT HAS NEVER ANSWERED IS NOT A PAIRED DECK. It wore the
    // paired row and the paired verb, and `unpair` on it named a fingerprint
    // built out of the address — which matches nothing this deck ever met, so
    // the one control on the row answered `could not unpair that deck`. One
    // typo made a row that failed every minute and could not be removed.
    if (!p.paired && p.manual && !p.met) dialling.push(diallingRow(p, fp, now));
    else paired.push(pairedRow(p, fp, aliases, now));
  }
  rows.push(...oneRowPerMachine(paired).sort(byName), ...dialling.sort(byName));

  const nearby: DeckRow[] = [];
  for (const p of s.strangers ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    nearby.push(nearbyRow(p, aliases, s.pairingMode));
  }
  rows.push(...nearby.sort(byName));

  const declined: DeckRow[] = [];
  for (const p of s.declined ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    declined.push(declinedRow(p, aliases));
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

/** A deck asking to pair: somebody waiting on an answer from this keyboard. */
function askingRow(p: LanStranger, aliases: Record<string, string>, now: number): DeckRow {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    kind: "asks", state: `wants to pair · ${askedLabel(p.at, now)}`, tone: "wait", here: true,
    hint: `${n.name} at ${p.addr}${p.via === "tailscale" ? ", over Tailscale," : ""} is waiting for an answer.`,
    ...tailnet(p.via),
  };
}

/** An address somebody typed that nothing has answered at yet. */
function diallingRow(p: Peer, fp: string, now: number): DeckRow {
  const line = roundLabel(p.last, now);
  const where = p.addr ? `${p.addr}:${p.port}` : "";
  return {
    fp: where, name: where || p.name || fp, addr: p.addr ?? "",
    kind: "dialling",
    // No presence clause: the row IS "an address nothing has answered at",
    // so saying it twice is the panel repeating itself.
    state: line ? roundWords(line) : "trying…",
    tone: line ? line.tone : "idle",
    here: false,
    hint: p.last?.error
      ? `Nothing has answered at ${where} yet — ${p.last.error}.`
      : `Dialling ${where} until something answers.`,
    ...tailnet(p.via),
  };
}

/** A deck somebody here paired with, or an address that has answered: whether
 *  it is there, and what the last round with it did. */
function pairedRow(p: Peer, fp: string, aliases: Record<string, string>, now: number): DeckRow {
  const line = roundLabel(p.last, now);
  const here = isOnline(p, now);
  const where = p.addr ? `${p.addr}:${p.port}` : "";
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
    ? (present ? `online · ${roundWords(line)}` : `${roundWords(line)} · ${presenceLabel(p, present, now)}`)
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
  const n = pairedName(p, fp, aliases);
  return {
    fp,
    ...n,
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
    ...tailnet(p.via),
    hint: called
      ? `${n.name} calls this deck, and this deck has no address to call back on — so it can repair its logins from here, and this deck cannot repair from it. ${
          p.lastSeen == null ? "It has not called since this deck started." : `It last called ${seenLabel(p.lastSeen, now)}.`
        } Add its address through Add a deck, the link at the top of this view, to reach it either way.`
      // The whole sentence, verbatim, including the address and the code the
      // row is too narrow to carry. This is where somebody looks when the
      // short form is not enough.
      : `${n.name}${where ? ` at ${where}` : ""}${p.last?.error ? ` — ${p.last.error}` : ""}${line?.hint ? ` — ${line.hint}` : ""}`,
  };
}

/** The name a paired deck's row is drawn under, which is also the name the
 *  list folds machines by — so the line that counts them asks it too. An
 *  address nothing has answered at has no identity to hang a name on. */
function pairedName(p: Peer, fp: string, aliases: Record<string, string>): { name: string; self?: string } {
  return p.manual && !p.met ? { name: p.addr ? `${p.addr}:${p.port}` : "" } : named(aliases, fp, p.name || fp);
}

/** A machine on the network that nobody here has paired with. */
function nearbyRow(p: LanStranger, aliases: Record<string, string>, pairingMode: "automatic" | "invite" | undefined): DeckRow {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    // Under invite-only the row says what it takes, since "not paired yet"
    // over a row with no ask on it reads as a machine that cannot be paired.
    kind: "nearby", state: pairingMode === "invite" ? "needs an invite" : "not paired yet", tone: "idle", here: true,
    hint: p.via === "tailscale"
      ? `${n.name} at ${p.addr} is on your tailnet and nothing is shared with it.`
      : `${n.name} at ${p.addr} is on this network and nothing is shared with it.`,
    ...tailnet(p.via),
  };
}

/** A deck that asked and was told no. */
function declinedRow(p: LanStranger, aliases: Record<string, string>): DeckRow {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    kind: "declined", state: "you said no", tone: "idle", here: false,
    hint: `${n.name} asked and was turned away. It is not asking any more.`,
  };
}

/**
 * WHAT SOMEBODY HERE CALLS IT, when they have said. Keyed by fingerprint, so
 * it follows the machine rather than the name the machine gives itself — and
 * that name is kept as `self`, for the one surface that says both. Sorting and
 * the duplicate check in deckRows both read the name that is drawn.
 *
 * Spread whole into a row: `self` is there only when somebody gave the deck
 * another name, so a row carries the key exactly when it has something to say.
 */
function named(aliases: Record<string, string>, fp: string | null | undefined, own: string): { name: string; self?: string } {
  const given = fp ? aliases[fp] : undefined;
  return given && given !== own ? { name: given, self: own } : { name: own };
}

/** `via` for a row, spread into it: present only for a deck reached over this
 *  person's tailnet, because absent means the local network — see LanRoute. */
function tailnet(via: LanRoute | undefined): { via?: "tailscale" } {
  return via === "tailscale" ? { via: "tailscale" } : {};
}

/** What a round did, without the clock roundLabel puts after it. A row has
 *  190px and says when in its own words — `online`, or `last online 12m ago` —
 *  so it keeps only what comes before the first ` · `, which is why roundLabel
 *  names every problem before its clock. */
function roundWords(line: RoundLine): string {
  return line.text.replace(/ · .*$/, "");
}

/**
 * ONE ROW PER MACHINE, among the paired decks.
 *
 * Reported from a screenshot: one colleague's Mac twice in the list, the same
 * name over the same address, two rows nobody could tell apart. They were two
 * decks on one computer — two starts that got through before a start kept at
 * most one, each with its own key — and to the person reading the list they are
 * one machine whatever the fingerprints say. So they are drawn once, and the
 * dialog behind that row lists every deck folded into it.
 *
 * BY THE NAME, which is what a reader tells rows apart by, and not by the
 * address alone: two decks at one address under different names are something
 * somebody here can tell apart, and chose to — an alias on one of them is
 * exactly that choice. The address splits a name only where it can: one name at
 * two addresses is two machines that happen to share a hostname, and a deck
 * under that name with no address here stays a row of its own, since nothing
 * says which of the two it is. With one address or none, every deck under the
 * name is that machine — including the keys it held before, which are paired,
 * hold no address and never call again once their deck is gone. Measured on
 * the machine this came from: three paired keys for one colleague's Mac, one of
 * them live.
 *
 * The one that is online leads, since it is the one the row's dot and verb are
 * about; then one that holds an address; otherwise the order they came in.
 */
export function oneRowPerMachine(rows: DeckRow[]): DeckRow[] {
  return machines(rows, r => r.name, r => r.addr).map(fold);
}

/** oneRowPerMachine's grouping, for anything with a name and an address: the
 *  rows the list draws, and the peers the line under the switch counts
 *  (#1802), so the two cannot tell machines apart two ways. A deck with no
 *  address under a name that is at two addresses is a machine of its own. */
function machines<T>(list: T[], nameOf: (t: T) => string, addrOf: (t: T) => string): T[][] {
  const byName = new Map<string, T[]>();
  for (const t of list) {
    const group = byName.get(nameOf(t));
    if (group) group.push(t); else byName.set(nameOf(t), [t]);
  }
  const out: T[][] = [];
  for (const group of byName.values()) {
    const addrs = [...new Set(group.map(addrOf).filter(Boolean))];
    if (addrs.length > 1) {
      for (const a of addrs) out.push(group.filter(t => addrOf(t) === a));
      for (const t of group) if (!addrOf(t)) out.push([t]);
    } else {
      out.push(group);
    }
  }
  return out;
}

/** One machine's decks as one row: the lead, and the rest as its twins. */
function fold(list: DeckRow[]): DeckRow {
  const [lead, ...twins] = [...list].sort((a, b) =>
    (Number(b.here) - Number(a.here)) || (Number(!!b.addr) - Number(!!a.addr)));
  return twins.length ? { ...lead, twins } : lead;
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

/** What the panel's way in to this section says about it (#844). */
/**
 * THE WAY IN, IN ONE LINE — what the accounts view says about this section from
 * the foot of the column, where the machines are no longer drawn.
 *
 * It answers the question a reader has before deciding to go in — how many of
 * the paired machines are on right now — and it gives way to the one state
 * waiting on this keyboard: a deck asking to pair.
 *
 * PRESENCE IS THE COUNT, because `8 paired` is a fact about a decision taken
 * once and the reader is asking how many of those machines are switched on
 * NOW — the same question the rows inside answer with `online`, and the reason
 * this line moves while nobody presses anything. The pairing count stays as the
 * denominator, so the row still says how big the fleet is. Asked for from a
 * screenshot of `8 paired · 1 not responding`, which left the other seven
 * unaccounted for.
 *
 * AND NO FAULT COUNT BESIDE IT. That same row carried `· 1 not responding` in
 * warning ink, and once presence leads, a deck that has timed out is already
 * missing from `1 of 8 online` — so the amber restated an absence the count had
 * just stated, in the one colour that means act on this, from a view where
 * there is nothing to act on. WHICH machine and WHY is a press away, and the
 * list still counts it there under its own fold. Dropped at the user's asking.
 */
export function entryLine(
  // `reach` is taken as the one field this row reads rather than as a whole
  // LanReach: the verdict's sentence, its steps and its shell are the block's
  // business under the switch, and a row that named the type would have to be
  // handed one to say anything at all.
  s: { enabled?: boolean; running?: boolean; stalled?: string | null; reach?: { blocked?: boolean } | null } | null,
  rows: DeckRow[],
): { text: string; tone: "bad" | "idle" | "ok" | "wait"; live: boolean } {
  if (!s) return { text: "checking…", tone: "idle", live: false };
  if (!s.enabled) return { text: "Off", tone: "idle", live: false };
  if (s.stalled) return { text: "could not start", tone: "bad", live: false };
  if (!s.running) return { text: "starting…", tone: "wait", live: false };
  const asks = rows.filter(r => r.kind === "asks").length;
  if (asks) return { text: asks === 1 ? "1 deck wants to pair" : `${asks} decks want to pair`, tone: "wait", live: false };
  // NOTHING CAN GET IN, AND THE COUNT IS WHAT HID IT. A blocked deck still
  // HEARS every beacon on the network, so all of its paired decks are present
  // and this row would read `8 online` — the most reassuring sentence it can
  // say, on the one machine where nothing works. The verdict is drawn in full
  // under the switch, but only for a reader who went in; this row is what tells
  // somebody to.
  //
  // NOT THE AMBER THIS ROW DROPPED. That one restated an absence the count had
  // already stated, in the colour that means act on this, from a view with
  // nothing to act on. This is the opposite case: a fault the count actively
  // conceals, and the one thing on this row somebody can do something about.
  //
  // After `asks` deliberately. A request already waiting came in over an
  // inbound connection, so it is both a press away and evidence that whatever
  // is in the way now was not always there.
  if (s.reach?.blocked) return { text: "nothing can get in", tone: "bad", live: false };
  const paired = rows.filter(r => r.kind === "paired");
  if (!paired.length) return { text: "On · none paired yet", tone: "idle", live: false };
  // `here` is the row's own presence — the dot the list draws — so the two
  // places cannot disagree about who is on.
  const online = paired.filter(r => r.here).length;
  if (!online) return { text: `none of ${paired.length} online`, tone: "idle", live: false };
  // A fleet that is all there does not need the arithmetic said out loud.
  if (online === paired.length) return { text: `${online} online`, tone: "ok", live: true };
  return { text: `${online} of ${paired.length} online`, tone: "ok", live: true };
}

/**
 * The view's rows, split the way the view draws them: the requests, which it
 * answers first and on their own, and the rest — the machines that are on,
 * then behind a fold that counts them, every one that is not.
 *
 * WHAT IS ON, AND THEN EVERYTHING ELSE. The list answers "who can I use right
 * now", and a machine that is off, or nearby and unpaired, or one somebody
 * said no to, is not an answer to that — it is context, and context does not
 * belong at the same size as the thing itself.
 *
 * WHAT IS NOT HIDDEN IS A PROBLEM. A deck that cannot be reached is exactly
 * the row a reader is scanning for, so folding it away silently would undo
 * the whole point of the tone: the fold COUNTS them, in the warning ink, and
 * one press opens it. A count in the right colour is a smaller lie than no
 * count at all — it is not a lie at all.
 *
 * Lifted out of LanSyncSection.tsx unchanged, so the fold can be asked what it
 * does rather than read.
 */
export function viewRows(rows: DeckRow[], foldOpen: boolean) {
  const asks = rows.filter(r => r.kind === "asks");
  const rest = rows.filter(r => r.kind !== "asks");
  const live = rest.filter(r => r.here);
  const folded = rest.filter(r => !r.here);
  const troubled = folded.filter(r => r.tone === "bad").length;
  // Nothing to lead with means nothing to fold behind: an empty list over a
  // `3 more` is a list that has hidden all of itself.
  const showFolded = foldOpen || live.length === 0;
  // The ones that are on stay at the top when the fold opens. Sorting the
  // whole list by presence would move a row between two five-second polls on
  // a lost beacon; sorting the two GROUPS moves a row only when the thing it
  // reports actually changed.
  const shown = showFolded ? [...live, ...folded] : live;
  const paired = rest.filter(r => r.kind === "paired").length;
  return { asks, rest, live, folded, troubled, showFolded, shown, paired };
}
