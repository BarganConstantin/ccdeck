// Which files each agent edited: per session, per subagent, the absolute path,
// when it was last edited and the folder the edit was made from.
//
// Fed the same envelopes pushEvent admits — live ones and the boot replay of
// the events log alike — so it is rebuilt on restart by the replay the deck
// already does, and covers exactly the window that replay covers. Only edits
// made through an edit tool count (Claude's Edit / Write / MultiEdit /
// NotebookEdit, Codex's apply_patch), and only when the call succeeded: a file
// changed from a shell is not marked, because nothing says which agent's
// command changed it.
//
// The main thread of a session is agent `null`; a subagent is its `agent_id`.
// Codex sessions have no subagents.
//
// Bounded twice: a cap on sessions (the one edited least recently goes first)
// and a cap on files per session (its oldest edit goes first), so a deck left
// up for weeks keeps a fixed amount of this however much is edited.
import { createCallJoiner } from "./agent-git-calls.mjs";

const ROOT = "";

/**
 * @typedef {object} Edit
 * @property {string} path        absolute path of the edited file
 * @property {number} at          when the edit was received (ms)
 * @property {string | null} cwd  the folder the editing event named
 * @property {string | null} agentId  the subagent, or null for the main thread
 */

/**
 * @param {{ maxSessions?: number, maxEditsPerSession?: number, maxPending?: number }} [opts]
 */
export function createEditTracker({ maxSessions = 200, maxEditsPerSession = 2000, maxPending = 512 } = {}) {
  // sid -> { agents: Map<agentKey, Map<path, { at, cwd }>>, count }
  // Both maps are kept in recency order (delete + set on every touch), so the
  // first entry of each is the least recent one.
  const sessions = new Map();
  const joiner = createCallJoiner({ maxPending });

  function evictOldestEdit(s) {
    let oldestAgent = null;
    let oldestAt = Infinity;
    for (const [agent, files] of s.agents) {
      const first = files.values().next().value;
      if (first && first.at < oldestAt) { oldestAt = first.at; oldestAgent = agent; }
    }
    if (oldestAgent === null) return;
    const files = s.agents.get(oldestAgent);
    files.delete(files.keys().next().value);
    s.count--;
    if (!files.size) s.agents.delete(oldestAgent);
  }

  /**
   * Record one finished call's edits. Calls that failed, and calls that edited
   * nothing, change nothing.
   *
   * @param {import("./agent-git-calls.mjs").FinishedCall | null} call
   */
  function noteCall(call) {
    if (!call || !call.ok || !Array.isArray(call.edits) || !call.edits.length) return;
    let s = sessions.get(call.sessionId);
    if (s) sessions.delete(call.sessionId);
    else s = { agents: new Map(), count: 0 };
    sessions.set(call.sessionId, s);
    const agent = call.agentId ?? ROOT;
    let files = s.agents.get(agent);
    if (!files) { files = new Map(); s.agents.set(agent, files); }
    for (const path of call.edits) {
      if (files.has(path)) files.delete(path);
      else s.count++;
      files.set(path, { at: call.at, cwd: call.cwd ?? null });
    }
    while (s.count > maxEditsPerSession) evictOldestEdit(s);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
  }

  return {
    /**
     * Feed one envelope as pushEvent admits it. The server's own Clear marker
     * forgets everything; a marker under any other source is ignored, exactly
     * as the replay ignores one.
     *
     * @param {{ payload?: unknown, receivedAt?: number, source?: string }} envelope
     */
    observe(envelope) {
      const p = envelope && typeof envelope === "object" ? envelope.payload : null;
      if (p && typeof p === "object" && p.hook_event_name === "__clear") {
        if (envelope.source === "internal") this.clear();
        return;
      }
      noteCall(joiner.join(envelope));
    },

    noteCall,

    /**
     * The files a session's agents edited, newest first.
     *
     * - no `agentId`: the main thread's own edits;
     * - `includeSubagents: true` (and no `agentId`): the whole session — main
     *   thread and every subagent — one row per agent per file;
     * - `agentId`: that subagent's edits alone.
     *
     * @param {string} sessionId
     * @param {{ agentId?: string | null, includeSubagents?: boolean }} [opts]
     * @returns {Edit[]}
     */
    editsFor(sessionId, { agentId = null, includeSubagents = false } = {}) {
      const s = sessions.get(sessionId);
      if (!s) return [];
      const keys = typeof agentId === "string" && agentId
        ? [agentId]
        : includeSubagents ? [...s.agents.keys()] : [ROOT];
      const out = [];
      for (const key of keys) {
        const files = s.agents.get(key);
        if (!files) continue;
        for (const [path, e] of files) out.push({ path, at: e.at, cwd: e.cwd, agentId: key === ROOT ? null : key });
      }
      return out.sort((a, b) => b.at - a.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },

    /** The agents of a session that edited anything — `null` for the main
     *  thread — in the order they first did. */
    agentsOf(sessionId) {
      const s = sessions.get(sessionId);
      return s ? [...s.agents.keys()].map(k => (k === ROOT ? null : k)) : [];
    },

    /** Every session with at least one recorded edit. */
    sessions() { return [...sessions.keys()]; },

    /** Forget one session — its edits and its calls in flight. */
    forget(sessionId) {
      sessions.delete(sessionId);
      joiner.forget(sessionId);
    },

    /** Forget everything. */
    clear() {
      sessions.clear();
      joiner.clear();
    },
  };
}
