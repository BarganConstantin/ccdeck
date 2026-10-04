// How much this deck was used on one UTC day: the distinct sessions, subagents
// and projects its hooks heard from — and how hard the deck worked for it: how
// many live events it took in, and its peak memory. The "active" report carries
// the totals of the last finished day (reports.mjs), the last two as buckets
// (depth-facts.mjs).
//
// WHY A DAY AND NOT A SNAPSHOT. The counts used to be read off the live state at
// the moment the "active" went out — and that moment is the first check-in of
// the day, which runs at launch, before anybody has done anything. Production
// on 2026-10-01: of 33 "active" reports carrying counts, the median session
// count was 0, and 24 said zero sessions. A day's totals, sent the next day,
// are the number the snapshot was trying to be.
//
// WHAT IS KEPT. In memory, the session ids, the subagent ids and the folders the
// transcripts sit in, so a session heard from a hundred times counts once. They
// never leave this module: what is saved between runs (prefs.json, beside the
// install id) and what is sent are counts, the day they belong to, and the
// names of the features used that day — fixed tokens off FEATURES, a yes for
// each, never what was done with them.
//
// A RESTART MID-DAY. The saved counts come back as a floor and the new run
// counts on top of them, so a session that was running across the restart is
// counted twice. That is the price of keeping no ids on disk, and a restart is
// rare next to the day's sessions.
//
// DAYS USED. Beside the day, a running count of the days the deck heard any
// session at all, and the last of them so a restart does not count a day twice
// — a count and one date, never the list. It is what decides when the deck has
// been in use long enough to ask how useful it is (rating.mjs).
//
// Only live use counts: a Claude hook fires because somebody is running the
// CLI, and the Codex watcher emits only what a rollout gains while the deck
// watches (its first scan skips every file's history). Replayed lines and the
// deck's own synthetic events are not use.

/**
 * The features a day can say were used — fixed tokens, never anything a caller
 * makes up. The page names the ones it sees opened (POST /api/feature, through
 * feature-use.ts), the server the ones a route or a session shows. A name not on
 * this list is dropped wherever it comes from.
 */
export const FEATURES = Object.freeze([
  // Panels the page showed that day (each can be closed, and the choice is kept).
  "usage-panel", "machine-panel", "detail-panel", "accounts-panel",
  // Dialogs somebody opened.
  "tool-detail", "session-summary", "context-window", "usage-history", "browser-watch",
  "feedback", "keyboard-help", "share-accounts", "account-projects", "add-account",
  "process-list", "lan-setup", "claude-fm",
  // What the server saw done.
  "account-switch", "accounts-manage", "auto-switch", "lan-pairing", "feedback-sent",
  "self-update", "clear-board",
  // Which CLI the day's sessions came from.
  "claude-sessions", "codex-sessions",
]);
const FEATURE_SET = new Set(FEATURES);

/** Only known feature names, once each, in the list's order. */
function knownFeatures(list) {
  if (!Array.isArray(list)) return [];
  const have = new Set(list.filter(f => FEATURE_SET.has(f)));
  return FEATURES.filter(f => have.has(f));
}

/** The day as the reporter says it: the UTC date, "2026-10-01". */
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A whole count of zero or more, else 0. */
function whole(n) {
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Saved totals, coerced: a day, its counts and the features used, or null for anything else. */
function savedTotals(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.day !== "string" || !DAY.test(raw.day)) return null;
  return {
    day: raw.day, sessions: whole(raw.sessions), subagents: whole(raw.subagents), projects: whole(raw.projects),
    features: knownFeatures(raw.features), events: whole(raw.events), peakMb: whole(raw.peakMb),
  };
}

/** What prefs.json keeps for this, coerced — deck-prefs.mjs normalises with it. */
export function normaliseUsage(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const day = v => (typeof v === "string" && DAY.test(v) ? v : "");
  return {
    current: savedTotals(src.current),
    done: savedTotals(src.done),
    sent: day(src.sent),
    daysUsed: whole(src.daysUsed),
    lastUsedDay: day(src.lastUsedDay),
  };
}

/** The folder a transcript sits in, which is the project it belongs to:
 *  `~/.claude/projects/<project>/<session>.jsonl`. */
function folderOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * The tally. `now` is injectable so the suite can walk it across midnight.
 */
export function createUsageDay({ now = () => new Date() } = {}) {
  /** The day being counted: saved counts from an earlier run as a floor, and
   *  this run's distinct ids on top. */
  let current = null;
  /** The last finished day whose totals have not gone out yet. */
  let done = null;
  /** The last day whose totals did go out. */
  let sent = "";
  /** Moves on every change, so the reporter saves only when there is something new. */
  let changes = 0;
  /** The days used before this run, as an earlier run saved them: a count and
   *  the last of them. */
  let usedBefore = 0;
  let lastUsedBefore = "";
  /** The days this run heard a session on — one or two, a deck past midnight. */
  const usedThisRun = new Set();
  /** The first use this run heard, `{ at, provider }`, for activation.mjs. */
  let first = null;
  const firstListeners = [];

  function fresh(day, floor = null) {
    return {
      day,
      floor: floor ?? { sessions: 0, subagents: 0, projects: 0, features: [], events: 0, peakMb: 0 },
      sessions: new Set(),
      subagents: new Set(),
      projects: new Set(),
      features: new Set(),
      events: 0,
      peakMb: 0,
    };
  }

  function totals(c) {
    return {
      day: c.day,
      sessions: c.floor.sessions + c.sessions.size,
      subagents: c.floor.subagents + c.subagents.size,
      projects: c.floor.projects + c.projects.size,
      features: knownFeatures([...c.floor.features, ...c.features]),
      events: c.floor.events + c.events,
      peakMb: Math.max(c.floor.peakMb, c.peakMb),
    };
  }

  /** The day being counted, rolled over first if the clock has passed it. */
  function today() {
    const day = utcDay(now());
    if (current?.day === day) return current;
    if (current && current.day < day) done = totals(current);
    current = fresh(day);
    changes++;
    return current;
  }

  function add(set, key) {
    if (set.has(key)) return;
    set.add(key);
    changes++;
  }

  /** A live payload: its session, and the subagent it came from if any. */
  function noteUse(raw) {
    const sid = raw?.session_id;
    if (!sid || typeof sid !== "string") return;
    const c = today();
    c.events++;
    changes++;
    add(usedThisRun, c.day);
    add(c.sessions, sid);
    if (typeof raw.agent_id === "string" && raw.agent_id) add(c.subagents, `${sid}\u0000${raw.agent_id}`);
    add(c.features, raw.provider === "codex" ? "codex-sessions" : "claude-sessions");
    if (!first) {
      first = { at: now().toISOString(), provider: raw.provider === "codex" ? "codex" : "claude" };
      for (const fn of firstListeners) {
        try { fn(first); } catch { /* a listener's failure is its own */ }
      }
    }
  }

  /** The deck's resident memory right now, in MB: the day keeps its highest. */
  function notePeak(mb) {
    if (!Number.isFinite(mb) || mb <= 0) return;
    const c = today();
    const rounded = Math.round(mb);
    if (rounded <= c.peakMb) return;
    c.peakMb = rounded;
    changes++;
  }

  /** A transcript path a Claude hook carried, already accepted as Claude's:
   *  the project is the folder it sits in. */
  function noteProject(path) {
    if (!path || typeof path !== "string") return;
    add(today().projects, folderOf(path));
  }

  /** A feature somebody used today — a name off FEATURES, or nothing. */
  function noteFeature(name) {
    if (!FEATURE_SET.has(name)) return false;
    add(today().features, name);
    return true;
  }

  /** A Codex session's working directory, which is its project. */
  function noteFolder(dir) {
    if (!dir || typeof dir !== "string") return;
    add(today().projects, dir);
  }

  /** How many days in all this deck heard a session on: the saved count, and
   *  the days of this run that came after the last of them. */
  function daysUsed() {
    let n = usedBefore;
    for (const d of usedThisRun) if (d > lastUsedBefore) n++;
    return n;
  }

  /** The last of those days, "" before the first. */
  function lastUsedDay() {
    let last = lastUsedBefore;
    for (const d of usedThisRun) if (d > last) last = d;
    return last;
  }

  /** The first use this run heard, or null. */
  function firstUse() {
    return first ? { ...first } : null;
  }

  /** Call `fn` with the first use, once, when it happens — or now, if it has. */
  function onFirstUse(fn) {
    if (first) {
      try { fn(first); } catch { /* as above */ }
      return;
    }
    firstListeners.push(fn);
  }

  /** The totals of the last finished day before `day`, if they have not gone
   *  out yet; null when there is none. Rolls over first, so a deck that ran past
   *  midnight with nothing said since still has yesterday finished. */
  function finished(day) {
    today();
    const c = current && current.day < day ? totals(current) : done;
    return c && c.day < day && c.day > sent ? c : null;
  }

  /** Those totals went out: never send them again. */
  function markSent(day) {
    if (day > sent) sent = day;
    if (done && done.day <= sent) done = null;
    changes++;
  }

  /** What survives a restart: counts and days, never an id or a path. */
  function saved() {
    return { current: current ? totals(current) : null, done, sent, daysUsed: daysUsed(), lastUsedDay: lastUsedDay() };
  }

  /**
   * An earlier run's `saved()`, merged into this one. This run may already have
   * heard from sessions — the prefs are read after the first hooks can land —
   * so nothing it counted is dropped: the saved day becomes the floor of the
   * same day, or the finished day of an earlier one.
   */
  function restore(raw) {
    const s = normaliseUsage(raw);
    if (s.sent > sent) sent = s.sent;
    // The further-along of the two, so restoring the same save twice adds nothing.
    if (s.daysUsed > usedBefore || (s.daysUsed === usedBefore && s.lastUsedDay > lastUsedBefore)) {
      usedBefore = s.daysUsed;
      lastUsedBefore = s.lastUsedDay;
    }
    for (const t of [s.done, s.current]) {
      if (!t) continue;
      const c = today();
      if (t.day === c.day) {
        c.floor = {
          sessions: t.sessions, subagents: t.subagents, projects: t.projects, features: t.features,
          events: t.events, peakMb: t.peakMb,
        };
      } else if (t.day < c.day && (!done || t.day > done.day)) {
        done = t;
      }
    }
    if (done && done.day <= sent) done = null;
    changes++;
  }

  function version() {
    return changes;
  }

  return {
    noteUse, noteProject, noteFolder, noteFeature, notePeak, firstUse, onFirstUse, finished, markSent, saved, restore, version,
    daysUsed,
  };
}

/** The deck's own tally, which the event pipeline feeds and the reporter reads. */
export const usageDay = createUsageDay();
