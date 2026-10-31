// How many sessions are working, and how many are waiting on their human,
// from the hook stream alone — for the account's status frame.
//
// WHY THE SERVER KEEPS ITS OWN COPY. The deck's waiting and running counts are
// computed in the BROWSER, from its reducer (ambient-counts.ts blockedSessions
// and runningSessionCount), and a machine in a fleet usually has no tab open.
// So this keeps the smallest version of that reducer, the way activity.mjs does
// for the away-update: per session, whether its root and its subagents are
// active, which tool calls are in flight, and the waiting block — enough to give
// the same two numbers the tab would.
//
// THE RULES ARE THE PAGE'S, mirrored, and session-counts-mirror.test.ts runs
// both over the same recorded event logs and requires the same counts after
// every event:
//
//   waiting   A `Notification` of `permission_prompt` (the newest in-flight
//             call says which subagent asked) or `agent_needs_input` raises a
//             block; `idle_prompt` raises one that is not an alarm. Any later
//             event of the session that is not one of the transcript scans
//             (WAITING_KEEPERS) may clear it: an idle block by anything, the
//             other two only by the root's own traffic or by the subagent that
//             asked (waiting-block.ts clearsWaiting).
//   running   A session with any agent active, the way the page counts it: the
//             root from the first event that creates it, a prompt, a session
//             start or a call it makes, until its `Stop` or `SessionEnd`; a
//             subagent from its `SubagentStart` until its `SubagentStop`. A
//             session that is waiting is counted as waiting, not running.
//
// TWO DOCUMENTED DIFFERENCES, both clocks the page does not have: a block with
// no event from its session for two hours is not counted (nobody is coming
// back to a prompt that old), and a session silent for 30 minutes is not
// running (activity.mjs's cap — a CLI that crashed never sends its Stop). The
// page's own sweep answers the second at 90 minutes; the frame is about now.
//
// IT DOES CONSUME A REPLAY, unlike activity.mjs: a block raised before a
// restart is still a person being waited on after it, and the page counts it
// from the replayed ring too. So the account seeds this from the ring at the
// moment it starts (`seed`), and is fed every live event after that.
//
// Bounded, because session ids arrive from outside (`/api/event` takes them
// without a credential): past MAX_SESSIONS the session heard from least
// recently goes.

export const WAITING_EXPIRE_MS = 2 * 60 * 60_000;
export const RUNNING_CAP_MS = 30 * 60_000;
export const MAX_SESSIONS = 256;

/** waiting-block.ts WAITING_KEEPERS, word for word: events that are not proof
 *  the session moved. */
export const WAITING_KEEPERS = new Set([
  "Notification", "ModelObserved", "ContextObserved", "UsageObserved", "SessionNamed",
  "SessionRecapped", "OutputObserved", "ActivityObserved", "JobObserved",
]);

/** The server's transcript scans, which the page applies to a card that
 *  exists and never let create one (reducer.ts, parked-enrichment.ts). */
const SCANS = new Set([
  "ModelObserved", "ContextObserved", "UsageObserved", "SessionNamed", "SessionRecapped",
  "OutputObserved", "ActivityObserved", "JobObserved",
]);

/** waiting-block.ts waitingKind. */
function waitingKind(type) {
  if (type === "permission_prompt") return "permission";
  if (type === "agent_needs_input") return "asked";
  if (type === "idle_prompt") return "idle";
  return null;
}

/** agent-attribution.ts explicitSubagentKey. */
function subagentKey(p) {
  if (typeof p.agent_id === "string" && p.agent_id) return p.agent_id;
  if (typeof p.parent_tool_use_id === "string" && p.parent_tool_use_id) return p.parent_tool_use_id;
  return null;
}

const alarming = w => w?.kind === "permission" || w?.kind === "asked";

/**
 * The counter. `now` is the clock the two documented expiries read; `capture`
 * answers whether anything feeds this deck at all — false, and the counts are
 * `no-capture` rather than a pair of zeros nobody measured.
 */
export function createSessionCounts({ capture = () => true } = {}) {
  /** session id → state, least recently heard first. */
  const sessions = new Map();
  let ready = false;

  function session(id, at, create) {
    let s = sessions.get(id);
    if (!s) {
      if (!create) return null;
      s = { rootActive: true, subs: new Map(), stack: [], keyed: false, calls: new Map(), waiting: null, lastAt: at, provider: null };
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    } else {
      sessions.delete(id);
    }
    sessions.set(id, s);
    return s;
  }

  /** Who a call or an event naming nobody belongs to, as resolveOwner says:
   *  the named subagent if it exists, else the newest live one on the stack
   *  (unless this session's subagents name themselves), else the root. */
  function ownerOf(s, key) {
    if (key && s.subs.has(key)) return key;
    if (!s.keyed && s.stack.length) {
      const top = s.stack[s.stack.length - 1];
      if (s.subs.has(top)) return top;
    }
    return null;
  }

  function clearIfAnswered(s, name, key) {
    if (!s.waiting || WAITING_KEEPERS.has(name)) return;
    if (s.waiting.kind === "idle") { s.waiting = null; return; }
    if (key == null) { s.waiting = null; return; }
    if (s.waiting.subKey != null && s.waiting.subKey === key) s.waiting = null;
  }

  /** The newest call still in flight on this session, as waiting-block.ts
   *  blockedCall reads it. */
  function newestCall(s) {
    let newest = null;
    for (const c of s.calls.values()) if (!newest || c.at > newest.at) newest = c;
    return newest;
  }

  /** One hook payload, as pushEvent receives it, stamped when it arrived. */
  function note(raw, at) {
    if (!raw || typeof raw !== "object") return;
    const name = typeof raw.hook_event_name === "string" ? raw.hook_event_name : "";
    if (name === "__clear") { sessions.clear(); return; }
    const id = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : "unknown";
    const key = subagentKey(raw);
    if (SCANS.has(name)) {
      // A scan moves nothing and creates nothing; it is still the session's id
      // arriving from a running process, which the clocks below count — except
      // a background job's file, which the page does not count either.
      const s = sessions.get(id);
      if (s && name !== "JobObserved" && at > s.lastAt) s.lastAt = at;
      return;
    }
    const s = session(id, at, true);
    if (at > s.lastAt) s.lastAt = at;
    if (raw.provider === "codex") s.provider = "codex";
    // The block's clear runs first, before the event does anything else.
    clearIfAnswered(s, name, key);
    if (name !== "SubagentStart" && name !== "SubagentStop" && typeof raw.agent_id === "string" && raw.agent_id) s.keyed = true;

    switch (name) {
      case "SessionStart":
      case "UserPromptSubmit":
        s.rootActive = true;
        break;
      case "SubagentStart":
        if (key) {
          s.subs.set(key, true);
          if (!s.stack.includes(key)) s.stack.push(key);
        }
        break;
      case "SubagentStop":
        if (key && s.subs.has(key)) s.subs.set(key, false);
        if (key) {
          const at2 = s.stack.lastIndexOf(key);
          if (at2 >= 0) s.stack.splice(at2, 1);
        }
        break;
      case "PreToolUse": {
        const owner = ownerOf(s, key);
        if (owner) s.subs.set(owner, true);
        else s.rootActive = true;
        if (typeof raw.tool_use_id === "string" && raw.tool_use_id && !s.calls.has(raw.tool_use_id)) {
          s.calls.set(raw.tool_use_id, { at, key });
        }
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure":
        if (typeof raw.tool_use_id === "string") s.calls.delete(raw.tool_use_id);
        break;
      case "Stop":
      case "SessionEnd":
        s.rootActive = false;
        // The root's own calls cannot outlive its turn (session-lifecycle.ts);
        // a subagent's can. Codex's missing result is a call parked on a
        // person, and is left alone.
        if (s.provider !== "codex") for (const [cid, c] of s.calls) if (c.key == null) s.calls.delete(cid);
        s.stack.length = 0;
        break;
      case "Notification": {
        const kind = waitingKind(raw.notification_type);
        if (!kind) break;
        const message = typeof raw.message === "string" ? raw.message : "";
        const prev = s.waiting;
        if (prev && prev.kind === kind && prev.message === message) {
          prev.since = Math.min(prev.since, at);
        } else {
          const block = { kind, message, since: at, subKey: null };
          if (kind === "permission") {
            const call = newestCall(s);
            if (call?.key) block.subKey = call.key;
          }
          s.waiting = block;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Every envelope the ring holds, oldest first: the replayed history and
   *  whatever arrived since, so the counts start where the page's would. */
  function seed(envelopes) {
    for (const e of envelopes ?? []) if (e && e.payload) note(e.payload, e.receivedAt);
  }

  /** The two numbers at `now`, as the status frame carries them — or why they
   *  cannot be told. */
  function reading(now = Date.now()) {
    if (!ready) return { unknown: "starting" };
    if (!capture()) return { unknown: "no-capture" };
    let running = 0;
    let waiting = 0;
    for (const s of sessions.values()) {
      const quiet = Math.abs(now - s.lastAt);
      if (alarming(s.waiting) && quiet <= WAITING_EXPIRE_MS) { waiting++; continue; }
      if (quiet > RUNNING_CAP_MS) continue;
      if (s.rootActive || [...s.subs.values()].some(Boolean)) running++;
    }
    return { running, waiting, sampledAt: now };
  }

  return {
    note,
    seed,
    /** The boot replay is over and the ring has been read: counts are real. */
    markReady: () => { ready = true; },
    reading,
    /** For the suite. */
    size: () => sessions.size,
  };
}
