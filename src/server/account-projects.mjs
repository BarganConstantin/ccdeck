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
// token counts, and its `cwd` — everything a row needs, once the `cwd` is taken
// back to the folder the session started in (see sessionFolder).
//
// The scan is incremental: a byte cursor per transcript file means a pass folds
// only the lines appended since the last one, so opening the report is a read
// of a small on-disk tally rather than a walk of every transcript.
import { open, stat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, basename, dirname, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { renameWithRetry } from "./installer.mjs";
import { ccProjectSlug, claudeConfigDir } from "./claude-dir.mjs";
import { accountKey } from "./lan-sync.mjs";
import { readSwapLog, accountAtTime, trackedSince, seedActive, markGap } from "./swap-log.mjs";

/** The pseudo-account for messages the swap log cannot place — everything
 *  before tracking began, or a gap. Shown once, apart from any real account, so
 *  a per-account total is never quietly inflated by work that is not that
 *  account's. A NUL keeps it from ever colliding with a real `email@@org` key. */
export const UNATTRIBUTED = "\u0000unattributed";
const STATE_VERSION = 3;

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
 * The folder a transcript line's session started in, recovered exactly from the
 * line's own `cwd` and the slug of the project directory the transcript sits in.
 *
 * CC writes the shell's CURRENT directory on every line, so an agent that ran
 * `cd src/web` stamps every later line with that subfolder. Keying the tally by
 * it split one project into a row for every folder its agent passed through —
 * 25 rows for one repo over a month (#1278). The folder CC files the transcript
 * under, ~/.claude/projects/<slug>, is the one the session started in, and the
 * canvas names a session after the same one. The slug cannot be decoded (a dash
 * in a folder name reads as a separator), but it can be MATCHED: the start
 * folder is the nearest ancestor of the line's cwd, the cwd itself included,
 * that encodes to that slug.
 *
 * Null when none does: the agent left its folder (`cd ../elsewhere`), or the
 * slug is CC's hashed long form of a path this cwd is not under.
 */
export function sessionFolder(cwd, slug) {
  if (!cwd || !slug) return null;
  for (let dir = cwd; ;) {
    if (ccProjectSlug(dir) === slug) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Which folder a line counts under. `from` describes the transcript the line
 * came from: `slug` is its project directory's name, and `folders` maps each
 * slug to the start folder last recovered for it. The map is shared by every
 * transcript of one project directory and persisted, so a line written after
 * the agent left its folder still counts under that folder. Without a slug (a
 * direct call, as the unit tests make) the line's own cwd is used unchanged.
 */
function folderOf(lineCwd, { slug = "", folders = null } = {}) {
  const found = sessionFolder(lineCwd, slug);
  if (found) {
    if (folders) folders[slug] = found;
    return found;
  }
  if (slug && folders?.[slug]) return folders[slug];
  return lineCwd || cwdFromSlug(slug);
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
 * `from` names the transcript's project directory — see folderOf.
 */
export function foldLine(tally, line, timeline, from) {
  if (!line || !line.includes('"usage"')) return;
  let obj = null;
  try { obj = JSON.parse(line); } catch { return; }
  // Claude writes one assistant record for each content block in a request.
  // Every block repeats the request's usage, so only block 0 is billable for
  // this rollup. Older records without the field are kept compatible.
  if (obj?.apiBlockIndex !== undefined && obj.apiBlockIndex !== 0) return;
  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return;
  const ts = Date.parse(obj?.timestamp);
  if (!Number.isFinite(ts)) return;
  const c = countersFrom(usage);
  if (!(c.i || c.o || c.cr || c.cc)) return;   // a usage block that billed nothing
  const model = typeof obj?.message?.model === "string" ? obj.message.model : "";
  const lineCwd = (typeof obj?.cwd === "string" && obj.cwd) ? obj.cwd : "";
  const cwd = projectPath(folderOf(lineCwd, from));   // a worktree counts under the repo it checks out
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

/** Every `.jsonl` under the transcript roots, de-duplicated, mapped to the
 *  slug of the project directory it sits in: the first folder below the root,
 *  also for a subagent's `<slug>/<session>/subagents/agent-*.jsonl`.
 *
 *  Shallowest first, so a session's own transcript, whose first line carries
 *  the folder it started in, is folded before its subagents' and a subagent
 *  that only ever worked outside that folder still finds it in `folders`. */
async function listTranscripts(roots) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let ents = null;
    try { ents = await readdir(root, { recursive: true, withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const dir = e.parentPath ?? e.path ?? root;
      const path = join(dir, e.name);
      if (seen.has(path)) continue;
      seen.add(path);
      const parts = relative(root, dir).split(/[\\/]/).filter(Boolean);
      found.push({ path, slug: parts[0] ?? "", depth: parts.length });
    }
  }
  found.sort((a, b) => a.depth - b.depth);
  return new Map(found.map(f => [f.path, f.slug]));
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
  // Unattributed folds ONLY into days that already have attributed work — it
  // feeds the per-day reconciliation denominator but must not raise a column of
  // its own, or the chart grows an empty bar for every day of pre-tracking
  // history (all of it unattributed).
  for (const daysMap of Object.values(tally[UNATTRIBUTED] ?? {})) {
    for (const [day, models] of Object.entries(daysMap)) {
      const s = byDay.get(day);
      if (!s) continue;
      for (const [m, c] of Object.entries(models)) addInto(s.un[m] ??= zero(), c);
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
  let state = { version: STATE_VERSION, cursors: {}, tally: {}, folders: {} };
  let timer = null;
  let running = false;
  let dirty = false;
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const disk = JSON.parse(await readFile(stateFile, "utf8"));
      if (disk && disk.version === STATE_VERSION && disk.tally && disk.cursors) {
        state = disk;
        state.folders ??= {};
      } else if (disk && (disk.version === 1 || disk.version === 2)) {
        // Version 1 counted every API content block; version 2 keyed each row
        // by the line's own cwd, a row per folder the agent cd'd into (#1278).
        // Neither tally can be re-keyed, since it no longer knows which
        // transcript a count came from. Keep the heartbeat so a restart gap
        // remains fenced, but rebuild the tally from transcripts.
        state = { version: STATE_VERSION, cursors: {}, tally: {}, folders: {}, lastAlive: disk.lastAlive };
        dirty = true;
      }
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

  async function foldFile(path, slug, timeline) {
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
    const from = { slug, folders: state.folders };
    let fh = null;
    try {
      fh = await open(path, "r");
      const consumed = await foldAppended(fh, offset, st.size, (line) => foldLine(state.tally, line, timeline, from));
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
      for (const [path, slug] of files) await foldFile(path, slug, timeline);
      // Forget cursors for files that are gone, and the folders of project
      // directories with no transcript left, so neither map grows forever.
      for (const p of Object.keys(state.cursors)) if (!files.has(p)) { delete state.cursors[p]; dirty = true; }
      const slugs = new Set(files.values());
      for (const s of Object.keys(state.folders)) if (!slugs.has(s)) { delete state.folders[s]; dirty = true; }
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
