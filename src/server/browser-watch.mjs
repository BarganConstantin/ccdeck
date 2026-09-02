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
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { discoverProfiles } from "./browser-profiles.mjs";
import { readVisitsSince } from "./browser-history.mjs";
import { classify, toEpisodes, defaultExclusions } from "./agent-activity.mjs";
import { appendLog, logPath, mergeEpisodes, readStore, writeStore } from "./browser-watch-store.mjs";
import { browserSurvey } from "./browser-presence.mjs";
import { available, performable, react } from "./browser-react.mjs";
import { RELAY_HOST } from "./relay-guard.mjs";

/**
 * The moment this deck started, and the only floor any read uses.
 *
 * THE WATCH LOOKS FORWARD, NEVER BACK. An earlier version swept thirty days of
 * Chrome's history on every open, which answered "what happened while you were
 * away last month" — and to do it, read a month of the user's browsing. That is
 * a great deal of somebody's private life to hold in memory for a feature whose
 * job is to notice a program driving their browser.
 *
 * So the floor is process start. Nothing before this deck was running is read,
 * reported, or kept, and the panel says so rather than leaving a reader to
 * wonder how far back it went. What happened while the deck was down is the
 * browser's business.
 *
 * FROM `process.uptime()`, NOT FROM MODULE LOAD. This file is imported lazily,
 * on the first request to the panel — so `Date.now()` at load is "when somebody
 * first opened Browser Watch", and a deck running for an hour before that lost
 * the hour while the panel claimed to cover it. Caught by driving a real
 * navigation and finding it invisible: the floor was two seconds newer than the
 * visit. `process.uptime()` is the deck's own start whenever this module is
 * first read.
 */
const STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);

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
  _lastBeat = 0;   // a manual refresh deserves a fresh proof of life
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

/**
 * One line of what the watch did.
 *
 * FIVE LEVELS, AND THEY ARE NOT SEVERITIES. `find` is the only one that means
 * something was found; `act` is the reader themselves, changing a setting or
 * the switch — the only lines in the file a person put there, and the ones they
 * scan for when asking "what did I change and when"; `ok` is the deck working,
 * `info` is the deck deciding not to work, and `warn` is the deck unable to.
 *
 * A log where every line is the same weight is a log nobody scans — and the one
 * line worth catching here is a program having driven the browser, which is not
 * an error and must not be dressed as one.
 *
 * @param {"find"|"act"|"ok"|"info"|"warn"} level
 */
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
  note("act", text);
}

/**
 * Whether THIS deck is the one that reacts and writes.
 *
 * ONE MACHINE, ONE STORE, AND USUALLY MORE THAN ONE DECK. The archive and the
 * log live at a single path per machine, but running two decks is ordinary here
 * — the repo has electWriters and a discovery directory precisely because it is.
 * Both would read the same Chrome history, find the same new episode, and each
 * write a line and fire a notification: one event, told twice.
 *
 * Verified rather than assumed: at the moment this was written, two decks were
 * live on this machine (ports 4317 and 4393), so the collision is the ordinary
 * case and not a corner.
 *
 * The rule is log-writer.mjs's, reused rather than reinvented: among live decks,
 * the LOWEST PORT wins, with the pid breaking a tie a stale discovery file could
 * invent. Deterministic, needs no lock file, and cannot strand the feature — a
 * deck that reads a directory it cannot open decides it is alone, which for the
 * common case of one deck is the right answer anyway.
 *
 * Reading only, never writing: this is a question about who else is running, and
 * a watcher that had to claim something to answer it could leave the claim
 * behind. The shell tool this descends from lost its lock on SIGHUP and then
 * refused to watch anything ever again.
 */
async function isReactingDeck(deps = {}) {
  if (deps.isReactingDeck) return deps.isReactingDeck();
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return true; }   // cannot look — assume alone

  let best = null;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (typeof d?.pid !== "number" || typeof d?.port !== "number") continue;
      // A record whose process is gone is a leftover, not a rival.
      try { process.kill(d.pid, 0); } catch { continue; }
      if (!best || d.port < best.port || (d.port === best.port && d.pid < best.pid)) best = d;
    } catch { /* corrupt, or gone between listing and read */ }
  }
  return best === null || best.pid === process.pid;
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

/**
 * How often the log says "still watching" when nothing has happened.
 *
 * THE LOG BECAME UNREADABLE THE MOMENT IT WENT LIVE. The panel polls every ten
 * seconds while the Log view is open, and every poll wrote one line per profile
 * saying the History file was unchanged — twelve lines a minute of nothing,
 * burying the one line that said a visit had been read. The view answering "is
 * this working" answered it by making its own answer unfindable.
 *
 * A quiet poll writes nothing now. Instead the log says so once every five
 * minutes, which is the same trade the shell tool this descends from made with
 * CLAUDE_CHROME_HEARTBEAT: a watch has to prove it is alive, and proving it
 * twelve times a minute proves nothing at all.
 */
const HEARTBEAT_MS = 5 * 60_000;
let _lastBeat = 0;

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

  // The store was written by a version whose rules produced rows this one would
  // never produce, and readStore has already hidden them. Erase them, because
  // "nothing from before the watch is kept" is a claim about the disk and not
  // only about the screen.
  if (store.migrated) {
    note("info", "cleared episodes kept under an older rule", now);
    await (deps.writeStore ?? writeStore)({ settings: store.settings, episodes: [] }, undefined, deps);
  }
  const minutes = m => m * 60_000;
  if (quietMs === undefined) quietMs = minutes(store.settings.quietMinutes);
  if (gapMs === undefined) gapMs = minutes(store.settings.gapMinutes);

  const profiles = (deps.discoverProfiles ?? discoverProfiles)(platform, env, undefined, deps.fs);
  // Fixed for the life of the process, which is also what keeps the mtime cache
  // working: a floor computed from `now` moves every millisecond and would land
  // in the cache key as a value that never repeats — that bug shipped once, and
  // it re-read and re-copied every database on every request while looking
  // perfectly correct, because only the cost was wrong.
  const sinceMs = STARTED_MS;
  // Chrome counts microseconds from 1601. Built here rather than imported so the
  // window is one expression the reader can check against the reader's own.
  const sinceChromeTime = String((BigInt(sinceMs) + 11644473600000n) * 1000n);

  const exclude = defaultExclusions(deckOrigins);
  const opts = {};
  if (quietMs !== undefined) opts.quietMs = quietMs;

  const reports = [];
  let quiet = 0;   // profiles whose History had not moved, for the heartbeat
  let allFindings = [];
  let anyDegraded = false;
  let oldestSeen = null;

  for (const profile of profiles) {
    const read = await visitsFor(profile, { sinceChromeTime, copyDir, deps });
    if (read.degraded) anyDegraded = true;
    // Tagged with the browser they came from, which is the one thing a reaction
    // cannot work out for itself: closing a tab means telling ONE application to
    // close it, and a finding that has forgotten which browser it was in can
    // only be guessed at.
    const findings = classify(read.rows, { ...opts, exclude })
      .map(f => ({ ...f, browser: profile.browser }));
    const where = `${profile.name}/${profile.profile}`;
    if (read.degraded) note("warn", `${where} — ${read.reason ?? "could not read"}`, now);
    // A poll that found the file unchanged says nothing. See HEARTBEAT_MS.
    else if (read.cached) quiet += 1;
    else {
      // `, 0 flagged` on every line is what made them all look alike: the
      // count that matters is the one that is not zero, and printing the zero
      // beside it buried the difference. Absence is the message.
      const n = read.rows.length;
      const found = findings.length > 0 ? `, ${findings.length} flagged` : "";
      note(findings.length > 0 ? "find" : "ok",
           `${where} — read ${n.toLocaleString("en-US")} visit${n === 1 ? "" : "s"}${found}`, now);
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
    });
  }

  // Proof of life, at a rate a person can read. Only when every profile was
  // quiet — a poll that read something has already said so in its own line.
  if (quiet === reports.length && quiet > 0 && now - _lastBeat >= HEARTBEAT_MS) {
    _lastBeat = now;
    note("info", `still watching ${quiet} profile${quiet === 1 ? "" : "s"} — nothing new`, now);
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
  const kept = enabled ? mergeEpisodes(store.episodes, live, now) : store.episodes;
  // Only one deck records and reacts; the others still SHOW everything, because
  // reading the store is free and a second panel that went blank would be a
  // worse bug than the one this prevents.
  const acting = enabled ? await isReactingDeck(deps) : false;
  if (acting && changedFrom(store.episodes, kept)) {
    // Only what is NEW gets a log line. mergeEpisodes replaces a run that has
    // grown, so writing the whole set every time would repeat one episode once
    // per page it gained.
    const known = new Set(store.episodes.map(e => `${e.host} ${e.startMs}`));
    const fresh = kept.filter(e => !known.has(`${e.host} ${e.startMs}`));
    note(fresh.length > 0 ? "find" : "ok",
         `${fresh.length || "no"} new · ${kept.length} since this deck started`, now);
    await (deps.writeStore ?? writeStore)({ settings: store.settings, episodes: kept }, undefined, deps);
    await (deps.appendLog ?? appendLog)(fresh, undefined, deps);

    // REACT ONLY TO WHAT IS NEW, AND ONLY ONCE. `fresh` is the set that was not
    // in the store a moment ago, so an episode still growing does not notify
    // again on every page it gains — which is the difference between a watch
    // and a nuisance.
    //
    // After the write, deliberately. A reaction that closed a tab and then lost
    // the record of why would leave the user with a vanished page and nothing
    // to read about it.
    const reaction = store.settings.reaction;
    if (fresh.length && performable(reaction, platform)) {
      for (const episode of fresh) {
        const acted = await (deps.react ?? react)(reaction, episode, { platform, deps })
          .catch(() => []);
        for (const line of acted) note("find", `${episode.host} — ${line}`, now);
      }
    }
  }
  const episodes = enabled ? kept : live;

  const browsers = await surveyBrowsers(platform, env, now, deps);

  return {
    ok: true,
    settings: store.settings,
    // What this platform can actually do, so the panel never offers a mode
    // that would silently do nothing. See browser-react.mjs.
    reactions: available(platform),
    log: watchLog(),
    profiles: reports,
    browsers,
    episodes,
    coverage: {
      // What the panel can honestly claim to know about, which is not the
      // window it asked for: a profile whose history only goes back a week
      // cannot answer for the month, and saying so is the difference between
      // "nothing happened" and "nothing was recorded".
      // When this deck started, which is the only moment the watch looks
      // forward from — the panel says so rather than leaving a reader to guess
      // how far back it went.
      startedMs: sinceMs,
      oldestVisitMs: oldestSeen,
      logPath: logPath(),
      // How many episodes this deck has seen since it started. Zero with the
      // watch off is not a fault — it is the switch doing what it says — and the
      // panel needs the number to be able to say which of the two it is.
      archived: kept.length,
      now,
    },
    degraded: anyDegraded,
  };
}
