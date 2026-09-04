// Claude rate-limit quota, from whichever source costs least.
//
// All three sources below end at the same place: GET /api/oauth/usage, which
// Anthropic budgets at roughly 28-30 calls per rolling hour PER TOKEN, shared
// by every tool on the machine. That budget is the constraint this module is
// built around, because it was being blown by this module: a 60s poll is 60
// calls an hour on its own, and the account the deck was polling started
// answering http-429 to claude-swap, whose collections the accounts panel is
// entirely made of. One panel went stale so the other could be a minute
// fresher.
//
//   1. claude-swap's store — free. It polls the active account on its own
//      schedule and writes what it got; reading that file costs nothing and
//      spends none of the budget. Used whenever it holds a recent enough row.
//   2. The OAuth usage API directly, with the token from
//      .credentials.json inside the Claude config dir — $CLAUDE_CONFIG_DIR when
//      it is set, ~/.claude otherwise. Exact and instant. Mechanism
//      reverse-engineered from steipete/CodexBar.
//   3. `claude --print /usage`, parsed. Used when there is no readable token —
//      notably on macOS, where Claude Code keeps credentials in the Keychain
//      and that file does not exist, so this is the ONLY self-service path
//      there. It is also the most expensive: a whole Claude Code process per
//      poll. On Windows the binary may be a .cmd wrapper, which spawn cannot
//      launch directly — exec.mjs's `run` routes that case through cmd.exe with
//      the argument vector intact, so no shell ever parses a path this module
//      read out of the environment.
//
// 2 and 3 are rate-floored (SELF_POLL_MS) and gated behind the same 429
// cooldown; 1 is not, because it is a local file read.
import { activeAccountUsage, requestCollection } from "./claude-accounts.mjs";
import { claudeCliCandidates, claudeConfigDir } from "./claude-dir.mjs";
import { pathLookup, run } from "./exec.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { PRODUCT } from "./brand.mjs";
import { resetLabelIso } from "./reset-label.mjs";

const USAGE_URL   = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const WIN_5H_SEC  = 18000;
const WIN_7D_SEC  = 604800;

// 429 cooldown gate — after a rate-limit, skip the API until this passes.
let _rateLimitedUntil = 0;

/**
 * Where Claude Code keeps the OAuth credentials this module borrows a token
 * from.
 *
 * It is `.credentials.json` inside the Claude config dir, and that dir moves:
 * CLAUDE_CONFIG_DIR replaces ~/.claude wholesale rather than overlaying it, so
 * on a machine where it is set there is no ~/.claude to read at all. Hardcoding
 * ~/.claude here did not fail loudly — it made readOAuthToken() return null
 * forever, which reads exactly like "this machine keeps its credentials in the
 * Keychain", and the quota chain quietly fell through to source 3 on every poll
 * it was allowed to make. See src/server/claude-dir.mjs, which owns the rule
 * and is the only place it is spelled.
 *
 * Resolved per call rather than frozen into a module-level constant, for the
 * same reason claudeConfigDir() is a function: a constant captured at import
 * time is a value nothing can observe or correct afterwards, and this module is
 * imported lazily by the /api/quota route rather than at a point in startup
 * anyone here controls.
 *
 * Exported for tests — it is the whole of the bug, and it is pure.
 */
export function credentialsPath() {
  return join(claudeConfigDir(), ".credentials.json");
}

async function readOAuthToken() {
  try {
    const raw  = await readFile(credentialsPath(), "utf8");
    const auth = JSON.parse(raw)?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    // expiresAt is epoch milliseconds. If expired, the CLI fallback handles it.
    if (auth.expiresAt && Date.now() >= auth.expiresAt) return null;
    return auth.accessToken;
  } catch {
    return null;
  }
}

/**
 * WHETHER THIS MACHINE HAS A SUBSCRIPTION TO REPORT ON AT ALL.
 *
 * Every source here needs a Claude.ai OAuth credential: the claude-swap store
 * holds one, `claudeAiOauth` in the credentials file is one, and
 * `claude --print /usage` prints windows only for a session signed in with one.
 * An API-key, Bedrock or Vertex install has none — and there is no quota to
 * read, because those are billed per token rather than in five-hour windows.
 *
 * That mattered because of what the CLI does on such a machine: it RUNS, prints
 * no quota lines, and the branch below used to read that as "genuine <1%" and
 * publish `ok: true` with two zeroes. The panel then drew empty bars, which is
 * a measurement nobody took. Codex already answers this properly, with
 * `api_key_mode` as its own reason and its own sentence.
 *
 * Cheap and synchronous: environment first, because a machine configured for
 * Bedrock or Vertex says so there, then the presence of the OAuth block in the
 * credentials file. `readOAuthToken` above answers a different question — it
 * also rejects an EXPIRED token, and an expired subscription is still a
 * subscription.
 */
export async function hasSubscriptionCredential(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1") return false;
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    if (JSON.parse(raw)?.claudeAiOauth?.accessToken) return true;
  } catch { /* absent or unreadable, decided below */ }
  // A key in the environment and no OAuth block beside it is the API-key
  // install. Without either, this deck simply has not been signed in yet, and
  // "sign in" is the right thing to say — which is the `waiting` branch, not
  // this one.
  return !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

// ISO-8601 → "Jun 19, 1:19pm" (local time, matching the CLI display format).
//
// The body moved to reset-label.mjs in #374: codex-quota.mjs had a copy that
// claimed in its own comment to match this one and did not, so the Codex lanes
// and the Claude lanes printed the same instant two different ways in the same
// panel. This rendering is the one both surfaces use now. The alias stays so
// the four call sites below read the way they always have.
const fmtResetIso = resetLabelIso;

function isoToSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// Map the OAuth usage JSON to our quota result shape.
// utilization is already a 0–100 percentage. 5h falls back to 7d if absent.
function mapOAuthUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const son = data?.seven_day_sonnet;
  const opus = data?.seven_day_opus;

  const primary = (fh?.utilization != null) ? fh : sd;
  if (!primary || primary.utilization == null) return null;

  const round = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const result = {
    session5hPct:       round(primary.utilization),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
  };
  if (sd?.utilization != null) {
    result.week7dPct     = round(sd.utilization);
    result.week7dReset   = fmtResetIso(sd.resets_at);
    result.week7dResetAt = isoToSec(sd.resets_at);
  } else {
    result.week7dPct = 0;
  }
  if (son?.utilization != null)  result.weekSonnetPct = round(son.utilization);
  if (opus?.utilization != null) result.weekOpusPct   = round(opus.utilization);

  // extra usage credits (pay-as-you-go top-up), if enabled
  const extra = data?.extra_usage;
  if (extra?.is_enabled) {
    result.extraEnabled = true;
    if (extra.used_credits != null)  result.extraUsedCredits  = extra.used_credits;
    if (extra.monthly_limit != null) result.extraMonthlyLimit = extra.monthly_limit;
    if (extra.currency)              result.extraCurrency     = extra.currency;
  }
  return result;
}

async function fetchOAuthUsage() {
  if (Date.now() < _rateLimitedUntil) return null;
  const token = await readOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "User-Agent":     "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const cooldownMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5 * 60_000;
      _rateLimitedUntil = Date.now() + cooldownMs;
      return null;
    }
    if (!res.ok) return null;

    return mapOAuthUsage(await res.json());
  } catch {
    return null;
  }
}

let _cache    = null;
let _cacheAt  = 0;
let _inflight = null;   // deduplicates concurrent CLI probes
let _lastGood = null;   // last result that had real quota percentages
let _lastSelfPollAt = 0;
// Which account the readings below are about — as a counter, because the
// account's identity is not something this module holds. invalidateQuotaCache
// bumps it; every write in _doFetch is stamped with the value that was current
// when that read STARTED. See publish().
let _generation = 0;

const CACHE_MS = 60_000;

// Floor between two polls WE pay for. Twelve an hour against a budget of
// ~28-30 leaves claude-swap room to collect for every account, which is what
// the accounts panel is made of. Only reached when the store cannot answer.
const SELF_POLL_MS = 5 * 60_000;

// The refresh button may beat that floor, but not turn into a poll loop when
// held down. It never beats the 429 cooldown.
const FORCE_POLL_MS = 60_000;

// How old a claude-swap row may be before we stop treating it as the answer.
// Its own default poll interval is 1800s, so a row older than this means its
// collector is backing off or not running — the case self-polling exists for.
const STORE_TRUSTED_MS = 45 * 60_000;

/**
 * claude-swap's row for the active account, in the shape the panel speaks.
 *
 * Exported for tests: the mapping is where a wrong number would come from, and
 * it is pure.
 */
export function quotaFromStore(entry) {
  const good = entry?.lastGood;
  const fh = good?.five_hour;
  const sd = good?.seven_day;
  const primary = (typeof fh?.pct === "number") ? fh : sd;
  if (typeof primary?.pct !== "number") return null;

  const round = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const out = {
    ok: true,
    source: "claude-swap",
    session5hPct:       round(primary.pct),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
    week7dPct:          typeof sd?.pct === "number" ? round(sd.pct) : 0,
    week7dReset:        fmtResetIso(sd?.resets_at),
    week7dResetAt:      isoToSec(sd?.resets_at),
    // The age of the DATA, not of our read of it. The panel prints this, and
    // "30s ago" over numbers claude-swap collected twenty minutes back is the
    // kind of true-looking lie this whole change exists to remove.
    fetchedAt: entry.fetchedAt,
  };
  // claude-swap keeps per-model windows in a named list rather than fixed
  // fields, because which ones an account has depends on its plan.
  for (const s of Array.isArray(good.scoped) ? good.scoped : []) {
    if (typeof s?.pct !== "number") continue;
    if (/sonnet/i.test(s.name ?? "")) out.weekSonnetPct = round(s.pct);
    else if (/opus/i.test(s.name ?? "")) out.weekOpusPct = round(s.pct);
  }
  return out;
}

/**
 * Whether we may spend a request of the user's budget right now.
 *
 * Exported for tests — this is the rule that stopped the deck from starving
 * claude-swap, and it is worth pinning down.
 */
export function maySelfPoll({ now, force, lastSelfPollAt, rateLimitedUntil }) {
  if (now < rateLimitedUntil) return false;
  return now - lastSelfPollAt >= (force ? FORCE_POLL_MS : SELF_POLL_MS);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "");
}

// Parse "Jun 18, 4:09pm" (local time, no tz) into unix seconds.
// Claude shows times in the user's local timezone, so parsing as local is correct.
// `now` is injectable so the year-boundary case is testable.
export function parseResetToSec(resetStr, now = Date.now()) {
  if (!resetStr) return null;
  try {
    // "4:09pm" → "4:09 PM" so Date.parse handles it. Minutes are optional in
    // the CLI's output ("9am"); Date.parse rejects "9 AM", so supply ":00".
    const norm = resetStr
      .replace(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
               (_all, h, mm, ampm) => `${h}:${mm ?? "00"} ${ampm}`)
      .trim();
    // The CLI prints no year, so we have to supply one. Stamping the current
    // year blindly puts a "Jan 2" reset read on Dec 30 eleven months in the
    // past, which hides the countdown and pins the pace marker at 100%. A
    // reset is never more than a week away, so the neighbouring year that
    // lands nearest to `now` is the one Claude meant.
    const thisYear = new Date(now).getFullYear();
    let best = null;
    for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
      const t = new Date(`${norm} ${year}`).getTime();
      if (isNaN(t)) continue;
      if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best === null ? null : Math.floor(best / 1000);
  } catch { return null; }
}

/**
 * Parse `claude --print /usage` output.
 *
 * Observed format (Claude Code ≥ 1.x):
 *   "Current session: 84% used · resets Jun 18, 4:09pm (Europe/Chisinau)"
 *   "Current week (all models): 85% used · resets Jun 21, 8:59am (Europe/Chisinau)"
 *   "Current week (Sonnet only): 48% used · resets Jun 21, 9am (Europe/Chisinau)"
 *   "Current week (Opus only): ..."   (if present)
 */
function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // Helper: find "X% used · resets <rest>" on a line matching a label.
  const extract = (labelRe) => {
    const line = text.split("\n").find(l => labelRe.test(l));
    if (!line) return null;
    const pctM = line.match(/(\d{1,3})\s*%/);
    const resetM = line.match(/resets\s+(.+)/i);
    const resetFull = resetM
      ? resetM[1].replace(/\(.*?\)/g, "").replace(/·/g, "").trim()
      : null;
    return {
      pct:     pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      reset:   resetFull,
      resetAt: parseResetToSec(resetFull),
    };
  };

  const session = extract(/current session/i);
  if (session?.pct != null) {
    result.session5hPct       = session.pct;
    result.session5hWindowSec = 18000;
    if (session.reset)   result.session5hReset   = session.reset;
    if (session.resetAt) result.session5hResetAt  = session.resetAt;
  }

  const weekAll = extract(/current week\s*\(all models\)/i) || extract(/current week\s*[:·]/i);
  if (weekAll?.pct != null) {
    result.week7dPct       = weekAll.pct;
    result.week7dWindowSec = 604800;
    if (weekAll.reset)   result.week7dReset   = weekAll.reset;
    if (weekAll.resetAt) result.week7dResetAt  = weekAll.resetAt;
  }

  const weekSon = extract(/current week\s*\(sonnet/i);
  if (weekSon?.pct != null) result.weekSonnetPct = weekSon.pct;

  const weekOpus = extract(/current week\s*\(opus/i);
  if (weekOpus?.pct != null) result.weekOpusPct = weekOpus.pct;

  return Object.keys(result).length > 0 ? result : null;
}

// Where the `claude` CLI can be. The list moved to claude-dir.mjs, which is the
// module that owns every "where does Claude Code live" answer the deck has —
// the config dir was already there, and the boot-time presence check that reads
// this same list had no business importing a quota poller to get at it.

/** Which `claude` to run for `--print /usage`: the first candidate that exists.
 *
 *  This used to hand back a whole shell command line — `"<bin>" --print /usage
 *  < /dev/null` — for `exec()` to parse. Double quotes are not escaping on
 *  POSIX: `$(…)`, backticks and `\` all still work inside them, and every
 *  ingredient of that line came from the environment (`%APPDATA%`, `homedir()`),
 *  so a home directory named `/home/a$(id)b` was shell code the quota poll ran
 *  every minute. A bare `$` was the duller half of the same bug — it expanded
 *  to nothing and the probe looked for a binary at a path that did not exist.
 *
 *  There is nothing left to escape once there is no shell: exec.mjs's `run`
 *  spawns the argument vector as given, resolves the Windows `.cmd`/`.exe`
 *  spelling itself, and closes the child's stdin — which is what `< /dev/null`
 *  was for, since `claude --print` waits three seconds on a stdin pipe nobody
 *  is writing to.
 *
 *  Exported, with everything it touches injectable, so the Windows branch is
 *  testable from the platforms this repo is actually developed on.
 *
 *  WHY THE BARE NAME HAS TO EARN ITS PLACE (#553). This used to be a `.find`
 *  over `!c.includes(sep) || exists(c)`, which reads as "a bare name always
 *  answers, a full path only when it is there". On Windows that is harmless —
 *  the bare name is LAST in the list — but on POSIX it is FIRST, so the `||`
 *  short-circuited on candidate one and `exists` was never called even once:
 *  `~/.local/bin/claude`, `/usr/local/bin/claude` and `/opt/homebrew/bin/claude`
 *  were in a list nothing ever read. The user this broke is the one
 *  claude-dir.mjs names out loud: Claude Code installed by the official
 *  installer, so the binary is at `~/.local/bin/claude`, and the deck launched
 *  from something whose PATH never sourced a shell rc — a LaunchAgent, a
 *  systemd user unit, pm2, a desktop shortcut. `hasClaudeInstalled()` stats the
 *  absolute paths and says yes, so hooks install and the Claude surface turns
 *  on; every `claude --print /usage` spawn is then a bare-name ENOENT logged as
 *  `quota: claude CLI failed`. On macOS there is no `.credentials.json` to fall
 *  back to (the token is in the Keychain, #360), so the quota panel simply stays
 *  dark on a machine that plainly has Claude Code. The identical install on
 *  Windows worked, because there the ordering already said what this now says.
 *
 *  WHICH WINS. The candidate list's own order decides, unchanged on both
 *  platforms — PATH first on POSIX, the two known install directories first on
 *  Windows — because the ordering question here is the one getRunner in
 *  ccusage.mjs already answered: preferring a different copy would silently
 *  change which binary runs on every machine that has two, and a deck that
 *  works today must not start running a `claude` it has never run. A user with
 *  a current claude on PATH via nvm/mise/volta and a stale one left in
 *  `~/.local/bin` keeps getting the one their own shell gives them. All that
 *  changes is that a bare name is now only ANSWERED WITH when PATH actually
 *  holds it, which is the same rule claudeCliOnDisk in claude-dir.mjs has
 *  always applied to this very list — the two readers of one list can no longer
 *  disagree about whether the deck can run what it says is installed.
 *
 *  WHAT IT COSTS. One PATH walk, stopping at the first hit, and only for the
 *  bare candidate; the absolute paths are stat'ed only once PATH has come up
 *  empty. That is the trade ccusage.mjs already priced for the same shape of
 *  question — "a handful of stats, once per uncached fetch, against a process
 *  spawn that follows it" — and here the spawn that follows is a whole Claude
 *  Code process measured at ~3s, behind the SELF_POLL_MS floor.
 *
 *  `pathLookup` is used as a yes/no gate rather than for the path it found, on
 *  purpose: answering with the bare name keeps spawn's own resolution (and, on
 *  Windows, exec.mjs's PATHEXT candidate walk) in charge of the PATH case
 *  exactly as before, so a PATH entry that merely LOOKS like a hit — a
 *  directory named `claude` — cannot become the answer.
 */
export function quotaClaudeBin(platform = process.platform, env = process.env,
                               home = homedir(), exists = existsSync) {
  const sep = platform === "win32" ? "\\" : "/";
  // process.env is case-insensitive on Windows; an injected plain object in a
  // test is not, and %Path% is how the variable is actually spelled there.
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  for (const c of claudeCliCandidates(platform, env, home)) {
    // A full path is worth a single stat; a bare name means "ask PATH", which
    // is pathLookup's walk — PATHEXT included, since `claude` on Windows is
    // spelled `claude.exe` or `claude.cmd` and never the bare word.
    if (c.includes(sep)) { if (exists(c)) return c; }
    else if (pathLookup(c, platform, { pathEnv, exists })) return c;
  }
  // Nothing on PATH and nothing at any known install directory. The bare name
  // is still the right last resort — POSIX `execvp` and cmd.exe's own search
  // both deserve their turn at a layout no list here knows — and the ENOENT it
  // produces is what `quota: claude CLI failed` reports.
  return "claude";
}

export async function fetchClaudeQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  // If another CLI probe is already in flight, wait for it instead of spawning a
  // second concurrent process (which can return empty output and overwrite the
  // good result with 0%).
  if (_inflight) return _inflight;

  // `_inflight === mine` rather than a bare clear: invalidateQuotaCache drops
  // `_inflight` so the next caller starts a read that knows the account moved,
  // and that read installs its own promise here. A read from before the switch
  // finishing afterwards would otherwise clear the NEW one on its way out,
  // letting a third caller spawn a second concurrent probe — which is the very
  // thing this slot exists to prevent.
  const mine = _doFetch(now, force, _generation)
    .finally(() => { if (_inflight === mine) _inflight = null; });
  _inflight = mine;
  return mine;
}

/**
 * Write a reading into the caches, unless the account moved while it was being
 * taken.
 *
 * Every one of _doFetch's writes happens after at least one await — a store
 * read, a 15-second HTTPS call, up to three `claude --print /usage` spawns with
 * 1.2s between them — and invalidateQuotaCache clears variables, which does
 * nothing to a function that is already running and still holds the old
 * account's answer in a local. So a switch landing mid-flight was followed,
 * milliseconds later, by the pre-switch reading being written straight back over
 * the cleared cache: the invalidation looked like it worked and was undone
 * before anyone could observe it.
 *
 * The fetch is deliberately NOT cancelled. Whoever asked for it is still owed an
 * answer, and the reading is not wrong — it is simply about an account that is
 * no longer active, which makes it a fine return value and a bad cached one.
 * `_lastGood` gets the same guard, and needs it more: it is the half that
 * survives the result cache's minute and comes back under a "stale" label for as
 * long as the store has nothing to say about the new account.
 */
function publish(gen, result, at, { good = false } = {}) {
  if (gen !== _generation) return result;
  _cache   = result;
  _cacheAt = at;
  if (good) _lastGood = result;
  return result;
}

/**
 * claude-swap's numbers for the active account, if it has any.
 *
 * Never throws and never blocks on the network: worst case the store is
 * missing, unparseable, or about a different account than the one that is
 * active, and the caller falls through to fetching for itself.
 */
async function storeQuota() {
  try {
    return quotaFromStore(await activeAccountUsage());
  } catch {
    return null;
  }
}

// After asking claude-swap to collect, how long to keep looking for the row it
// writes. Its fetch is a single HTTPS call; three tries covers a slow one
// without making the refresh button feel stuck.
const REREAD_TRIES = 3;
const REREAD_GAP_MS = 800;

/**
 * Whichever of two readings was collected later, regardless of source.
 *
 * Quota numbers only ever move forward in time, so "newer" is the only ranking
 * that makes sense between a store row and something we fetched ourselves. A
 * five-hour window can also reset between the two, which makes an older reading
 * not merely stale but wrong — 23% from before the reset, 3% after it.
 */
export function freshest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (b.fetchedAt ?? 0) > (a.fetchedAt ?? 0) ? b : a;
}

/** Ask for a collection, then watch the store for the result. */
async function nudgeAndReread(previous) {
  let asked = false;
  try { asked = await requestCollection(); } catch { /* cswap missing */ }
  if (!asked) return previous;

  for (let i = 0; i < REREAD_TRIES; i++) {
    await sleep(REREAD_GAP_MS);
    const fresh = await storeQuota();
    if (fresh && (!previous || fresh.fetchedAt > previous.fetchedAt)) return fresh;
  }
  return previous;
}

// Run `claude --print /usage` once. Returns { cliOk, parsed }.
//   cliOk  — the CLI ran and we recognized its output (preamble present)
//   parsed — quota percentages object, or null if the "Current session/week"
//            lines were absent (CLI cold-start, or genuinely <1% usage)
/**
 * The failure this last said out loud, so a standing one is said once.
 *
 * #742. A Windows user with no Claude Code installed sent a screenshot of three
 * identical lines — `ccdeck quota: claude CLI failed: claude exited ENOENT` —
 * interleaved with the deck's pulse line, and they keep coming for as long as
 * the deck runs. Every poll ran the loop below three times, and every attempt
 * printed. A CLI that is not installed is not news three times a minute; it is
 * a condition, and a condition is worth exactly one line.
 *
 * Cleared on the first run that works, so a `claude` installed while the deck
 * is up can still report its next genuine failure.
 */
let _saidFailure = null;

/** Exported for its test, and for the same reason resetCswapBin is: a module
 *  that remembers something across calls needs a way to be asked twice.
 *
 *  Deliberately NOT folded into invalidateQuotaCache, which production calls
 *  after an account switch — forgetting the notice there would put the same
 *  sentence back on the terminal every time somebody changed accounts. */
export function forgetQuotaFailureNotice() { _saidFailure = null; }

/** The rate floor, cleared. `maySelfPoll` keeps a self-poll to one a minute
 *  even under `force`, which is correct for a user's budget and is a test
 *  asking the same question three times running into a wall. */
export function resetQuotaPollFloor() {
  _lastSelfPollAt = 0;
  _rateLimitedUntil = 0;
}

async function _execOnce(bin) {
  const r = await run(bin, ["--print", "/usage"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    // Marks this Claude Code run as the deck's own. `claude --print /usage`
    // is a full invocation, so it fires the hooks we installed, and every
    // quota poll was drawing itself onto the canvas as a fresh session with
    // no prompt and no tools. Hooks inherit the environment, so hook.js
    // sees this and stays quiet.
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb", AGENTS_DECK_INTERNAL: "1" },
  });
  // `run` never rejects, so there is one path rather than two — and the output
  // is kept either way, which matters because the CLI writes the quota lines to
  // stdout and can still exit non-zero afterwards.
  const combined = r.stdout + "\n" + r.stderr;
  // `run` normalises a binary that is not there to this, on every platform —
  // see exec.mjs. It is the difference between "Claude Code answered badly",
  // which is worth retrying and worth saying, and "there is no Claude Code on
  // this machine", which is neither.
  const missing = r.code === "ENOENT";
  if (!r.ok) {
    const msg = stripAnsi(r.stderr).trim() || `claude exited ${r.code}`;
    if (msg !== _saidFailure) {
      _saidFailure = msg;
      console.error(`${PRODUCT} quota: claude CLI failed:`, msg);
    }
  } else {
    _saidFailure = null;
  }
  const cliOk = /subscription/i.test(combined) || /claude code usage/i.test(combined);
  return { cliOk, missing, parsed: parseUsageText(combined) };
}

async function _doFetch(now, force = false, gen = _generation) {
  // Source 1: claude-swap's store. Free, and already paid for.
  let store = await storeQuota();

  // Refresh asks for newer numbers, and the honest way to get them from this
  // source is to ask the collector that owns it — which applies its own
  // schedule and backoff, so this cannot become a poll loop.
  if (force && (!store || now - store.fetchedAt > FORCE_POLL_MS)) {
    store = await nudgeAndReread(store);
  }
  if (store && now - store.fetchedAt <= STORE_TRUSTED_MS) {
    // Keep the store moving even when the accounts panel is closed. Without
    // this the numbers only advance while something else asks — claude-swap's
    // own schedule still decides whether this touches the network, and the
    // throttle inside is shared with the accounts panel, so two open panels
    // ask no more often than one.
    if (!force) requestCollection().catch(() => {});
    return publish(gen, store, now, { good: true });
  }

  // Nothing usable in the store. Everything below spends the user's budget, so
  // it happens on a floor, and not at all while a 429 cooldown is running.
  if (!maySelfPoll({ now, force, lastSelfPollAt: _lastSelfPollAt, rateLimitedUntil: _rateLimitedUntil })) {
    // A stale row still beats an empty panel, and says how stale it is — but
    // it must be the freshest thing we hold, not just the store. Preferring
    // the store here threw away readings we had already paid for: after a boot
    // that fell through to the CLI, the panel showed 3% (fetched seconds ago)
    // and then reverted to 23% (from a 48-minute-old store row) on the very
    // next poll, because the store had not moved.
    const held = freshest(store, _lastGood);
    if (held) return publish(gen, { ...held, stale: true }, now);
    const result = { ok: false, reason: now < _rateLimitedUntil ? "rate_limited" : "waiting", fetchedAt: now };
    return publish(gen, result, now - (CACHE_MS - 5_000));
  }
  _lastSelfPollAt = now;

  // Source 2: OAuth usage API — instant, exact, no cold-start gap.
  const api = await fetchOAuthUsage();
  if (api) {
    return publish(gen, { ok: true, ...api, source: "api", fetchedAt: now }, now, { good: true });
  }

  // Source 3: parse `claude --print /usage` CLI output.
  const bin = quotaClaudeBin();

  // The CLI sometimes omits the "Current session/week" quota lines on a cold
  // invocation (right after the server starts, or after the page is hard-
  // refreshed). The real lines appear on a subsequent call. Retry a couple
  // times before giving up so the first paint already shows real values.
  let cliOk = false;
  let parsed = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    const r = await _execOnce(bin);
    cliOk = r.cliOk || cliOk;
    if (r.parsed) { parsed = r.parsed; break; }
    // The retry exists for a CLI that RAN and left the quota lines out of a cold
    // invocation. A CLI that is not installed will not be installed 1.2 seconds
    // from now, and asking twice more spends two spawns and 2.4 seconds of the
    // caller's wait to print the same sentence three times. See _execOnce.
    if (r.missing) break;
  }

  // Got real quota lines — cache normally and remember as last-known-good.
  if (parsed) {
    return publish(gen, { ok: true, ...parsed, source: "cli", fetchedAt: now }, now, { good: true });
  }

  // No quota lines after retries. If we've ever seen real values, keep showing
  // them rather than regressing to 0% on a transient empty read — with the
  // timestamp of the answer they actually are. Re-stamping them `now` put "just
  // now" over percentages collected hours earlier for one poll in five, then let
  // the label snap back to the true age: an age indicator that oscillates, and
  // vouches for numbers this branch already knows are stale. Short-cache so we
  // retry the CLI again soon.
  if (_lastGood) {
    return publish(gen, { ..._lastGood, stale: true }, now - (CACHE_MS - 5_000));
  }

  // Never had good data. A CLI that RAN and printed no quota lines is two
  // different machines, and they need two different answers:
  //
  //   * a subscription install on a cold invocation — the lines come back on a
  //     later call, and until then "<1%" is the honest reading of a window that
  //     has genuinely just reset;
  //   * an API-key, Bedrock or Vertex install, which has no windows at all.
  //     Publishing two zeroes there drew empty bars for a measurement nobody
  //     took, on a machine where no amount of retrying will ever produce one.
  //
  // A CLI that failed entirely is `ok: false` as it always was, and the reason
  // says which of the two the reader is looking at.
  const subscribed = cliOk ? await hasSubscriptionCredential() : false;
  const result = cliOk && subscribed
    ? { ok: true, session5hPct: 0, session5hWindowSec: 18000,
        week7dPct: 0, week7dWindowSec: 604800, fetchedAt: now }
    : { ok: false, reason: cliOk ? "no_subscription" : "cli_failed", fetchedAt: now };
  return publish(gen, result, now - (CACHE_MS - 5_000));
}

/**
 * Forget every reading held for the account that was active when it was taken.
 *
 * `?refresh=1` is the browser asking for a fresher read; this is the server
 * knowing the numbers it holds are the wrong account's. A Claude account switch
 * makes them that — every percentage here belongs to whoever was active when it
 * was collected — and the switch happens server-side, where no tab is in a
 * position to send the flag: it is driven from the accounts panel, and the usage
 * panel neither owns that state nor hears about it.
 *
 * `_lastGood` goes with the result cache, and it is the half that matters.
 * Clearing `_cache` alone only shortens the wrong answer's life to the next
 * poll, because both fallbacks in _doFetch hand `_lastGood` straight back — and
 * freshest() ranks by fetchedAt, so a reading the deck already paid for beats
 * any row the store holds for an account nobody has collected for since. The
 * panel would print the previous account's percentages under a "stale" label
 * instead of admitting it has no answer for this one yet.
 *
 * The self-poll floor deliberately survives: a switch is not a reason to spend
 * the shared request budget, and one that reset it would make switching a way to
 * hammer it. Until the store answers for the new account, "no reading yet" is
 * the honest thing to serve.
 *
 * Clearing the three variables is not enough on its own, because a fetch that is
 * already running is not a variable. `_doFetch` writes `_cache` and `_lastGood`
 * AFTER its awaits, so one that read the store before the switch and resolves
 * after it put the previous account's numbers back into both, undoing this call
 * from the other side of an await — and callers arriving in that window were
 * handed the same in-flight promise rather than a read that knows the account
 * moved. The window is real: a forced fetch goes through nudgeAndReread, which
 * sleeps REREAD_TRIES * REREAD_GAP_MS = 2.4 seconds by construction, comfortably
 * longer than a `cswap switch`.
 *
 * So the generation counter moves too. Every write in `_doFetch` is stamped with
 * the generation that was current when that read started, and publish() drops
 * any write whose stamp is stale — the fetch still resolves, and whoever asked
 * for it still gets its answer, but that answer no longer becomes this module's.
 * `_inflight` is released for the same reason: the next caller must start a read
 * of its own rather than join one that is describing the account the deck just
 * left.
 */
export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
  _lastGood = null;
  _generation++;
  _inflight = null;
}
