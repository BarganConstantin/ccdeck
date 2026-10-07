// The newest value of each last-value-wins enrichment the ring has evicted,
// per session — what a page that connects behind the ring's head is handed
// ahead of the replay, so it is not left without them.
//
// WHY THESE GO MISSING. A session's model, name, usage, context, activity line
// and background job (LAST_VALUE_WINS in ring-bounds.mjs) are each sent when
// they change, and the scanners gate most of them on that: an idle session's
// ModelObserved and SessionNamed went out once, near its start. The ring keeps
// the newest MAX_BUFFER hook events, so on a busy deck those events fall off
// its head while the session's later hook events are still held. A reload or a
// second tab is replayed what is left: the card is drawn, from its surviving
// hook events, with no model chip, no name and a stale token count, and nothing
// sends them again until the session does something.
//
// WHAT IS KEPT. Every enrichment envelope the ring evicts is folded here into
// the newest value of its kind for its session (foldEnrichment), and keeps the
// seq, time and source of the last one folded. A page whose Last-Event-ID is
// older than what was evicted is sent these BEFORE the ring, under their own
// seq — see withLostBehind in event-routes.mjs — so the page applies
// them exactly where the ring would have, and every newer event still in the
// ring lands on top of them as it would have. Nothing is pushed into the ring,
// nothing is broadcast to the pages already connected and nothing is logged;
// and because each keeps its own `receivedAt`, none of them reads to the page
// as the session being heard from just now.
//
// Fed by admitEvent (event-ring.mjs) as it evicts, and emptied with the ring by
// clearEventBuffer, so a Clear forgets these as it forgets the ring.
import { payloadChars } from "./ring-bounds.mjs";

/** The kinds kept: the session's own last-value-wins enrichment, each read by
 *  its applier in transcript-events.ts. Named here rather than read off
 *  LAST_VALUE_WINS, because the fold below is written for exactly these and a
 *  kind added there is not folded right by rules it was never written for. */
const KINDS = new Set([
  "ModelObserved", "UsageObserved", "ContextObserved", "SessionNamed",
  "ActivityObserved", "JobObserved",
]);

/** The most sessions kept, least recently folded dropped first — the deck's
 *  own working number for the sessions it tracks (MAX_TRACKED_SESSIONS in
 *  session-tracking.mjs), well above the 200 cards a page draws. */
export const MAX_EVICTED_SESSIONS = 256;

/** What everything kept may weigh, in the characters payloadChars charges,
 *  and what one value may. Real values are a few kilobytes — a usage total
 *  split by model, a context breakdown with its memory files, a session's
 *  subagent models — so the cap on one value is only ever met by a payload no
 *  scanner wrote; `POST /api/event` takes enrichment names from anyone, and
 *  this must not become a second ring with no budget. */
export const MAX_EVICTED_CHARS = 8 * 1024 * 1024;
export const MAX_EVICTED_VALUE_CHARS = 256 * 1024;

// sid -> Map<hook_event_name, { seq, epoch, receivedAt, source, payload, chars }>,
// both in least-recently-folded order.
const kept = new Map();
let keptChars = 0;

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = v => typeof v === "string" && v.trim() !== "";

/** The facts the reducer stamps off whatever payload carries them
 *  (stampSessionFacts), each with the test it is stamped under: anything else
 *  says nothing, so it never replaces a value that does. */
const STAMPED = [
  ["model_context_window", v => typeof v === "number" && v > 0],
  ["approval_policy", v => typeof v === "string" && v !== ""],
  ["context_tokens", v => typeof v === "number" && v >= 0],
];

const JOB_STATES = new Set(["working", "blocked", "done", "failed", "stopped"]);
const validActivity = a => isObject(a) && typeof a.text === "string" && a.text.trim() !== "" && Number.isFinite(a.at);

/**
 * Two enrichment payloads of one kind, for one session, as the one payload
 * that leaves a card where the two in a row would have.
 *
 * The rules are the reducer's own (transcript-events.ts), and the page folds
 * what waits for a card by the same ones (parked-enrichment.ts):
 *   - a field the newer payload leaves out, or leaves undefined, says nothing;
 *   - the stamped facts, a ModelObserved's model and a SessionNamed's two
 *     names count only when they hold a value;
 *   - a context breakdown merges key by key, and subagent models by subagent;
 *   - a SessionNamed title that repeats the name is dropped, as the card drops it;
 *   - an activity line never goes backwards in time;
 *   - a job of `null` is the job gone, and one the reducer would refuse says nothing;
 *   - a usage total replaces the last one whole, its split by model included,
 *     and a UsageObserved without one says nothing about either.
 */
export function foldEnrichment(prev, next) {
  if (!isObject(prev)) return next;
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  const keep = k => { if (k in prev) out[k] = prev[k]; else delete out[k]; };
  for (const [k, ok] of STAMPED) if (!ok(next[k])) keep(k);
  switch (next.hook_event_name) {
    case "ModelObserved":
      if (!(typeof next.model === "string" && next.model !== "")) keep("model");
      if (isObject(prev.subagentModels) || isObject(next.subagentModels)) {
        out.subagentModels = {
          ...(isObject(prev.subagentModels) ? prev.subagentModels : {}),
          ...(isObject(next.subagentModels) ? next.subagentModels : {}),
        };
      }
      break;
    case "ContextObserved": {
      if (!isObject(next.context)) { keep("context"); break; }
      const ctx = isObject(prev.context) ? { ...prev.context } : {};
      for (const [k, v] of Object.entries(next.context)) if (typeof v === "number" || Array.isArray(v)) ctx[k] = v;
      out.context = ctx;
      break;
    }
    case "SessionNamed": {
      const name = nonEmpty(next.sessionName) ? next.sessionName : (prev.sessionName ?? null);
      let title = nonEmpty(next.sessionTitle) ? next.sessionTitle : (prev.sessionTitle ?? null);
      if (nonEmpty(name) && nonEmpty(title) && title.trim().toLowerCase() === name.trim().toLowerCase()) title = null;
      out.sessionName = name;
      out.sessionTitle = title;
      break;
    }
    case "ActivityObserved":
      if (!validActivity(next.activity) || (validActivity(prev.activity) && next.activity.at < prev.activity.at)) keep("activity");
      break;
    case "JobObserved":
      if (!(next.job === null || (isObject(next.job) && JOB_STATES.has(next.job.state)))) keep("job");
      break;
    case "UsageObserved":
      if (!isObject(next.usage)) { keep("usage"); keep("usageByModel"); }
      else if (next.usageByModel === undefined) delete out.usageByModel;
      break;
  }
  return out;
}

function drop(sid, name) {
  const kinds = kept.get(sid);
  const entry = kinds?.get(name);
  if (!entry) return;
  keptChars -= entry.chars;
  kinds.delete(name);
  if (kinds.size === 0) kept.delete(sid);
}

function dropSession(sid) {
  for (const name of [...(kept.get(sid)?.keys() ?? [])]) drop(sid, name);
}

/**
 * One envelope the ring has just evicted. Anything that is not one of KINDS,
 * or names no session, is not kept. `charged` is what the ring charged the
 * envelope, so a payload no scanner could have written is let go without
 * being walked a second time — and takes the older value of its kind with it,
 * since a page told the older one would be told something the deck has since
 * heard replaced.
 */
export function noteEvicted(evt, charged = 0) {
  const p = evt?.payload;
  if (!isObject(p) || !KINDS.has(p.hook_event_name)) return;
  const sid = p.session_id;
  if (typeof sid !== "string" || sid === "") return;
  const name = p.hook_event_name;
  if (charged > MAX_EVICTED_VALUE_CHARS) { drop(sid, name); return; }
  const prev = kept.get(sid)?.get(name);
  const payload = foldEnrichment(prev?.payload, p);
  const chars = payloadChars(payload);
  drop(sid, name);
  if (chars > MAX_EVICTED_VALUE_CHARS) return;
  // Re-inserted, so both maps' own order is the order things were last folded
  // in and the caps below drop the session heard from longest ago.
  const kinds = kept.get(sid) ?? new Map();
  kept.delete(sid);
  kept.set(sid, kinds);
  kinds.set(name, { seq: evt.seq, epoch: evt.epoch, receivedAt: evt.receivedAt, source: evt.source, payload, chars });
  keptChars += chars;
  while (kept.size > MAX_EVICTED_SESSIONS || keptChars > MAX_EVICTED_CHARS) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    dropSession(oldest);
  }
}

/** Forget everything kept — the ring was cleared. */
export function clearEvicted() {
  kept.clear();
  keptChars = 0;
}

/**
 * What a page is missing, as envelopes, oldest first: for each of `sessions`,
 * the newest value of each kind whose last fold is newer than `after` (what
 * the page was last sent) and older than `before` (the oldest seq the page is
 * about to be replayed). A page that saw every one of them is sent none.
 *
 * @param {{ after: number, before: number, sessions: Set<string> }} range
 */
export function evictedEnrichment({ after, before, sessions }) {
  const out = [];
  for (const sid of sessions) {
    const kinds = kept.get(sid);
    if (!kinds) continue;
    for (const e of kinds.values()) {
      if (e.seq <= after || e.seq >= before) continue;
      out.push({ seq: e.seq, epoch: e.epoch, receivedAt: e.receivedAt, source: e.source, payload: e.payload });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** What is kept right now, for the suite: sessions, values and their weight. */
export function evictedStats() {
  let values = 0;
  for (const kinds of kept.values()) values += kinds.size;
  return { sessions: kept.size, values, chars: keptChars };
}
