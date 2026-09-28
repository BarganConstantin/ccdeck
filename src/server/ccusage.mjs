// Fetches historical usage from the `ccusage` CLI (https://github.com/ccusage/ccusage).
// ccusage reads the local ~/.claude (and other agent) logs and reports cost +
// token usage grouped by day.
//
// The copy it runs is usually the deck's own managed install, which
// ccusage-install.mjs builds and keeps current; what is said when a run or an
// install fails is ccusage-failure.mjs's.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { killTree, pathLookup, spawnSpec } from "./exec.mjs";
import { note, stamp, tagged } from "./ccusage-failure.mjs";
import {
  backgroundUpdateDue, discardDamagedInstall, installsDisabled, lastInstallError, maybeBackgroundUpdate,
  resolveEntry, startInstall, touchMarker, winShim,
} from "./ccusage-install.mjs";

// 60s, and it is the panel's poll interval rather than a number of its own: the
// Usage panel asks once a minute and expects a reading that has actually moved,
// so a longer cache would hand the same figure back and make the interval a
// lie. Two tabs polling out of phase still share one run, which is what the
// cache is for here. The modal is manual-open and unaffected either way.
const CACHE_MS = 60_000;
const TIMEOUT_MS = 90_000;

const _cache = new Map(); // key `${since}|${until}` → { result, at }

// How much a read is allowed to cost. /api/ccusage is a GET, deliberately: a
// cross-site read of the loopback port is an ordinary top-level navigation and
// isTrustedRead is right not to refuse it. What was missing is a ceiling on
// what one of those reads may start. Before #544, thirty distinct `since`
// values were thirty concurrent `node <PKG_DIR>/src/cli.js daily --json`
// children — each with a ninety-second deadline, each walking the whole
// ~/.claude log tree, doubled again whenever runDaily retried flagless — and
// thirty permanent Map entries. isCliDate admits all 10^8 eight-digit strings
// on purpose (a date outside the logs is ccusage's question to answer, not the
// deck's to guess at), so the map's key space was 10^8 and its eviction policy
// was none.
//
// Both numbers are set against what the feature does rather than against the
// attack. The usage-history modal asks for one range at a time and offers three
// presets, so four ranges outstanding at once is already more than a human
// clicking as fast as they can, and thirty-two remembered ranges is more than
// one sitting will ever look at. Whatever exceeds either is not a reader.
const CACHE_MAX = 32;
const MAX_OUTSTANDING = 4;

/** Ranges being fetched right now, keyed exactly as `_cache` is, so two callers
 *  asking the same question wait on one child instead of starting a second. The
 *  cache alone could never do this: it is written when a run finishes, and the
 *  whole window this is about is the ninety seconds before that. */
const _inflight = new Map();

/** The tail of the run queue, and how many runs are alive behind it.
 *
 *  Serialised rather than merely counted, because two ccusage runs are two
 *  walks of the same directory tree: running them at once is slower than
 *  running them in sequence, so the queue costs a concurrent caller nothing it
 *  was actually going to get. What it buys is that a flood is one child at a
 *  time rather than a child per request. */
let _chain = Promise.resolve();
let _outstanding = 0;

/** Run `job` after every run already queued, whatever became of them — a run
 *  that threw must not take the queue down with it. */
function queued(job) {
  _outstanding += 1;
  const started = _chain.then(job, job);
  _chain = started.then(() => {}, () => {});
  return started.finally(() => { _outstanding -= 1; });
}

/**
 * Remember one range's answer, and keep the map from being somewhere a caller
 * can grow without limit.
 *
 * Entries past CACHE_MS can never be served again, so they are the ones to drop
 * first; only when dropping all of them is still not enough does the oldest
 * surviving entry go, which Map's insertion order hands over for free.
 * Re-writing a key moves it to the back, so the range someone is actually
 * polling is the last one evicted rather than the first.
 */
function rememberRange(key, result, at) {
  _cache.delete(key);
  _cache.set(key, { result, at });
  if (_cache.size <= CACHE_MAX) return;
  for (const [k, v] of _cache) {
    if (_cache.size <= CACHE_MAX) break;
    if (at - v.at >= CACHE_MS) _cache.delete(k);
  }
  for (const k of _cache.keys()) {
    if (_cache.size <= CACHE_MAX) break;
    _cache.delete(k);
  }
}

// npx is the same kind of shim as npm, and the fallback run needs the same
// treatment for a second, sharper reason: its argument vector carries a
// user-supplied `--since`. `shell: true` handed `[file, ...args].join(" ")` to
// /bin/sh -c, so `GET /api/ccusage?since=1;id;` ran `id` — and because that
// route is a GET, any page open in the user's browser could aim it at the
// loopback port with no CORS, no preflight and no need to read the answer.
// spawnSpec quotes each argument into the cmd.exe line on Windows and spawns
// the vector untouched everywhere else, so nothing in it is ever parsed as
// syntax. Naming the file `npx.cmd` on Windows is what makes that work: only a
// .cmd/.bat file routes through cmd.exe, and a bare `npx` there is not a file
// spawn can launch at all (PATHEXT is a shell's job), so asking for the
// extensionless name would trade a shell injection for an ENOENT. What it must
// NOT be is the bare `npx.cmd` this said until #456 — see winShim.
function npxSpec(args, platform = process.platform, deps) {
  return spawnSpec(platform === "win32" ? winShim("npx.cmd", deps) : "npx", args, platform);
}

/**
 * What `spawn` gets for the portable `npx -y ccusage@latest <args>` fallback.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about.
 */
export const fallbackSpec = (args = [], platform = process.platform, deps) =>
  npxSpec(["-y", "ccusage@latest", ...args], platform, deps);

// ── the user's own copy ─────────────────────────────────────────────────────

/**
 * A ccusage the USER put somewhere, either by naming it outright or by having
 * it on PATH — or null when there is no such thing.
 *
 * This is #433, and the case for it is not that a PATH search is nice to have.
 * The deck has been telling people "put ccusage on PATH yourself" in
 * admin-failure.ts for as long as that sentence has existed, and nothing
 * anywhere ever looked: a user who did exactly what they were told, and could
 * prove it with `ccusage --version` in their own shell, got the identical
 * failure on the next click. Two ways out of that, and the other one is to
 * delete the promise. It is kept because there is a configuration that needs it
 * and has no other:
 *
 *   - `AGENTS_DECK_NO_INSTALL=1` is documented as "never install or update
 *     claude-swap / ccusage". Someone who sets it AND installs ccusage
 *     themselves has done the only thing that flag can sensibly mean, and until
 *     now the deck answered "ccusage is not installed" while it was installed
 *     and on their PATH. There was NO combination of settings that made a
 *     self-managed ccusage work.
 *   - The #432 machine — npm and npx both unusable on disk — cannot create the
 *     managed install and cannot run the npx fallback. A copy the user already
 *     has is the only route left, and it was the one route the deck refused to
 *     look down.
 *
 * The override wins over PATH the way AGENTS_DECK_CSWAP does over cswap's own
 * search, and is never remembered, because somebody debugging a bad resolution
 * needs a change to it to take effect on the next click rather than the next
 * restart. Nothing here is cached for the same reason, and it is affordable:
 * a lookup is a handful of stats, once per uncached fetch, against a process
 * spawn that follows it.
 *
 * `platform` and `deps` are parameters, and this is exported, for the reason
 * every other Windows answer in this module is: the PATHEXT walk and the
 * `.cmd` spelling have to be checkable from a machine that cannot run Windows.
 */
export function userCcusage(platform = process.platform, deps, env = process.env) {
  const named = env.AGENTS_DECK_CCUSAGE;
  if (named) {
    // A path the user typed is used as typed — pathLookup would refuse it
    // anyway, since re-rooting a name that carries a directory is a way to run
    // something other than what was asked for. Whether it EXISTS is the
    // caller's question, because "the path you gave me is not there" is a
    // different sentence from "you have no ccusage".
    return { file: String(named), named: true };
  }
  const found = pathLookup("ccusage", platform, deps);
  return found ? { file: found, named: false } : null;
}

/** Does the file an explicit override names actually exist? Split out so the
 *  existence check is injectable alongside the lookup above. */
const overrideIsThere = (file, { exists = existsSync } = {}) => {
  try {
    return exists(file);
  } catch {
    return false;
  }
};

// Ensure a runnable ccusage. Returns { kind:"node", entry } for the managed
// install, { kind:"path", file } for a copy the user provided, or { kind:"npx" }
// as the portable fallback.
//
// The order is the whole design decision, so it is stated rather than implied.
//
// An explicit AGENTS_DECK_CCUSAGE is first and is never fallen through: a user
// who pointed the deck at a file and got silently ignored has been given a
// setting that does nothing, which is worse than not having one. If it does not
// resolve, the failure names THAT — "npx is not on this deck's PATH" would be
// both true and completely beside the point.
//
// The managed install then comes BEFORE the PATH copy, which is the opposite of
// what #433 proposed, and deliberately. Preferring PATH would silently change
// which ccusage runs on every machine that already has both — a deck that works
// today would start running a copy it has never run, and an old global ccusage
// without `daily --json` would turn a working panel into a broken one for no
// reason the user asked for. The PATH copy is an ESCAPE ROUTE, and it wants to
// be reached exactly when the managed install is not there; someone who wants
// their own copy to win over the deck's says so with AGENTS_DECK_CCUSAGE, which
// is unambiguous in a way a precedence rule never is.
//
// PATH comes before INSTALLING, though. Downloading a second copy of a tool
// that is already on the machine is not something to do to somebody, and it is
// what makes the order identical with and without AGENTS_DECK_NO_INSTALL=1 —
// that flag now removes a step rather than changing the sequence.
async function getRunner() {
  const mine = userCcusage();
  if (mine?.named) {
    if (!overrideIsThere(mine.file)) {
      throw tagged("bad_override",
        `AGENTS_DECK_CCUSAGE points at ${mine.file}, and there is no such file`);
    }
    return { kind: "path", file: mine.file, named: true };
  }
  let resolved = resolveEntry();
  if (resolved) {
    maybeBackgroundUpdate(resolved.version);
    return { kind: "node", entry: resolved.entry };
  }
  if (mine) return { kind: "path", file: mine.file, named: false };
  // Nothing installed, nothing of the user's to run, and installs are
  // forbidden. The npx fallback is not an escape hatch — `npx -y ccusage@latest`
  // downloads and runs the same package — so there is no runner to hand back.
  // Fail with the reason, which the usage-history modal shows, instead of
  // quietly installing.
  if (installsDisabled()) {
    throw tagged("no_install", "ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)");
  }
  // Cold: install once (deduped across concurrent callers).
  await startInstall("latest");
  resolved = resolveEntry();
  if (resolved) { touchMarker(); return { kind: "node", entry: resolved.entry }; }
  // npm unavailable / offline → fall back to npx, carrying WHY the managed
  // install is not here. Without that the modal can only describe the fallback,
  // and the fallback is the second thing that failed.
  return { kind: "npx", installError: lastInstallError() };
}

// ── invocation ──────────────────────────────────────────────────────────────

/**
 * What `spawn` gets for a ccusage the user provided.
 *
 * `file` is always an absolute path by the time it reaches here — pathLookup
 * resolves the directory and an override is a path the user typed — and that is
 * load-bearing rather than tidy. On Windows the thing on PATH is `ccusage.cmd`,
 * a batch file, so spawnSpec routes it through cmd.exe; a batch file launched
 * by BARE name computes `%~dp0` from the deck's working directory and goes
 * looking for its payload there, which is #456 exactly. Resolving first and
 * quoting second is the same order the npm and npx shims go through.
 *
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS.
 */
export const userSpec = (file, args = [], platform = process.platform) =>
  spawnSpec(file, args, platform);

/**
 * The platform binary ccusage's own cli.js would run, resolved the way cli.js
 * resolves it (`@ccusage/ccusage-<platform>-<arch>/bin/ccusage[.exe]`, from
 * the package's own directory), or null when there is none.
 *
 * WINDOWS ONLY, and for one reason: cli.js starts that binary WITHOUT hiding
 * its console. The deck runs with no console of its own (detached, or inside
 * the desktop app), so the binary is given a new one — and with Windows
 * Terminal as the default terminal that is a window flashing up on every
 * usage read, measured on a Windows 10 box as a CASCADIA_HOSTING_WINDOW_CLASS
 * hosting ccusage. Running the binary directly, with windowsHide, is what
 * cli.js does minus the window. Elsewhere nothing flashes, and the wrapper
 * stays in the path it has always been in.
 *
 * Exported for tests; `resolve` is injectable.
 */
export function nativeCcusage(entry, platform = process.platform, arch = process.arch, resolve = null) {
  if (platform !== "win32" || typeof entry !== "string" || !entry) return null;
  const pkg = arch === "arm64" ? "@ccusage/ccusage-win32-arm64" : arch === "x64" ? "@ccusage/ccusage-win32-x64" : null;
  if (!pkg) return null;
  try {
    const req = resolve ?? createRequire(entry).resolve;
    return req(`${pkg}/bin/ccusage.exe`);
  } catch {
    return null;
  }
}

// One attempt with one runner. No branch gets a shell. The managed install is
// `node <entry> …`, which never needed one; the user's own copy and the npx
// fallback are routed through spawnSpec instead — see npxSpec and userSpec, and
// note that `args` here ends in whatever /api/ccusage was asked for.
function runOnce(runner, args) {
  const native = runner.kind === "node" ? nativeCcusage(runner.entry) : null;
  const { file, args: full, opts } = native
    ? { file: native, args, opts: {} }
    : runner.kind === "node"
    ? { file: process.execPath, args: [runner.entry, ...args], opts: {} }
    : runner.kind === "path"
      ? userSpec(runner.file, args)
      : fallbackSpec(args);
  return new Promise((resolve, reject) => {
    const child = spawn(file, full, { windowsHide: true, ...opts });
    let out = "", err = "";
    const timer = setTimeout(() => {
      // The npx fallback goes through cmd.exe on Windows, so `child` is the
      // wrapper there and npx is a grandchild that a plain kill would leave
      // downloading.
      killTree(child);
      reject(tagged("timeout", "ccusage timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `ccusage exited ${code}`));
    });
  });
}

// Run ccusage with the given args, resolve raw stdout AND the runner that
// produced it. One retry, and only for the one failure that is otherwise
// permanent — see discardDamagedInstall. The second getRunner() is what rebuilds
// the install, or falls through to npx when npm cannot.
//
// The runner comes back with the output because the caller has to say which
// path answered: `extractJson` below can fail on a run that started perfectly
// well, and "ccusage ran but printed no usage data" reads differently depending
// on which ccusage that was.
async function runCcusage(args) {
  const runner = await getRunner();
  try {
    return { out: await runOnce(runner, args), runner };
  } catch (err) {
    if (!discardDamagedInstall(runner, err)) throw stamp(err, runner);
    note("managed install was unusable, rebuilding it", err);
    const rebuilt = await getRunner();
    try {
      return { out: await runOnce(rebuilt, args), runner: rebuilt };
    } catch (again) {
      throw stamp(again, rebuilt);
    }
  }
}

// ── the per-agent split ─────────────────────────────────────────────────────

/**
 * The flag that stops ccusage merging every CLI it read into one row.
 *
 * ccusage groups by day and, by default, adds Claude Code's spend to Codex's —
 * and to OpenCode's, Amp's, Gemini CLI's and the dozen other sources it now
 * reads — before it prints anything. The deck then drew that single number under
 * a subtitle naming two CLIs, so "how much of this is Codex?" had no answer
 * anywhere on the panel (#431).
 *
 * Measured against ccusage 20.0.20 rather than read off its README, because the
 * whole reason to send this is what comes back. Two runs over the same range,
 * with and without it, differ in exactly one way: each day gains an `agents`
 * array, one entry per CLI, carrying that CLI's own `totalCost`, token counts
 * and `modelBreakdowns`. Every key the parser below already reads survives byte
 * for byte, the day's `totalCost` is unchanged and still equals the sum of its
 * agents, the day count is the same and `totals` is untouched. The flag is
 * purely additive, which is what makes it safe to send unconditionally: the
 * merged view the deck has always drawn stays available for free, and a browser
 * that ignores `agents` sees the reply it has always seen.
 */
const BY_AGENT = "--by-agent";

/**
 * A ccusage on this machine that does not know `--by-agent`, remembered.
 *
 * The npx fallback resolves `ccusage@latest` and so is never the stale case,
 * but a managed install that has not had its once-a-day update yet can be, and
 * a copy the user put on PATH themselves can be any age at all. Process-scoped,
 * like ccusage-install.mjs's `_checkedThisRun` and `_repairedThisRun`: a deck restarted after
 * upgrading ccusage asks again.
 */
let _byAgentUnsupported = false;

/**
 * A failure that is about this flag rather than about this machine.
 *
 * Every argument parser that rejects an unknown option quotes the option back —
 * "Unknown option '--by-agent'", "unrecognized option --by-agent", "unexpected
 * argument '--by-agent' found", "Unknown argument: by-agent" — so the flag's own
 * name is the one token they all agree on, and matching it needs no table of
 * parsers or versions. The dashes are deliberately not part of the match, since
 * one of those spellings drops them.
 *
 * This decides only whether to REMEMBER, never whether to retry: a run that
 * failed for its own reasons and then happened to succeed on the second attempt
 * must not leave the deck convinced, for the rest of the process, that this
 * ccusage cannot report a split it can report perfectly well.
 */
const blamesByAgent = (text) => /by-agent/i.test(String(text ?? ""));

/**
 * BOTH REPORTS FROM ONE LOAD.
 *
 * `daily` answers "what did this range cost" and `session` answers "which
 * session spent it". They used to be two commands and therefore two children —
 * two npx resolutions, two Node starts, and two full walks of every transcript
 * on the machine for the same set of files.
 *
 * `--sections` is ccusage's own answer to that: one load, several report
 * sections in one JSON object. Measured against this machine's logs, asking for
 * `daily,session` returns exactly what the two runs returned — `daily` (with
 * its `agents` split when `--by-agent` rides along), `session`, and one
 * `totals` — so the deck reads the same fields off one child.
 *
 * Not on `session` alone: the panel's totals and its per-model split come from
 * `daily`, so `daily` is the command and the sessions are the extra section.
 */
const SECTIONS = ["--sections", "daily,session"];
const blamesSections = (text) => /sections/i.test(String(text ?? ""));

/**
 * A ccusage too old for `--sections`, remembered for the life of the process —
 * the same narrow memory `_byAgentUnsupported` keeps, for the same reason: the
 * retry costs one process on a machine that is already failing, and the memory
 * costs the extra section for as long as the deck runs.
 */
let _sectionsUnsupported = false;

/**
 * Run `daily` for a range, asking for the per-agent split, and give up the
 * split rather than the whole answer when this ccusage will not produce one.
 *
 * Retrying is chosen over gating on `resolveEntry().version`, which the module
 * already has in hand, for one reason: a version table only knows about the
 * ccusage versions that existed when it was written, and two of the three
 * runners here are copies the deck did not install and cannot date — an
 * AGENTS_DECK_CCUSAGE override and whatever is on PATH. Retrying degrades
 * correctly for ANY unknown ccusage rather than only for old ones.
 *
 * The retry is narrow, because a second attempt is a second process and on a
 * genuinely broken machine that is a second wait. It fires only when the CLI
 * itself failed — an untagged error, which is this module's word for "the child
 * exited non-zero, or never started" — and never for the four failures that are
 * already understood: `timeout` (where a retry would cost another 90 seconds
 * for nothing), `no_install` and `bad_override` (thrown before any process
 * runs), and `bad_output` (thrown after a run that ccusage considered a
 * success, so the flag was accepted). An old ccusage lands squarely in the
 * untagged case: measured, it exits 2 with an empty stdout and
 * `Unknown option '--by-agent'` on stderr, which is unambiguous — it cannot be
 * confused with a successful run that happened to have no data.
 *
 * When the retry ALSO fails, its failure is the one that travels, not the first
 * one. Both runs failed, and the one without the deck's flag on it is the
 * honest account of this machine: reporting the first would blame a flag that
 * has just been shown to make no difference. Nothing is remembered in that case
 * either, so the split is asked for again on the next attempt.
 *
 * The retry is therefore broad and the MEMORY of it is narrow — see
 * blamesByAgent. Those are different questions with different costs: guessing
 * wrong about whether to retry costs one process on a machine that is already
 * failing, and guessing wrong about whether to remember costs the split for the
 * life of the deck.
 */
async function runDaily(args) {
  if (_byAgentUnsupported) return runCcusage(args);
  try {
    return await runCcusage([...args, BY_AGENT]);
  } catch (err) {
    if (err?.reason !== undefined) throw err;
    const plain = await runCcusage(args);
    if (blamesByAgent(err?.message)) _byAgentUnsupported = true;
    return plain;
  }
}

// ccusage prints the JSON object somewhere in stdout; slice first { to last }.
function extractJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) throw tagged("bad_output", "no JSON in ccusage output");
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch (err) {
    // A ccusage that printed a progress line containing braces, or was cut off
    // mid-object, lands here rather than on the branch above. Same failure to
    // the reader either way: it ran, and what came back was not usage data.
    throw tagged("bad_output", `unreadable ccusage output: ${err?.message ?? err}`);
  }
}

/**
 * The default window's first day, as the `YYYYMMDD` ccusage's `--since` takes:
 * the LOCAL calendar date `days` before `now`.
 *
 * ccusage buckets its rows by local calendar date — usage-range.ts's
 * presetSince states it, and does the page's half of this correctly. This read
 * `new Date(now - 30 * 86400_000).toISOString()`, the UTC date, and the two
 * disagree for part of every day: at 08:30 in Tokyo it asked for
 * `--since 20260815` when the local date thirty days back is 20260816, and at
 * 20:30 in Los Angeles it ran a day the other way (#994). The same shape as
 * presetSince, deliberately: the local calendar fields of `now` fix the
 * endpoint and the subtraction runs in UTC, where every day is exactly 24h, so
 * no daylight-saving change inside the window can move the result by a day.
 * Exported for its test, which hands it a `now` whose calendar fields belong
 * to a named zone, since Node does not honour a `TZ` changed mid-process.
 */
export function defaultCcusageSince(now = new Date(), days = 30) {
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - days));
  return start.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch daily usage from ccusage for a date range.
 * @param {{ since?: string, until?: string, force?: boolean }} opts
 *        since/until are YYYYMMDD strings (CLI format). Defaults to last 30 days.
 * @returns {{ ok, days, totals, since, until, fetchedAt } | { ok:false, reason, error }}
 */
export async function fetchCcusageDaily({ since, until, force = false } = {}) {
  const now = Date.now();
  const sinceArg = since || defaultCcusageSince(new Date(now));
  const key = `${sinceArg}|${until ?? ""}`;

  const cached = _cache.get(key);
  if (!force && cached && now - cached.at < CACHE_MS) return cached.result;

  // A run for this exact range is already going: join it. `force` joins too,
  // rather than starting a competing child — what ?refresh=1 asks for is a
  // reading newer than the cache, and a run still in progress is one.
  const already = _inflight.get(key);
  if (already) return already;

  // Refused here, before anything is spawned or remembered. The caller that
  // reaches this is the fifth distinct range in flight at once, which the modal
  // cannot produce; queueing it would mean holding a request open behind up to
  // four ninety-second deadlines, which is a worse answer than saying no.
  if (_outstanding >= MAX_OUTSTANDING) {
    return {
      ok: false,
      reason: "busy",
      error: `${MAX_OUTSTANDING} usage ranges are already being read \u2014 try again in a moment`,
      fetchedAt: now,
    };
  }

  const run = queued(() => readRange(sinceArg, until, key))
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, run);
  return run;
}

/**
 * One ccusage run, once the queue has let it through.
 *
 * `now` is read here rather than carried in from the call, so `fetchedAt` and
 * the cache stamp both mean "when this reading was taken" even for a run that
 * waited its turn. With an empty queue that is the same instant the caller
 * asked, which is what this always did.
 */
/**
 * The same range, grouped by session rather than by day.
 *
 * Returns `[]` for every failure, including a ccusage too old to have the
 * subcommand. The panel's totals and its per-model split come from `daily`, and
 * losing the session names must not lose those — an empty list draws one
 * section short, which is the same thing that happens on a machine with no
 * ccusage at all and is already a state the panel knows.
 *
 * WHAT `period` IS HERE, and it is the whole reason this is worth a second
 * child: on a session row ccusage puts the SESSION ID in `period` — the same
 * uuid Claude Code writes into every hook payload, and therefore the same key
 * the canvas already files its agents under. So these rows join to the board by
 * id, which is what lets the panel show ccusage's money against the deck's own
 * project names. Without that join a session row is a uuid and a number.
 */
async function readSessions(sinceArg, until) {
  try {
    const args = ["session", "--json", "--since", sinceArg];
    if (until) args.push("--until", until);
    const ran = await runCcusage(args);
    const raw = extractJson(ran.out);
    // `session`, singular — ccusage names the array after the command, not
    // after its contents, and `sessions` reads as the obvious guess and is
    // always undefined.
    return Array.isArray(raw.session) ? raw.session : [];
  } catch (err) {
    note("session read failed", err);
    return [];
  }
}

async function readRange(sinceArg, until, key) {
  const now = Date.now();
  let result;
  let ran = null; // the runner that answered, for stamping a bad_output failure
  try {
    const args = ["daily", "--json", "--since", sinceArg];
    if (until) args.push("--until", until);
    let raw;
    if (_sectionsUnsupported) {
      ran = await runDaily(args);
      raw = extractJson(ran.out);
    } else {
      try {
        ran = await runDaily([...args, ...SECTIONS]);
        raw = extractJson(ran.out);
      } catch (err) {
        // A ccusage that could not run at all fails the same way with or
        // without the flag, so only a complaint naming the flag is worth a
        // second child — and `reason` set means the run never started, which is
        // not something a flag can fix.
        if (err?.reason !== undefined || !blamesSections(err?.message)) throw err;
        _sectionsUnsupported = true;
        ran = await runDaily(args);
        raw = extractJson(ran.out);
      }
    }
    // Already here on any ccusage that knows `--sections`: one load answered
    // both questions. The second child is the fallback for the older ones, and
    // it stays deliberately after the first rather than beside it — a failure
    // to name the sessions must not cost the totals, which are what the panel
    // is mostly for, and two ccusage processes at once on a cold machine is the
    // shape #476 spent a release removing from the boot path.
    // The second child belongs to the OLD ccusage and to nothing else. A build
    // that took `--sections` answered with the section — empty for a range with
    // no sessions in it — so a missing `session` key there means this deck
    // asked for something that build does not report, and asking again as a
    // separate command would get the same silence for the price of a second
    // walk of every transcript on the machine.
    const sessions = Array.isArray(raw.session)
      ? raw.session
      : (_sectionsUnsupported ? await readSessions(sinceArg, until) : []);
    // Passed through whole, `agents` array and all. Every day ccusage returns
    // under `--by-agent` is a superset of the day it returns without one, so
    // there is nothing here to reshape: the browser reads the merged totals it
    // always read, and reads the split when it is there. A run that fell back
    // to the flagless form simply carries days with no `agents`, which the
    // usage-history modal treats the same way it treats a range with one CLI in
    // it — no split, and no new chrome.
    const days = Array.isArray(raw.daily) ? raw.daily : [];
    result = {
      ok: true,
      days,
      sessions,
      totals: raw.totals ?? null,
      since: sinceArg,
      until: until ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    // `extractJson` throws about a run that started fine, so it arrives here
    // knowing nothing about which ccusage it read. The runner does.
    if (ran) stamp(err, ran.runner);
    // Naming the path in the terminal too. "fetch failed" alone was true of
    // both, and an operator reading a boot report has the same question the
    // modal's reader has: which of the two.
    note(err?.stage === "managed" ? "fetch failed (managed install)"
      : err?.stage === "npx" ? "fetch failed (npx fallback)"
        : "fetch failed", err);
    // Anything untagged got here from the child itself — a non-zero exit, or a
    // spawn that never started one — which is exactly what run_failed means.
    // `error` keeps the child's WHOLE output, stack trace and all: it is the
    // modal's hover title, which is where the raw bytes are meant to live, and
    // it is what somebody pastes into an issue. Only the terminal gets a line.
    //
    // `stage` and `install` are the halves that used to be lost. They are what
    // let the modal say WHICH path failed and why, on screen, instead of
    // guessing it from the shape of a stack trace — the guess that shipped two
    // wrong diagnoses in a row (#432, #450). `bin` joined them for #433: with a
    // third path, "your own copy failed" is only half an answer until it names
    // which file that was. Undefined when nothing ran, and JSON.stringify drops
    // them, so an older browser sees the reply it expects.
    result = {
      ok: false,
      reason: err?.reason ?? "run_failed",
      stage: err?.stage,
      install: err?.install,
      bin: err?.bin,
      error: String(err?.message ?? err),
      fetchedAt: now,
    };
  }

  rememberRange(key, result, now);
  return result;
}

/**
 * Get ccusage ready at startup instead of on first use.
 *
 * The lazy path is fine for correctness but means the first person to open the
 * usage-history modal on a fresh machine waits out an npm install with no
 * explanation. Called from the CLI so that cost is paid while the deck is
 * still booting.
 *
 * Returns { state: "present" | "user" | "installing" | "updating" |
 * "unavailable" }. Never throws and never blocks on the install itself — a slow
 * registry must not hold up the server. That second half was a claim rather
 * than a fact until #476: `startInstall` wrapped a `spawnSync` in an async IIFE
 * with nothing to await in it, so `{ state: "installing" }` was returned only
 * after the install had already happened, on this stack.
 *
 * The order here is getRunner's order, and it has to be: a boot that installs a
 * managed copy while the user already has one on PATH would make getRunner's
 * "PATH before installing" true only until the first restart, and would spend a
 * download saying so. `user` is reported without a version because finding one
 * means RUNNING the thing, and the boot is not the place to spawn a process to
 * fill in a status row.
 */
export function primeCcusage() {
  const mine = userCcusage();
  // An override that names a file which is not there is not reported here at
  // all: the boot has nothing useful to say about it and getRunner will say it
  // properly, with the path, the first time the modal is opened.
  if (mine && (!mine.named || overrideIsThere(mine.file))) {
    const resolved = resolveEntry();
    // The managed install still wins when it exists — see getRunner — so an
    // existing deck's boot row does not change.
    if (mine.named || !resolved) return { state: "user", bin: mine.file };
  }
  // The CLI already skips this call under AGENTS_DECK_NO_INSTALL=1; repeating
  // the check here keeps the promise a property of the module rather than of
  // one caller.
  if (installsDisabled()) {
    const have = resolveEntry();
    return have ? { state: "present", version: have.version } : { state: "unavailable" };
  }
  const resolved = resolveEntry();
  if (resolved) {
    // Already installed: the daily check may still queue a background upgrade.
    const due = backgroundUpdateDue();
    maybeBackgroundUpdate(resolved.version);
    return { state: due ? "updating" : "present", version: resolved.version };
  }
  startInstall("latest");
  return { state: "installing" };
}
