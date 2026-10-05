// What the deck knows about a session at the moment one of its agents commits:
// when it started, what it has spent so far, what it is called, and which
// model each of its agents runs on — read off the same envelopes pushEvent
// admits, so a restart rebuilds it from the replay like everything else here.
//
// THE SPEND IS THE NEWEST UsageObserved. Nothing else on the server keeps it:
// the transcript scan (session-enrichment.mjs) and the Codex watcher emit it
// as a synthetic event on a 2.5 s throttle and the client assigns it, so the
// newest one IS the session's cumulative spend — main thread and every
// subagent for Claude (`usage` + `usageByModel`), the whole session for Codex
// (`usage` = total_token_usage, priced by `model`). It is kept raw, tokens
// and models, because prices live in the client (pricing.ts) and a snapshot
// of tokens can be priced by any rate table later. It can trail the commit by
// up to one throttle period; its own `at` says how much.
//
// Bounded: least recently heard sessions go first, and the per-agent maps are
// capped for sessions that run hundreds of subagents.
import { agentKeyOf } from "./agent-git-calls.mjs";

const ROOT = "";

/**
 * @typedef {object} SessionSnapshot
 * @property {number | null} firstSeenAt  the first event the deck saw (ms)
 * @property {number | null} startedAt    the newest SessionStart (ms)
 * @property {{ usage: object, usageByModel: object | null, model: string | null, at: number } | null} usage
 * @property {string | null} sessionName
 * @property {string | null} sessionTitle
 * @property {string | null} agentType    the subagent's type, for a subagent
 * @property {string | null} model        the agent's newest known model
 */

/**
 * @param {{ maxSessions?: number, maxAgentsPerSession?: number }} [opts]
 */
export function createSessionFacts({ maxSessions = 512, maxAgentsPerSession = 512 } = {}) {
  const sessions = new Map();

  const capped = (map) => { while (map.size > maxAgentsPerSession) map.delete(map.keys().next().value); };
  const setCapped = (map, k, v) => { map.delete(k); map.set(k, v); capped(map); };

  return {
    /** @param {{ payload?: unknown, receivedAt?: number }} envelope */
    observe(envelope) {
      const p = envelope && typeof envelope === "object" ? envelope.payload : null;
      if (!p || typeof p !== "object") return;
      const sid = typeof p.session_id === "string" && p.session_id ? p.session_id : null;
      if (!sid) return;
      const at = typeof envelope.receivedAt === "number" ? envelope.receivedAt : Date.now();
      let s = sessions.get(sid);
      if (s) sessions.delete(sid);
      else s = { firstSeenAt: at, startedAt: null, usage: null, sessionName: null, sessionTitle: null, models: new Map(), agentTypes: new Map() };
      sessions.set(sid, s);
      while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);

      const name = p.hook_event_name;
      const agent = agentKeyOf(p);
      if (name === "SessionStart") s.startedAt = at;
      if (name === "UsageObserved" && p.usage && typeof p.usage === "object") {
        s.usage = {
          usage: p.usage,
          usageByModel: p.usageByModel && typeof p.usageByModel === "object" ? p.usageByModel : null,
          model: typeof p.model === "string" && p.model ? p.model : null,
          at,
        };
      }
      if (name === "SessionNamed") {
        s.sessionName = typeof p.sessionName === "string" && p.sessionName ? p.sessionName : null;
        s.sessionTitle = typeof p.sessionTitle === "string" && p.sessionTitle ? p.sessionTitle : null;
      }
      if (name === "ModelObserved" && p.subagentModels && typeof p.subagentModels === "object") {
        for (const [k, m] of Object.entries(p.subagentModels)) if (typeof m === "string" && m) setCapped(s.models, k, m);
      }
      if (typeof p.model === "string" && p.model) setCapped(s.models, agent ?? ROOT, p.model);
      if (agent && typeof p.agent_type === "string" && p.agent_type) setCapped(s.agentTypes, agent, p.agent_type);
    },

    /**
     * @param {string} sessionId
     * @param {string | null} [agentId]
     * @returns {SessionSnapshot}
     */
    snapshot(sessionId, agentId = null) {
      const s = sessions.get(sessionId);
      const key = typeof agentId === "string" && agentId ? agentId : ROOT;
      if (!s) return { firstSeenAt: null, startedAt: null, usage: null, sessionName: null, sessionTitle: null, agentType: null, model: null };
      return {
        firstSeenAt: s.firstSeenAt,
        startedAt: s.startedAt,
        usage: s.usage,
        sessionName: s.sessionName,
        sessionTitle: s.sessionTitle,
        agentType: key === ROOT ? null : s.agentTypes.get(key) ?? null,
        model: s.models.get(key) ?? null,
      };
    },

    forget(sessionId) { sessions.delete(sessionId); },
    clear() { sessions.clear(); },
  };
}
