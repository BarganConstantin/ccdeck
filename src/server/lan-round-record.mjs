// What the last round did with each deck, and when the whole round last
// finished: lifted out of createEngine in lan-engine.mjs with the two
// variables only these read and write, and the one rule read off them — is
// anybody on the other end still deciding. The round in the engine writes a
// record per deck it asked; the panel's rows, a deck's own `check now` and the
// clock that picks the next round's gap (lan-round-timer.mjs) read them.

/** `now` is the engine's clock. */
export function createRoundRecord({ now }) {
  /** What the last round did, for the panel. Not a log: one line per peer, most
   *  recent only, because "what happened" is a question about now. */
  const lastRound = new Map();
  /** When the last round FINISHED, whatever it did or failed to do. The panel's
   *  `↻` fires one on demand and the loop fires one on its own; a reader who
   *  pressed it wants to know it happened, and a reader who did not wants to
   *  know the list is not a photograph of an hour ago. */
  let roundAt = null;
  /** The rows the last whole round asked, and the rows asked since it — the
   *  only ones whose line still says anything about who is deciding. See
   *  waitingOnSomebody. */
  let asked = new Set();
  let asking = new Set();

  /**
   * Is anybody on the other end still deciding?
   *
   * The exact sentence lan-call.mjs gives for "a real deck, not yet
   * accepted", which is the one state where dialling again in a few seconds
   * does something a minute later would not.
   *
   * AND ONLY OF A ROW A ROUND STILL ASKS (#1742). A line stays here after its
   * row is gone — removed in the panel, dropped by a settings write, evicted
   * by the cap, or no longer dialled at all — and nothing asks that row again
   * to overwrite it, so one that said "waiting" kept every round eight seconds
   * apart until the deck restarted. What the last whole round asked is the
   * list the next one dials, give or take the row somebody just changed; a
   * row taken off costs one more quick round, never the rest of the process.
   */
  const waitingOnSomebody = () =>
    [...asked, ...asking].some(fp => lastRound.get(fp)?.error === "waiting for the other deck to accept this one");

  return {
    /** What the last ask of a row did, or undefined. Keyed by the ROW the
     *  round dialled, which for a typed address is the placeholder built from
     *  it rather than the fingerprint that answered there. */
    of: fp => lastRound.get(fp),
    /** An ask of that row finished, well or not, and this is what it did. The
     *  record is kept as it is handed over, so the same object before and
     *  after a wait means nothing asked that row in between — see roundOne. */
    keep(fp, record) { lastRound.set(fp, record); asking.add(fp); },
    /** Nothing of that row is drawn any more: a dial-back taken away. */
    drop(fp) { lastRound.delete(fp); },
    /** A whole round finished — see roundAt, and asked. */
    finished() {
      roundAt = now();
      asked = asking;
      asking = new Set();
    },
    checkedAt: () => roundAt,
    waitingOnSomebody,
  };
}
