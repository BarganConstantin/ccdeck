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
// A commit is recorded from a LIVE event only by the deck that is writing that
// session to the events log — the same election that keeps one deck per log
// line, so two decks on one machine do not both record it. A deck with no log
// at all (`--no-persist`, RAM-only) is in no election: it keeps the commits it
// sees in its own memory, never in the file, so its view marks them for as
// long as it runs.
//
// A commit found in the BOOT REPLAY was live once, but possibly in front of no
// recording deck at all (one from before recording existed, or one that had
// the git view switched off). Those candidates are set aside while the replay
// runs — the newest REPLAY_RECORD_MAX of them, with what the session had spent
// and how long it had worked as the replayed events tell it — and nothing is
// done with them on the replay's path. `recordReplayed` takes them up later,
// once the deck knows it is the one writing the log: the ones the store does
// not hold yet for their repository are confirmed against it like a live one
// and kept only when it confirms them, marked `source: "replay"`. A commit
// held for another repository — the same history cloned or moved elsewhere —
// is recorded for this one too.
//
// WHO HEARS OF A COMMIT. `onCommit` listeners are told of every line this
// deck's recorder adds — live, kept in memory only, or found in the replay —
// and, when another deck is the one recording a session (this one is not
// writing its events to the log), of the session a commit was spotted in, so
// they can read the other deck's line from the shared store a moment later.
// The lane of recent commits under a card listens (git-recent-commits.mjs).
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

/** The most commits found in one boot replay that are set aside to record —
 *  the newest. */
export const REPLAY_RECORD_MAX = 500;

/**
 * @param {{ edits?: ReturnType<typeof createEditTracker>,
 *           facts?: ReturnType<typeof createSessionFacts>,
 *           store?: ReturnType<typeof createCommitStore>,
 *           resolveRepo?: ((cwd: string) => any) | null,
 *           confirm?: ((candidate: object) => any) | null,
 *           replayMax?: number }} [deps]
 */
export function createAgentGitTap({
  edits = createEditTracker(),
  facts = createSessionFacts(),
  store = createCommitStore({ path: commitStorePath() }),
  resolveRepo = null,
  confirm = null,
  replayMax = REPLAY_RECORD_MAX,
} = {}) {
  const joiner = createCallJoiner();
  const recorder = createCommitRecorder({ store, resolveRepo, confirm });
  /** Who is told of each commit — see `onCommit`. */
  const listeners = new Set();
  const tell = (heard) => {
    for (const fn of listeners) {
      try { fn(heard); } catch { /* a listener's fault is its own */ }
    }
  };
  /** Commits the boot replay found, oldest first: `{ candidate, facts }`. */
  let replayed = [];

  return {
    edits,
    facts,
    store,

    /**
     * One envelope, as pushEvent admitted it.
     *
     * @param {{ payload?: unknown, receivedAt?: number, source?: string }} envelope
     * @param {{ replay?: boolean, persisting?: boolean, ramOnly?: boolean }} [opts]
     *   `replay`: read back from the log at boot; `persisting`: this deck is
     *   the one writing the event's session to the log; `ramOnly`: this deck
     *   writes no log at all.
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
      if (!recorder.connected || !call.commands.length) return;
      if (opts.replay) {
        // Set aside for recordReplayed, with the spend and names as the
        // replay has rebuilt them up to this event; the newest kept.
        for (const candidate of commitCandidates(call)) {
          replayed.push({ candidate, facts: facts.snapshot(candidate.sessionId, candidate.agentId) });
        }
        if (replayed.length > replayMax * 2) replayed = replayed.slice(-replayMax);
        return;
      }
      if (!opts.persisting && !opts.ramOnly) {
        // Another deck records this session: its line reaches the shared
        // store in a moment.
        for (const sid of new Set(commitCandidates(call).map((c) => c.sessionId))) tell({ elsewhere: sid });
        return;
      }
      for (const candidate of commitCandidates(call)) {
        // The spend and names as they stand now, not after the async lookups.
        void recorder.record(candidate, facts.snapshot(candidate.sessionId, candidate.agentId), { memoryOnly: !opts.persisting })
          .then((line) => { if (line) tell({ line }); });
      }
    },

    /**
     * Record the commits the boot replay set aside — the newest
     * `replayMax`, oldest first — that the store does not hold yet for the
     * repository their folder is in, each kept only when that repository
     * confirms it. Takes them: a second call finds none. Never rejects.
     * Answers what it did: `{ found, known, recorded }`.
     */
    async recordReplayed() {
      const batch = replayed.slice(-replayMax);
      replayed = [];
      const done = { found: batch.length, known: 0, recorded: 0 };
      if (!batch.length || !recorder.connected) return done;
      for (const { candidate, facts: snapshot } of batch) {
        // Held for this repository already: no need to ask git about it.
        if (await recorder.held(candidate)) { done.known++; continue; }
        const line = await recorder.record(candidate, snapshot, { replay: true });
        if (line) { done.recorded++; tell({ line }); }
      }
      return done;
    },

    /**
     * Be told of every commit: `{ line }` for each line this deck's recorder
     * added (live, in memory only, or found in the replay), `{ elsewhere:
     * sessionId }` for a commit spotted in a session another deck records.
     * Answers the way to stop.
     *
     * @param {(heard: { line?: object, elsewhere?: string }) => void} fn
     */
    onCommit(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    /** Forget the commits the replay set aside, unrecorded. */
    dropReplayed() { replayed = []; },

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
 * @param {{ replay?: boolean, persisting?: boolean, ramOnly?: boolean }} [opts]
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
