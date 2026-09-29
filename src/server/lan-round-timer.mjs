// When the next sync round runs, lifted out of createEngine in lan-engine.mjs
// with the one variable only it used — the timer — and the two gaps it picks
// between. What a round does is the engine's, and the line every round waits
// in is lan-turns.mjs's; this is only the clock that asks for the next one.

/** How often a deck asks its peers what they have. A minute is far more often
 *  than a login dies, and it is what makes the panel's list feel live rather
 *  than something that updates when you press a button. */
export const SYNC_MS = 60_000;

/**
 * How long to wait before dialling again while somebody is deciding.
 *
 * A minute is right for the steady state — two decks whose logins all work have
 * nothing to say to each other — and it is far too long for the one moment
 * anybody is watching: the seconds after somebody presses accept on the other
 * machine. Reported as "it should work by itself", from a panel that had been
 * correct for up to fifty-nine more seconds than the person in front of it.
 *
 * So the loop tightens while a request is outstanding and relaxes the moment it
 * is answered — either way. A refusal is an answer, and a deck that said no is
 * not asked every eight seconds.
 */
export const ASKING_MS = 8_000;

/**
 * `round` runs one whole round, the engine's own, which waits its turn in the
 * line. `waiting` says whether a deck this one dialled is still deciding
 * whether to accept it — the one state where asking again in a few seconds
 * does something a minute later would not.
 */
export function createRoundTimer({ round, waiting }) {
  /** The next round, while one is scheduled. */
  let timer = null;

  /**
   * Run a round a whole SYNC_MS after the listener comes up, and another each
   * time the last one finishes, until `ended` says the start that began the
   * loop is over — stopped, restarted or switched off.
   */
  const start = ended => {
    // A self-scheduling loop rather than one interval, because the gap
    // between rounds is not one number: see ASKING_MS.
    const tick = async () => {
      try { await round(); } catch { /* a round reports itself, per peer */ }
      if (ended()) return;
      timer = setTimeout(() => { void tick(); }, waiting() ? ASKING_MS : SYNC_MS);
      timer.unref?.();
    };
    timer = setTimeout(() => { void tick(); }, SYNC_MS);
    timer.unref?.();
  };

  /** Call off the round scheduled next. One already running finishes, and
   *  schedules nothing after it once its start has ended. */
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { start, stop };
}
