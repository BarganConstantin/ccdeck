// What one round with a paired deck did, in the words a row has room for.
//
// Lifted out of LanSyncSection.tsx unchanged. A round comes back from the
// engine as `last` — a sentence off the wire, an errno Node put in front of an
// address, or the logins it moved and what was wrong with each — and this is
// where each of those becomes a line and a tone: the codes lan-copies.mjs and
// lan-call.mjs define on one side, the words the deck list and a deck's own
// dialog draw on the other. silenceNote is here for the same reason. It is
// what a round that timed out means when a beacon from the same machine says
// more than the socket could.
import { arrivalCheck, KEYCHAIN } from "./admin-failure";
import type { LanStranger, Peer } from "./lan-types";
import { ownRow } from "./own-row";

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
 *  things it is — and, when a login came with a problem, what to do about it,
 *  which is too long for the row and goes where the whole sentence goes. */
export interface RoundLine { text: string; tone: "bad" | "warn" | "idle" | "ok"; hint?: string }

type DoneRow = NonNullable<NonNullable<Peer["last"]>["done"]>[number];

/**
 * The reasons a round names, keyed by the codes lan-copies.mjs defines: a few
 * words for the row and the sentence with the remedy for the dialog. Looked up
 * through ownRow, so a code this build does not know names nothing rather
 * than something from the prototype.
 *
 * WHICH MACHINE is the whole point of the Keychain pair. The fix is on the Mac
 * that cannot read its own Keychain, and "blocked by Keychain" without saying
 * which sent people to the one that was fine.
 */
const ROUND_WHY: Record<string, { short: string; long: string }> = {
  // From the sending deck, on the wire. Nothing to do here: once that Mac
  // opens its Keychain the next round asks again and brings it.
  keychain_unavailable: {
    short: "Keychain locked on the other Mac",
    long: `the other Mac could not export it. On that Mac: ${KEYCHAIN}. The next round brings it.`,
  },
};

/** What a round has to say about one login beyond arrived / did not, or null.
 *  This deck's own findings are worded where the Add Account dialog's are —
 *  see arrivalCheck. */
export function roundWhy(d: DoneRow): { short: string; long: string } | null {
  if (!d.why) return null;
  return ownRow(ROUND_WHY, d.why) ?? arrivalCheck(d.why);
}

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
 * Keyed on the wire's own sentence, which lan-call.mjs builds — the two files
 * are one protocol and this is the panel's half of it.
 *
 * Exported because presence reads it as well: a deck that answered was
 * reached, whatever the answer was — see isOnline.
 */
export const WIRE_ANSWERS: Record<string, RoundLine> = {
  "waiting for the other deck to accept this one": { text: "waiting for them to say yes", tone: "idle" },
  "that deck said no": { text: "it said no", tone: "bad" },
  // Invite-only, from both ends. Neither is a fault, so neither is red: the
  // other deck chose it, or this one did, and an invite is the way through.
  "that deck pairs only by invite": { text: "it pairs only by invite", tone: "idle" },
  "this deck pairs only by invite": { text: "needs an invite · your setting", tone: "idle" },
};

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
 * seen is more useful whole than replaced by a guess, and lan-call.mjs is
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
  // A ROUND CUT OFF PART-WAY STILL SAYS WHAT IT DID. Logins that arrived before
  // the socket died are on this machine now, and a Keychain problem found on
  // the way is still the thing to fix — so the line is the finished part's own,
  // with the interruption added after its problems and, like them, before the
  // clock, where the deck list keeps it.
  if (last.error && last.done?.length) {
    const finished = roundLabel({ ...last, error: undefined }, now)!;
    const at = ` · ${seenLabel(last.at, now)}`;
    return { ...finished, text: `${finished.text.slice(0, -at.length)}, then ${faultText(last.error)}${at}`, tone: "bad" };
  }
  if (last.error) return WIRE_ANSWERS[last.error] ?? { text: faultText(last.error), tone: "bad" };
  const done = last.done ?? [];
  // NOT "nothing to do", which reads two ways and one of them is alarming: a
  // reader cannot tell it from "nothing is shared, so there was nothing to
  // send". Two decks whose logins all work is the steady state of this feature
  // and the sentence says so.
  if (!done.length) return { text: `all logins fine · ${seenLabel(last.at, now)}`, tone: "idle" };
  const ok = done.filter(d => d.ok);
  const verb = ok.length === 1 ? "login" : "logins";
  // THE COUNT STAYS, AND EVERY PROBLEM IS NAMED AFTER IT. A round with one
  // Keychain failure among three arrivals is still three arrivals, and a second
  // failure on the other machine is a second thing to fix; a line that showed
  // only the first sent somebody to fix one, retry, and meet the next. The
  // names go BEFORE the clock, because the list cuts everything after the
  // first " · " — see roundWords in lan-roster.ts.
  const said = done.map(d => ({ d, why: roundWhy(d) })).filter(x => x.why);
  const names = [...new Set(said.map(x => x.why!.short))];
  const what = names.length ? `, ${names.join(", ")}` : "";
  const hint = said.length ? said.map(x => `${x.d.email}: ${x.why!.long}`).join(" ") : undefined;
  const at = seenLabel(last.at, now);
  return ok.length === done.length
    // "arrived", because a round only ever pulls: roundWith dials, reads the
    // other deck's manifest and imports. Nothing leaves this deck on a round it
    // started, and "took 2 accounts" left which way it went to the reader.
    ? { text: `${ok.length} ${verb} arrived${what} · ${at}`, tone: said.length ? "warn" : "ok", ...(hint ? { hint } : {}) }
    // Some moved and some did not, which is neither a clean round nor a failure
    // to reach the deck. It reads as the partial thing it is.
    : { text: `${ok.length} of ${done.length} logins arrived${what} · ${at}`, tone: "bad", ...(hint ? { hint } : {}) };
}

/** How recently a beacon has to have arrived for this panel to speak about that
 *  machine in the present tense. Three announce intervals — see silenceNote. */
export const FRESH_BEACON_MS = 90_000;

/**
 * Why nothing answered at an address, when this deck knows more than the socket
 * did.
 *
 * WHAT THE ROW SAID WAS TRUE AND USELESS. `no answer · handshake timed out` is
 * the socket's whole account of the failure, and it is the same sentence for a
 * machine that is switched off, an address with a digit wrong, and the case
 * this exists for: a machine that is up, running the deck, shouting its beacon
 * across the room every thirty seconds, and dropping every packet sent back to
 * it. Reported as two people on one router unable to connect for an afternoon,
 * with a beacon from the far machine arriving here the whole time — which is
 * to say the answer was already on this screen and nothing read it.
 *
 * A BEACON IS THE EVIDENCE, and it is strong: it carries a fingerprint, it
 * arrived on this network, and it says which port that deck listens on. So a
 * timeout at a host we are hearing from cannot be a machine that is off and
 * cannot be a network that does not reach — it is one of exactly two things,
 * and the beacon's port tells them apart.
 *
 * SAYS, NEVER DOES. Both cases have an action on the other machine or in the
 * address field, and neither is this dialog's to take: dialling the announced
 * port behind somebody's back would leave the row they typed unexplained, and
 * the beacon's row already dials that port every round anyway.
 *
 * Null when there is nothing to add — no failure, or no beacon from that host.
 */
export function silenceNote(
  { error, host, port }: { error?: string | null; host: string; port: number | null },
  heard: LanStranger[],
  now: number,
  discoveryPort = 45_317,
): string | null {
  // Only for a socket that got nothing back. Every other error already names
  // its own cause — refused, hung up, answered as somebody else — and a second
  // sentence under those would be this dialog talking over the evidence.
  if (error !== "handshake timed out") return null;
  const at = (host ?? "").trim();
  if (!at) return null;
  // HEARD LATELY, not heard once. "Its beacon arrives here every half minute"
  // is a claim about the present tense, and a deck that beaconed this morning
  // and has been off since would make it a lie — which is the one thing worse
  // than the bare `handshake timed out` this replaces. The window is the same
  // one seenLabel calls `now`: three announce intervals, so a single dropped
  // broadcast does not retract the sentence.
  const same = heard.filter(h => h.addr === at && h.port && h.at > 0 && now - h.at < FRESH_BEACON_MS);
  if (!same.length) return null;
  // The port it announces. More than one deck on that machine is ordinary —
  // several runs on one computer — so every announced port is offered rather
  // than the first.
  const ports = [...new Set(same.map(h => h.port as number))];
  if (port != null && !ports.includes(port)) {
    const list = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(" and ")}`;
    return `A deck at ${at} is announcing itself on ${list}, not on ${port}. This deck already hears it and dials it there, so this typed row has nothing to reach.`;
  }
  return `That machine is running the deck — its beacon arrives here every half minute — and what this deck sends back never gets there. That is a firewall on ${at}, not a network fault. Whoever uses it can allow two ports: UDP ${discoveryPort} and TCP ${port ?? ports[0]}.`;
}
