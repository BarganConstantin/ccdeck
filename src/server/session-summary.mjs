// The sessions a deck is watching, as one row each, for `ccdeck sessions`
// (#2183) — the question somebody on SSH asks first: which of my agents is
// waiting on me?
//
// The canvas answers it from src/web/reducer.ts, which folds every event into a
// graph of agents, tool calls and subagents. None of that is needed to say
// which sessions exist and which one is blocked, and none of it can be imported
// here: it is TypeScript bundled for the browser. So this is a small fold over
// the same ring, and THE WAITING RULE IS A MIRROR of src/web/waiting-block.ts —
// the same three `notification_type` kinds, the same events that leave a block
// standing, the same rule for whose traffic clears one — written twice because
// it has to be, the way block-notify.mjs mirrors sound.ts.
// session-summary-mirror.test.ts runs both over the same events and fails the
// day they disagree.
//
// Pure: envelopes in, rows out. The route that serves it is in index.mjs.

/** How long a session may be silent before it is taken to be gone — the
 *  canvas's own STALE_SESSION_MS (src/web/board-sweeps.ts), for its reasons:
 *  long enough for a permission prompt left standing through a meeting, short
 *  enough that this morning's closed terminals stop being listed as running. */
export const STALE_SESSION_MS = 90 * 60_000;

/** The `notification_type` values that raise a block, as the chore each one is
 *  — waitingKind in waiting-block.ts. */
export function waitingKind(notificationType) {
  if (notificationType === "permission_prompt") return "permission";
  if (notificationType === "agent_needs_input") return "asked";
  if (notificationType === "idle_prompt") return "idle";
  return null;
}

/** Events that are not evidence the session moved, and leave a block standing
 *  — WAITING_KEEPERS in waiting-block.ts, which says why each one is here. */
export const WAITING_KEEPERS = new Set([
  "Notification", "ModelObserved", "ContextObserved", "UsageObserved",
  "SessionNamed", "SessionRecapped", "OutputObserved", "ActivityObserved", "JobObserved",
]);

/** The transcript scans: enrichment the server reads off a session's files,
 *  never the session's own traffic — the reducer's early returns, which stamp
 *  no provider and prove nothing about whether the session is alive. */
const SCANS = new Set([...WAITING_KEEPERS].filter(n => n !== "Notification"));

/** Two copies of one event inside this are the wire talking twice —
 *  HOOK_REDELIVERY_WINDOW_MS and PROMPT_REDELIVERY_WINDOW_MS in
 *  src/web/redelivery.ts, which are the same number on purpose. */
const REDELIVERY_MS = 2_000;

/** Whose traffic an event is: the subagent it names, or null for the root's —
 *  explicitSubagentKey in agent-attribution.ts. */
function subagentKeyOf(p) {
  if (p.agent_id) return p.agent_id;
  if (p.parent_tool_use_id) return p.parent_tool_use_id;
  return null;
}

/** Is this event evidence the human dealt with `w`? clearsWaiting in
 *  waiting-block.ts: any traffic falsifies an idle block; a permission prompt
 *  or a question is answered only by the root's own traffic or by the very
 *  subagent that asked. */
function clearsWaiting(w, p) {
  if (w.kind === "idle") return true;
  const key = subagentKeyOf(p);
  if (key == null) return true;
  return w.subagent != null && w.subagent === key;
}

/** The newest call still in flight on a session, whose payload names who is
 *  asking — blockedCall in waiting-block.ts, minus the canvas's owner lookup:
 *  the payload's own key is what that function reads in the end. */
function newestInFlight(s) {
  let newest = null;
  for (const c of s.inFlight.values()) if (!newest || c.at > newest.at) newest = c;
  return newest;
}

function blankSession(id, at) {
  return {
    id, provider: null, cwd: null, name: null, model: null,
    startedAt: at, lastEventAt: at, recoveryLiveAt: null,
    turn: "idle", turnSince: at, closed: false, waiting: null,
    prompts: [], lastTurnEndAt: null,
    inFlight: new Map(),
  };
}

/** A prompt, filed in time order unless it is a copy of one already filed —
 *  recordPrompt in redelivery.ts. Only the newest is ever read, as evidence. */
function recordPrompt(s, at, text) {
  for (let i = s.prompts.length - 1; i >= 0; i--) {
    const prev = s.prompts[i];
    if (prev.at < at - REDELIVERY_MS) break;
    if (prev.text === text && prev.at <= at + REDELIVERY_MS) return;
  }
  let i = s.prompts.length;
  while (i > 0 && s.prompts[i - 1].at > at) i--;
  s.prompts.splice(i, 0, { at, text });
}

/**
 * `Stop` or `SessionEnd`: the root's turn is over — applyTurnEnd in
 * session-lifecycle.ts, the parts of it a row can show.
 *
 * Refused whole when it is out of order (a boundary older than the prompt that
 * opened the turn now running) or a copy of the ending already recorded, for
 * the reducer's reason (#1022): a replayed `Stop` landing in the next turn
 * would call a working session "your turn". And the calls it settles are the
 * ROOT's only, and none on Codex: a background subagent outlives the turn that
 * dispatched it, and its call — and a permission prompt that call raises — is
 * still running after the root's `Stop`.
 */
function endTurn(s, name, at) {
  const newest = s.prompts[s.prompts.length - 1];
  const evidenceAt = newest && newest.at > s.startedAt ? newest.at : s.startedAt;
  if (at < evidenceAt) return;
  if (s.lastTurnEndAt != null && evidenceAt > s.lastTurnEndAt && at <= s.lastTurnEndAt + REDELIVERY_MS) return;
  s.turn = "idle"; s.turnSince = at;
  s.lastTurnEndAt = at;
  if (s.provider !== "codex") {
    for (const [id, call] of s.inFlight) if (call.key == null) s.inFlight.delete(id);
  }
  if (name === "SessionEnd") s.closed = true;
}

/**
 * The deck's recovery scan, which finds a session already running when it
 * starts — recoverSession in session-recovery.ts. Not the session's traffic:
 * it leaves a standing block standing (after a restart the replay has put the
 * session's prompt back up, and the scan arrives every second and a half),
 * and a snapshot older than the session's own newest event says nothing.
 */
function recover(sessions, p, at) {
  const id = p.session_id;
  if ((p.provider !== "codex" && p.provider !== "claude") || typeof id !== "string" || !id) return;
  const s = sessions.get(id);
  if (s?.provider && s.provider !== p.provider) return;
  if (s && Number.isFinite(p.snapshot_observed_at) && (s.recoveryLiveAt ?? s.lastEventAt ?? 0) >= p.snapshot_observed_at) return;
  if (p.recovery_active === false) {
    if (s) endTurn(s, p.recovery_session_closed === true ? "SessionEnd" : "Stop", at);
    return;
  }
  const r = s ?? blankSession(id, at);
  sessions.set(id, r);
  r.recoveryLiveAt ??= s?.lastEventAt ?? 0;
  r.provider = p.provider;
  r.closed = false;
  if (r.turn !== "working") { r.turn = "working"; r.turnSince = at; }
  r.lastEventAt = at;
  if (!r.cwd && typeof p.cwd === "string" && p.cwd) r.cwd = p.cwd;
  if (typeof p.model === "string" && p.model) r.model = p.model;
  if (!s && Number.isFinite(p.turn_started_at) && p.turn_started_at <= at) r.startedAt = p.turn_started_at;
  if (typeof p.prompt === "string" && p.prompt && r.prompts.at(-1)?.text !== p.prompt) r.prompts.push({ at, text: p.prompt });
}

/**
 * Every session in the ring, folded.
 *
 * `envelopes` are the ring's own `{ seq, receivedAt, payload }`, oldest first.
 * Each row says what the session is doing in one word:
 *
 *   waiting   a permission prompt or a question is standing — the alarm the
 *             topbar chip counts (isAlarming in ambient-counts.ts)
 *   working   a turn is running
 *   idle      the turn ended and the input box is waiting, which is not an
 *             alarm (#348) but is "your turn"
 *   ended     SessionEnd, or nothing heard for STALE_SESSION_MS
 */
export function summarizeSessions(envelopes, { now = Date.now(), staleMs = STALE_SESSION_MS } = {}) {
  let sessions = new Map();
  for (const env of Array.isArray(envelopes) ? envelopes : []) {
    const p = env?.payload;
    if (!p || typeof p !== "object") continue;
    const name = p.hook_event_name ?? "Unknown";
    // POST /api/clear wipes the canvas with this; it wipes the list too.
    if (name === "__clear") { sessions = new Map(); continue; }
    const at = Number(env.receivedAt) || now;
    if (name === "ClaudeSessionRecovered" || name === "CodexSessionRecovered") { recover(sessions, p, at); continue; }
    const id = typeof p.session_id === "string" && p.session_id ? p.session_id : null;
    if (!id) continue;
    let s = sessions.get(id);
    if (!s) { s = blankSession(id, at); sessions.set(id, s); }
    // A Codex child thread named by its parent: a session of its own, and
    // nothing the human did — linkCodexThread, which returns before any block
    // is read.
    if (name === "CodexThreadLinked") { if (p.provider === "codex") s.provider ??= "codex"; continue; }

    if (!WAITING_KEEPERS.has(name) && s.waiting && clearsWaiting(s.waiting, p)) s.waiting = null;
    // A background job's file is not always the session talking — see the
    // reducer's note at noteSessionHeard.
    if (name !== "JobObserved" && at > s.lastEventAt) s.lastEventAt = at;
    if (!SCANS.has(name)) {
      // The provider, from the session's first own event; a scan stamps none.
      s.provider ??= p.provider === "codex" ? "codex" : "claude";
      if (at >= (s.recoveryLiveAt ?? 0)) s.recoveryLiveAt = at;
    }
    if (!s.cwd && typeof p.cwd === "string" && p.cwd) s.cwd = p.cwd;
    if (typeof p.model === "string" && p.model && !subagentKeyOf(p)) s.model = p.model;
    if (name === "SessionNamed") s.name = p.sessionTitle ?? p.sessionName ?? s.name;

    switch (name) {
      case "SessionStart":
        s.closed = false;
        // The earliest beginning heard of, as applySessionStart keeps it.
        s.startedAt = Math.min(s.startedAt, at);
        if (s.turn !== "working") { s.turn = "idle"; s.turnSince = at; }
        break;
      case "UserPromptSubmit": {
        s.closed = false;
        s.turn = "working"; s.turnSince = at;
        const text = typeof p.prompt === "string" ? p.prompt : typeof p.message === "string" ? p.message : "";
        if (text) recordPrompt(s, at, text);
        break;
      }
      case "Stop":
      case "SessionEnd":
        endTurn(s, name, at);
        break;
      case "PreToolUse":
        if (p.tool_use_id) s.inFlight.set(p.tool_use_id, { at, key: subagentKeyOf(p), tool: p.tool_name ?? null });
        if (s.turn !== "working") { s.turn = "working"; s.turnSince = at; }
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (p.tool_use_id) s.inFlight.delete(p.tool_use_id);
        break;
      case "Notification": {
        const kind = waitingKind(p.notification_type);
        if (!kind) break;
        const message = typeof p.message === "string" ? p.message : "";
        const prev = s.waiting;
        if (prev && prev.kind === kind && prev.message === message) {
          prev.since = Math.min(prev.since, at);
          break;
        }
        const block = { kind, message, since: at, subagent: null, tool: null };
        if (kind === "permission") {
          const call = newestInFlight(s);
          if (call?.key) block.subagent = call.key;
          // BLOCK_GUESS_WINDOW_MS: only a call that started moments before the
          // prompt is printed as the thing being asked about.
          if (call?.tool && at - call.at <= 30_000 && call.at <= at) block.tool = call.tool;
        }
        s.waiting = block;
        break;
      }
      default:
        break;
    }
  }

  const rows = [];
  for (const s of sessions.values()) {
    const gone = s.closed || now - s.lastEventAt > staleMs;
    const alarm = !gone && s.waiting && s.waiting.kind !== "idle";
    const state = gone ? "ended" : alarm ? "waiting" : s.turn === "working" && !s.waiting ? "working" : "idle";
    const since = state === "waiting" ? s.waiting.since
      : state === "idle" && s.waiting ? Math.min(s.waiting.since, s.turnSince)
      : state === "ended" ? s.lastEventAt
      : s.turnSince;
    rows.push({
      id: s.id,
      provider: s.provider ?? "claude",
      cwd: s.cwd,
      project: s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd : null,
      name: s.name,
      model: s.model,
      state,
      since,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
      waiting: gone || !s.waiting ? null : { kind: s.waiting.kind, message: s.waiting.message, since: s.waiting.since, tool: s.waiting.tool },
    });
  }
  // The ones waiting on a human first, longest-blocked first — the order the
  // topbar's own click visits them (blockedSessions) — then running, then the
  // idle and the ended, most recently heard first.
  const rank = { waiting: 0, working: 1, idle: 2, ended: 3 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state]
    || (a.state === "waiting" ? a.since - b.since : b.lastEventAt - a.lastEventAt));
}
