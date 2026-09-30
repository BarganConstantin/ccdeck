// The deck-managed auto-switch loop: `cswap auto --once` run on claude-swap's
// own interval, one tick at a time, and only while the user has it switched on
// — a choice kept in ~/.agents-deck/cswap-auto.json across restarts.
//
// Moved out of cswap-auto.mjs unchanged, with what one tick is (summarise,
// runAutoTick). cswap-auto.mjs re-exports setAutoEnabled and initCswapAuto,
// which is where the route and the boot reach them; its settings write asks
// restartLoop for a new interval, and its status route reports loopEnabled and
// lastTick.
import { run } from "./exec.mjs";
import { failureDetail } from "./exec-output.mjs";
import { cswapBin } from "./cswap-install.mjs";
import { externalAutoRunning, readCswapConfig } from "./cswap-auto-readers.mjs";
import { invalidateClaudeAccountsCache } from "./claude-accounts.mjs";
import { invalidateQuotaCache } from "./quota.mjs";
// The one store mutex. A tick is the only thing in the deck that moves the live
// account with nobody watching, which is why it of all writers must queue.
import { withStoreLock } from "./store-lock.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR  = join(homedir(), ".agents-deck");
const STATE_PATH = join(STATE_DIR, "cswap-auto.json");

const TICK_TIMEOUT_MS = 120_000;   // a tick can refresh a token and switch
const MIN_INTERVAL_S  = 15;        // claude-swap's own floor

// ── ticks ──────────────────────────────────────────────────────────────────

/** Last meaningful event from a `cswap auto --once --json` run. */
function summarise(stdout) {
  const events = stdout.split("\n")
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && typeof e === "object");

  const poll   = events.find(e => e.event === "poll") ?? null;
  const action = [...events].reverse().find(e => e.event !== "poll" && e.event !== "sleep") ?? null;

  return {
    event:     action?.event ?? "no-switch",
    // Whether the LIVE ACCOUNT MOVED, which is a narrower question than which
    // event came last and the only one the caches care about. Taken over every
    // event rather than over `action`, so a quarantine or an error emitted after
    // the switch cannot hide it; and `dryRun` is checked even though this
    // module's ticks never pass `--dry-run`, because the engine emits the same
    // `switch` event for a decision it did not carry out, and a false positive
    // here throws away readings that cost a subprocess each.
    switched:  events.some(e => e.event === "switch" && e.dryRun !== true),
    reason:    action?.reason ?? null,
    detail:    action?.detail ?? null,
    from:      action?.from ?? null,
    to:        action?.to ?? null,
    active:    poll?.active ?? null,
    threshold: poll?.threshold ?? null,
    headroom:  poll?.headroomPct ?? null,
    windows:   poll?.windowsPct ?? null,
  };
}

/**
 * Evaluate a tick for real. May switch the active account.
 *
 * UNDER THE STORE MUTEX (#1039). `cswap auto --once` is not a question: it
 * reads sequence.json, decides, and writes it back, which is the unlocked
 * read-modify-write cswap-admin.mjs's header opens by explaining and the reason
 * every mutation there goes through one lock. This one was outside it, and it
 * is the writer least likely to be noticed — nobody presses it. The interval
 * floor is MIN_INTERVAL_S = 15 s (claude-swap's own) and one `cswap add` is
 * allowed sixty, so a tick landing inside a sign-in takes no coincidence at
 * all: whichever write lands second drops the other's record, and the deck
 * reports a rotation that was silently undone, or the account the user has just
 * added is gone.
 *
 * A tick skipped because the lock was busy is not a tick lost — `tick()` already
 * says as much about its own guard: the next interval is at most fifteen
 * seconds away and the work is idempotent by design. Here it is not even
 * skipped, only queued.
 *
 * AND QUEUED IS A WAIT (#1797). The chain is first-in first-out with no
 * timeout, so a tick can stand behind a sixty-second `cswap add` — and the
 * switch runTick checked before joining the queue may have been turned off by
 * the time the lock is its. Both of runTick's questions are asked again as the
 * first thing the lock runs, before `cswapBin()` and before anything is
 * spawned, and a tick that finds either answer changed comes back as the same
 * skip runTick would have recorded. The external-engine reading is the shared
 * ten-second one, so a tick that did not wait pays nothing for it here.
 */
async function runAutoTick() {
  const r = await withStoreLock(async () => {
    if (!_enabled) return { skipped: "disabled" };
    if (await externalAutoRunning()) return { skipped: "external-engine" };
    return run(await cswapBin(), ["auto", "--once", "--json"], { timeout: TICK_TIMEOUT_MS });
  });
  if (r.skipped) return { event: "skipped", reason: r.skipped };
  // A KILLED RUN IS NOT A QUIET ONE. `run`'s timeout path deliberately keeps an
  // 8 KB tail of whatever the child managed to print, so `!r.ok && !r.stdout`
  // is false for a tick that emitted its `{"event":"poll"}` line and then
  // stalled — and the killed run fell through to `ok: true`. The panel then
  // showed a healthy `no-switch` every two minutes, forever, while the engine
  // did nothing at all: exactly the trap exec.mjs's own header names.
  if (r.timedOut) {
    return { ok: false, reason: "tick_timeout", detail: `cswap auto --once did not finish within ${TICK_TIMEOUT_MS / 1000}s` };
  }
  if (!r.ok && !r.stdout) {
    return { ok: false, reason: "tick_failed", detail: failureDetail(r, 300) };
  }
  return { ok: true, ...summarise(r.stdout) };
}

// ── deck-managed loop ──────────────────────────────────────────────────────

let _timer   = null;
let _lastTick = null;
let _enabled  = false;
// Set the instant startLoop is entered and cleared when it settles, because
// `_timer` cannot do that job: it is assigned AFTER an await, and the window in
// between is what #537 was. See startLoop.
let _starting = false;
/** Set when a restart is asked for while `startLoop` is mid-read, so the read
 *  that is already running takes the new value instead of installing the old
 *  one. Module-level beside `_starting`, which it exists to answer for. */
let _restartWanted = false;
// The tick in flight, so the interval can skip rather than stack. See tick.
let _ticking = null;
// What every tick waits for before it runs anything: the launcher's word that
// the claude-swap it drives is not being installed or upgraded underneath it.
// Settled by default, so a caller with nothing to wait for — a respawn, a test,
// the dev server — ticks exactly as before. See initCswapAuto (#1043).
let _toolQuiet = Promise.resolve();

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return {}; }
}
async function saveState(state) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

async function tickInterval() {
  const cfg = await readCswapConfig();
  const raw = Number(cfg?.["autoswitch.intervalSeconds"]?.value);
  return Math.max(MIN_INTERVAL_S, Number.isFinite(raw) ? raw : 60) * 1000;
}

/**
 * Everything the deck holds that belongs to ONE Claude account, dropped.
 *
 * The accounts roster is keyed on whichever account claude-swap says is active,
 * and every quota percentage was read for whoever was active when it was
 * collected. A switch makes both of them the wrong account's, and neither cache
 * has any way to find that out for itself: they are refreshed on timers, by
 * panels that were not told.
 *
 * The two caches decay at very different rates, which is why saying nothing was
 * visibly wrong rather than briefly wrong. claude-accounts.mjs holds its roster
 * for CACHE_MS = 5s, so the panel flips to the new account almost at once, while
 * quota.mjs holds its result for a CACHE_MS of its own = 60s — and `_lastGood`
 * outlives even that, coming back under a "stale" label every five seconds until
 * the store has something to say about the account the deck moved TO. So for up
 * to a minute, and for longer than that in the fallback, two panels on one screen
 * described two different accounts, and the wrong one was the big quota bars:
 * sitting at the 90% that triggered the switch, for an account nobody is on.
 */
function forgetAccountScopedCaches() {
  invalidateClaudeAccountsCache();
  invalidateQuotaCache();
}

async function runTick() {
  // NOT WHILE THE TOOL IS BEING SET UP (#1043). A tick is `cswap auto --once`,
  // which moves the user's live Claude credentials, and the boot arms this loop
  // the moment the port binds — while bin/deck.js may still be installing
  // claude-swap, or has just fired an upgrade of it that nothing awaits. It sits
  // here rather than in startLoop so that it holds every tick that could land in
  // that window: the boot's eager one, an interval that comes round during a
  // three-minute install, and one the user starts from the panel meanwhile.
  // Everything below is asked after it, so a switch turned off while this was
  // waiting is seen as off.
  await _toolQuiet;
  // Re-check each time: the user can start their own loop at any point, and
  // the deck should fall silent rather than compete with it.
  if (await externalAutoRunning()) {
    _lastTick = { at: Date.now(), event: "skipped", reason: "external-engine" };
    return;
  }
  // AND RE-CHECK THE SWITCH ITSELF, after that await. `stopLoop` clears the
  // interval and nothing else, so a tick already running went on to move the
  // user's live account seconds after the panel had drawn itself as off. The
  // await above is not short: ticks are at least fifteen seconds apart against
  // a ten-second floor, so every one pays a real process-table read — on
  // Windows a PowerShell Get-CimInstance with an eight-second deadline. The
  // panel then showed `enabled: false` beside a `lastTick` of
  // `{event: "switch", from, to}` stamped after the user turned it off.
  if (!_enabled) {
    _lastTick = { at: Date.now(), event: "skipped", reason: "disabled" };
    return;
  }
  const result = await runAutoTick();
  // Before `_lastTick`, not after. This is the only path in the deck that moves
  // the live account without a click behind it, so nothing else is in a position
  // to make the call — and `_lastTick` is what /api/cswap-auto reports, so
  // dropping the caches first means anything that can see the tick happened is
  // already looking at caches that know about it.
  //
  // Only on a tick that actually switched. A tick is mostly a poll that decides
  // to do nothing — cooldown, no candidates, nothing over the threshold — and
  // invalidating on those would throw away readings the deck paid a subprocess
  // for, every interval, forever.
  if (result.switched) forgetAccountScopedCaches();
  // Record the move for the account-projects report. Only on a real switch, and
  // best effort — the tick must not fail because a log line did not append. The
  // slot is resolved from the store inside recordSwap, so cswap's `to` need not
  // be threaded through here.
  if (result.switched) {
    import("./swap-log.mjs")
      .then(({ recordSwap }) => recordSwap(result.to, "auto"))
      .catch(() => {});
  }
  _lastTick = { at: Date.now(), ...result };
}

/**
 * One tick at a time, whatever the interval is.
 *
 * The interval floor is 15 seconds (MIN_INTERVAL_S, and SETTINGS allows exactly
 * that), while a single tick can legitimately take 8 for externalAutoRunning's
 * `Get-CimInstance`/`ps` plus 120 for runAutoTick's own timeout. Nothing capped
 * the fan-out, so a slow `cswap auto --once` — one that is refreshing a token
 * and switching an account — could have eight copies of itself running against
 * each other two minutes later, each with a PowerShell process beside it on
 * Windows. `_lastTick` was then written by whichever finished last rather than
 * by the most recent tick, so the panel's "last tick" could go backwards.
 *
 * A skipped tick is not a lost one: the next interval is at most 15 seconds
 * away, and the work this schedules is idempotent by design.
 */
function tick() {
  if (_ticking) return _ticking;
  _ticking = runTick().finally(() => { _ticking = null; });
  return _ticking;
}

/**
 * Start the deck-managed loop, at most once.
 *
 * `if (_timer) return` looked like a guard and was not one: `_timer` is assigned
 * after `await tickInterval()`, which shells out to `cswap config`, so two
 * callers could both be past the check before either had set it. Two ways in
 * during that window, both reachable from the UI:
 *
 *   - enable then disable, a few hundred milliseconds apart. The disable set
 *     `_enabled = false` and called stopLoop, which cleared nothing because
 *     `_timer` was still null — and then the enable came back and installed the
 *     interval. autoStatus() reported `enabled: false` and the toggle read off
 *     while every tick went on running `cswap auto --once`, which switches the
 *     user's live Claude account. A control that says it is off while it moves
 *     credentials is the worst shape this bug could take.
 *
 *   - two enables (a double click, or two tabs). Two intervals, only the second
 *     reachable from `_timer`, so the first could never be cleared again for the
 *     life of the process.
 *
 * initCswapAuto is a third way in: index.mjs fires it unawaited while the server
 * is already accepting requests.
 *
 * `_starting` is set before the await, so the guard covers the whole function.
 * `_enabled` is re-read after it, because the answer may have changed while this
 * was waiting on a subprocess — and a loop that installs itself after the user
 * has turned it off is the same defect from the other side.
 */
async function startLoop() {
  // A start requested while one is already in flight is REMEMBERED, not dropped
  // (#791). `initCswapAuto()` is fired unawaited at boot, so this sits inside
  // `await tickInterval()` — a `cswap config` spawn, preceded on Windows by
  // cswapBin() probing up to four spellings, two of them through cmd.exe, each
  // with an 8s deadline — while the panel is already serving. A user setting
  // the interval in that window called stopLoop() (no timer yet: a no-op) and
  // then startLoop(), which returned here having done nothing; the boot's own
  // start then resumed with the interval it had read BEFORE the write and
  // installed the timer at the old value. The panel read back the new number
  // while the loop kept the old one for the life of the process.
  if (_starting) { _restartWanted = true; return; }
  if (_timer) return;
  _starting = true;
  try {
    // Loop rather than a single pass: the config may be written again while
    // THIS read is in flight, and the answer must be the last one written.
    for (;;) {
      _restartWanted = false;
      const ms = await tickInterval();
      if (!_enabled) return;   // turned off while we were asking cswap
      if (_restartWanted) continue;   // the interval changed under this read
      _timer = setInterval(() => { tick().catch(() => {}); }, ms);
      _timer.unref?.();
      break;
    }
  } finally {
    _starting = false;
  }
  tick().catch(() => {});   // don't make the user wait a full interval for the first one
}

function stopLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Put a new interval into effect: the timer goes, and a fresh read of the
 *  interval installs the next one. */
export function restartLoop() {
  stopLoop();
  // startLoop records the ask when one is already in flight, so this can no
  // longer be swallowed by the boot's own start — see the note there (#791).
  return startLoop();
}

/** Whether the user has the loop switched on — the setting, which a new
 *  interval and the status route both ask about, rather than whether a timer is
 *  installed right now. */
export function loopEnabled() {
  return _enabled;
}

/** What the most recent tick did, as /api/cswap-auto reports it; null before
 *  the first. */
export function lastTick() {
  return _lastTick;
}

/** Turn the deck-managed loop on or off, persisting the choice. */
export async function setAutoEnabled(enabled) {
  _enabled = Boolean(enabled);
  await saveState({ ...(await loadState()), enabled: _enabled });
  if (_enabled) await startLoop(); else stopLoop();
  return { ok: true, enabled: _enabled };
}

/**
 * Restore the persisted setting at server boot.
 *
 * `after` is the launcher's promise that claude-swap is quiet: its startup job
 * has settled, and so has any upgrade that job started without waiting for.
 * index.mjs passes on what bin/deck.js hands startServer. With nothing to wait
 * for it is null, and the loop ticks as it always did. A rejection counts as
 * settled, because a job that failed has nothing left running either.
 *
 * The loop still starts here and reads its interval here. Only the ticks wait.
 */
export async function initCswapAuto({ after = null } = {}) {
  _toolQuiet = Promise.resolve(after).then(() => {}, () => {});
  const state = await loadState();
  if (state.enabled) { _enabled = true; await startLoop(); }
}
