// Which sessions the Command Panel started, as this deck recorded it (F6-R).
//
// On Windows a session the panel launched can be out of this deck's reach —
// running under another Windows sign-in, behind another session host — and
// the engine answers case C for it, which the deck's own sentence calls
// "started outside the deck". The page knew better only while the tab that
// launched it stayed open (panel-launch.ts): a reload, another tab or a deck
// restart lost it. This is the deck's own record of those launches, kept
// where the deck already keeps what it knows about its sessions: events.jsonl,
// as its own internal events, replayed at boot like every other line.
//
// WHAT IS RECORDED. One event, `__panel_launch`, at these moments:
//   - "started": before the engine is asked to launch, or to reopen a session
//     (adopt) — the provider, the page's launch key, a reference for the
//     answer, and for an adopt the session's id;
//   - "bound": once the engine has said which session that is — a launch's
//     own answer naming one (Claude), a claim it confirmed (Codex), an adopt
//     it ran;
//   - "refused": the engine answered that it started nothing;
//   - "held": every live record at once, written now and then (REFRESH_EVERY)
//     so a restart's replay, which reads only the newest ring's worth of the
//     log, still finds them. Only while the Command Panel is switched on: a
//     deck without it writes nothing of its own here.
// Ids, providers, launch keys and times: no folder, prompt, output, account or
// environment. A Clear forgets every record, as it forgets the sessions: what
// the log held before it is not written back. The id is never where a hook puts `session_id`, so nothing
// that keys off a session — the LRU, the transcript scans, the log election,
// the board — takes the deck's note for the session speaking.
//
// WHO MAY WRITE IT. Only this deck, from its own routes' answers. The name
// starts `__`: `POST /api/event` refuses it (isReservedEventName) and the
// boot replay honours it only from the server's own source, so an event is
// read as a record only when its source is "internal".
//
// WHAT IT ANSWERS. For a session, one of three:
//   - "panel": a bound record;
//   - "external": no record, and the deck saw the session start at a time
//     its records cover in full (`since`), outside every launch that never
//     said which session it became;
//   - "unknown": anything else — a start the deck did not see, one before the
//     records begin, one inside such a launch, an id started again after its
//     record was bound, a session another deck logs, an id that is not one.
// It is never asked whether a session may be attached, opened or reopened:
// the engine decides that, and the routes act exactly as they did without it.
//
// HOW LONG. A record goes when its session definitively ends (its SessionEnd),
// never because this deck cannot reach it. Past LAUNCHES_MAX records, or
// LAUNCH_MAX_AGE_MS old, the oldest goes and `since` moves past its start, so
// a session started before then becomes "unknown", never "external".
import { randomUUID } from "node:crypto";
import { terminalOn } from "./deck-prefs.mjs";
import { isForeignSession } from "./event-log.mjs";
import { pushEvent } from "./event-sink.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { MAX_BUFFER, isEnrichment } from "./ring-bounds.mjs";

/** The deck's own event name for these records. Reserved: see isReservedEventName. */
export const PANEL_LAUNCH = "__panel_launch";
/** The three answers. */
export const PROVENANCE = Object.freeze(["panel", "external", "unknown"]);

/** Live records kept at once. A deck has a handful of panel sessions running. */
export const LAUNCHES_MAX = 128;
/** Session starts remembered, for "external". */
export const STARTS_MAX = 2048;
/** Launches waiting for the engine to say which session they are. */
export const PENDING_MAX = 32;
/** Spans of launches that never said, kept for "unknown". */
export const GAPS_MAX = 64;
/** How long a launch may take to say which session it is — a Codex is claimed
 *  within seconds of appearing on the board — before its span is a gap. */
export const PENDING_MS = 10 * 60_000;
/** The oldest a record may be. A Codex writes no SessionEnd. */
export const LAUNCH_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Hook events between two "held" records: a quarter of the replay window. */
export const REFRESH_EVERY = Math.floor(MAX_BUFFER / 4);

const PROVIDERS = new Set(["claude", "codex"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAUNCH_KEY = /^[A-Za-z0-9_-]{1,96}$/;
const REF = SESSION_ID;

const isId = (v) => typeof v === "string" && SESSION_ID.test(v);
const isKey = (v) => typeof v === "string" && LAUNCH_KEY.test(v);
const isTime = (v) => Number.isFinite(v) && v > 0;
const slot = (provider, id) => `${provider}:${id.toLowerCase()}`;
const providerOf = (raw) => (raw?.provider === "codex" ? "codex" : "claude");

/** Drop a Map's oldest entries until it holds `max`, handing each to `gone`. */
function trim(map, max, gone = () => {}) {
  while (map.size > max) {
    const [k, v] = map.entries().next().value;
    map.delete(k);
    gone(k, v);
  }
}

/**
 * One deck's record. `emit` sends an event into the pipeline (pushEvent);
 * `foreign` says another deck logs a session; `now` is the clock; `active`
 * says the Command Panel is switched on (the routes' own switch).
 */
export function createPanelProvenance({
  emit = (raw) => pushEvent(raw, "internal"),
  foreign = isForeignSession,
  now = Date.now,
  active = () => terminalOn(heldPrefs.current()),
} = {}) {
  /** slot → { provider, session, at, state: "panel" | "unknown", started } */
  const launches = new Map();
  /** slot → when the deck last saw that session start */
  const starts = new Map();
  /** ref → { provider, at, key?, session? } */
  const pending = new Map();
  /** { provider, from, to } */
  let gaps = [];
  /** From when the records are whole: a replayed "held" says, else this
   *  deck's own start, before which no launch of its can have been made. */
  const bootAt = now();
  let since = null;
  let heard = 0;
  let held = false;
  let refreshQueued = false;

  function moveSince(at) {
    since = Math.max(since ?? bootAt, at);
  }

  function addRecord(provider, session, at, state, started) {
    const k = slot(provider, session);
    launches.delete(k);
    launches.set(k, { provider, session: session.toLowerCase(), at, state, started });
    trim(launches, LAUNCHES_MAX, (gk, r) => forget(gk, r));
  }

  /** A record that leaves for room or age: whatever started before it is no longer covered. */
  function forget(k, r) {
    const s = starts.get(k);
    moveSince(Math.max(r.at, s ?? 0) + 1);
  }

  function addGap(provider, from, to) {
    gaps.push({ provider, from, to });
    while (gaps.length > GAPS_MAX) moveSince(gaps.shift().to + 1);
  }

  function close(ref) {
    const p = pending.get(ref);
    pending.delete(ref);
    return p ?? null;
  }

  /** Launches past PENDING_MS: a launch becomes a gap, an adopt makes its session unknown. */
  function expire(at) {
    for (const [ref, p] of pending) {
      if (at - p.at <= PENDING_MS) continue;
      pending.delete(ref);
      if (p.session) addRecord(p.provider, p.session, p.at, "unknown", true);
      else addGap(p.provider, p.at, p.at + PENDING_MS);
    }
    for (const [k, r] of launches) {
      if (at - r.at <= LAUNCH_MAX_AGE_MS) break;
      launches.delete(k);
      forget(k, r);
    }
  }

  function bind(raw, at) {
    const provider = raw.provider;
    const session = raw.session;
    if (!PROVIDERS.has(provider) || !isId(session)) return;
    let p = REF.test(raw.ref ?? "") ? close(raw.ref) : null;
    if (!p && isKey(raw.key)) {
      for (const [ref, q] of pending) {
        if (q.key === raw.key && q.provider === provider) { p = close(ref); break; }
      }
    }
    const from = p?.at ?? at;
    const k = slot(provider, session);
    const s = starts.get(k);
    addRecord(provider, session, at, "panel", s !== undefined && s >= from);
  }

  function start(raw, at) {
    if (!isId(raw.session_id)) return;
    // A cleared conversation goes on in the same process under a new id: who
    // started that process is not known from here. A compaction is the same
    // session going on.
    if (raw.source === "clear" || raw.source === "compact") return;
    const provider = providerOf(raw);
    const k = slot(provider, raw.session_id);
    const r = launches.get(k);
    if (r) {
      const reopening = [...pending.values()].some((p) => p.session && slot(p.provider, p.session) === k);
      // The id started again after the panel's own start: somebody resumed
      // it, and only an adopt in flight says that somebody was this deck.
      if (r.started && !reopening) r.state = "unknown";
      else r.started = true;
    }
    starts.delete(k);
    starts.set(k, at);
    trim(starts, STARTS_MAX);
  }

  function end(raw) {
    if (!isId(raw.session_id)) return;
    const k = slot(providerOf(raw), raw.session_id);
    launches.delete(k);
    starts.delete(k);
  }

  /** A Clear: every session before it is forgotten, so is every record of one. */
  function cleared(at) {
    launches.clear();
    starts.clear();
    moveSince(at);
    held = false;
    heard = 0;
  }

  function restore(raw) {
    launches.clear();
    pending.clear();
    gaps = [];
    since = isTime(raw.since) ? raw.since : since;
    for (const r of Array.isArray(raw.launches) ? raw.launches.slice(-LAUNCHES_MAX) : []) {
      if (!r || !PROVIDERS.has(r.provider) || !isId(r.session) || !isTime(r.at)) continue;
      addRecord(r.provider, r.session, r.at, r.state === "unknown" ? "unknown" : "panel", r.started === true);
    }
    for (const p of Array.isArray(raw.pending) ? raw.pending.slice(-PENDING_MAX) : []) {
      if (!p || !REF.test(p.ref ?? "") || !PROVIDERS.has(p.provider) || !isTime(p.at)) continue;
      pending.set(p.ref, { provider: p.provider, at: p.at, ...(isKey(p.key) ? { key: p.key } : {}), ...(isId(p.session) ? { session: p.session } : {}) });
    }
    for (const g of Array.isArray(raw.gaps) ? raw.gaps.slice(-GAPS_MAX) : []) {
      if (g && PROVIDERS.has(g.provider) && isTime(g.from) && isTime(g.to)) gaps.push({ provider: g.provider, from: g.from, to: g.to });
    }
  }

  function record(raw, at) {
    switch (raw.launch) {
      case "started":
        if (!REF.test(raw.ref ?? "") || !PROVIDERS.has(raw.provider)) return;
        pending.delete(raw.ref);
        pending.set(raw.ref, {
          provider: raw.provider, at,
          ...(isKey(raw.key) ? { key: raw.key } : {}),
          ...(isId(raw.session) ? { session: raw.session } : {}),
        });
        trim(pending, PENDING_MAX, (_, p) => (p.session ? addRecord(p.provider, p.session, p.at, "unknown", true) : addGap(p.provider, p.at, p.at + PENDING_MS)));
        return;
      case "bound": bind(raw, at); return;
      case "refused": if (REF.test(raw.ref ?? "")) close(raw.ref); return;
      case "held": restore(raw); return;
      default: return;
    }
  }

  function snapshot() {
    return {
      hook_event_name: PANEL_LAUNCH,
      launch: "held",
      since,
      launches: [...launches.values()].map((r) => ({ ...r })),
      pending: [...pending.entries()].map(([ref, p]) => ({ ref, ...p })),
      gaps: gaps.map((g) => ({ ...g })),
    };
  }

  /** "held" now, once the event that asked for it has gone through. */
  function refreshSoon() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      heard = 0;
      held = true;
      if (since === null) since = bootAt;
      emit(snapshot());
    });
  }

  return {
    /**
     * Every event on its way into the pipeline (pushEvent), the boot replay's
     * included, at the time it was received.
     */
    observe(raw, source, at, opts = {}) {
      if (!raw || typeof raw !== "object" || !isTime(at)) return;
      const name = raw.hook_event_name;
      if (name === PANEL_LAUNCH) {
        if (source === "internal") record(raw, at);
        return;
      }
      if (name === "__clear") {
        // Nothing is written into the log a Clear just emptied: the next live
        // event writes what is left.
        if (source === "internal") cleared(at);
        return;
      }
      expire(at);
      if (name === "SessionStart" && (source === "hook" || source === "codex")) start(raw, at);
      else if (name === "SessionEnd" && source === "hook") end(raw);
      if (opts.replay) return;
      // The first live event after a boot carries the records forward; after
      // that, every REFRESH_EVERY hook events do. With the panel off, none
      // does, until it is switched on again.
      if (isEnrichment(raw)) return;
      if (!active()) { held = false; return; }
      heard += 1;
      if (!held || heard >= REFRESH_EVERY) refreshSoon();
    },

    /** Before the engine is asked to launch or to reopen: a reference for its answer. */
    started(method, question) {
      if (!question || typeof question !== "object") return null;
      const provider = method === "launch" ? question.agent : question.provider;
      if (!PROVIDERS.has(provider)) return null;
      if (method === "adopt" && !isId(question.sessionId)) return null;
      const ref = randomUUID();
      emit({
        hook_event_name: PANEL_LAUNCH, launch: "started", ref, provider,
        ...(isKey(question.key) ? { key: question.key } : {}),
        ...(method === "adopt" ? { session: question.sessionId.toLowerCase() } : {}),
      });
      return ref;
    },

    /**
     * The engine's answer to `method`: a record where it says which session
     * this deck's panel started. Nothing else is ever read from it.
     */
    answered(method, question, ref, status, body) {
      const ok = status >= 200 && status < 300 && body && typeof body === "object" && body.ok === true;
      if (method === "launch") {
        if (!ref) return;
        if (!ok) { emit({ hook_event_name: PANEL_LAUNCH, launch: "refused", ref }); return; }
        // A Codex has not chosen its id yet: its claim binds it.
        if (isId(body.sessionId)) emit({ hook_event_name: PANEL_LAUNCH, launch: "bound", ref, provider: question.agent, session: body.sessionId.toLowerCase() });
        return;
      }
      if (method === "adopt") {
        if (!ref) return;
        if (!ok) { emit({ hook_event_name: PANEL_LAUNCH, launch: "refused", ref }); return; }
        emit({ hook_event_name: PANEL_LAUNCH, launch: "bound", ref, provider: question.provider, session: question.sessionId.toLowerCase() });
        return;
      }
      if (method === "claim" && ok && body.claimed === true && PROVIDERS.has(question?.provider) && isId(question?.sessionId)) {
        emit({
          hook_event_name: PANEL_LAUNCH, launch: "bound", provider: question.provider, session: question.sessionId.toLowerCase(),
          ...(isKey(question.key) ? { key: question.key } : {}),
        });
      }
    },

    /** "panel", "external" or "unknown" for one session. */
    classify(provider, sessionId) {
      if (!PROVIDERS.has(provider) || !isId(sessionId)) return "unknown";
      expire(now());
      const k = slot(provider, sessionId);
      const r = launches.get(k);
      if (r) return r.state === "panel" ? "panel" : "unknown";
      if (foreign(sessionId)) return "unknown";
      const s = starts.get(k);
      if (s === undefined || s < (since ?? bootAt)) return "unknown";
      for (const p of pending.values()) {
        if (p.provider === provider && !p.session && p.at <= s) return "unknown";
      }
      for (const g of gaps) {
        if (g.provider === provider && s >= g.from && s <= g.to) return "unknown";
      }
      return "external";
    },

    /** The "held" record, for the suite. */
    snapshot,
  };
}

/** This deck's. */
export const panelProvenance = createPanelProvenance();

/**
 * `body` with its target's provenance, when the target is case C for a
 * session the question named. Every other answer is handed back unchanged.
 */
export function withProvenance(provenance, question, body) {
  const target = body && typeof body === "object" ? body.target : null;
  if (!provenance || !target || typeof target !== "object" || target.kind !== "C") return body;
  return { ...body, target: { ...target, provenance: provenance.classify(question?.provider, question?.sessionId) } };
}
