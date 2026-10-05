// What the git view learns from the event stream, and the one place it learns
// it: pushEvent hands every envelope it admits to `observeAgentGit` — a hook's
// POST, a Codex rollout line, the boot replay of the events log — so what is
// held in memory here is rebuilt on restart by the replay the deck already
// runs, and covers the window that replay covers.
//
// Three things are kept:
//   - per session and per agent, the files edited through edit tools
//     (agent-git-edits.mjs);
//   - per session, what the deck knows at any moment — start, spend, names,
//     models (agent-git-facts.mjs);
//   - every commit an agent's shell output reports making, written to the
//     local commit store (agent-git-detect.mjs → agent-git-record.mjs →
//     agent-git-store.mjs), so the marks outlive the log.
//
// A commit is recorded only from a LIVE event, and only by the deck that is
// writing that session to the events log — the same election that keeps one
// deck per log line, so two decks on one machine do not both record it. A
// replayed event was live once, in front of whichever deck recorded it then.
//
// Nothing here runs git. Recording needs the repository a folder is in and,
// ideally, the repo's word that the commit exists; both come in through
// `connectAgentGit` (see agent-git-record.mjs for the two hooks). Until
// something connects them, commits are spotted and nothing is written.
//
// `observeAgentGit` never throws: it sits on the hottest path in the process,
// and a fault in a feature must not cost the deck an event.
import { PRODUCT } from "./brand.mjs";
import { createCallJoiner } from "./agent-git-calls.mjs";
import { commitCandidates } from "./agent-git-detect.mjs";
import { createCommitRecorder } from "./agent-git-record.mjs";
import { commitStorePath, createCommitStore } from "./agent-git-store.mjs";
import { createEditTracker } from "./agent-git-edits.mjs";
import { createSessionFacts } from "./agent-git-facts.mjs";

/**
 * @param {{ edits?: ReturnType<typeof createEditTracker>,
 *           facts?: ReturnType<typeof createSessionFacts>,
 *           store?: ReturnType<typeof createCommitStore>,
 *           resolveRepo?: ((cwd: string) => any) | null,
 *           confirm?: ((candidate: object) => any) | null }} [deps]
 */
export function createAgentGitTap({
  edits = createEditTracker(),
  facts = createSessionFacts(),
  store = createCommitStore({ path: commitStorePath() }),
  resolveRepo = null,
  confirm = null,
} = {}) {
  const joiner = createCallJoiner();
  const recorder = createCommitRecorder({ store, resolveRepo, confirm });

  return {
    edits,
    facts,
    store,

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
        // The commit store is not touched: a Clear forgets sessions, not history.
        if (envelope.source === "internal") { edits.clear(); joiner.clear(); }
        return;
      }
      facts.observe(envelope);
      const call = joiner.join(envelope);
      if (!call) return;
      edits.noteCall(call);
      if (opts.replay || !opts.persisting || !recorder.connected || !call.commands.length) return;
      for (const candidate of commitCandidates(call)) {
        // The spend and names as they stand now, not after the async lookups.
        void recorder.record(candidate, facts.snapshot(candidate.sessionId, candidate.agentId));
      }
    },

    /** Connect the git hooks recording needs — see agent-git-record.mjs. */
    connect(hooks) { recorder.connect(hooks); },

    /** Resolves once every commit handed to the recorder so far is settled. */
    settled() { return recorder.settled(); },
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
 * Give the deck's tap the two git hooks commit recording needs:
 * `resolveRepo(cwd) → { top, commonDir } | null` and
 * `confirm(candidate) → { sha, authorTime } | null | false`.
 */
export function connectAgentGit(hooks) {
  agentGit.connect(hooks);
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

/**
 * Every stored agent commit of one repository, oldest first.
 *
 * @param {string} repo the realpath of the repository's common git directory
 */
export function agentCommitsFor(repo) {
  return agentGit.store.forRepo(repo);
}
