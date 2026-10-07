// What a deck's own dialog says about the machine behind a row, as far as that
// is words and states rather than drawing.
//
// Lifted out of LanPeerModal.tsx unchanged. The dialog is handed the row, the
// peer or stranger it was built from and this deck's own status, and every
// fact it draws — where the machine is and how it is reached, what each end
// runs, what the last round said and whether the socket's silence has a
// reason, whether the network between the two is up, and what each login the
// two decks offer would do — is decided here, where it can be asked for rather
// than read. The drawing, the presses and the dialog's own state stay in the
// dialog. None of it touches React.
import { exchangeLanes, type Lane, versionOrder } from "./lan-exchange";
import { roundLabel, seenLabel, silenceNote } from "./lan-round";
import type { DeckRow, RowSource } from "./lan-roster";
import type { DeckAbout, LanAccount, LanStatus } from "./lan-types";

/** Two stamps this far apart came off the same round.
 *
 *  A round reads the other deck's manifest and then writes its own result, so
 *  `offersBy` and `lastRound` land microseconds apart when it worked and drift
 *  apart when it did not — see roundWith. A whole second is orders of
 *  magnitude more than the gap it is there to swallow and orders of magnitude
 *  less than the interval between rounds, so nothing that matters lands in it. */
export const SAME_ROUND_MS = 1_000;

/** A date somebody reads, and how long ago in the panel's own words. */
export function sinceLabel(at: number, now: number): string {
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const ago = seenLabel(at, now);
  return `${day} · ${ago === "now" ? "just now" : ago}`;
}

/** A deck's card as one line: its version, then the system under it. */
export function runsLine(about: DeckAbout | null | undefined): string | null {
  if (!about) return null;
  return [about.version, about.os, about.arch].filter(Boolean).join(" · ") || null;
}

/** What the two marks at the ends of a lane stand for, for a reader who cannot
 *  see them. The caption beside them only says what is not working. */
export const HERE_SAID = { works: "works here", expired: "expired here", missing: "not on this deck", unavailable: "cannot share here" } as const;
export const THERE_SAID = { works: "works there", broken: "broken there", unavailable: "cannot share there", unknown: "not offered by that deck" } as const;
export function laneSaid(l: Lane): string {
  const ways = l.in && l.out ? "offered both ways" : l.in ? "offered by that deck" : "offered by this deck";
  // The accent and the ring say this to the eye; these words say it aloud.
  return `${HERE_SAID[l.here]}, ${THERE_SAID[l.there]}, ${ways}${l.usedThere ? ", in use there" : ""}.`;
}

/**
 * Everything the dialog says about the machine behind `row`, from the peer or
 * stranger it was built from (`source`), this deck's own `status` and
 * `accounts`, at `now`.
 */
export function peerView({ row, source, status, accounts, now }: {
  row: DeckRow;
  source: RowSource;
  status: LanStatus;
  /** This deck's own accounts, to say what each offered login would do here. */
  accounts: LanAccount[];
  now: number;
}) {
  const { peer, stranger } = source;
  const paired = row.kind === "paired";
  const own = row.self ?? row.name;
  // A typed address nothing has answered at is not a machine yet, so there is
  // nothing to hang a name on — see deckRows.
  const canRename = row.kind !== "dialling";
  const fp = row.kind === "dialling" ? null : row.fp;
  const where = peer
    ? (peer.addr ? `${peer.addr}:${peer.port}` : "")
    : stranger
      ? (stranger.port ? `${stranger.addr}:${stranger.port}` : stranger.addr)
      : row.addr;
  const about = peer?.about ?? null;
  const mine = status.about?.version ?? null;

  // WHAT IT HAS NOT SAID, and whose move that is. A card is only ever sent
  // between paired decks, so an unpaired one has not said by design; a paired
  // one that answered a round and still sent nothing is running a version from
  // before this; and one that only calls in says it the next time it calls.
  const unsaid = !paired ? "shown once paired"
    : peer?.waiting
      ? (peer.lastSeen != null ? "not said — it runs an older version" : "not said yet — it says when it next calls")
      : peer?.offers ? "not said — it runs an older version"
      : "not reached yet";

  // WHAT EACH END RUNS, under its name, so the two versions are read side by
  // side — which is why the comparison is one word now. `older than this
  // deck's 3.22.9` spelled out the number already printed across the dialog.
  const hereRuns = runsLine(status.about);
  const thereRuns = runsLine(about);
  const order = about?.version && mine ? versionOrder(about.version, mine) : null;

  const line = peer ? roundLabel(peer.last, now) : null;
  // WHAT THE DECK ALREADY KNEW about an address that answers nothing: whether a
  // beacon from that machine is arriving here, and on which port. See
  // silenceNote, where the two conclusions and the evidence for them live.
  //
  // Every deck heard on this network is offered, whatever list it is filed
  // under — a machine that beacons is a machine that is up, and which of this
  // panel's three lists it landed in says nothing about that. The row's own
  // beacon is among them on purpose: a PAIRED deck that is heard and cannot be
  // dialled is the same firewall, said about a machine that already has a name.
  const silence = peer && peer.last?.error
    ? silenceNote(
      { error: peer.last.error, host: peer.addr, port: peer.port },
      [
        ...(status.strangers ?? []),
        ...(status.pending ?? []),
        ...(status.peers ?? []).filter(p => !p.manual && p.addr).map(p => ({ fp: p.fp, name: p.name, addr: p.addr, port: p.port, at: p.lastSeen ?? 0 })),
      ],
      now,
    )
    : null;
  // The sentence the row translated, kept whole: `not listening` is what the
  // row can fit, `connect ECONNREFUSED 192.168.1.229:65059` is what somebody
  // fixing it needs.
  const raw = peer?.last?.error && line && line.text !== peer.last.error ? peer.last.error : null;
  const done = peer?.last?.done ?? [];
  // THE HEADER ALREADY SAID IT. A deck that did not answer reads `no answer ·
  // last online 1h ago` under its name, and the line under the network said
  // `no answer` again with the reason after it. When the header carries the
  // verdict, the picture carries what the header cannot: the reason, in the
  // machine's own words.
  const echoed = !!line && !!raw && !row.quiet && row.state.startsWith(line.text);
  const showRound = paired || row.kind === "dialling";
  // Over the tailnet the same three sentences name it, because "on this
  // network" about a laptop at home is the one thing the row must not say.
  const overTailnet = (peer?.via ?? row.via) === "tailscale";
  const how = peer
    ? peer.waiting ? null : peer.manual ? (overTailnet ? "added by its Tailscale address" : "added by address")
      : overTailnet ? "over Tailscale" : "on this network"
    : row.kind === "nearby" ? (overTailnet ? "heard over Tailscale" : "heard on this network")
    : overTailnet ? "asked this deck to pair, over Tailscale" : "asked this deck to pair";

  // THE NETWORK, drawn the way the row's mark is coloured: whole and lit while
  // it answers, broken only when the link itself failed, and a
  // dotted line for every other state — not paired yet, or not heard lately.
  const link = row.tone === "bad" ? "bad" : !paired ? "loose" : row.here ? "up" : "down";

  const offers = peer?.offers ?? null;
  // WHICH ACCOUNT IT IS ON, and only while it answers: "on this one right now"
  // cannot be vouched for by a deck that has gone quiet, so the mark stops with
  // the lights. `hidden` is its owner's switch, and `other` an account it does
  // not share — both said under its name, since neither is a lane to mark.
  const current = link === "up" ? offers?.current ?? null : null;
  const theirKey = current && "key" in current ? current.key : null;
  const hiddenThere = !!current && "hidden" in current;
  const otherThere = !!current && "other" in current;
  // A deck that calls in sends its list with every call now, so its lanes are
  // drawn from what it said like anybody else's; an older one sends none.
  // This deck's half is what it offers THAT deck, which is less than what is
  // ticked here for a deck the accept switch paired — see notOffered.
  const offering = (status.shared ?? []).filter(key => !peer?.notOffered?.includes(key));
  const lanes = paired
    ? exchangeLanes(offers?.accounts ?? null, accounts, offering, theirKey)
    : [];
  // A login this deck advertises and cannot honour, with nothing coming the
  // other way to repair it: every paired deck is promised something that
  // gives them nothing. A lane that already says `sign in again` is not one.
  const spent = lanes.filter(l => l.in == null && l.out === "cut");
  const taking = lanes.some(l => l.in != null);
  const giving = lanes.some(l => l.out != null);
  // What the last round moved, on the lane it moved along. Anything it moved
  // that is not a lane any more is listed under the network instead.
  const told = new Map(done.map(d => [d.email, d]));
  const unplaced = done.filter(d => !lanes.some(l => l.email === d.email));
  // WHY THAT DECK'S HALF IS MISSING, when it is. This deck's half is drawn
  // either way — it is this deck's own list, and it is known.
  const unknown = !paired ? null
    : !offers
      ? (peer?.waiting
        // It says with every call now. One that has called and still said
        // nothing runs a version from before it started saying.
        ? "What that deck offers is not known yet. A deck that calls in says so each time it calls — one on an older version never does."
        : peer?.last?.error
          ? "What that deck offers is not known — the last attempt to ask it did not get through."
          : "Nobody has asked that deck what it offers yet. The next round asks it.")
      : offers.accounts.length === 0 ? "That deck offers nothing. Nobody there has chosen a login to share."
      : null;
  // WHEN IT LAST TOLD US, and only when that is not already answered under
  // the network. A round sets `offersBy` and `lastRound` microseconds apart,
  // so on every healthy deck this was a second printing of the same clock —
  // redundant often enough to train the eye to skip it, which is exactly the
  // habit that hides it on the one round that failed and left the lanes a
  // fossil. `offers.at` only falls behind when a round did not get through.
  const stale = offers && peer?.last && peer.last.at - offers.at > SAME_ROUND_MS
    ? seenLabel(offers.at, now)
    : null;

  return {
    peer, stranger, paired, own, canRename, fp, where, about, unsaid, hereRuns, thereRuns, order,
    line, silence, raw, echoed, showRound, how, link, hiddenThere, otherThere,
    lanes, spent, taking, giving, told, unplaced, unknown, stale,
  };
}
