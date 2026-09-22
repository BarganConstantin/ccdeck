// How much each account worked in each project — the rollup behind the
// account card's "Projects" report.
//
// The account cards show account-wide rate-limit utilisation, which has no
// project dimension and cannot be sliced. This is the other axis: for one
// account, the tokens it spent per project, which the web side prices with the
// board's own pricing table (pricing.ts). Cost is NOT computed here — the
// server is plain .mjs with no build step and cannot import the .ts price
// table, and keeping one source of prices beats a second copy that drifts. So
// this file tallies TOKENS per (account, project, day, model) and the client
// multiplies by the rates it already owns.
//
// Attribution is per MESSAGE, not per session. A running session migrates to a
// newly-activated account on its next message, so a whole session can span two
// accounts; only the message's own timestamp, matched against the swap log,
// says who was active when it was billed. Each transcript line carries, in one
// JSON object, its `timestamp`, its `message.model` and its `message.usage`
// token counts, and its `cwd` — everything a row needs.
//
// The scan is incremental: a byte cursor per transcript file means a pass folds
// only the lines appended since the last one, so opening the report is a read
// of a small on-disk tally rather than a walk of every transcript.
import { open, stat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { renameWithRetry } from "./installer.mjs";
import { claudeConfigDir } from "./claude-dir.mjs";
import { accountKey } from "./lan-sync.mjs";
import { readSwapLog, accountAtTime, trackedSince, seedActive, markGap } from "./swap-log.mjs";

/** The pseudo-account for messages the swap log cannot place — everything
 *  before tracking began, or a gap. Shown once, apart from any real account, so
 *  a per-account total is never quietly inflated by work that is not that
 *  account's. A NUL keeps it from ever colliding with a real `email@@org` key. */
export const UNATTRIBUTED = "\u0000unattributed";

/** Where the tally and cursors live, beside cswap-auto's own state. */
export function statePath(home = homedir()) {
  return join(home, ".agents-deck", "account-projects.json");
}

const MAX_CHUNK = 1 << 20;           // 1 MiB reads, so a cold 100 MB transcript never loads whole
const RETAIN_DAYS = 60;              // covers the 30-day window with margin; older days are pruned
const DEFAULT_INTERVAL_MS = 20_000;  // a pass every 20 s; each is stat + append-only reads
const HEARTBEAT_MS = 300_000;        // persist "last seen alive" at most this often when idle
const GAP_MS = 600_000;              // a boot more than this after the last heartbeat means the
                                     // deck was down; that stretch is fenced off as unattributed

/** The two directories Claude Code writes transcripts under: the configured one
 *  and the default, since a deck launched from a desktop shortcut may resolve
 *  CLAUDE_CONFIG_DIR differently than the `claude` process that wrote the file
 *  (the same two-root reason index.mjs states for the hook path). */
export function transcriptRoots(home = homedir(), env = process.env) {
  const roots = [resolve(claudeConfigDir(env, home), "projects")];
  const def = resolve(home, ".claude", "projects");
  if (!roots.includes(def)) roots.push(def);
  return roots;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The six token counters a transcript's `usage` block carries, in the compact
 *  keys the tally stores. Shape mirrors web's TokenUsage so the client maps it
 *  straight onto costForUsage. */
export function countersFrom(usage) {
  const cc = (usage && typeof usage.cache_creation === "object" && usage.cache_creation) || {};
  return {
    i: num(usage?.input_tokens),
    o: num(usage?.output_tokens),
    cr: num(usage?.cache_read_input_tokens),
    cc: num(usage?.cache_creation_input_tokens),
    c1h: num(cc.ephemeral_1h_input_tokens),
    c5m: num(cc.ephemeral_5m_input_tokens),
  };
}

function addInto(dst, src) {
  dst.i += src.i; dst.o += src.o; dst.cr += src.cr;
  dst.cc += src.cc; dst.c1h += src.c1h; dst.c5m += src.c5m;
  return dst;
}

function zero() { return { i: 0, o: 0, cr: 0, cc: 0, c1h: 0, c5m: 0 }; }

/** Local calendar day of a timestamp, `YYYY-MM-DD`. Local because that is the
 *  day a person means by "today", and how ccusage buckets its daily rollup. The
 *  string sorts chronologically, so a window is a `>=` on it. */
export function localDay(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The earliest day a window of `days` includes, counting today as day 1. */
export function windowCutoff(days, now = Date.now()) {
  if (!days || days <= 0) return null;
  return localDay(now - (days - 1) * 86_400_000);
}

/** CC encodes a cwd `/Users/x/y` as the folder `-Users-x-y`. The reverse is
 *  lossy — a real dash in a directory name is indistinguishable from a
 *  separator — so this is only the fallback for a line that carried no `cwd`;
 *  a real dash in a path is rare and only ever mislabels that one project. */
function cwdFromSlug(slug) {
  if (!slug || slug === "." ) return "";
  return "/" + slug.replace(/^-+/, "").replace(/-/g, "/");
}

/**
 * The project a cwd belongs to. A git worktree lives at
 * `<repo>/.claude/worktrees/<name>`, so work done in one is counted under the
 * repo it is a checkout of — otherwise the same project splits into a row per
 * worktree ("agents-deck" and "account-projects" for one repo, #1200 review).
 * Handles both path separators, for a Windows cwd. Anything not in a worktree
 * is returned unchanged.
 */
export function projectPath(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  // Strip `.claude/worktrees` and anything under it — the worktree name, a
  // path inside it, or nothing at all (a session run in the worktrees dir).
  return cwd.replace(/[\\/]\.claude[\\/]worktrees(?:[\\/].*)?$/, "");
}

/**
 * Fold one transcript line into the tally. A line with no usage block, no
 * parseable timestamp, or that is not JSON leaves the tally untouched — the
 * same tolerance the whole-file scanners have.
 *
 * `timeline` is the sorted swap log; the account is whoever it says was active
 * at this line's timestamp, or UNATTRIBUTED when the timestamp precedes it.
 */
export function foldLine(tally, line, timeline, fallbackCwd) {
  if (!line || !line.includes('"usage"')) return;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return; }
  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return;
  const ts = Date.parse(obj?.timestamp);
  if (!Number.isFinite(ts)) return;
  const c = countersFrom(usage);
  if (!(c.i || c.o || c.cr || c.cc)) return;   // a usage block that billed nothing
  const model = typeof obj?.message?.model === "string" ? obj.message.model : "";
  const rawCwd = (typeof obj?.cwd === "string" && obj.cwd) ? obj.cwd : (fallbackCwd || "");
  const cwd = projectPath(rawCwd);   // a worktree counts under the repo it checks out
  const who = accountAtTime(timeline, ts);
  const key = who ? accountKey(who.email, who.orgUuid) : UNATTRIBUTED;
  const day = localDay(ts);
  const proj = (((tally[key] ??= {})[cwd] ??= {})[day] ??= {});
  addInto(proj[model] ??= zero(), c);
}

/** Read the bytes of `path` from `start` to `size`, folding each COMPLETE line,
 *  and return the byte offset of the last newline consumed. A partial final
 *  line (an append still in flight) is left for the next pass. StringDecoder
 *  carries a multibyte character split across a chunk boundary. */
async function foldAppended(fh, start, size, onLine) {
  const dec = new StringDecoder("utf8");
  let offset = start;
  let carry = "";
  const buf = Buffer.allocUnsafe(Math.min(MAX_CHUNK, Math.max(1, size - start)));
  while (offset < size) {
    const want = Math.min(buf.length, size - offset);
    const { bytesRead } = await fh.read(buf, 0, want, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
    carry += dec.write(buf.subarray(0, bytesRead));
    let nl;
    while ((nl = carry.indexOf("\n")) >= 0) {
      onLine(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
    }
  }
  carry += dec.end();
  // Consumed up to the last newline; the leftover partial line's bytes stay
  // uncounted so the next pass reads it whole.
  return size - Buffer.byteLength(carry, "utf8");
}

/** Every `.jsonl` under the transcript roots, de-duplicated. */
async function listTranscripts(roots) {
  const out = new Set();
  for (const root of roots) {
    let ents = null;
    try { ents = await readdir(root, { recursive: true, withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      out.add(join(e.parentPath ?? e.path ?? root, e.name));
    }
  }
  return [...out];
}

/** Drop day buckets older than the retention window and prune the empty
 *  branches left behind, so the file cannot grow without bound. */
function prune(tally, now = Date.now()) {
  const keep = windowCutoff(RETAIN_DAYS, now);
  if (!keep) return;
  for (const acct of Object.keys(tally)) {
    const projects = tally[acct];
    for (const cwd of Object.keys(projects)) {
      const days = projects[cwd];
      for (const day of Object.keys(days)) if (day < keep) delete days[day];
      if (!Object.keys(days).length) delete projects[cwd];
    }
    if (!Object.keys(projects).length) delete tally[acct];
  }
}

/** Sum a project's per-day, per-model counters into one `{ model: counters }`
 *  over the days at or after `cutoff` (all days when cutoff is null). */
function sumModels(daysMap, cutoff) {
  const models = {};
  let any = false;
  for (const day of Object.keys(daysMap)) {
    if (cutoff && day < cutoff) continue;
    for (const [model, c] of Object.entries(daysMap[day])) {
      addInto(models[model] ??= zero(), c);
      any = true;
    }
  }
  return any ? models : null;
}

/**
 * The report for one account over a window: its projects (each a per-model
 * token breakdown for the client to price), plus the global unattributed
 * bucket for the same window, and when tracking began.
 *
 * `days` of 0 (or null) means all retained days. Projects with no tokens in the
 * window are dropped. Ordering is left to the client, which prices first.
 */
export function reportFrom(tally, timeline, key, days, now = Date.now()) {
  const cutoff = windowCutoff(days, now);
  const projects = [];
  for (const [cwd, daysMap] of Object.entries(tally[key] ?? {})) {
    const models = sumModels(daysMap, cutoff);
    if (models) projects.push({ path: cwd, name: basename(cwd) || cwd || "(unknown)", models });
  }
  // Unattributed is not any one account's, so it is collapsed across projects
  // into a single bucket shown apart from the account's own totals.
  const unModels = {};
  let unAny = false;
  for (const daysMap of Object.values(tally[UNATTRIBUTED] ?? {})) {
    const m = sumModels(daysMap, cutoff);
    if (m) { for (const [model, c] of Object.entries(m)) addInto(unModels[model] ??= zero(), c); unAny = true; }
  }
  return {
    trackedSince: trackedSince(timeline),
    days: days || 0,
    projects,
    unattributed: unAny ? unModels : null,
    daily: dailyFrom(tally, key, cutoff),
  };
}

/**
 * The same window, sliced by day, for the per-day chart: for each day that has
 * work, the per-project and the unattributed model counters. The unattributed
 * bucket is kept per day too — not to draw it, but so the client can reconcile
 * each day to ccusage over a complete denominator.
 */
export function dailyFrom(tally, key, cutoff) {
  const byDay = new Map();
  const slot = day => { let s = byDay.get(day); if (!s) { s = { projects: {}, un: {} }; byDay.set(day, s); } return s; };
  for (const [cwd, daysMap] of Object.entries(tally[key] ?? {})) {
    for (const [day, models] of Object.entries(daysMap)) {
      if (cutoff && day < cutoff) continue;
      const dst = (slot(day).projects[cwd] ??= {});
      for (const [m, c] of Object.entries(models)) addInto(dst[m] ??= zero(), c);
    }
  }
  for (const daysMap of Object.values(tally[UNATTRIBUTED] ?? {})) {
    for (const [day, models] of Object.entries(daysMap)) {
      if (cutoff && day < cutoff) continue;
      const un = slot(day).un;
      for (const [m, c] of Object.entries(models)) addInto(un[m] ??= zero(), c);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, s]) => ({
      day,
      projects: Object.entries(s.projects).map(([path, models]) => ({ path, models })),
      unattributed: Object.keys(s.un).length ? s.un : null,
    }));
}

/**
 * The rollup engine: a periodic incremental scan, an on-disk tally, and a
 * synchronous `report`. Everything is injectable so the pass, the paths and the
 * clock can be driven from a test without touching the real machine.
 */
export function createProjectRollup({
  now = Date.now,
  intervalMs = DEFAULT_INTERVAL_MS,
  roots = transcriptRoots(),
  state: stateFile = statePath(),
  swapLog,                         // path override for readSwapLog / seedActive
  storeRoot,                       // claude-swap store root the seed reads (tests inject a bogus one)
  setInterval: setIv = setInterval,
  clearInterval: clearIv = clearInterval,
} = {}) {
  let state = { version: 1, cursors: {}, tally: {} };
  let timer = null;
  let running = false;
  let dirty = false;
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const disk = JSON.parse(await readFile(stateFile, "utf8"));
      if (disk && disk.version === 1 && disk.tally && disk.cursors) state = disk;
    } catch { /* first run: empty state */ }
  }

  async function persist() {
    if (!dirty) return;
    dirty = false;
    prune(state.tally, now());
    const tmp = stateFile + ".tmp";
    try {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(tmp, JSON.stringify(state), "utf8");
      // Atomic replace, so a crash never leaves half a file — through the
      // shared retry ladder, because a bare rename loses to a virus scanner or
      // an indexer holding the target open on Windows (installer.mjs's #786).
      await renameWithRetry(tmp, stateFile);
    } catch { /* a failed persist just re-folds next time; cursors stay in memory */ }
  }

  async function foldFile(path, timeline) {
    let st = null;
    try { st = await stat(path); } catch { return; }
    let offset = state.cursors[path] ?? 0;
    // A shrunk file was replaced or rotated. Re-folding from 0 would double-count
    // what is already in the tally (which is not keyed by file), so instead
    // resync the cursor to the current end: the replaced content is lost, never
    // counted twice. Transcripts append and do not shrink in normal use, so this
    // is the rare, safe side to err on.
    if (st.size < offset) { state.cursors[path] = st.size; dirty = true; return; }
    if (st.size <= offset) return;
    const fallback = cwdFromSlug(basename(dirname(path)));
    let fh = null;
    try {
      fh = await open(path, "r");
      const consumed = await foldAppended(fh, offset, st.size, (line) => foldLine(state.tally, line, timeline, fallback));
      if (consumed > offset) { state.cursors[path] = consumed; dirty = true; }
    } catch { /* unreadable this pass; cursor unchanged, tried again next pass */ }
    finally { if (fh) await fh.close().catch(() => {}); }
  }

  async function pass() {
    if (running) return;             // one pass at a time; folding twice would double totals
    running = true;
    try {
      await load();
      const nowMs = now();
      // The deck was down between the last heartbeat and this boot. Fence that
      // stretch off so work timestamped inside it is unattributed rather than
      // charged to whoever was active when the deck closed — the user may have
      // switched accounts by hand while nothing was recording. Written before
      // the seed so the order is stop → start.
      if (state.lastAlive && nowMs - state.lastAlive > GAP_MS) {
        await markGap(state.lastAlive + 1, swapLog);
      }
      await seedActive({ now, path: swapLog, root: storeRoot });   // anchor the current account, once, deduped
      const timeline = await readSwapLog(swapLog);
      const files = await listTranscripts(roots);
      for (const path of files) await foldFile(path, timeline);
      // Forget cursors for files that are gone, so the map cannot grow forever.
      const alive = new Set(files);
      for (const p of Object.keys(state.cursors)) if (!alive.has(p)) { delete state.cursors[p]; dirty = true; }
      // Heartbeat: record that the deck was alive now, so a later boot can see
      // how long it was down. Cheap when nothing else changed — only bumped
      // (and so only persisted) once every HEARTBEAT_MS while idle.
      if (dirty || !state.lastAlive || nowMs - state.lastAlive > HEARTBEAT_MS) {
        state.lastAlive = nowMs;
        dirty = true;
      }
      await persist();
    } finally { running = false; }
  }

  return {
    async start() { await pass(); if (!timer) timer = setIv(() => { void pass(); }, intervalMs); if (timer.unref) timer.unref(); return this; },
    stop() { if (timer) { clearIv(timer); timer = null; } },
    /** Force one incremental pass now (used at boot and by tests). */
    tick: pass,
    /** Synchronous report from the in-memory tally + freshly-read swap log. */
    async report(key, days) {
      await load();
      const timeline = await readSwapLog(swapLog);
      return reportFrom(state.tally, timeline, key, days, now());
    },
    _state: () => state,
  };
}
