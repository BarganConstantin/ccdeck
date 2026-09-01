// The one answer the Browser Watch panel asks for: which browsers are here,
// what a program drove in them while nobody was browsing, and whether the relay
// that lets a stranger drive them is open.
//
// Everything below is composition. The four readers underneath it — profiles,
// history, activity, relay — hold every rule and every threshold, and each is
// tested against the real profile on its own. This file exists because the
// panel needs ONE request and because reading is not free, which is the whole
// of what it adds:
//
// THE COPY IS THE COST, AND mtime IS WHY IT IS RARE. A History database cannot
// be opened while the browser holds it, so every read copies the file first —
// 168 ms for 21 MB on the machine this was written on, and a database grows.
// Polling that on a timer would be gigabytes an hour of pointless churn. So the
// snapshot stats the file, and re-reads only when the browser has actually
// written to it since last time. `stat` is free.
//
// The property that makes this comfortable rather than merely acceptable: the
// cost is lowest exactly when the feature matters most. A machine somebody is
// browsing on rewrites History constantly and pays for every read — but nobody
// is away, so nothing can be found. A machine left alone for a weekend never
// touches the file at all, so the watch costs one `stat` per poll for two days
// and still has the complete record when its owner comes back.
//
// WHAT IS NOT HERE. No timer, no daemon, no background loop. The snapshot is
// pulled when the panel asks. Chrome writes its history whether or not ccdeck
// is running, so a deck that was closed all weekend still answers Monday's
// question completely — which is why there is no process to keep alive and no
// gap to apologise for.
import { readFileSync, statSync } from "node:fs";
import { discoverProfiles } from "./browser-profiles.mjs";
import { readVisitsSince } from "./browser-history.mjs";
import { classify, toEpisodes, defaultExclusions } from "./agent-activity.mjs";
import { hostsPath, killswitchCommand, readKillswitch, extensionReport, verdict } from "./relay-guard.mjs";
import { mergeEpisodes, readStore, writeStore } from "./browser-watch-store.mjs";
import { browserSurvey } from "./browser-presence.mjs";
import { RELAY_HOST } from "./relay-guard.mjs";

/** Chrome expires history at 90 days by default, so a window wider than that
 *  promises a past the browser has already forgotten. Thirty is the panel's
 *  default reach: long enough to cover a holiday, short enough that the first
 *  read of a large profile is not the user's first impression of the feature. */
const DEFAULT_WINDOW_DAYS = 30;

/** One cached read per profile: the mtime it was taken at, and what it found.
 *  Keyed by history path, so two browsers and two profiles never share an
 *  entry. Module-level because a snapshot is a request and the point is to
 *  survive between them. */
const cache = new Map();

/** The file's modification time in ms, or null when it is not there at all —
 *  an uninstalled browser, a profile that has never been opened, a home
 *  directory on a volume that is not mounted. Never throws: one unreadable
 *  profile must not take the other browsers' answers down with it. */
function mtimeMs(file, deps) {
  try { return (deps.statSync ?? statSync)(file).mtimeMs; } catch { return null; }
}

/**
 * Visits for one profile, re-reading only when the browser has written since
 * the last look.
 *
 * The cache is keyed on mtime rather than on a clock: a browser that is closed
 * cannot invalidate it, and a browser that is busy invalidates it on its own
 * schedule. `stale` is reported so the panel can say when it last actually
 * looked rather than implying the answer is a live one.
 */
async function visitsFor(profile, { sinceChromeTime, copyDir, deps = {} }) {
  const stamp = mtimeMs(profile.historyPath, deps);
  if (stamp === null) return { rows: [], degraded: true, reason: "no-history-file", stamp: null };

  const hit = cache.get(profile.historyPath);
  if (hit && hit.stamp === stamp && hit.since === sinceChromeTime) return { ...hit.value, cached: true };

  const read = await (deps.readVisitsSince ?? readVisitsSince)(
    profile.historyPath, sinceChromeTime, { copyDir },
  );
  const value = { rows: read.rows, degraded: read.degraded, reason: read.reason, stamp };
  cache.set(profile.historyPath, { stamp, since: sinceChromeTime, value });
  return value;
}

/** Drop every cached read. The panel's refresh control calls this: an mtime that
 *  has not moved is normally proof nothing changed, and the one case where a
 *  person disagrees with that is the one where they pressed refresh. */
export function invalidateBrowserWatchCache() {
  cache.clear();
  _lastForced = 0;
  surveyCache = { atMs: 0, rows: [] };
}

/** The floor between two reads somebody paid for, spelled the way quota.mjs,
 *  codex-quota.mjs, codex-usage.mjs, self-update.mjs and claude-accounts.mjs
 *  spell it — one idea, one name, one number. */
const FORCE_POLL_MS = 60_000;

let _lastForced = 0;
let _inflight = null;

/**
 * Whether a forced read is allowed to spend anything right now.
 *
 * `?refresh=1` on this route is not a cheap ask: it drops the mtime cache and
 * copies every profile's History database — 21 MB and 168 ms for one browser on
 * the machine this was tuned on, and databases only grow. A GET needs no CORS,
 * no preflight and no ability to read the reply, and `isTrustedRead` deliberately
 * does not apply the Sec-Fetch-Site test that would stop one, so ANY page the
 * user has open can send this in a loop. Without the floor that loop is
 * unbounded disk traffic on their machine, at their cost, from a page they are
 * not even looking at.
 *
 * A minute is far longer than a person clicking Refresh will notice — the button
 * still re-renders, it is just answered from a cache that is at most a minute
 * old — and short enough that a real "something just happened, look again" is
 * served.
 */
export function mayForceRead(now = Date.now()) {
  return now - _lastForced >= FORCE_POLL_MS;
}

/**
 * The snapshot, with the two guards a forcible route owes.
 *
 * `_inflight` is the second half and it is not the same protection: the floor
 * bounds how often a NEW read starts, and this bounds how many run at once.
 * Ten simultaneous requests before any of them finishes would otherwise be ten
 * concurrent copies of the same database, all of which the floor lets through
 * because none of them has completed yet to move the clock.
 */
export async function fetchBrowserWatch({ force = false, ...opts } = {}) {
  if (_inflight) return _inflight;
  if (force && mayForceRead()) {
    cache.clear();
    _lastForced = Date.now();
  }
  _inflight = browserWatchSnapshot(opts).finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * Every loopback address a ccdeck could have opened a tab on.
 *
 * Not just this process's port. The deck asks for 4317 and, when something else
 * already holds it, binds a RANDOM port in 4318-4400 instead (startServer's
 * `portRange`), so a machine that has been running decks for a month has tabs
 * on several. The real profile this feature was tuned against carried 41 visits
 * to 127.0.0.1:4317 and 34 to 127.0.0.1:4399 — two ports, both this deck, both
 * FROM_API because `open` is an API call, and every one of them a card the
 * panel would have shown its owner about itself.
 *
 * The whole range rather than the ports seen: the alternative is to remember
 * which ports past decks used, which is a file to keep, a file to migrate, and
 * a file that is empty the first time it matters. Eighty-four loopback ports
 * this program documents as its own are not a meaningful loss of coverage — a
 * user's own dev server on 3000 or 44440 is still reported, which is the case
 * that would have hurt.
 */
export function deckOwnOrigins(portRange = [4317, 4400]) {
  const [lo, hi] = portRange;
  const out = [];
  for (let port = lo; port <= hi; port++) out.push(`http://127.0.0.1:${port}`);
  return out;
}

/**
 * Whether the relay is reachable, and what to paste to change that.
 *
 * Reads the hosts file, which needs no privileges, and returns a command the
 * person runs themselves. Nothing in this path writes or elevates — see
 * relay-guard.mjs for why that is a rule and not a preference.
 *
 * A hosts file that cannot be read is reported as unknown rather than as
 * "open": claiming a machine is exposed on the strength of a failed read would
 * put a red banner on every locked-down corporate laptop in the world.
 */
export function relayState(platform = process.platform, env = process.env, deps = {}) {
  const path = hostsPath(platform, env);
  let text = null;
  try { text = (deps.readFileSync ?? readFileSync)(path, "utf8"); } catch { /* unknown */ }
  if (text === null) {
    return { path, readable: false, blocked: null, ours: [], foreign: [], command: null };
  }
  const state = readKillswitch(text);
  // The command offered is always the OTHER direction: a blocked relay gets the
  // unblock line, an open one gets the block line.
  const command = killswitchCommand(platform, { on: !state.blocked });
  return { path, readable: true, ...state, command };
}


/**
 * What the watch has been doing, newest first.
 *
 * The shell tool this descends from printed a running commentary — armed,
 * standing down, still watching, nothing found — and that commentary was most
 * of what made it trustworthy: you could see it working rather than take its
 * silence on faith. A panel that only ever shows a list has no way to say "I
 * looked, and there was nothing", which reads identically to "I am not looking".
 *
 * In memory and bounded. It is a record of what this process did since it
 * started, not an audit trail — the archive on disk is the thing that must
 * survive, and it already does.
 */
const LOG_MAX = 200;
const logLines = [];

/** @param {"ok"|"info"|"warn"} level */
function note(level, text, atMs = Date.now()) {
  logLines.unshift({ atMs, level, text });
  if (logLines.length > LOG_MAX) logLines.length = LOG_MAX;
}

export function watchLog() {
  return logLines.slice();
}

/** Called by the settings route, which is the one moment worth a line of its
 *  own: everything else here is the deck reading, and this is the user acting. */
export function noteWatchSetting(text) {
  note("ok", text);
}

/**
 * The browser survey, behind a short cache.
 *
 * It costs a `dig`, a `pgrep` per browser and an `lsof` per running one — up to
 * a dozen subprocesses — and none of what it reports moves quickly: a browser
 * does not get installed twice a minute. Thirty seconds is far below the
 * interval the badge polls on and far above the rate a person clicks Refresh.
 */
const SURVEY_TTL_MS = 30_000;
let surveyCache = { atMs: 0, rows: [] };

async function surveyBrowsers(platform, env, now, deps) {
  if (deps.browserSurvey) return deps.browserSurvey();
  if (now - surveyCache.atMs < SURVEY_TTL_MS) return surveyCache.rows;
  const rows = await browserSurvey({ relayHost: RELAY_HOST, platform, env, deps }).catch(() => []);
  surveyCache = { atMs: now, rows };
  return rows;
}

/** Whether the archive gained or altered anything worth a disk write. Compared
 *  on the shape a card is drawn from, so a re-read that found exactly the same
 *  episodes writes nothing — which is most polls, most of the time. */
function changedFrom(before, after) {
  if (before.length !== after.length) return true;
  for (let i = 0; i < after.length; i++) {
    const a = after[i], b = before[i];
    if (a.host !== b.host || a.startMs !== b.startMs || a.endMs !== b.endMs || a.count !== b.count) return true;
  }
  return false;
}

/**
 * Everything the panel draws, in one object.
 *
 * `deckOrigins` are the addresses this deck is listening on. They are excluded
 * by default and it is not an optimisation: ccdeck opens its own tab through
 * `open` on every start, which Chrome records with the same FROM_API bit as any
 * other program, so a watch without them reports the deck as the intruder every
 * time it launches.
 */
export async function browserWatchSnapshot({
  deckOrigins = [],
  quietMs,
  gapMs,
  windowDays = DEFAULT_WINDOW_DAYS,
  copyDir,
  now = Date.now(),
  platform = process.platform,
  env = process.env,
  deps = {},
} = {}) {
  // The store answers first and the caller's arguments override it, so the
  // panel's own selects still work while the watch is off — the settings on
  // disk are what the WATCH runs on, not a lock on what a reader may look at.
  const store = await (deps.readStore ?? readStore)(undefined, deps);
  const enabled = store.settings.enabled;
  const minutes = m => m * 60_000;
  if (quietMs === undefined) quietMs = minutes(store.settings.quietMinutes);
  if (gapMs === undefined) gapMs = minutes(store.settings.gapMinutes);
  if (windowDays === DEFAULT_WINDOW_DAYS) windowDays = store.settings.windowDays;

  const profiles = (deps.discoverProfiles ?? discoverProfiles)(platform, env, undefined, deps.fs);
  // THE FLOOR IS A DAY BOUNDARY, AND THE CACHE ABOVE DEPENDS ON IT. A window
  // measured from `now` moves every millisecond, so it lands in the cache key as
  // a value that never repeats — which silently turned the mtime cache into a
  // no-op that re-read and re-copied every database on every single request. It
  // read as working, because the answers were right; only the cost was wrong.
  //
  // Whole days are also the truer reading of the control: "look back 30 days"
  // is a span of days, not of milliseconds since whenever the panel opened.
  const sinceMs = Math.floor((now - windowDays * 86_400_000) / 86_400_000) * 86_400_000;
  // Chrome counts microseconds from 1601. Built here rather than imported so the
  // window is one expression the reader can check against the reader's own.
  const sinceChromeTime = String((BigInt(sinceMs) + 11644473600000n) * 1000n);

  const exclude = defaultExclusions(deckOrigins);
  const opts = {};
  if (quietMs !== undefined) opts.quietMs = quietMs;

  const reports = [];
  let allFindings = [];
  let anyDegraded = false;
  let oldestSeen = null;

  for (const profile of profiles) {
    const read = await visitsFor(profile, { sinceChromeTime, copyDir, deps });
    if (read.degraded) anyDegraded = true;
    const findings = classify(read.rows, { ...opts, exclude });
    const where = `${profile.name}/${profile.profile}`;
    if (read.degraded) note("warn", `${where} — ${read.reason ?? "could not read"}`, now);
    else if (read.cached) note("info", `${where} — unchanged, nothing to re-read`, now);
    else {
      const n = read.rows.length;
      note("ok", `${where} — read ${n.toLocaleString("en-US")} visit${n === 1 ? "" : "s"}, ${findings.length} flagged`, now);
    }
    allFindings = allFindings.concat(findings);
    for (const row of read.rows) {
      if (oldestSeen === null || row.timeMs < oldestSeen) oldestSeen = row.timeMs;
    }
    reports.push({
      browser: profile.browser,
      name: profile.name,
      profile: profile.profile,
      hasClaudeExt: profile.hasClaudeExt,
      visits: read.rows.length,
      findings: findings.length,
      degraded: read.degraded,
      reason: read.reason ?? null,
      // Null rather than 0 for a profile with no file: "never written" and
      // "written at the epoch" are different answers and only one is true.
      lastWrittenMs: read.stamp,
      extension: readExtension(profile, deps),
    });
  }

  const live = toEpisodes(allFindings, gapMs === undefined ? undefined : { gapMs });

  // THE UNION, AND WHY IT IS NOT JUST THE LIVE READ. Chrome's history is the
  // better source right up to the moment somebody clears it — and whoever can
  // drive this browser can clear it, with the same button the user has. While
  // the watch is on, everything it sees is written down, and what was written
  // down outlives the browser's own memory of it.
  //
  // Only while it is ON. An archive that filled itself whether or not the user
  // had asked for a watch would be a record they never consented to keep, of
  // pages they visited, on disk. The switch means what it says.
  const archived = enabled ? mergeEpisodes(store.episodes, live, now) : store.episodes;
  if (enabled && changedFrom(store.episodes, archived)) {
    note("ok", `archive now holds ${archived.length} episode${archived.length === 1 ? "" : "s"}`, now);
    await (deps.writeStore ?? writeStore)({ settings: store.settings, episodes: archived }, undefined, deps);
  }
  const episodes = enabled ? archived : live;

  const browsers = await surveyBrowsers(platform, env, now, deps);
  const anyExtension = reports.some(r => r.hasClaudeExt && r.extension?.enabled !== false);
  const relay = relayState(platform, env, deps);

  return {
    ok: true,
    settings: store.settings,
    log: watchLog(),
    verdict: verdict({ anyExtension, blocked: relay.blocked === true }),
    relay,
    profiles: reports,
    browsers,
    episodes,
    coverage: {
      // What the panel can honestly claim to know about, which is not the
      // window it asked for: a profile whose history only goes back a week
      // cannot answer for the month, and saying so is the difference between
      // "nothing happened" and "nothing was recorded".
      requestedSinceMs: sinceMs,
      oldestVisitMs: oldestSeen,
      // How much of what is on screen the deck itself is holding. Zero with the
      // watch off is not a fault, it is the switch doing what it says, and the
      // panel needs the number to be able to say which of the two it is.
      archived: archived.length,
      now,
    },
    degraded: anyDegraded,
  };
}

/** The extension's own permissions, out of the profile's Secure Preferences.
 *  Unreadable is reported as unknown, not as absent: a profile the deck cannot
 *  open is not a profile without the extension. */
function readExtension(profile, deps) {
  try {
    const raw = (deps.readFileSync ?? readFileSync)(profile.securePrefsPath, "utf8");
    return extensionReport(JSON.parse(raw));
  } catch {
    return null;
  }
}
