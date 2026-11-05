// The Projects report for a Codex profile: what one signed-in Codex home spent,
// per project and per day, in the shape the Claude accounts' report has
// (account-projects.mjs reportFrom/dailyFrom), so the same dialog renders both.
//
// WHY THE TALLY IS PER FOLDER AND CREATOR ACCOUNT. A rollout names two things
// that matter here: the folder the session started in (`session_meta.payload.cwd`,
// canonicalised the way the watcher canonicalises it, so a symlinked checkout is
// one project) and the ChatGPT account that created it (`creator_account_id`).
// Claude's report has to guess which account a transcript belonged to from a swap
// log; a Codex home has no such problem, because a profile IS one home and the
// home's auth.json says who is signed in to it NOW. So a session is the project
// of its folder, with one exception below, and nothing is inferred.
//
// WHAT GOES TO `unattributed`. A rollout whose creator is known, whose home's
// login is known, and where the two DIFFER was written by an earlier sign-in in
// this folder (the user logged out and in as someone else, or replaced the
// login). Its spend is real but is not this account's, so the whole file counts
// under `unattributed`, which the dialog keeps apart from the account's own
// totals and reconciles to the day as Claude's does. A rollout with no recorded
// cwd cannot be placed on a project and goes there too. A rollout with no
// `creator_account_id` (an older Codex, or an API-key login) is NOT a mismatch —
// absence proves nothing — so it counts for its project. The raw account id is
// only ever compared here; it is never put in the report.
//
// WHY THE FOLD IS foldCodexCost. A session card prices a Codex session from
// codex-cost-usage.mjs: only OBSERVED INCREASES of the cumulative totals, under
// the model and the service tier in force at that record, with the whole session
// discarded when a total goes DOWN (a rollout that restarted its counters cannot
// be added up with what came before). This report runs every record of a rollout
// through that same fold and attributes each record's increase to the local day
// of the record's timestamp, so a day's tokens here and a session card's cost
// cannot disagree. When the fold discards its totals the per-day tally of that
// file is discarded with them, for the same reason. Lines before the window are
// folded too: they are what makes the first in-window delta a delta rather than
// the session's lifetime total.
//
// THE COUNTERS MAPPING. Counters is the Claude shape `{ i, o, cr, cc, c1h, c5m,
// s? }`. Codex's `input_tokens` INCLUDES the cached portion, and the client's
// billedInputTokens (src/web/pricing.ts) subtracts `cr` itself for a Codex model,
// so `i` is the cache-inclusive input as reported, NOT input minus cache. `o` is
// output, `cr` the cached input, `cc` the cache-write input; `c1h` and `c5m` are
// Claude's cache-lifetime split and are 0 here. `s` holds the share billed at a
// tier other than standard ("fast", "flex"…), a SUBSET of the counters it sits
// on, with the same mapping.
//
// WHICH FILES, AND THE MTIME RULE. A resumed session appends to its ORIGINAL
// rollout, however old its name or day folder is (#1731), so a window cannot pick
// files by the day directory: a plain rollout is read when its mtime is inside
// the window, and the per-record timestamps then decide which of its tokens count.
// A compressed `.jsonl.zst` is one Codex already judged cold, and its mtime is the
// moment of compression rather than of any work, so it is chosen by the start time
// its file name carries — the rule codex-usage.mjs applies to it too. The one case
// that misses is a compressed rollout that started before the window and was
// written inside it, which Codex does not leave compressed.
//
// WHAT IT COSTS. A rollout can be many megabytes, so each is read a chunk at a
// time (forEachRolloutLine) and never held whole. The per-day, per-model tally of
// a file is memoised by path + size + mtime and does not depend on the window, so
// any window is cut from the same memo; the attribution against the login is made
// at report time, so replacing the login re-files the same memo. Files read at
// most MAX_PARALLEL_READS at a time, overlapping calls share one scan, and a
// finished report is kept for a few seconds. Memo entries for files no longer in
// the tree are dropped on the next scan.
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { walkRolloutDays } from "./codex-dir.mjs";
import { codexCostState, foldCodexCost } from "./codex-cost-usage.mjs";
import { canonicalCwd } from "./canonical-path.mjs";
import { forEachRolloutLine } from "./codex-usage.mjs";
import { readCodexHomeAccountId, resolveCodexProfile } from "./codex-profiles.mjs";
import { localDay, windowCutoff } from "./account-projects.mjs";

const MAX_PARALLEL_READS = 4;
const MAX_PARALLEL_STATS = 16;
const REPORT_CACHE_MS = 20_000;
const PLAIN = ".jsonl";
const COMPRESSED = ".jsonl.zst";

// A record the fold can act on says one of these; every other line (the bulk of a
// rollout, the response items) is skipped before the JSON.parse.
const FOLDED = ["session_meta", '"model"', "thread_settings_applied", "total_token_usage"];

/** @type {Map<string, Map<string, object>>} sessions dir -> path -> memo entry */
const memo = new Map();
/** Reads in progress, by file identity, so two overlapping scans open a file once. */
const fileReads = new Map();
/** Reports in progress and finished, by `id:days`. */
const reportInflight = new Map();
const reportCache = new Map();

const zero = () => ({ i: 0, o: 0, cr: 0, cc: 0, c1h: 0, c5m: 0 });

function addInto(dst, src) {
  dst.i += src.i; dst.o += src.o; dst.cr += src.cr; dst.cc += src.cc;
  dst.c1h += src.c1h; dst.c5m += src.c5m;
  for (const [tier, share] of Object.entries(src.s ?? {})) addInto(((dst.s ??= {})[tier] ??= zero()), share);
}

/** A fold bucket (codex-cost-usage.mjs) as plain numbers, or zeros. */
function plainBucket(bucket) {
  const take = u => ({ i: u?.input_tokens ?? 0, o: u?.output_tokens ?? 0, cr: u?.cached_input_tokens ?? 0, cc: u?.cache_write_input_tokens ?? 0 });
  return { ...take(bucket), speeds: new Map([...(bucket?.speeds ?? [])].map(([tier, u]) => [tier, take(u)])) };
}

/** What a record added to its model's bucket, as Counters, or null when nothing. */
function deltaCounters(before, after) {
  const out = zero();
  out.i = after.i - before.i; out.o = after.o - before.o; out.cr = after.cr - before.cr; out.cc = after.cc - before.cc;
  for (const [tier, now] of after.speeds) {
    const was = before.speeds.get(tier);
    const d = { i: now.i - (was?.i ?? 0), o: now.o - (was?.o ?? 0), cr: now.cr - (was?.cr ?? 0), cc: now.cc - (was?.cc ?? 0), c1h: 0, c5m: 0 };
    if (d.i > 0 || d.o > 0 || d.cr > 0 || d.cc > 0) (out.s ??= {})[tier] = d;
  }
  return out.i > 0 || out.o > 0 || out.cr > 0 || out.cc > 0 ? out : null;
}

/** Read one rollout into its memo entry: the creator and folder its header
 *  names, and its per-day, per-model Counters. Null when it could not be read. */
async function readRollout(path, fallbackDay) {
  const state = codexCostState();
  const days = new Map();
  let creator = null;
  let rawCwd = null;
  let sawMeta = false;
  let lastDay = null;
  const onLine = raw => {
    if (!FOLDED.some(needle => raw.includes(needle))) return;
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    if (!obj || typeof obj !== "object") return;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(ts)) lastDay = localDay(ts);
    if (obj.type === "session_meta" && !sawMeta) {
      sawMeta = true;
      const pl = obj.payload;
      creator = typeof pl?.creator_account_id === "string" && pl.creator_account_id !== "" ? pl.creator_account_id : null;
      rawCwd = typeof pl?.cwd === "string" ? pl.cwd : null;
    }
    const counts = obj.type === "event_msg" && obj.payload?.type === "token_count"
      && obj.payload.info?.total_token_usage && typeof obj.payload.info.total_token_usage === "object";
    const model = state.model;
    const before = counts ? plainBucket(state.models.get(model)) : null;
    foldCodexCost(state, obj);
    if (!counts) return;
    // The fold threw its totals away (a cumulative total went down): so does the
    // tally, or a day here would carry tokens its session card no longer prices.
    if (state.models.size === 0) { days.clear(); return; }
    if (!model) return;
    const d = deltaCounters(before, plainBucket(state.models.get(model)));
    if (!d) return;
    const day = lastDay ?? fallbackDay;
    const perModel = days.get(day) ?? new Map();
    addInto(perModel.get(model) ?? perModel.set(model, zero()).get(model), d);
    days.set(day, perModel);
  };
  if (!await forEachRolloutLine(path, onLine)) return null;
  return { creator, cwd: await canonicalCwd(rawCwd), days };
}

/** The start time a rollout's file name carries, in LOCAL time as Codex writes it
 *  (#609), or null for a name that is not a rollout's. */
function nameStartMs(name) {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  return dt.getMonth() === mo - 1 && dt.getDate() === d ? dt.getTime() : null;
}

async function forEachLimited(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

/** Bring the memo of one sessions tree up to date for the files a window needs,
 *  and return it. Files no longer on disk are evicted whatever the window. */
async function scanTree(sessionsDir, windowStartMs) {
  const files = [];
  await walkRolloutDays((dir, names) => {
    for (const name of names) {
      const compressed = name.endsWith(COMPRESSED);
      if (!compressed && !(name.endsWith(PLAIN) && name.startsWith("rollout-"))) continue;
      files.push({ path: join(dir, name), name, compressed });
    }
  }, { sessionsDir });
  await forEachLimited(files, MAX_PARALLEL_STATS, async file => {
    try { Object.assign(file, { st: await stat(file.path) }); } catch { /* gone since the walk */ }
  });
  const known = memo.get(sessionsDir) ?? new Map();
  const kept = new Map();
  const wanted = [];
  for (const file of files) {
    if (!file.st) continue;
    const prior = known.get(file.path);
    const fresh = prior && prior.size === file.st.size && prior.mtimeMs === file.st.mtimeMs;
    if (fresh) kept.set(file.path, prior);
    if (fresh || windowStartMs == null) { if (!fresh) wanted.push(file); continue; }
    const startMs = file.compressed ? nameStartMs(file.name) : null;
    const inWindow = file.compressed ? startMs != null && startMs >= windowStartMs : file.st.mtimeMs >= windowStartMs;
    if (inWindow) wanted.push(file);
  }
  await forEachLimited(wanted, MAX_PARALLEL_READS, async file => {
    const { size, mtimeMs } = file.st;
    const identity = `${file.path}\0${size}\0${mtimeMs}`;
    let read = fileReads.get(identity);
    if (!read) {
      read = readRollout(file.path, localDay(mtimeMs)).finally(() => fileReads.delete(identity));
      fileReads.set(identity, read);
    }
    const entry = await read;
    if (entry) kept.set(file.path, { ...entry, size, mtimeMs, compressed: file.compressed, startMs: nameStartMs(file.name) });
  });
  memo.set(sessionsDir, kept);
  return kept;
}

/** The report's one window cut, over memo entries already filtered to the window. */
function buildReport(entries, accountId, days, now) {
  const cutoff = windowCutoff(days, now);
  const projects = new Map();          // cwd -> day -> model -> Counters
  const unattributed = new Map();      // day -> model -> Counters
  const put = (bucket, day, model, c) => {
    const perModel = bucket.get(day) ?? new Map();
    addInto(perModel.get(model) ?? perModel.set(model, zero()).get(model), c);
    bucket.set(day, perModel);
  };
  for (const entry of entries) {
    // An earlier sign-in's sessions, or one with no folder, are not this
    // account's project work; see the header.
    const otherLogin = accountId && entry.creator && entry.creator !== accountId;
    const target = otherLogin || !entry.cwd ? unattributed : projects.get(entry.cwd) ?? projects.set(entry.cwd, new Map()).get(entry.cwd);
    for (const [day, models] of entry.days) {
      if (cutoff && day < cutoff) continue;
      for (const [model, c] of models) put(target, day, model, c);
    }
  }
  const sum = byDay => {
    const models = {};
    for (const perModel of byDay.values()) for (const [m, c] of perModel) addInto(models[m] ??= zero(), c);
    return Object.keys(models).length ? models : null;
  };
  const toObject = perModel => Object.fromEntries([...perModel]);
  const projectList = [...projects]
    .map(([path, byDay]) => ({ path, name: basename(path) || path || "(unknown)", models: sum(byDay) }))
    .filter(p => p.models)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Per day, like dailyFrom: unattributed folds only into days that already have
  // project work, so history made by another sign-in raises no column of its own.
  const byDay = new Map();
  for (const [path, perDay] of projects) {
    for (const [day, models] of perDay) {
      const slot = byDay.get(day) ?? byDay.set(day, { projects: [], un: null }).get(day);
      slot.projects.push({ path, models: toObject(models) });
    }
  }
  for (const [day, models] of unattributed) {
    const slot = byDay.get(day);
    if (slot) slot.un = toObject(models);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, s]) => ({ day, projects: s.projects.sort((a, b) => (a.path < b.path ? -1 : 1)), unattributed: s.un }));
  return { ok: true, trackedSince: null, days: days || 0, projects: projectList, unattributed: sum(unattributed), daily };
}

/** The earliest millisecond a window of `days` reaches, or null for all time. */
function windowStart(days, now) {
  const cutoff = windowCutoff(days, now);
  if (!cutoff) return null;
  const [y, m, d] = cutoff.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * The Projects report of one Codex profile over `days` (1, 7, 30; 0 is all).
 *
 * `options` injects what a test has to control: `selection` (the homes and
 * profile ids, as readCodexSelection answers), `now`, and `cacheMs`.
 */
export async function codexProjectsReport({ id, days } = {}, options = {}) {
  const d = days === 1 ? 1 : days === 30 ? 30 : days === 0 ? 0 : 7;
  const home = await resolveCodexProfile(id, options);
  if (!home) return { ok: false, reason: "unknown_profile" };
  const now = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  const cacheMs = options.cacheMs ?? REPORT_CACHE_MS;
  const key = `${id}:${d}`;
  const cached = reportCache.get(key);
  if (cached && now - cached.at < cacheMs) return cached.value;
  const running = reportInflight.get(key);
  if (running) return running;
  const run = (async () => {
    const sessionsDir = join(home, "sessions");
    const tree = await scanTree(sessionsDir, windowStart(d, now));
    const start = windowStart(d, now);
    // The same selection the scan made: a plain rollout by mtime, a compressed
    // one by its name — applied again here so a memo filled by a wider window
    // does not widen this one.
    const inWindow = [...tree.values()].filter(e => start == null
      || (e.compressed ? e.startMs != null && e.startMs >= start : e.mtimeMs >= start));
    const value = buildReport(inWindow, await readCodexHomeAccountId(home), d, now);
    reportCache.set(key, { at: now, value });
    return value;
  })().finally(() => { reportInflight.delete(key); });
  reportInflight.set(key, run);
  return run;
}
