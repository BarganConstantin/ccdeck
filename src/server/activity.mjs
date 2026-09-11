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

export function createActivity({ openCapMs = OPEN_CAP_MS } = {}) {
  /** session id → when its turn last produced an event */
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
      if (CLOSES.has(name)) open.delete(id);
      else open.set(id, at);
    },
    /** Whether any turn is still running. */
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
  };
}
