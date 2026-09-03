// Aggregates Codex token usage from ~/.codex/sessions rollout JSONL files.
// Unlike Claude, Codex has no CLI quota command — we derive usage from the
// actual session logs for 5h and 7d rolling windows.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createReadStream } from "node:fs";
// The NAMESPACE, never a named import. `import { createZstdDecompress }` is
// resolved at link time, and node:zlib has no such export before Node 22.15 —
// so the named form does not degrade on an older runtime, it throws before a
// single line of this module runs and takes the whole deck down with it. Caught
// by the timezone probe, which spawns a child that imports this file.
import zlib from "node:zlib";
import { STOP, walkRolloutDays } from "./codex-dir.mjs";
import { PRODUCT } from "./brand.mjs";

// Cache results for 60s (lighter than Claude quota — reads more files)
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

// ── what a forced read may cost ─────────────────────────────────────────────
// Until #600 the cache above was the whole of the admission control here, and
// `force` walked straight past it. That made one GET worth a full week of the
// rollout tree: listRolloutFiles(WINDOW_7D_MS) and then a read of every file it
// returns. Measured on this repo's machine against 280 rollouts of ~90KB — a
// week of ordinary use — one forced call is 685ms, 280 file opens and a peak of
// four descriptors. Nothing bounded how many of those calls ran at once, and
// the cost scaled exactly linearly: 16 concurrent forced reads were 4,480 opens
// and 64 descriptors, 128 were 35,840 opens, 512 descriptors and 54.7s.
//
// Reads on this server are deliberately open — `isTrustedRead` does not apply
// the `Sec-Fetch-Site` test that `isTrustedMutation` does, because a cross-site
// read of `http://127.0.0.1:4317` is an ordinary top-level navigation — so any
// page the user has open could run
//
//     for (;;) fetch("http://127.0.0.1:4317/api/codex-usage?refresh=1",
//                    { mode: "no-cors" });
//
// and get one of those scans per request. MAX_PARALLEL_READS below bounds the
// fan-out WITHIN one call, and it exists because opening a week of rollouts at
// once risked EMFILE — which readTokenSeries swallows into `return null`, a
// silent undercount rather than an error. Unbounded calls let that EMFILE back
// in through the door the pool does not cover.
//
// The two things between a caller and a scan are the ones quota.mjs established
// and codex-quota.mjs adopted in #597, spelled the same way in all three:
//
//   _inflight     — callers that overlap wait on the one scan already running,
//                   `force` included. What ?refresh=1 asks for is a reading
//                   newer than the cache, and a scan in progress is one, so
//                   joining it costs nothing and is offered before the floor.
//   FORCE_POLL_MS — the minimum interval between two scans WE pay for.
//                   `_inflight` deduplicates callers that overlap and nothing
//                   else, so a caller that waits for one scan to settle and then
//                   asks again was a fresh week of the disk every time.
//
// This module has neither of the extra parts its two siblings carry, and
// deliberately: there is no upstream backend to rate-limit us, so no cooldown,
// and nothing outside this file invalidates the cache, so no generation guard.
let _inflight = null;

// Stamped when a scan STARTS rather than when it lands: what the floor rations
// is the walk of the disk, and one that is still running has already been paid
// for.
let _lastScanAt = 0;

// quota.mjs's number, and codex-quota.mjs's, for the reason those two give it:
// "The refresh button may beat that floor, but not turn into a poll loop when
// held down." Three routes within a few lines of each other in the router have
// no business disagreeing about what `?refresh=1` costs.
const FORCE_POLL_MS = 60_000;

/**
 * Whether we may walk a week of the rollout tree right now.
 *
 * Exported for tests, for the same reason quota.mjs exports `maySelfPoll` and
 * codex-quota.mjs exports `mayFetchQuota`: this is the rule, it is pure, and it
 * is worth pinning down away from the scan it guards.
 */
export function mayScanUsage({ now, lastScanAt }) {
  return now - lastScanAt >= FORCE_POLL_MS;
}

/**
 * The answer to a read the floor refused.
 *
 * A reading, not an error. The panel draws this number from `codexUsage?.ok &&
 * window7d.sessionCount > 0`, so an `{ ok: false }` refusal would make the token
 * line vanish for a minute — the deck teaching itself a new failure mode in
 * order to defend against a loop nobody ran. `stale` is the flag quota.mjs and
 * codex-quota.mjs both use for exactly this, and `fetchedAt` keeps the moment
 * the DATA was read rather than the moment of the read that was refused, so an
 * age label drawn from it never vouches for a scan that did not happen.
 */
function heldReading(now) {
  if (_cache) return { ..._cache, stale: true };
  // Only reachable before the first scan has ever landed — every outcome below
  // is cached, failures included, and a scan that is still running is served by
  // `_inflight` — and spelled the way codex-quota.mjs spells the same state.
  return { ok: false, reason: "waiting", fetchedAt: now };
}

const WINDOW_5H_MS  = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS  = 7 * 24 * 60 * 60 * 1000;

// A rollout file grows for as long as its session runs, and a week's worth of
// them is however much the user happened to type. Reading them all at once made
// the peak working set a function of that total; these two caps make it a
// function of the pool instead — at most MAX_PARALLEL_READS files in flight,
// each holding one chunk plus the line it is still assembling.
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_PARALLEL_READS = 4;

// Run `worker` over `items` with at most `limit` of them in flight. Workers
// pull from a shared cursor, so a slow file delays only its own worker instead
// of stalling a fixed-size batch.
async function forEachLimited(items, limit, worker) {
  let next = 0;
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push((async () => {
      while (next < items.length) await worker(items[next++]);
    })());
  }
  await Promise.all(workers);
}

// Append one rollout line's token_count event to the series, if it has one.
function foldTokenLine(series, raw) {
  // Cheap pre-filter before the (relatively) expensive JSON.parse.
  if (!raw.includes("total_token_usage")) return;
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") return;
  const u = obj.payload.info?.total_token_usage;
  if (!u) return;
  const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
  series.push({
    ts:     isNaN(ts) ? null : ts,
    inp:    u.input_tokens             ?? 0,
    out:    u.output_tokens            ?? 0,
    cacheR: u.cached_input_tokens      ?? 0,
    // Read even though every value observed so far is zero: emptyWindow() has
    // declared a cacheCreateTokens field since this file was written and nothing
    // ever incremented it, so the window shape promised a number it could not
    // produce. OpenAI populating the field is the only thing that has to change
    // for the count to become real, and it should not also need a code change.
    cacheW: u.cache_write_input_tokens ?? 0,
    total:  u.total_tokens             ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
  });
}

// Read the full series of cumulative token_count events from a rollout file.
// Each token_count event carries `info.total_token_usage` — the running total
// for the session at that point. We keep the whole series (with timestamps) so
// we can compute how many tokens were spent *within* a rolling window via a
// cumulative delta, rather than dumping a session's lifetime total into a bucket
// based on when it merely started.
//
// Returns an ascending-by-time array of { ts, inp, out, cacheR, total } where
// `inp` includes the cached portion (Codex reports input_tokens incl. cache),
// or null if the file has no usable token_count events.
/**
 * Codex compresses cold rollouts, and this is how the deck keeps reading them.
 *
 * openai/codex 0.153.0 added a background worker that rewrites any rollout older
 * than seven days as `rollout-….jsonl.zst`. Its own source says the quiet part
 * out loud — "Requires every reader of the Codex home to support compressed
 * shared histories" — and this deck is one of those readers. The flag
 * (`local_thread_store_compression`) is still `default_enabled: false`, so
 * nothing on disk has changed yet; the failure it would cause is why this is
 * here before it does. A reader that matched only `.jsonl` would have skipped
 * every day past the seventh IN SILENCE, and the 30-day Codex window would have
 * quietly collapsed to the last seven with figures that still looked right.
 *
 * Streamed, not decompressed whole. The plain path reads a chunk at a time
 * precisely so a megabyte of prompt text is never buffered, and handing that
 * property back for a one-line `zstdDecompressSync` would trade a silent
 * undercount for a memory spike.
 *
 * `createZstdDecompress` arrived in Node 22.15 and this package declares
 * `>=18`, so a deck on an older runtime cannot read them at all. It says so
 * once, on the terminal it was started from, rather than counting zero and
 * looking healthy.
 */
const COMPRESSED = ".jsonl.zst";
const createZstdDecompress = typeof zlib.createZstdDecompress === "function"
  ? zlib.createZstdDecompress
  : null;
let warnedNoZstd = false;

async function readCompressedTokenSeries(filePath) {
  if (!createZstdDecompress) {
    if (!warnedNoZstd) {
      warnedNoZstd = true;
      console.error(
        `${PRODUCT} codex-usage: this Node (${process.version}) cannot read Codex's compressed `
        + "rollouts; sessions older than about a week are being left out. Node 22.15 or newer reads them.",
      );
    }
    return null;
  }
  try {
    const series = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const stream = createReadStream(filePath).pipe(createZstdDecompress());
    for await (const chunk of stream) {
      pending += decoder.write(chunk);
      let from = 0;
      let nl;
      while ((nl = pending.indexOf("\n", from)) >= 0) {
        foldTokenLine(series, pending.slice(from, nl));
        from = nl + 1;
      }
      if (from > 0) pending = pending.slice(from);
    }
    pending += decoder.end();
    if (pending) foldTokenLine(series, pending);
    return series.length ? series : null;
  } catch { return null; }
}

/** The reader, exported under a test-only name. The compressed path cannot be
 *  reached through `fetchCodexUsage` without a Codex home full of week-old
 *  sessions, and the thing worth checking is that both spellings produce the
 *  same series. */
export const readTokenSeriesForTest = filePath => readTokenSeries(filePath);

async function readTokenSeries(filePath) {
  if (filePath.endsWith(COMPRESSED)) return readCompressedTokenSeries(filePath);
  let fd;
  try {
    fd = await open(filePath, "r");
    const { size } = await fd.stat();
    if (size === 0) return null;
    const series = [];
    // A chunk at a time rather than the whole file: only the token_count
    // numbers survive the pass, so buffering megabytes of prompt text (once as
    // a Buffer, again as a string, a third time as the split array) bought
    // nothing. StringDecoder carries a UTF-8 sequence that straddles a chunk
    // boundary over to the next chunk.
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await fd.read(buf, 0, READ_CHUNK_BYTES, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      pending += decoder.write(buf.subarray(0, bytesRead));
      let from = 0;
      let nl;
      while ((nl = pending.indexOf("\n", from)) >= 0) {
        foldTokenLine(series, pending.slice(from, nl));
        from = nl + 1;
      }
      if (from > 0) pending = pending.slice(from);
    }
    // A rollout still being written can end without its final newline.
    pending += decoder.end();
    if (pending) foldTokenLine(series, pending);
    return series.length ? series : null;
  } catch { return null; }
  // AWAITED. A close scheduled and abandoned means this function resolves while
  // the descriptor is still open, and on Windows a file with any handle on it
  // cannot be deleted: the unlink marks it delete-pending, the name stays in
  // the directory, and the next rmdir of the parent fails with ENOTEMPTY. The
  // deck sweeps its own rollout copies, and the suite tears down a sandbox full
  // of them — this is how "the read is finished" stops being a lie about the
  // handle. Awaiting in a finally costs one microtask and cannot change what is
  // returned. Errors stay swallowed: a close that fails is nothing a reader can
  // act on.
  finally { await fd?.close().catch(() => {}); }
}

// Tokens spent within [windowStartMs, now]: the last cumulative snapshot minus
// the last snapshot taken *before* the window opened. If the session began
// inside the window (no prior snapshot), the baseline is zero and the full
// cumulative end counts. Three of the fields are non-overlapping and sum to
// `total`: `input` is fresh (non-cached) input, `cacheRead` is the cached
// portion, `output` is output. (Codex's input_tokens includes cache, so we
// subtract it out to avoid double-counting.) `cacheCreate` is the exception and
// is documented as one where it is returned below — it is a slice of `input`
// rather than a fourth disjoint bucket.
function windowDelta(series, windowStartMs) {
  if (!series || series.length === 0) return null;
  const end = series[series.length - 1];
  // Baseline = last event strictly before the window opened.
  let base = null;
  for (const e of series) {
    if (e.ts != null && e.ts < windowStartMs) base = e;
    else if (e.ts != null) break;
  }
  const dInp    = Math.max(0, end.inp    - (base?.inp    ?? 0));
  const dOut    = Math.max(0, end.out    - (base?.out    ?? 0));
  const dCacheR = Math.max(0, end.cacheR - (base?.cacheR ?? 0));
  const dCacheW = Math.max(0, end.cacheW - (base?.cacheW ?? 0));
  const dTotal  = Math.max(0, end.total  - (base?.total  ?? 0));
  return {
    inputTokens:     Math.max(0, dInp - dCacheR), // fresh (non-cached) input
    outputTokens:    dOut,
    cacheReadTokens: dCacheR,
    // Reported alongside the three above rather than carved out of `input`, and
    // deliberately not part of the sum that reaches `total`. Codex's own
    // arithmetic — total_tokens === input_tokens + output_tokens, in 171 of 171
    // usage objects measured — puts the written tokens inside `input_tokens`,
    // so subtracting them here would silently shrink the token line this
    // window's only reader prints. Pricing is where the split has to happen and
    // where it does happen (see billedInputTokens); this is a count, and the
    // count is right as it stands.
    cacheCreateTokens: dCacheW,
    totalTokens:     dTotal,
  };
}

// Parse session start time from rollout filename.
// Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
// The timestamp portion uses dashes instead of colons (Windows-safe).
//
// THAT WALL CLOCK IS LOCAL. This used to append a "Z" and hand the result to
// `Date.parse`, which declares it UTC, and every rollout the walk below
// considered was therefore mis-dated by the machine's offset — the whole
// membership test shifted by however far the machine sits from Greenwich
// (#609). Measured against the ten rollouts under `$CODEX_HOME` on this
// machine, TZ=Europe/Chisinau, offset +3: read as UTC the filename sits
// 179.3, 173.4, 178.5, 179.6, 179.7, 180.0, 179.8, 180.0 and 179.9 minutes
// ahead of the first event in its own file; read as local it lands 0.0 to 6.6
// minutes BEFORE it, which is the gap between naming a file and writing the
// first line into it. Ten out of ten, and the sign is the tell — a session
// cannot log an event before it starts.
//
// The tenth file is the one worth spelling out, because it is the reason this
// keys off the name and not the contents. In
// `rollout-2026-08-18T08-00-24-01a0133d-…` the envelope timestamp on line 1 is
// 06:33:07.513Z — 92 minutes AFTER the name, since the session sat idle before
// its first turn — while the `session_meta` payload nested inside that same
// line reads 05:00:24.355Z, which is 08:00:24 local, the filename to the
// second. So the outer timestamp is when the file was first APPENDED TO and
// the name is when the session STARTED; the two differ by as much as the user
// leaves the prompt sitting there.
//
// Reading that inner field would mean opening every rollout in the tree just
// to decide which rollouts to open, which is the one cost this function exists
// to avoid: the module's own measurements put a week at 280 files, and the
// files ruled out by the name are exactly the ones never touched again. It
// would also need an answer for a rollout whose first line is truncated,
// unparseable or simply not there yet — and the only two answers are to open
// it anyway (paying the cost the filter was for) or to drop it (a silent
// undercount, which is the bug being fixed here wearing a different hat). The
// name is on disk, free to read, and by the measurement above it is the more
// accurate of the two.
function parseRolloutTime(filename) {
  // e.g. rollout-2026-06-17T12-39-01-019ed4f2-c821-...jsonl
  const m = filename.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  // Built from parts rather than parsed from a string, so the conversion uses
  // the zone rules in force ON THAT DATE rather than any single offset. An
  // offset is not a constant: America/Los_Angeles is -8 in January and -7 in
  // July, so a fix that subtracted `new Date().getTimezoneOffset()` would be
  // wrong for half the window it filters, twice a year, and wrong by an hour
  // for the whole of it on the days either side of a transition.
  const dt = new Date(y, mo - 1, d, h, mi, s);
  // `Date.parse` used to reject a nonsense date for free; the constructor
  // instead rolls it over (month 13 becomes next January), which would turn a
  // file that is not a rollout at all into one dated in the future — and a
  // future date passes the window test below. Month and day are enough to
  // catch that, and deliberately not the hour: a local time inside a
  // spring-forward gap does not exist, and V8 normalises it to the hour after,
  // which is the right answer and not a rollover. It subsumes the `isNaN` test
  // that used to stand at the end of this function, since an invalid Date
  // answers NaN to `getMonth()` and NaN matches nothing.
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

// List rollout files whose start times fall within the given window.
//
// The walk over $CODEX_HOME/sessions is shared with the two entry points in
// index.mjs (codex-dir.mjs) rather than repeated here, so the files this counts
// usage from are exactly the files the watcher tails. They used to be two
// verbatim copies of the same four nested readdirs over two verbatim copies of
// the same CODEX_SESSIONS_DIR — which is how one of them came to resolve a
// relative CODEX_HOME differently from the other (#375).
async function listRolloutFiles(sinceMs) {
  const out = [];
  const nowMs = Date.now();
  // Years arrive newest-first, so the first one that cannot hold a file in the
  // window ends the walk: everything after it is older still. The extra day of
  // slack covers a session that started just before the window.
  //
  // It used to also claim to cover "a filename timestamp that is UTC while the
  // year directory is local time", which asserted the opposite of what the
  // files say — see parseRolloutTime. Both are local now and `getFullYear()`
  // here is local too, so the two sides of this comparison finally speak the
  // same clock. What the day of slack still earns, beyond the session that
  // started just before the window: an ambiguous local time on the day the
  // clocks go back happens twice, V8 resolves it to the first of the two, and
  // a session started during the second is dated an hour early. That is a
  // one-hour error on one or two days a year against a seven-day window,
  // where the old bug was an offset-wide error on every day of it.
  const oldestYear = new Date(nowMs - sinceMs - 86400000).getFullYear();
  await walkRolloutDays(
    (dir, files) => {
      for (const f of files) {
        // Both spellings. A cold rollout is `rollout-….jsonl.zst` and its name
        // still carries the timestamp parseRolloutTime reads, so nothing else
        // in this function has to know.
        if (!f.endsWith(".jsonl") && !f.endsWith(COMPRESSED)) continue;
        const t = parseRolloutTime(f);
        if (t != null && nowMs - t <= sinceMs) {
          out.push({ path: join(dir, f), startMs: t });
        }
      }
    },
    { onYear: y => (parseInt(y, 10) < oldestYear ? STOP : undefined) },
  );
  return out;
}

function emptyWindow() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, sessionCount: 0 };
}

export function fetchCodexUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return Promise.resolve(_cache);
  // Offered before the floor: a scan that has not finished yet is a reading
  // newer than the cache, which is what refresh asked for, and joining it costs
  // nothing.
  if (_inflight) return _inflight;
  if (!mayScanUsage({ now, lastScanAt: _lastScanAt })) return Promise.resolve(heldReading(now));
  _lastScanAt = now;
  // A bare clear rather than quota.mjs's `_inflight === mine` check: that guard
  // is there because invalidateQuotaCache drops the slot mid-flight, and this
  // module has no invalidator to race with. If one is ever added, it needs the
  // same check adding with it.
  _inflight = scanCodexUsage(now).finally(() => { _inflight = null; });
  return _inflight;
}

async function scanCodexUsage(now) {
  const w5h  = emptyWindow();
  const w7d  = emptyWindow();
  const start5h = now - WINDOW_5H_MS;
  const start7d = now - WINDOW_7D_MS;

  const addTo = (win, d) => {
    if (!d || d.totalTokens <= 0) return;
    win.inputTokens       += d.inputTokens;
    win.outputTokens      += d.outputTokens;
    win.cacheReadTokens   += d.cacheReadTokens;
    win.cacheCreateTokens += d.cacheCreateTokens;
    win.totalTokens       += d.totalTokens;
    win.sessionCount++;
  };

  try {
    // Files whose session *started* within 7d. A long session that started up
    // to 7d ago but is still active is captured here too, and its share of the
    // 5h window is recovered via the cumulative delta below — so bucketing no
    // longer drops active-but-old sessions or over-counts the pre-window tail.
    const files = await listRolloutFiles(WINDOW_7D_MS);

    // Bounded fan-out: a week of rollouts is an open-ended list, and opening
    // every one of them at once also risked EMFILE, which readTokenSeries
    // swallows into a silent undercount.
    await forEachLimited(files, MAX_PARALLEL_READS, async ({ path }) => {
      const series = await readTokenSeries(path);
      if (!series) return;
      // Same series feeds both windows; baseline differs per window start.
      addTo(w5h, windowDelta(series, start5h));
      addTo(w7d, windowDelta(series, start7d));
    });
  } catch (err) {
    console.error(`${PRODUCT} codex-usage: scan failed:`, err?.message ?? err);
    const result = { ok: false, fetchedAt: now };
    _cache = result;
    _cacheAt = now;
    return result;
  }

  const result = { ok: true, window5h: w5h, window7d: w7d, fetchedAt: now };
  _cache = result;
  _cacheAt = now;
  return result;
}
