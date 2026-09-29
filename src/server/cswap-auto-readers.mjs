// The two readings behind GET /api/cswap-auto — claude-swap's settings map, and
// whether the user is running a `cswap auto` loop of their own — each shared by
// everyone who asks inside its window, one child at a time (#616).
//
// Moved out of cswap-auto.mjs unchanged, with the rule that tells the user's
// loop from the deck's own ticks. cswap-auto.mjs asks both on every status
// read, takes the tick interval out of the settings map, asks about the other
// engine before every tick, and drops both readings when it writes a setting;
// it re-exports all five names, which is where the suite reaches them.
import { run } from "./exec.mjs";
import { cswapBin, cswapRefused } from "./cswap-install.mjs";

// ── one reading at a time ──────────────────────────────────────────────────

/**
 * #616: /api/cswap-auto is a GET with no cache, no dedupe and no throttle, and
 * autoStatus() runs BOTH of this module's readers on every one of them — so the
 * number of children was exactly twice the number of requests.
 *
 * Measured on macOS with claude-swap installed, counting real children through a
 * PATH shim: one autoStatus() is 2 children (`cswap config` and `ps -Ao args=`)
 * and about 190ms warm; two back-to-back calls are 4; twenty-five concurrent
 * readers produced 50 — twenty-five Python interpreters and twenty-five `ps` —
 * and took 1.3 to 1.9s between them against 190ms for one, so the cost per
 * reader grows rather than holds. With the guard below the same twenty-five are
 * 2 children and 190ms, which is one reader's worth.
 *
 * On Windows the process-table half is `Get-CimInstance Win32_Process` through
 * PowerShell, carrying an 8s deadline of its own, which is the same order of
 * cost as the Get-Process #544 measured at about six seconds; and where cswap is
 * not on PATH each call also re-pays cswapBin()'s probe, which memoizes only
 * success and which `candidates` expands to four spellings there, two of them
 * launched through cmd.exe.
 *
 * Two callers reach these without an attacker anywhere: AccountsPanel polls the
 * route every 15s per open tab, and runTick asks externalAutoRunning() again
 * before every tick. And it is a GET, so it passed isTrustedRead for any local
 * client that sends neither Origin nor Sec-Fetch-Site — curl, a shell script, a
 * sandboxed agent. It is a guarded read now (GUARDED_READS in
 * request-gates.mjs), which refuses those callers unless they hold the token;
 * the guard below still bounds the ones that pass.
 *
 * The fix is #544's, at the route that sweep did not reach: a minimum gap plus
 * one shared in-flight promise per reader. There is no MAX_OUTSTANDING beside it
 * the way ccusage.mjs has one, and there does not need to be — ccusage keys its
 * cache by date range, so a flood of distinct ranges can never share a run,
 * while each reader here asks exactly one question and every caller of it can
 * therefore join the same child.
 *
 * What is NOT shared is the window, because the two halves are not the same
 * question. See CONFIG_MIN_GAP_MS and EXTERNAL_MIN_GAP_MS.
 */

/**
 * `cswap config` — the settings map, which is also what the panel DISPLAYS.
 *
 * The deck is not its only writer: `cswap config set` typed in a terminal
 * changes it behind the deck's back, and the panel is where the user would
 * expect to see that. So this window has to stay well under AccountsPanel's
 * 15s poll, or an edit made outside the deck waits for the window AND the poll.
 * Three seconds does not delay a single tab by one frame — its polls are five
 * gaps apart — while a burst of requests and two tabs whose polls land within
 * three seconds of each other collapse onto one child.
 */
const CONFIG_MIN_GAP_MS = 3_000;

/**
 * The process table — the expensive half, and the one whose answer changes
 * least: it is a boolean about whether the user has their own `cswap auto`
 * running, and nobody starts one between two fifteen-second polls.
 *
 * Ten seconds is chosen against the two scheduled callers rather than against
 * the cost: AccountsPanel's poll is 15s and MIN_INTERVAL_S — claude-swap's own
 * floor, and the smallest tick interval SETTINGS will accept — is also 15, so a
 * gap below both means neither of them is ever handed a reading older than its
 * own period. The deck's tick still decides on a fresh process table, and the
 * panel still shows one; what disappears is the second, third and twenty-fifth
 * copy taken in the same ten seconds.
 *
 * Worst case for a caller in a loop is now 20 `cswap config` and 6 process-table
 * children a minute, whatever it asks for, against a pair per request before.
 */
const EXTERNAL_MIN_GAP_MS = 10_000;

const _config   = { last: null, inFlight: null };
const _external = { last: null, inFlight: null };

/**
 * One reading of `read`, shared by everyone who asks inside `gapMs`.
 *
 * Only a real reading is remembered, which is what `value != null` means here:
 * readCswapConfig spells its failure `null` — autoStatus reports
 * `ok: config != null`, so holding one for three seconds would turn a single
 * hiccup into a panel that renders itself as broken for longer than the hiccup
 * lasted — and externalAutoRunning has no failure spelling at all, answering
 * `false` for a process table it could not read because that is the same answer
 * as an empty one and is the safe one either way. The in-flight share still
 * applies to a failing read, so a burst arriving during one is a single failing
 * child rather than a burst of them.
 *
 * `slot.inFlight === mine` on both hops is claude-accounts.mjs's guard and is
 * here for its reason: invalidateCswapAutoCache drops `inFlight` so the next
 * caller starts a read that knows the settings moved, and a read from BEFORE the
 * write must neither store its answer under the new state nor clear the new
 * read's promise on its way out.
 *
 * The reading is not keyed by platform even though externalAutoRunning branches
 * on one. A process does not change platform; the two test files that flip
 * `process.platform` to reach the other half from this one call
 * invalidateCswapAutoCache between cases.
 */
function throttled(slot, gapMs, read) {
  const now = Date.now();
  if (slot.last && now - slot.last.at < gapMs) return Promise.resolve(slot.last.value);
  if (slot.inFlight) return slot.inFlight;
  const mine = read()
    .then(value => {
      if (value != null && slot.inFlight === mine) slot.last = { at: Date.now(), value };
      return value;
    })
    .finally(() => { if (slot.inFlight === mine) slot.inFlight = null; });
  slot.inFlight = mine;
  return mine;
}

/**
 * Forget both readings, because the deck has just changed what they would say.
 *
 * The one caller is setCswapConfig. There is no `?refresh=1` on /api/cswap-auto
 * and no force argument through autoStatus, because the panel's explicit-refresh
 * path is not a query parameter: every auto-switch control is a POST followed by
 * `load(true)`, which re-fetches this route. Dropping the reading inside the
 * write is what makes that reload show what was written rather than the map read
 * a moment before it — the same disagreement between an optimistic value and the
 * next read that #584 was.
 *
 * The process-table reading goes with it. A settings write does not start
 * anybody's `cswap auto`, so this is not correctness for that half — it is that
 * one function which forgets everything this module is holding cannot be called
 * half-right, and the cost is at most one extra `ps` on a path the user reached
 * by clicking. It is also what the tests reset between cases.
 */
export function invalidateCswapAutoCache() {
  _config.last = _config.inFlight = null;
  _external.last = _external.inFlight = null;
}

// ── settings ───────────────────────────────────────────────────────────────

/**
 * Parse `cswap config` — "key   value   (default)" per line.
 *
 * Exported for its test, not only for its callers (#383). Its two callers in
 * cswap-auto.mjs — `autoStatus`, which hands the map straight to the settings
 * panel, and `tickInterval`, which takes the poll interval out of it — both
 * reduce the parse to something a test cannot see through: the panel takes
 * whatever shape it is given, and the interval collapses four fields to one
 * number that is clamped anyway. The parse itself is a regex over
 * human-formatted output from a separate Python tool, on both line-ending
 * conventions. See cswap-auto-readers.test.ts.
 *
 * One reading at a time and one every CONFIG_MIN_GAP_MS at most; the parse below
 * is what a reading is, and admission control is the wrapper. See throttled.
 */
export function readCswapConfig() {
  return throttled(_config, CONFIG_MIN_GAP_MS, readCswapConfigNow);
}

async function readCswapConfigNow() {
  const bin = await cswapBin();
  // Not a copy the deck refused (#1799): the panel's settings are no reason to
  // run it, and null is what a tool that cannot be asked already answers.
  if (cswapRefused()) return null;
  const r = await run(bin, ["config"]);
  if (!r.ok) return null;
  const out = {};
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(.*?)\s*(\(default\))?\s*$/);
    if (!m || !m[1].includes(".")) continue;
    const raw = m[2].trim();
    out[m[1]] = {
      value:     raw === "(none)" ? null : raw,
      isDefault: Boolean(m[3]),
    };
  }
  return out;
}

// ── external engine detection ──────────────────────────────────────────────

/**
 * One command line, as a list of the words a process was actually launched
 * with.
 *
 * The quote characters are separators here, not delimiters, and that is the
 * whole point of #552. `Win32_Process.CommandLine` reports what the CREATOR
 * wrote, and every launcher on Windows except a human typing at `cmd.exe`
 * quotes the executable:
 *
 *     "C:\Users\dorin\.local\bin\cswap.exe" auto
 *
 * — which is what .NET's `Process.Start` writes, so PowerShell, Windows
 * Terminal's default profile, Task Scheduler and an Explorer shortcut all
 * produce it. A pattern that wanted whitespace immediately after `cswap.exe`
 * saw a `"` there and answered no, for every one of them.
 *
 * The deck's own spawns are the same shape from the other side: viaCmd in
 * src/server/exec.mjs launches a `.cmd` shim as
 * `cmd.exe /d /s /c ""C:\…\cswap.cmd" "auto" "--once""`, with the whole line
 * wrapped in one more pair of quotes because that is what `cmd /c` wants.
 * Treating `"` as a separator takes both apart with no parser and no knowledge
 * of which launcher wrote the line — the outer pair, the per-argument pairs and
 * the bare case all collapse to the same token list.
 *
 * What it deliberately does NOT do is respect a quoted path containing spaces:
 * `"C:\Program Files\cswap\cswap.exe" auto` splits into three tokens rather than
 * two. That costs nothing here — the tail token is still `cswap.exe` followed by
 * `auto`, which is the only question asked — and the alternative is a real
 * command-line parser for a probe whose wrong answer must never be a crash.
 */
export function commandTokens(line) {
  return String(line ?? "").split(/["\s]+/).filter(Boolean);
}

/** The last path component of a token: `C:\bin\cswap.exe` → `cswap.exe`. */
const leaf = (token) => token.split(/[\\/]/).pop() ?? "";

/** Every spelling of the executable, on every platform. */
const CSWAP_EXE = /^cswap(\.exe|\.cmd|\.bat)?$/i;

/**
 * True when this command line is a long-lived `cswap auto` loop.
 *
 * The rule, stated over tokens rather than characters: some token IS the cswap
 * executable — its last path component, so `/opt/bin/mycswap` and `notcswap`
 * are somebody else's program — and the token straight after it is exactly
 * `auto`, so `autopilot` and `automate` are not this. `--once` anywhere rules
 * the line out: the deck's own ticks carry it, and so does a cron user's.
 *
 * Pure and exported so the Windows shapes can be checked from a Mac. The
 * residual false positive is a line that mentions cswap as an ARGUMENT and then
 * `auto` — `myprog --exe cswap auto`. That direction is the safe one: a wrong
 * `true` is a deck that stays quiet, while a wrong `false` is two engines moving
 * the same live Claude account.
 */
export function looksLikeAutoLoop(line) {
  if (/--once/i.test(String(line ?? ""))) return false;
  const tokens = commandTokens(line);
  return tokens.some((token, i) =>
    CSWAP_EXE.test(leaf(token)) && String(tokens[i + 1] ?? "").toLowerCase() === "auto");
}

/**
 * True when the user is already running `cswap auto` themselves.
 *
 * Two engines would not corrupt anything — claude-swap serializes decisions
 * under its state lock — but they would double the tick rate against a request
 * budget that is already the scarce resource here, and the user would have two
 * things switching their account with no single place showing why. So the deck
 * reports it and stays out of the way.
 *
 * Exported for its test, not only for its callers (#383). Its two callers in
 * cswap-auto.mjs reduce it to a boolean on a status object and to a skipped
 * tick, so neither can show WHICH command line was matched — and the matching
 * is the whole function. The two halves also run completely different
 * commands, `ps` against `Get-CimInstance`, so on any one machine only half of
 * it is ever exercised at all. See cswap-auto-readers.test.ts, which drives both
 * from either host.
 *
 * One reading at a time and one every EXTERNAL_MIN_GAP_MS at most — the
 * expensive half of #616, and the one both of its callers ask for on a
 * fifteen-second timer. See throttled.
 */
export function externalAutoRunning() {
  return throttled(_external, EXTERNAL_MIN_GAP_MS, externalAutoRunningNow);
}

async function externalAutoRunningNow() {
  // A line is the user's loop if it runs `cswap auto` without --once. Our own
  // ticks are --once, and so is a cron user's. See looksLikeAutoLoop.
  const isLoop = looksLikeAutoLoop;

  if (process.platform === "win32") {
    // No `ps` on Windows, and `tasklist` reports the image name only — every
    // Python tool shows up as python.exe, which cannot tell cswap from
    // anything else. CIM is the one place the full command line is available.
    //
    // `Out-String -Width 32767` is not decoration. `-ExpandProperty` emits
    // strings, and strings leave PowerShell through its console FORMATTER,
    // which hard-wraps at the host buffer width — 80 columns on a redirected
    // stdout, which is what a spawned child always has. A real command line
    // (`"C:\Users\dorin\AppData\Local\Programs\Python\Python312\Scripts\cswap.exe" auto`)
    // is longer than that, so the executable and its subcommand arrived on
    // SEPARATE LINES and no per-line match could ever see both. 32767 is the
    // maximum length Windows allows a command line, so nothing real can wrap.
    const r = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine | Out-String -Width 32767",
    ], { timeout: 8_000 });
    if (!r.ok) return false;   // no PowerShell, or the query was refused
    return r.stdout.split("\n").some(isLoop);
  }

  // `ps`, not `pgrep -a`: BSD pgrep ignores -a and prints bare PIDs, so a
  // command-line match against its output silently never fires.
  const r = await run("ps", ["-Ao", "args="], { timeout: 5_000 });
  if (!r.stdout.trim()) return false;
  return r.stdout.split("\n").some(isLoop);
}
