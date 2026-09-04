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
import { classify, toEpisodes, defaultExclusions, isProgramNavigation } from "./agent-activity.mjs";
import { appendLog, logPath, mergeEpisodes, readStore, undismissed, updateStore, writeStore } from "./browser-watch-store.mjs";
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
/**
 * Is that pid still running?
 *
 * A bare `catch { continue; }` used to stand where this is called, which threw
 * away the one distinction that matters: a process this account may not signal
 * answers EPERM on POSIX and EACCES on Windows (libuv maps
 * ERROR_ACCESS_DENIED), and both mean ALIVE. Treating them as gone made an
 * elevated deck invisible to the writer election below, which is how a machine
 * ends up with two elected writers — duplicate log lines, duplicate reactions,
 * and two writers racing the same rename.
 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e.code === "EPERM" || e.code === "EACCES"); }
}

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
  // The memo of what each profile last really said goes with it. It exists to
  // stand in for a read the cache skipped, and there are no skipped reads left
  // to stand in for.
  _lastRead.clear();
  // _lastCount is DELIBERATELY NOT cleared. It is not a cache of what was
  // read — it is the record of what has already been REPORTED, and the log it
  // feeds survives this reset too. Clearing it made the next read compute its
  // delta from zero and re-report the whole running total as growth, while the
  // earlier deltas were still sitting in the feed above it. Measured live
  // after one toggle of the switch: the feed's deltas summed to 15 against a
  // cumulative of 6, so the two numbers the panel shows about itself disagreed
  // and a reader had no way to tell which was lying.
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
export function deckOwnOrigins(portRange = [4317, 4400], registered = []) {
  const [lo, hi] = portRange;
  const out = [];
  for (let port = lo; port <= hi; port++) out.push(`http://127.0.0.1:${port}`);
  // AND THE PORTS DECKS ACTUALLY REGISTERED, which the range cannot know about.
  // The range covers the default and its fallback; an explicit `--port` lands
  // anywhere. Measured: a deck running from a worktree on `--port 4793` opened
  // its own tab, and this panel reported it to its owner as a program driving
  // the browser — which it was, and the program was ccdeck.
  //
  // Read rather than guessed. The registry already holds a port per live deck
  // for the election, so this is a fact the machine has, not a range somebody
  // has to keep current.
  //
  // A deck that registered NOTHING is still reported, and that is right rather
  // than a gap: from here it is a program driving the browser and nothing
  // announces otherwise. The reader can dismiss it once and it stays dismissed.
  for (const port of registered) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (port >= lo && port <= hi) continue;
    out.push(`http://127.0.0.1:${port}`);
  }
  return out;
}

/** The port of every live deck that registered one. Same directory and the same
 *  liveness check the election uses — a record whose process is gone is a
 *  leftover, not a deck whose tabs should be excused. */
export async function registeredDeckPorts(deps = {}) {
  if (deps.registeredDeckPorts) return deps.registeredDeckPorts();
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const ports = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (typeof d?.pid !== "number" || typeof d?.port !== "number") continue;
      if (!pidAlive(d.pid)) continue;
      ports.push(d.port);
    } catch { /* corrupt, or gone between listing and read */ }
  }
  return ports;
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
function note(level, text, atMs = Date.now(), parts = null) {
  // `parts` is the same line said as columns, for the one shape that HAS
  // columns: a profile read. The panel aligns those into a grid, where the
  // count lands in the same place on every row instead of at the end of a
  // sentence whose length depends on the browser's name. Composed here rather
  // than parsed back out of `text` in the client — a program that has to
  // reverse its own formatting has two spellings of one fact and will
  // eventually disagree with itself.
  //
  // Null for every other line, and that is not a gap: "still watching 2
  // profiles" and "closed the tab" are the deck talking, not events with a
  // browser and a number, and the panel renders them as a different kind of
  // row on purpose.
  logLines.unshift(parts ? { atMs, level, text, parts } : { atMs, level, text });
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
      // ONLY DECKS THAT RUN THE WATCH GET A VOTE. This elected on port alone,
      // so an older ccdeck that predates the feature won by holding the lower
      // port and then wrote nothing — while the deck that has the watch stood
      // down and also wrote nothing. Measured here: a v1.46 deck out of an npx
      // cache held 4317, answered this route with the SPA's index.html, and the
      // watch recorded nothing at all for as long as both were up. Findings on
      // screen, an empty disk, and not one line anywhere saying why.
      //
      // An older deck has no such field, so it loses by construction rather
      // than by a version comparison this would otherwise have to keep.
      if (d.watch !== true) continue;
      // A record whose process is gone is a leftover, not a rival.
      if (!pidAlive(d.pid)) continue;
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
 * Polls completed since this process started, and when the last one finished.
 *
 * THIS REPLACED A HEARTBEAT ROW. A five-minute "still watching 2 profiles —
 * nothing new" proved the deck was alive by writing into the feed it was
 * supposed to be reporting on, and the feed is bounded at 200: on a machine
 * somebody actually browses, bookkeeping does not merely clutter it, it evicts
 * the findings the panel exists to show. Liveness is a number the panel reads,
 * which costs no rows at all.
 *
 * NOT `lastWrittenMs`, which is the History file's mtime — when the BROWSER
 * last wrote, a fact about the browser rather than about the watch. On an idle
 * machine that climbs past an hour while this keeps checking every ten seconds.
 */
let _checks = 0;
let _checkedMs = 0;

/**
 * What the last REAL read of each profile produced, keyed by browser/profile.
 *
 * The mtime cache answers "this file has not moved since you last looked", and
 * the honest reading of that is "the same as last time" — but the code read it
 * as an empty file, so a cached poll produced no findings, no oldest visit and
 * no last human navigation.
 *
 * With the watch ON that stayed invisible: the archive in the store carried the
 * episodes and nobody noticed the live read had gone blank underneath it. With
 * the watch OFF there is no archive, so the list emptied itself within one
 * poll — the panel claiming "still read live from the browser's own history"
 * while showing nothing, which is exactly the failure the sentence promises
 * cannot happen.
 *
 * Process-scoped, like STARTED_MS: it describes a window that begins when this
 * deck begins, and a deck that restarts re-reads everything anyway.
 */
const _lastRead = new Map();

/** How many rows each profile had at its last real read, so a row can report
 *  what was ADDED rather than the running total. */
const _lastCount = new Map();


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
    await (deps.writeStore ?? writeStore)({ settings: store.settings, episodes: [], dismissed: store.dismissed }, undefined, deps);
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
  let allFindings = [];
  let anyDegraded = false;
  let oldestSeen = null;
  // The newest visit a PERSON made, across every profile. It is what the quiet
  // gate measures against, so it is also the honest answer to "would a program
  // page opened right now be reported" — which is the question somebody has
  // when they are sitting in front of the browser wondering whether the watch
  // is doing anything.
  let lastHuman = null;

  for (const profile of profiles) {
    const read = await visitsFor(profile, { sinceChromeTime, copyDir, deps });
    if (read.degraded) anyDegraded = true;
    // Tagged with the browser they came from, which is the one thing a reaction
    // cannot work out for itself: closing a tab means telling ONE application to
    // close it, and a finding that has forgotten which browser it was in can
    // only be guessed at.
    const key = `${profile.browser}/${profile.profile}`;
    let findings = classify(read.rows, { ...opts, exclude })
      .map(f => ({ ...f, browser: profile.browser }));
    // Everything this profile contributes, so a cached poll can hand back what
    // the last real one found instead of erasing it.
    let oldest = null;
    let human = null;
    // PAGES A PROGRAM OPENED, which is not the same as findings. A finding also
    // has to clear the quiet gate; this is every navigation Chrome marked as
    // coming from an API, whether or not anybody was at the keyboard. It is the
    // figure the overview shows, because a panel about what programs did should
    // count what programs did — the total row count it showed before was, on a
    // measured profile, 78% the reader's own browsing.
    let byProgram = 0;
    for (const row of read.rows) {
      if (oldest === null || row.timeMs < oldest) oldest = row.timeMs;
      if (isProgramNavigation(row.transition)) byProgram += 1;
      else if (human === null || row.timeMs > human) human = row.timeMs;
    }
    if (read.cached) {
      // Carried across a cached poll like everything else here: a read that
      // says "unchanged" means "as before", not "nothing".
      ({ findings, oldest, human, byProgram } =
        _lastRead.get(key) ?? { findings: [], oldest: null, human: null, byProgram: 0 });
    } else if (!read.degraded) _lastRead.set(key, { findings, oldest, human, byProgram });
    const where = `${profile.name}/${profile.profile}`;
    if (read.degraded) note("warn", `${where} — ${read.reason ?? "could not read"}`, now);
    // A poll that found the file unchanged says nothing at all.
    else if (read.cached) { /* silent */ }
    else {
      // `, 0 flagged` on every line is what made them all look alike: the
      // count that matters is the one that is not zero, and printing the zero
      // beside it buried the difference. Absence is the message.
      // THE DELTA, NOT THE RUNNING TOTAL. `read.rows` is every row since this
      // deck started, so re-reporting its length made the feed a counter
      // dressed as a log: "2 visits", "4 visits", "7 visits" are not three
      // events of those sizes, they are one number growing. Each row is now a
      // discrete fact — what this browser added since the last time the file
      // moved — which is what a log line is supposed to be.
      //
      // And a read that added nothing says nothing. Chrome touches this file
      // for reasons of its own, so an mtime that moved is not proof that
      // anything happened; only a row count that grew is.
      const n = read.rows.length;
      const added = n - (_lastCount.get(key) ?? 0);
      _lastCount.set(key, n);
      if (added < 0) {
        // THE COUNT WENT DOWN, which within one deck's run means one thing:
        // the browsing history was truncated or cleared. Swallowing it broke
        // the panel's own arithmetic — the deltas in the feed would no longer
        // telescope to the total in the overview — and it hid the exact event
        // this watch is built around. Whoever can drive this browser can clear
        // its history with the same button the user has, and that is the one
        // action that destroys the evidence.
        note("warn",
             `${where} — history shrank by ${(-added).toLocaleString("en-US")}; it was cleared or trimmed`, now,
             {
               browser: profile.name,
               profile: profile.profile,
               value: `${added.toLocaleString("en-US")} entries`,
               flagged: 0,
             });
      } else if (added > 0 || findings.length > 0) {
        const found = findings.length > 0 ? `, ${findings.length} flagged` : "";
        note(findings.length > 0 ? "find" : "ok",
             `${where} — ${added.toLocaleString("en-US")} new entr${added === 1 ? "y" : "ies"}${found}`, now,
             {
               browser: profile.name,
               profile: profile.profile,
               // `+` because the whole point of the change was that this is a
               // DELTA and not a total, and a bare number in a column of
               // numbers reads as a quantity of something rather than as
               // growth. The noun matches the overview's caption above it.
               value: `+${added.toLocaleString("en-US")} ${added === 1 ? "entry" : "entries"}`,
               flagged: findings.length,
             });
      }
    }
    allFindings = allFindings.concat(findings);
    if (oldest !== null && (oldestSeen === null || oldest < oldestSeen)) oldestSeen = oldest;
    if (human !== null && (lastHuman === null || human > lastHuman)) lastHuman = human;
    reports.push({
      browser: profile.browser,
      name: profile.name,
      profile: profile.profile,
      hasClaudeExt: profile.hasClaudeExt,
      visits: read.rows.length,
      // What a program opened, ungated. The overview reads this; `visits` stays
      // because the feed's deltas are computed against it and the two numbers
      // answer different questions.
      programVisits: byProgram,
      findings: findings.length,
      degraded: read.degraded,
      reason: read.reason ?? null,
      // Null rather than 0 for a profile with no file: "never written" and
      // "written at the epoch" are different answers and only one is true.
      lastWrittenMs: read.stamp,
    });
  }

  // NO HEARTBEAT ROW. A successful check that found nothing is not an event,
  // and writing one made the feed's own bookkeeping its main content — after
  // two hours the panel would hold a hundred lines saying nothing happened and
  // the three that said something would be buried among them, or evicted by
  // them, since this buffer is bounded at 200.
  //
  // Liveness is said where it costs nothing: the sweep turns, the dot is lit,
  // and `checkedMs` below is the honest timestamp of the last poll. Errors,
  // access failures and the reader's own actions still get rows, because those
  // are not "nothing happened".
  _checks += 1;

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
    // Already-dismissed episodes are not fresh news: the reader has seen them
    // and said so, and notifying about one again is the panel arguing.
    const fresh = undismissed(kept.filter(e => !known.has(`${e.host} ${e.startMs}`)), store.dismissed);
    // Only when something actually arrived. "no new · 3 since this deck
    // started" is the deck telling itself it wrote a file, which is not news.
    if (fresh.length > 0) {
      note("find", `${fresh.length} new episode${fresh.length === 1 ? "" : "s"} · ${kept.length} kept`, now);
    }
    // THE ARCHIVE IS OURS TO WRITE; THE OTHER TWO FIELDS ARE NOT. This poll
    // takes about 400ms — a 21 MB History copy plus the sqlite read — and it
    // used to write back the `dismissed` and `settings` it had read at the
    // start, so a dismissal or a watch-off toggle made while it ran was
    // reverted ten seconds later by the next poll. Re-merging inside the update
    // keeps this function's own answer and takes the other two from disk as
    // they are at the moment of the write.
    const merge = cur => ({
      settings: cur.settings,
      episodes: mergeEpisodes(cur.episodes, live, now),
      dismissed: cur.dismissed,
    });
    if (deps.updateStore) await deps.updateStore(merge, undefined, deps);
    else if (deps.writeStore) await deps.writeStore(merge(store), undefined, deps);
    else await updateStore(merge, undefined, deps);
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
        // A THROW IS NOT NOTHING. `catch(() => [])` turned a reaction that
        // blew up into a reaction that had never been asked for, and the feed
        // then said nothing at all about a finding the panel had promised to
        // act on. The message goes in the line, because the one thing a reader
        // needs when a reaction fails is which failure it was.
        const acted = await (deps.react ?? react)(reaction, episode, { platform, deps })
          .catch(err => [`reaction failed — ${err?.message ?? "unknown error"}`]);
        // `could not` lines are the deck unable to do what it said it would,
        // which is what `warn` is for; the rest is the reaction working.
        for (const line of acted) {
          note(/^(could not|reaction failed)/.test(line) ? "warn" : "find",
               `${episode.host} — ${line}`, now);
        }
      }
    }
  }
  // FILTERED ON BOTH PATHS, because the panel builds episodes from the
  // browser's own history on every poll: dropping only the archived copy would
  // be undone within ten seconds by the next read of the same visits.
  const episodes = undismissed(enabled ? kept : live, store.dismissed);

  // Stamped after the work, so it means "a poll finished" rather than "a poll
  // began" — the difference shows on the first look, which copies every
  // database and can take a second.
  _checkedMs = now;

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
      // Null when nobody has browsed since the deck started, which is itself
      // the answer: the gate is already open.
      lastHumanMs: lastHuman,
      quietMs: quietMs ?? 15 * 60_000,
      logPath: logPath(),
      // When the deck last FINISHED a poll, and how many it has done. The
      // panel's liveness reads from these; the heartbeat row that used to
      // carry it is gone. Not `lastWrittenMs` — that is the History file's
      // mtime, a fact about the browser rather than about the watch, and on an
      // idle machine it grows forever while the watch keeps looking.
      checkedMs: _checkedMs,
      checks: _checks,
      // How many episodes this deck has seen since it started. Zero with the
      // watch off is not a fault — it is the switch doing what it says — and the
      // panel needs the number to be able to say which of the two it is.
      archived: undismissed(kept, store.dismissed).length,
      now,
    },
    degraded: anyDegraded,
  };
}
