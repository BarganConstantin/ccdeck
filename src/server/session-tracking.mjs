// Which sessions the deck still keeps anything for: the least-recently-heard
// cap every per-session cache is reaped against, the transcript watch that
// polls the live ones between their hook events, and POST /api/forget, the
// page telling the deck what left its board.
//
// These lived in src/server/index.mjs — the expiry section after the ring's
// reader, and the forget route after Clear. pushEvent touches a session on
// every live event and notes its transcript for the watch; a Clear empties
// the watch; startServer starts it. The caches being reaped are the
// enrichment's and the Codex watcher's, dropped through their own forget
// functions. The bodies are unchanged.
import { readBody, send } from "./http-io.mjs";
// What a session is producing between its tool calls — the 16.5% of measured
// time the hooks cannot see. See output-watch.mjs.
import { createOutputWatch } from "./output-watch.mjs";
// Claude Code's own line for a background session, from its job folder. See
// claude-jobs.mjs.
import { createJobWatch } from "./claude-jobs.mjs";
import { forgetEnrichment, noteJob, onTranscriptTail } from "./session-enrichment.mjs";
import { forgetCodexSession } from "./codex-enrichment.mjs";
// event-pipeline.mjs's pushEvent, reached without importing it — see
// event-sink.mjs.
import { pushEvent } from "./event-sink.mjs";

// ─── Per-session cache expiry ────────────────────────────────────────────
// Every enrichment cache (session-enrichment.mjs, codex-enrichment.mjs) is keyed by
// session id and nothing ever removed an entry: a deck left up for weeks — the 24/7 use this thing is
// built for — kept a model string, a subagent signature and four read-throttle
// stamps for every session it had ever seen, plus the Codex rollout path and
// model of each. SessionEnd is not a usable eviction signal (a killed CLI
// never sends one, and Codex has no such hook at all), so entries expire by
// least-recent use against a cap instead — the same shape pruneTranscriptScans
// already uses for its per-path state.
//
// AND A LIVE SESSION IS NEVER EVICTED, which this comment used to assert on the
// strength of the cap sitting "far above any plausible number of concurrent
// sessions". The cap held; the claim around it did not, and the 257th
// concurrent session is where that showed. forgetSession clears the three
// read-throttle stamps and pruneTranscriptScans drops the byte cursor, so an
// evicted session that speaks again does not "simply re-read its transcript" —
// it re-reads it on EVERY event, and those re-reads are themselves pushEvent
// calls, so the degradation feeds itself. Measured here, fresh deck per row,
// 16 events per session, 21 KB transcripts:
//
//   N=200  posted=3200  synthetic=600   rchar=6 MB   rps=5614  p50=17ms
//   N=256  posted=4096  synthetic=768   rchar=7 MB   rps=6341  p50=16ms
//   N=300  posted=4800  synthetic=9159  rchar=77 MB  rps=2308  p50=97ms
//
// A 17% increase in session count: 11.9x the derived events, 11x the transcript
// reads, ingest down 2.7x, p50 up 6x. Three per SESSION became three per EVENT.
// A cliff, not a slope, sitting exactly on the constant — and the server's cap
// (256) sits above the client's AGENT_CAP (200), so the UI cannot warn about a
// number it will not draw.
//
// So the cap reaps only what it was always described as reaping: sessions
// nothing has been heard from. A session with an event inside
// OUTPUT_WATCH_WINDOW_MS is live by the same definition outputWatchOnce already
// uses, and keeping it costs four numbers and a string.
const sessionTouchedAt = new Map();   // sid -> ms of the last event seen
const MAX_TRACKED_SESSIONS = 256;

/**
 * The absolute ceiling, above which even a live session is dropped.
 *
 * The age rule alone is unbounded in principle — nothing stops a machine from
 * having ten thousand sessions inside five minutes — and an unbounded map is
 * the leak this whole mechanism exists to end. This is a backstop, not the
 * working limit: reaching it means something is wrong in a way no cache policy
 * fixes, and dropping the least-recently-seen entries is still the least bad
 * answer. Eight times the cap, which is forty times the client's AGENT_CAP.
 */
export const HARD_TRACKED_SESSIONS = MAX_TRACKED_SESSIONS * 8;

/** The transcript watch, and how far back a session stays worth polling.
 *
 *  A session is polled while its last HOOK event is recent — and the window has
 *  to be generous for exactly the reason this watch exists: a session that is
 *  thinking has, by definition, not fired a hook. Measured on this machine's
 *  log, the gaps with no event at all run to p99 53s and 155s at the longest,
 *  so five minutes clears the whole measured distribution and still keeps the
 *  polled set to the sessions somebody is actually running. */
const outputWatch = createOutputWatch();
const OUTPUT_WATCH_WINDOW_MS = 5 * 60_000;
const OUTPUT_WATCH_MS = 1_500;
let outputWatchTimer = null;

/** How long a quiet session is still worth a `stat` for its recap, and how
 *  often it gets one.
 *
 *  The five minutes above are sized to a session that is WORKING. A recap is
 *  the opposite case: Claude Code writes it once a finished turn has sat three
 *  minutes AND the terminal has lost focus, so it lands whenever the person
 *  walks away — a median 3.1 minutes after the turn on this machine, and an
 *  hour after it for somebody who stayed at the terminal first. A session that
 *  quiet is producing nothing, so every fourth tick is plenty: a recap reaches
 *  the deck within six seconds of being written, and a resting session costs a
 *  `stat` every six seconds rather than every one and a half. */
const RECAP_WATCH_WINDOW_MS = 12 * 60 * 60_000;
const RECAP_WATCH_EVERY = 4;
let outputWatchTicks = 0;

/** The job folders, every other tick: three seconds, well inside the fifteen
 *  Claude Code itself waits between rewrites of a working job's line. The
 *  sessions asked about are the resting window's, not the live one's — a
 *  background job blocked on a question fires no hook for as long as nobody
 *  answers it, and that is the job whose line matters most. */
const jobWatch = createJobWatch();
const JOB_WATCH_EVERY = 2;

/** One tick: stat the recent sessions' transcripts, read only what grew, and
 *  say what landed. Everything expensive about this is guarded inside the watch
 *  — a session that wrote nothing costs one `stat`.
 *
 *  Resting sessions ride along on every RECAP_WATCH_EVERY-th tick for their
 *  recap alone, and their blocks are not reported: this answers for the
 *  sessions it calls live, and a resting one that starts working again fires a
 *  hook first, which makes it live the ordinary way.
 *
 *  A tick that starts while the last one is still reading gets nothing back:
 *  the watch refuses the overlap itself, where the offset is — see `poll` in
 *  output-watch.mjs for what two overlapping ticks used to report (#1089). */
async function outputWatchOnce() {
  const now = Date.now();
  const cutoff = now - OUTPUT_WATCH_WINDOW_MS;
  const restingCutoff = now - RECAP_WATCH_WINDOW_MS;
  const tick = outputWatchTicks++;
  const withResting = tick % RECAP_WATCH_EVERY === 0;
  const live = new Set();
  const polled = [];
  const recent = [];
  for (const [sid, at] of sessionTouchedAt) {
    if (at >= cutoff) { live.add(sid); polled.push(sid); }
    else if (withResting && at >= restingCutoff) polled.push(sid);
    if (at >= restingCutoff) recent.push(sid);
  }
  if (recent.length && tick % JOB_WATCH_EVERY === 0) {
    const jobs = await jobWatch.poll().catch(() => null);
    if (jobs) for (const sid of recent) noteJob(sid, jobs.get(sid) ?? null);
  }
  if (!polled.length) return;
  // The recap and the activity line, off the same tail — see onTranscriptTail.
  const found = await outputWatch.poll(polled, onTranscriptTail);
  for (const f of found) {
    if (!live.has(f.sid)) continue;
    pushEvent({
      hook_event_name: "OutputObserved",
      session_id: f.sid,
      kind: f.kind,
      at: f.at,
    }, "internal");
  }
}

function startOutputWatch() {
  if (outputWatchTimer) return outputWatchTimer;
  outputWatchTimer = setInterval(() => { outputWatchOnce().catch(() => {}); }, OUTPUT_WATCH_MS);
  // Unref'd like the Codex watcher's: a poll must never be the reason the
  // process stays up.
  if (outputWatchTimer.unref) outputWatchTimer.unref();
  return outputWatchTimer;
}

function forgetSession(sid) {
  outputWatch.forget(sid);
  forgetEnrichment(sid);
  forgetCodexSession(sid);
}

function touchSession(sid) {
  if (!sid || typeof sid !== "string") return;
  // Re-insert so the Map's own insertion order *is* the LRU order and eviction
  // below is one key read rather than a scan of every session ever seen.
  sessionTouchedAt.delete(sid);
  const now = Date.now();
  sessionTouchedAt.set(sid, now);
  if (sessionTouchedAt.size <= MAX_TRACKED_SESSIONS) return;
  // Insertion order IS recency, so the first entry still inside the window
  // proves every entry after it is too, and the loop stops there rather than
  // scanning. That is what keeps this O(evicted) and not O(sessions) on the hot
  // path — which matters most in exactly the case that used to be worst.
  const idleBefore = now - OUTPUT_WATCH_WINDOW_MS;
  for (const [oldest, at] of sessionTouchedAt) {
    if (sessionTouchedAt.size <= MAX_TRACKED_SESSIONS) break;
    if (at >= idleBefore && sessionTouchedAt.size <= HARD_TRACKED_SESSIONS) break;
    sessionTouchedAt.delete(oldest);
    forgetSession(oldest);
  }
}

/** The most session ids one press of this may name. A board holding more than
 *  the server tracks at all cannot be describing anything the server still
 *  remembers, and a body is not a reason to walk an unbounded list. */
const MAX_FORGET_IDS = MAX_TRACKED_SESSIONS;

/**
 * POST /api/forget — the client's own pruners, saying what left the board.
 *
 * THE THIRD PLACE THE RULE HAD TO REACH (#1024). `handleClear`'s comment states
 * it: "anything answering 'has this changed' has to appear in BOTH places that
 * mean the client no longer has it — here (clearEnrichmentGates), and in
 * forgetSession (forgetEnrichment)." There was a
 * third, and the server never heard about it — `pruneDoneSessions` and
 * `pruneOldAgents` in the page, which run every 250ms at cap 6 / grace 2
 * minutes, and #445's own measurement says 7 of 20 evicted sessions went on to
 * emit more events.
 *
 * Usage, context and the ROOT model all come back on their own: the first two
 * are not change-gated, and `pushEvent` stamps `raw.model` on every payload.
 * `sessionName`/`sessionTitle` and the per-subagent models do not, because
 * `nameBySession` and `modelBySession` still hold the signature that gates the
 * emit. Measured against a real deck over a real transcript, sandboxed HOME:
 *
 *     SessionNamed while the session was on the board: ["reducer-audit"]
 *     --- the client prunes S5, and tells nobody ---
 *     events for S5 after the resume: UserPromptSubmit, UsageObserved,
 *       UserPromptSubmit, UsageObserved, ContextObserved, …
 *     SessionNamed among them: false
 *
 * A session evicted while idle and then resumed showed as unnamed in the sidebar
 * and on the card for the rest of the day, with no way to recover but reloading
 * the tab.
 *
 * `forgetSession` is the whole of the answer and it already exists — this route
 * is the client's half of a call the server has been making to itself since the
 * LRU cap was added. It drops the read stamps along with the signatures, for the
 * reason `handleClear` lists them: clearing only the signatures would leave the
 * next hook event inside MODEL_READ_THROTTLE_MS, so nothing would be re-read and
 * the name would still be missing.
 *
 * NOT DROPPING THE CHANGE GATE INSTEAD, which was the other option in the
 * report. The gate is what keeps a per-pass emit from becoming ~683 events
 * saying nothing out of 685 records, and the reducer absorbing repeats correctly
 * is not a reason to send them.
 *
 * Costs nothing when it is wrong. A session named here that the deck is still
 * hearing from re-reads its transcript once and re-emits what it finds, which
 * the reducer's assign-don't-append handlers apply idempotently.
 */
async function handleForget(req, res) {
  const raw = await readBody(req).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids) return send(res, 400, { ok: false, reason: "bad_request" });
  let forgotten = 0;
  for (const sid of ids.slice(0, MAX_FORGET_IDS)) {
    if (typeof sid !== "string" || sid === "") continue;
    // Out of the LRU as well, so the cap is not spent on a session nothing is
    // tracking any more. A session that speaks again is re-inserted by
    // `touchSession` as what it now is: one the deck has just heard from.
    sessionTouchedAt.delete(sid);
    forgetSession(sid);
    forgotten++;
  }
  return send(res, 200, { ok: true, forgotten });
}

// What index.mjs calls besides HARD_TRACKED_SESSIONS. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export { handleForget, outputWatch, startOutputWatch, touchSession };
