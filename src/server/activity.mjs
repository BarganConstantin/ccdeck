// Whether any agent is mid-turn, from the hook stream alone.
//
// For the one decision the server takes on its own that must not land in the
// middle of a turn: restarting into a new version while nobody is looking
// (auto-update.mjs). A restart mid-turn drops the hook events fired during the
// gap, and the canvas shows those tools in flight until the stale sweeper
// reaps them — restart.ts states the rule for the page, which decides it from
// its reducer's `active` state.
//
// With no page open there is no reducer, so this keeps the smallest version of
// it: a session is open from the first event of a turn until the turn ends
// (`Stop`, `SessionEnd`). SessionStart and Notification move nothing — a CLI
// sitting at its prompt is not busy, and the idle reminder arrives after the
// turn it is about. An open session whose last event is older than
// OPEN_CAP_MS counts as gone rather than busy: a CLI that crashed never sends
// its Stop, and waiting on one forever would mean never updating.
export const OPEN_CAP_MS = 30 * 60_000;

const OPENS = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop",
]);
const CLOSES = new Set(["Stop", "SessionEnd"]);

/** More turns open at once than any machine runs — the same figure as the
 *  deck's own working limit for the sessions it tracks (MAX_TRACKED_SESSIONS in
 *  index.mjs). A bound because the ids arrive from outside: this is fed from
 *  pushEvent for every live event, and `/api/event` takes them without a
 *  credential. presence.mjs caps its map of tab ids for the same reason.
 *
 *  Past it the turn heard from least recently goes, and that costs `busy` no
 *  accuracy at all: the map is kept in the order turns were last heard from
 *  (see `note`), so every turn that stays is at least as recent as the one that
 *  left, and if the one that left was live, so is everything behind it. */
export const MAX_OPEN_TURNS = 256;

export function createActivity({ openCapMs = OPEN_CAP_MS } = {}) {
  /** session id → when its turn last produced an event, least recent first */
  const open = new Map();
  let lastAt = 0;
  return {
    /** One hook payload, as pushEvent receives it. Anything else is ignored. */
    note(raw, at) {
      const name = raw?.hook_event_name;
      if (!OPENS.has(name) && !CLOSES.has(name)) return;
      if (at > lastAt) lastAt = at;
      const id = raw?.session_id;
      if (typeof id !== "string" || !id) return;
      // DELETE, THEN SET (#1089), which is what presence.mjs has always done
      // and this did not. `Map.set` on a key that is already there updates it
      // IN PLACE, so a turn kept its position from its first event for as long
      // as it ran — and `busy` below stops at the first live entry it meets,
      // which is also the only place an entry ever expires. One long-running
      // turn therefore sat at the head of the iteration order and shielded
      // every turn that went quiet behind it: measured with 200,000 abandoned
      // turns queued behind one that kept working, fifty sweeps at 150 minutes
      // past the cap freed nothing, and when the long turn finally ended the
      // next call swept the whole backlog in one synchronous loop — 175ms of an
      // event loop that is also serving SSE and `/api/event`, off the timer the
      // away-update runs on. Re-inserting moves the turn to the young end, so
      // the map stays in the order turns were last heard from and the early
      // return is sound: whatever is behind a live entry is younger than it.
      open.delete(id);
      if (OPENS.has(name)) {
        open.set(id, at);
        while (open.size > MAX_OPEN_TURNS) open.delete(open.keys().next().value);
      }
    },
    /** Whether any turn is still running. Expires what it walks past, and may
     *  stop at the first live entry only because `note` keeps the map oldest
     *  first — everything after that entry was heard from more recently. A turn
     *  stamped by a clock that has since moved either way is as expired as an
     *  old one, which is why the difference is absolute. */
    busy(now) {
      for (const [id, at] of open) {
        if (Math.abs(now - at) > openCapMs) open.delete(id);
        else return true;
      }
      return false;
    },
    /** How long since the last turn event of any session — Infinity before the first. */
    quietMs(now) {
      return lastAt ? Math.max(0, now - lastAt) : Infinity;
    },
    /** How many turns are being held. For the suite: the map is private, and
     *  what it holds is the whole of what #1089 was about. */
    size() {
      return open.size;
    },
  };
}
