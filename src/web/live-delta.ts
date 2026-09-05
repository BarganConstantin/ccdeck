// What has been spent SINCE the last ccusage reading, from the canvas.
//
// The panel's figures are the truth off the logs on disk, and reading them costs
// a process that walks every transcript on the machine — 7.8 CPU-seconds here,
// on 3,615 files. Asking every ten seconds would be 78% of a core, forever, for
// numbers that move slowly. Asking every five minutes is cheap and leaves the
// headline five minutes stale, which on an active machine is the whole point of
// having it.
//
// So the deck fills the gap with what it already knows. Every hook event
// carries the session's cumulative usage, so the canvas holds a running total
// that is exact and free. Take a baseline of it at the moment a ccusage reading
// lands, and everything the board has accrued since is, to the token, the spend
// that reading does not include yet.
//
// THE ONE APPROXIMATION, said plainly: the tokens are exact and the DOLLARS on
// the delta are priced by this deck's own rate table rather than by ccusage's.
// The two agree on every model either of them knows; where they do not, the
// difference is a minute or two of one session's spend and it disappears at the
// next true-up. That is the trade for a number that moves when the work happens.
import { agentCost, type UsageBearing } from "./usage-models";

/** One session's cumulative usage, as the canvas holds it. */
export interface SessionUsage {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/** What a delta adds to a reading. Same shape as the reading's own totals. */
export interface LiveDelta extends SessionUsage {
  /** How many sessions contributed anything. Zero means "nothing has happened
   *  since", which is what an idle machine looks like and is worth being able
   *  to say. */
  sessions: number;
}

export const NO_DELTA: LiveDelta = {
  cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sessions: 0,
};

/** The agents this counts: session roots, which are the only nodes that carry
 *  usage. A subagent's tokens are already inside its root's total — see the
 *  note in reducer.ts — so counting nodes would count them twice. */
export interface CountableAgent extends UsageBearing {
  kind?: string;
  sessionId?: string;
}

/**
 * The canvas's per-session usage right now, keyed by session id.
 *
 * This is the baseline captured when a reading lands, and the same function
 * produces the "now" side of the comparison — one shape, one place, so the two
 * cannot drift apart.
 */
export function boardBySession(agents: Iterable<CountableAgent>, now?: number): Map<string, SessionUsage> {
  const out = new Map<string, SessionUsage>();
  for (const a of agents) {
    if (a.kind !== "root" || !a.sessionId) continue;
    const c = agentCost(a, now);
    out.set(a.sessionId, {
      cost: c.total,
      inputTokens: a.usage.inputTokens,
      outputTokens: a.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens,
      cacheCreateTokens: a.usage.cacheCreateTokens,
    });
  }
  return out;
}

/**
 * Everything the board has gained since `baseline`.
 *
 * PER SESSION, and never negative. The canvas evicts a finished session about
 * two minutes after it ends, and a board-wide subtraction would then go
 * backwards — the headline falling on its own is exactly the defect #687 is
 * about, and it would be worse here because it would fall UNDER a total that
 * already counted that session. A session that has left contributes nothing
 * further.
 *
 * A SESSION MISSING FROM THE BASELINE CONTRIBUTES NOTHING EITHER, and that is a
 * correction. This function used to count all of it, on the reading that "a
 * session the baseline never saw is work ccusage cannot have counted". That is
 * true of a session that did not exist yet and false of the ordinary case,
 * which is a session that existed all along and had not reached the CANVAS yet.
 *
 * Measured on a deck four seconds old: ccusage answered $450.28 for today and
 * the panel printed $1,006. The reading lands about 2.5s after boot and the
 * canvas is still replaying its event log at that moment, so the baseline was
 * taken over an almost empty board — and every session that then appeared,
 * each of them already inside ccusage's $450, was added again in full. The
 * error is unbounded and always upward: the more the deck knows, the more it
 * over-reports.
 *
 * The cost of the correction is that a genuinely NEW session's spend waits for
 * the next reading, so up to sixty seconds. That is the behaviour the panel had
 * before the delta existed at all, it is invisible next to a figure that
 * doubles, and it is the direction to be wrong in: this delta may only ever add
 * work it has WATCHED happen, never work it has merely learned about.
 */
export function liveDelta(
  baseline: Map<string, SessionUsage> | null,
  current: Map<string, SessionUsage>,
): LiveDelta {
  if (!baseline) return NO_DELTA;
  const out: LiveDelta = { ...NO_DELTA };
  for (const [id, now] of current) {
    const was = baseline.get(id);
    // Not in the baseline: this session's history is not this delta's to claim.
    // See the note above — it is almost never new work, and when it is, the
    // next reading picks it up.
    if (!was) continue;
    const gained = {
      cost: now.cost - was.cost,
      inputTokens: now.inputTokens - was.inputTokens,
      outputTokens: now.outputTokens - was.outputTokens,
      cacheReadTokens: now.cacheReadTokens - was.cacheReadTokens,
      cacheCreateTokens: now.cacheCreateTokens - was.cacheCreateTokens,
    };
    // A session whose totals went DOWN is not a refund — it is a replay, a
    // restarted deck, or a reading this deck should not try to interpret. It
    // contributes nothing rather than subtracting.
    if (gained.cost < 0 || gained.inputTokens < 0 || gained.outputTokens < 0) continue;
    if (gained.cost === 0 && gained.inputTokens === 0 && gained.outputTokens === 0
      && gained.cacheReadTokens === 0 && gained.cacheCreateTokens === 0) continue;
    out.cost += gained.cost;
    out.inputTokens += Math.max(0, gained.inputTokens);
    out.outputTokens += Math.max(0, gained.outputTokens);
    out.cacheReadTokens += Math.max(0, gained.cacheReadTokens);
    out.cacheCreateTokens += Math.max(0, gained.cacheCreateTokens);
    out.sessions += 1;
  }
  return out;
}
