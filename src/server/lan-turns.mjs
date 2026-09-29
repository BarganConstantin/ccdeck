// The one line every sync round waits in, lifted out of createEngine in
// lan-engine.mjs so the rule it keeps — whichever round is running is running
// alone — can be read, and tested, without a network. Nothing here knows what
// a round does: the engine hands it the job and the session it was asked in.

/**
 * Where every round waits its turn — the whole list, or one deck from its own
 * dialog — so that whichever is running is running alone. `round` and
 * `roundOne` are the only two ways in, and both come through here.
 *
 * A LINE RATHER THAN A FLAG, because the two ways in want different things
 * from what is already running and both have to end up behind it. A round
 * asked for during a check cannot join it — a check asks one deck, and a
 * round was asked to ask all of them — so it waits. A check asked for during
 * a round can often join it, and sometimes cannot. Both need somewhere to
 * stand that is after whatever is in flight, and this is it.
 *
 * The tail never rejects: `roundWith` reports a failure per peer instead of
 * throwing, and anything else is swallowed here rather than left to stop
 * every turn after it. The caller of the turn that threw still hears it.
 */
export function createTurns() {
  let _turn = Promise.resolve();
  const inTurn = job => {
    const run = _turn.then(job);
    _turn = run.then(() => {}, () => {});
    return run;
  };

  /** The whole round in flight or waiting its turn, or null. See `round` below. */
  let _round = null;
  /** The session `_round` was asked for in. */
  let _roundIn = -1;

  /**
   * One round at a time, and the one already running is the answer (#1040).
   *
   * The sequential loop in the engine's oneRound reasons about peers being
   * dialled one after another, which is a statement about the WHOLE round and
   * was only ever true of a round running alone. Two ways in, and they meet: a
   * self-scheduling timer (SYNC_MS, or ASKING_MS while somebody is waiting) and
   * the "Sync now" press, which calls this straight from the route. A press
   * landing on the timer's round gave two rounds walking the same peer list,
   * each reading the same slot as empty and each force-importing a credential
   * over the other — and the second one's blob wins for no reason anybody
   * chose.
   *
   * JOINING rather than skipping, because the press has a reply to send: a
   * caller that got `[]` for "a round is already running" would report "nothing
   * to sync" about a round that was at that moment moving a credential. This is
   * the shape `codexScanOnce` and ccusage's `_inflight` already use.
   *
   * THERE WAS A THIRD WAY IN, and it did not come through here (#1132). The
   * `check now` in a deck's own dialog reaches `roundOne`, which called
   * `roundWith` straight — so a press landing on the timer's round dialled the
   * deck that round was already healing from, and the far side exported the
   * same login twice for one account that needed repairing once. Both now take
   * their turn in one line, above. A round joins only another whole round,
   * never a check: joining a check would answer "ask every deck" with one
   * deck's work and leave the rest waiting another minute.
   *
   * NEVER A ROUND FROM A SESSION THAT ENDED. LAN switched off and on again
   * while one ran: that round stops at its next peer and reports nothing, so
   * joining it would answer the new session's first tick with nothing and
   * leave every deck unasked for a whole SYNC_MS. The new one queues behind it.
   */
  const round = (session, oneRound) => {
    if (_round && _roundIn === session) return _round;
    _roundIn = session;
    const mine = inTurn(oneRound).finally(() => { if (_round === mine) _round = null; });
    _round = mine;
    return mine;
  };

  /** Everything already in the line, settled — what a check waits behind
   *  before it decides whether it still has to ask. Never rejects. */
  const ahead = () => _turn;

  return { inTurn, round, ahead };
}
