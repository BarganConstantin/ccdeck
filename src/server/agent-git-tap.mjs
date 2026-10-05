// What the git view learns from the event stream, and the one place it learns
// it: pushEvent hands every envelope it admits to `observeAgentGit` — a hook's
// POST, a Codex rollout line, the boot replay of the events log — so what is
// held here is rebuilt on restart by the replay the deck already runs, and
// covers the window that replay covers.
//
// Nothing here runs git or reads a repo. It keeps, per session and per agent,
// the files edited through edit tools (agent-git-edits.mjs).
//
// `observeAgentGit` never throws: it sits on the hottest path in the process,
// and a fault in a feature must not cost the deck an event.
import { PRODUCT } from "./brand.mjs";
import { createCallJoiner } from "./agent-git-calls.mjs";
import { createEditTracker } from "./agent-git-edits.mjs";

/**
 * @param {{ edits?: ReturnType<typeof createEditTracker> }} [deps]
 */
export function createAgentGitTap({ edits = createEditTracker() } = {}) {
  const joiner = createCallJoiner();

  return {
    edits,

    /**
     * One envelope, as pushEvent admitted it.
     *
     * @param {{ payload?: unknown, receivedAt?: number, source?: string }} envelope
     * @param {{ replay?: boolean, persisting?: boolean }} [opts] `replay`: read
     *   back from the log at boot; `persisting`: this deck is the one writing
     *   the event's session to the log.
     */
    observe(envelope, opts = {}) {
      const p = envelope && typeof envelope === "object" ? envelope.payload : null;
      if (!p || typeof p !== "object") return;
      if (p.hook_event_name === "__clear") {
        // The server's own Clear empties the canvas, and with it every edit
        // the canvas was showing. A marker from anywhere else is not the deck's.
        if (envelope.source === "internal") { edits.clear(); joiner.clear(); }
        return;
      }
      const call = joiner.join(envelope);
      if (!call) return;
      edits.noteCall(call);
    },
  };
}

/** The deck's one tap, fed by pushEvent. */
export const agentGit = createAgentGitTap();

/**
 * pushEvent's door into the tap. Never throws.
 *
 * @param {{ payload?: unknown, receivedAt?: number, source?: string }} envelope
 * @param {{ replay?: boolean, persisting?: boolean }} [opts]
 */
export function observeAgentGit(envelope, opts) {
  try {
    agentGit.observe(envelope, opts);
  } catch (err) {
    console.error(`${PRODUCT}: the git view could not read an event:`, err?.message ?? err);
  }
}

/**
 * The files a session's agents edited, newest first — see
 * agent-git-edits.mjs `editsFor` for the three scopes.
 *
 * @param {string} sessionId
 * @param {{ agentId?: string | null, includeSubagents?: boolean }} [opts]
 */
export function editsFor(sessionId, opts) {
  return agentGit.edits.editsFor(sessionId, opts);
}
