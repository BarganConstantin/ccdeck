// How much this deck was used on one UTC day: the distinct sessions, subagents
// and projects its hooks heard from. The "active" report carries the totals of
// the last finished day (reports.mjs).
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
// install id) and what is sent are three counts and the day they belong to.
//
// A RESTART MID-DAY. The saved counts come back as a floor and the new run
// counts on top of them, so a session that was running across the restart is
// counted twice. That is the price of keeping no ids on disk, and a restart is
// rare next to the day's sessions.
//
// Only live use counts: a Claude hook fires because somebody is running the
// CLI, and the Codex watcher emits only what a rollout gains while the deck
// watches (its first scan skips every file's history). Replayed lines and the
// deck's own synthetic events are not use.

/** The day as the reporter says it: the UTC date, "2026-10-01". */
export function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A whole count of zero or more, else 0. */
function whole(n) {
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Saved totals, coerced: a day and three counts, or null for anything else. */
function savedTotals(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.day !== "string" || !DAY.test(raw.day)) return null;
  return { day: raw.day, sessions: whole(raw.sessions), subagents: whole(raw.subagents), projects: whole(raw.projects) };
}

/** What prefs.json keeps for this, coerced — deck-prefs.mjs normalises with it. */
export function normaliseUsage(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    current: savedTotals(src.current),
    done: savedTotals(src.done),
    sent: typeof src.sent === "string" && DAY.test(src.sent) ? src.sent : "",
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
  /** The first use this run heard, `{ at, provider }`, for activation.mjs. */
  let first = null;
  const firstListeners = [];

  function fresh(day, floor = null) {
    return {
      day,
      floor: floor ?? { sessions: 0, subagents: 0, projects: 0 },
      sessions: new Set(),
      subagents: new Set(),
      projects: new Set(),
    };
  }

  function totals(c) {
    return {
      day: c.day,
      sessions: c.floor.sessions + c.sessions.size,
      subagents: c.floor.subagents + c.subagents.size,
      projects: c.floor.projects + c.projects.size,
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
    add(c.sessions, sid);
    if (typeof raw.agent_id === "string" && raw.agent_id) add(c.subagents, `${sid}\u0000${raw.agent_id}`);
    if (!first) {
      first = { at: now().toISOString(), provider: raw.provider === "codex" ? "codex" : "claude" };
      for (const fn of firstListeners) {
        try { fn(first); } catch { /* a listener's failure is its own */ }
      }
    }
  }

  /** A transcript path a Claude hook carried, already accepted as Claude's:
   *  the project is the folder it sits in. */
  function noteProject(path) {
    if (!path || typeof path !== "string") return;
    add(today().projects, folderOf(path));
  }

  /** A Codex session's working directory, which is its project. */
  function noteFolder(dir) {
    if (!dir || typeof dir !== "string") return;
    add(today().projects, dir);
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
    return { current: current ? totals(current) : null, done, sent };
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
    for (const t of [s.done, s.current]) {
      if (!t) continue;
      const c = today();
      if (t.day === c.day) {
        c.floor = { sessions: t.sessions, subagents: t.subagents, projects: t.projects };
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

  return { noteUse, noteProject, noteFolder, firstUse, onFirstUse, finished, markSent, saved, restore, version };
}

/** The deck's own tally, which the event pipeline feeds and the reporter reads. */
export const usageDay = createUsageDay();
