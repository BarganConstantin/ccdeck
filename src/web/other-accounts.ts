// THE FOLD IN THE ACCOUNTS COLUMN — what one row says about every account that
// is not the live one, and which of them it names when a pointer rests on it.
//
// WHY THE LIVE ACCOUNT IS NOT IN IT. The panel opens on one question that is
// asked every few minutes — how much of my current window is left — and a
// second one that is asked once a day: where do I go when it runs out. The
// column answered both at the same size, so four accounts of manage-menus and
// slot numbers stood between the reader and the three bars they came for. The
// fold keeps the live account whole and puts the others behind one row.
//
// THIS IS NOT LOCAL NETWORK'S ROW WITH ANOTHER NOUN, even though it is drawn in
// the same idiom. That row leads to a VIEW; this one unfolds a LIST in place,
// because a switch is the act the reader came to perform and a view change puts
// a way back between them and it. What the two do share is the doctrine: a
// count on the row, the names on a peek beside it, and not one control inside
// the peek — see LanPeek's header for why a card that closes 140ms after the
// pointer leaves is no place to put a press.
//
// PURE, AND IN ITS OWN FILE, for the reason lane-open.ts gives for the same
// move: the suite runs on plain node with no DOM, and a rule that only exists
// inside JSX is a rule nothing can check.

/** One account standing behind the fold, in the only terms the row and its peek
 *  need. The panel builds these from its roster; nothing here knows about slots,
 *  organizations or lanes. */
export interface Peer {
  /** Stable across a `cswap move`, because it is an identity and not a slot —
   *  see lane-open.ts, whose `laneKey` is what the panel passes here. */
  key: string;
  /** The alias if the account has one, else the address, else its slot. */
  name: string;
  /** A switch to this account would work. Held out and a dead login are both
   *  refusals, and the row's own `Switch` is withheld for exactly this pair. */
  ready: boolean;
  /** Why it is not ready, in the words its own row already uses. Null when it
   *  is. */
  why: string | null;
  /** Whether that reason is the reader's to act on. A card may say less than
   *  the row it stands for; it may not say it more quietly — an expired login
   *  printed in the muted tier here and in amber one press away would be the
   *  same fact wearing two levels of urgency. */
  warn: boolean;
  /** 100 minus its fullest lane, as the server computes it, or null when
   *  nothing has ever been collected for it. */
  headroom: number | null;
}

/** How many names the peek prints before it counts the rest. Six, the number
 *  Local network settled on for the same card at the same width: the most that
 *  can be read in the moment a hover lasts. */
export const FOLD_NAMES = 6;

/**
 * WHAT THE ROW SAYS, in one line.
 *
 * READINESS IS THE COUNT, not the roster. `3 accounts` is a fact about a
 * decision taken months ago; the reader is asking how many of them they could
 * be on in the next ten seconds, which is a smaller number whenever a login has
 * died or an account is held out. The roster stays as the denominator so the
 * row still says how big the set is.
 *
 * AND NO FAULT COUNT BESIDE IT, for the reason `entryLine` dropped one: an
 * account whose login expired is already missing from `1 of 2 ready`, and
 * restating it in the colour that means act on this — from a row where the only
 * act is to unfold — would be the same absence said twice. WHICH one, and why,
 * is on the peek and on the row itself one press away. The live account's own
 * trouble is a different matter and never folds: it is hoisted above the whole
 * list, because every session this deck starts runs on it.
 *
 * THE FREEST NUMBER, ONLY WHILE THE READER IS THE ONE CHOOSING. A row that
 * always printed `96% free` would be a second number competing with the bars
 * above it every time the reader glanced down, to answer a question they were
 * not asking. Once the live account is past the threshold auto-switch would act
 * on, that IS the question — but only while nothing else is going to answer it.
 * With the policy armed the reader is not picking anything, so the row drops
 * the number rather than offering a choice that has already been delegated.
 *
 * AND WHAT IT WILL NOT SAY IS WHICH ONE. The deck does not choose: a tick shells
 * out to `cswap auto --once` and claude-swap picks the target. `claude1 is next`
 * would be a prediction this side of the wire cannot make, and a summary that
 * guesses once is a summary nobody reads twice.
 *
 * THE ONE THING WORTH AN ALARM is the state neither the bars nor the toggle can
 * show: a policy that is armed with nowhere to go. Auto-switch reads as on, the
 * live account's bar fills, and at the threshold nothing happens — because
 * every other account is held out or its login is dead. That is the whole
 * failure, and it is the only sentence here in the colour that means act on it.
 */
export function restLine(peers: readonly Peer[], mode: {
  /** The live account is past the threshold auto-switch would act on. */
  strained: boolean;
  /** Something is switching automatically — this deck's own loop, or a
   *  `cswap auto` in a terminal, which does the same job while the deck stands
   *  down. Both mean the reader is not the one picking. */
  armed: boolean;
  /** Where the policy trips, as the store spells it, or null while the panel
   *  has not read it yet. Printed because the control that sets it now lives
   *  behind this row — see the tail clause below. */
  threshold?: string | null;
}): {
  text: string;
  tone: "ok" | "idle" | "bad";
  /** The best headroom among the ready, when the row is saying it. Returned so
   *  the panel does not recompute a number the row already found. */
  free: number | null;
} {
  const ready = peers.filter(p => p.ready);
  if (mode.armed && peers.length > 0 && ready.length === 0) {
    // Named rather than counted. `none of 2 ready` is the same fact in the
    // calm tier, and the reader it is for is about to hit a wall the policy
    // promised to keep them off. The control it names is the next row down.
    return { text: "Auto-switch has nowhere to go", tone: "bad", free: null };
  }
  const base = ready.length === peers.length
    ? `${peers.length} ready`
    : ready.length === 0
      // `none of 1 ready` is arithmetic about a set of one. The singular says it
      // as a state instead, which is what it is.
      ? peers.length === 1 ? "not ready" : `none of ${peers.length} ready`
      : `${ready.length} of ${peers.length} ready`;
  const tone = ready.length ? "ok" as const : "idle" as const;
  const free = mode.strained && !mode.armed ? bestFree(ready) : null;
  const clauses = [base];
  if (free != null) clauses.push(`${free}% free`);
  // THE TAIL IS ALWAYS THE POLICY, and it is here because the control moved
  // behind this row. A toggle nobody can see is a toggle nobody can tell the
  // state of, and `off` has to be as sayable as `on`: a row that only spoke
  // when the policy was armed would leave a reader unable to tell a deck that
  // will not switch from a row that does not mention switching. The threshold
  // rides with `on` because it is the whole of what on MEANS here.
  clauses.push(mode.armed ? `auto ${mode.threshold ?? "on"}${mode.threshold ? "%" : ""}` : "auto off");
  return { text: clauses.join(" · "), tone, free };
}

/** The most room any of these has left, or null when none of them has ever been
 *  read. */
function bestFree(peers: readonly Peer[]): number | null {
  const known = peers.map(p => p.headroom).filter((h): h is number => typeof h === "number");
  return known.length ? Math.max(...known) : null;
}

/**
 * WHAT THE PEEK SHOWS — the names the count refuses to say, in the order the
 * question is asked in.
 *
 * READY FIRST, EMPTIEST FIRST, because the reader hovering this row is choosing
 * where to go and the top name is the answer. An account that cannot be
 * switched to is not a candidate, so it sorts under all of them and carries the
 * word that says why rather than a number that would read as a candidate's.
 *
 * A name with nothing collected for it sorts last among the ready: it may well
 * be the emptiest account there is, and saying so on no evidence is how a
 * summary earns a reader who stops believing it.
 */
export function foldPeek(peers: readonly Peer[]): {
  title: string;
  shown: Peer[];
  /** The tail line: the names too many to print, or null when none were cut. */
  rest: string | null;
} {
  const order = [...peers].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (!a.ready) return a.name.localeCompare(b.name);
    const ah = a.headroom, bh = b.headroom;
    if (ah == null && bh == null) return a.name.localeCompare(b.name);
    if (ah == null) return 1;
    if (bh == null) return -1;
    return bh - ah;
  });
  const shown = order.slice(0, FOLD_NAMES);
  const cut = order.length - shown.length;
  return {
    title: peers.some(p => p.ready) ? "Where you could switch" : "Nothing to switch to",
    shown,
    rest: cut > 0 ? `and ${cut} more` : null,
  };
}
