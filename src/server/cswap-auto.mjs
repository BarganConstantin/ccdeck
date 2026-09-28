// Auto-switch controls: read and write claude-swap's autoswitch settings and
// run a tick on a schedule.
//
// The engine is claude-swap's own — `cswap auto --once` evaluates one tick and
// exits, honouring the cooldown, quarantine and poll-budget state it keeps in
// its own files. Running that on an interval gets the same behaviour as the
// long-lived `cswap auto` loop while leaving all the decisions with the tool
// that owns them: nothing here decides when to switch, only when to ask.
//
// A tick can move the user's live Claude account, so it is off unless turned
// on and the setting survives restarts.
import { run } from "./exec.mjs";
import { failureDetail } from "./exec-output.mjs";
import { cswapBin } from "./cswap-install.mjs";
import {
  commandTokens, externalAutoRunning, invalidateCswapAutoCache, looksLikeAutoLoop, readCswapConfig,
} from "./cswap-auto-readers.mjs";
import { invalidateClaudeAccountsCache, slotNumber } from "./claude-accounts.mjs";
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

// Only these may be written, and only with a value of the right shape. The
// value reaches an exec argument, and `cswap config set` will happily store
// whatever it is handed.
const SETTINGS = {
  "autoswitch.threshold":       { type: "number", min: 50, max: 99.9 },
  "autoswitch.intervalSeconds": { type: "number", min: 15, max: 3600 },
  "autoswitch.cooldownSeconds": { type: "number", min: 0,  max: 86400 },
  "autoswitch.hysteresisPct":   { type: "number", min: 0,  max: 50 },
  "autoswitch.model":           { type: "model" },
};

// The two readings behind the status route — the settings map and whether the
// user runs their own loop — each one child at a time and one per window
// (#616): cswap-auto-readers.mjs.
export { invalidateCswapAutoCache, readCswapConfig };

// ── settings ───────────────────────────────────────────────────────────────

/**
 * What the model list may be made of before it becomes an argv element.
 *
 * The character class is the same one this field has always had — a
 * comma-separated list of plain model names, bounded at 120 — with the one rule
 * #543 wrote down at cswap-admin.mjs's EMAIL_OK added to the front: *"The
 * leading-character rule is the same argv-position rule ALIAS_OK now carries."*
 *
 * This is the THIRD free-text field to reach an argument vector and the first
 * one that pass missed, because it lives in a different module. It is not a
 * different question. `{ key: "autoswitch.model", value: "-h" }` produced
 * `cswap config set autoswitch.model -h`; argparse on the other side reads the
 * leading dash as an option rather than as data, prints help, exits 0 — so
 * `r.ok` is true and the deck reports a setting saved that was never written,
 * after which the panel's optimistic value disagrees with the next read (#584).
 *
 * Only the first character is constrained, so `claude-3-5-sonnet` and every
 * other dash-bearing model name still works. cswap-argv-position.test.ts
 * enumerates every field this rule covers, so a fourth cannot be added without
 * one.
 */
const MODEL_LIST_OK = /^(?!-)[A-Za-z0-9 ,._-]{1,120}$/;

/**
 * The argument a setting's value becomes, as `{ ok: true, str }`, or the
 * refusal `{ ok: false, reason }` setCswapConfig answers with instead.
 *
 * Validated against SETTINGS and nothing else, and pure: neither answer spawns
 * anything, so a test can hand it every shape a caller might send without a
 * `cswap` behind it. setCswapConfig is its one caller.
 */
export function settingArg(key, value) {
  // `Object.hasOwn`, not a bare read. `SETTINGS["constructor"]` is truthy and
  // its `.type` is undefined, so a prototype member passed the allowlist and
  // fell through to the free-text branch — reaching `cswap config set
  // constructor <value>` and skipping the type-specific range check on the way.
  // Nothing reachable that way was dangerous; an allowlist that does not hold
  // is.
  const spec = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
  if (!spec) return { ok: false, reason: "unknown_setting" };

  let str;
  if (spec.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return { ok: false, reason: "out_of_range" };
    str = String(n);
  } else if (spec.type === "enum") {
    if (!spec.values.includes(value)) return { ok: false, reason: "bad_value" };
    str = value;
  } else {
    // Model names: a comma-separated list of plain words, or "all".
    str = String(value ?? "").trim();
    if (str && !MODEL_LIST_OK.test(str)) return { ok: false, reason: "bad_value" };
  }
  return { ok: true, str };
}

/** Validate against SETTINGS, then hand to `cswap config set`. */
export async function setCswapConfig(key, value) {
  const arg = settingArg(key, value);
  if (!arg.ok) return arg;
  const { str } = arg;

  const r = await run(await cswapBin(), ["config", "set", key, str]);
  // Whatever the CLI said. A write that reported a failure may still have landed
  // — and `r.ok` is not proof either way here, which is the whole of #584 — so
  // the only safe thing to hold after asking cswap to change a setting is
  // nothing. The panel reloads this route immediately afterwards and gets a real
  // read; see invalidateCswapAutoCache.
  invalidateCswapAutoCache();
  // A NEW INTERVAL HAS TO REACH THE TIMER. `tickInterval()` is read once, at
  // startLoop, so changing this setting used to update what the panel reports
  // and nothing else: set 3600 with auto-switch on and the panel read back an
  // hour while the loop kept firing every sixty seconds for the life of the
  // process — sixty `cswap auto --once` spawns an hour instead of one, against
  // the shared per-account request budget this subsystem exists to protect.
  // Lowering it was equally inert.
  if (r.ok && key === "autoswitch.intervalSeconds" && _enabled) {
    stopLoop();
    // startLoop records the ask when one is already in flight, so this can no
    // longer be swallowed by the boot's own start — see the note there (#791).
    await startLoop();
  }
  return r.ok ? { ok: true } : { ok: false, reason: "set_failed", detail: failureDetail(r, 300) };
}

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
 */
async function runAutoTick() {
  const r = await withStoreLock(async () =>
    run(await cswapBin(), ["auto", "--once", "--json"], { timeout: TICK_TIMEOUT_MS }));
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
    return { ok: false, reason: "tick_failed", detail: (r.stderr || "").trim().slice(0, 300) };
  }
  return { ok: true, ...summarise(r.stdout) };
}

// Whether the user is already running `cswap auto` themselves, and the rule
// that tells their loop from the deck's own ticks: cswap-auto-readers.mjs.
export { commandTokens, externalAutoRunning, looksLikeAutoLoop };

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

export async function autoStatus() {
  const [config, external] = await Promise.all([readCswapConfig(), externalAutoRunning()]);
  return {
    ok:        config != null,
    enabled:   _enabled,
    external,                       // user is running their own `cswap auto`
    lastTick:  _lastTick,
    settings:  config ?? {},
  };
}

// ── per-account rotation flag ──────────────────────────────────────────────

/** Hold an account out of auto-rotation, or return it.
 *
 *  UNDER THE MUTEX AND FOLLOWED BY AN INVALIDATION, like every other
 *  mutation of claude-swap's store, and this was the one that was neither.
 *
 *  `cswap enable/disable` writes `accounts[N].disabled` in sequence.json, which
 *  is the field claude-accounts.mjs's roster reads as `disabled` — so it is the
 *  read-modify-write cswap-admin.mjs opens by explaining is why every mutation
 *  goes through one mutex.
 *
 *  And the missing invalidation is what made the press look like a no-op. The
 *  panel polls every 15s and each poll stamps `_lastReadAt`, so that stamp is
 *  never more than 15s old. The press then reloads with ?refresh=1, and a
 *  forced read needs `now - _lastReadAt >= FORCE_POLL_MS` (60s) — a quantity
 *  that can never be reached while the panel is open. The read was refused
 *  every time and `heldReading` handed back the pre-press roster: the chip did
 *  not move, the button still said "hold out", and nothing had failed.
 *  invalidateClaudeAccountsCache sets `_lastReadAt = 0`, which is what makes
 *  the following forced read real work — the invalidator's own docblock says
 *  so, and calls a floor that answers ?refresh=1 with the stale roster "the
 *  guard being the bug". */
export async function setAccountEnabled(accountNum, enabled) {
  const num = slotNumber(accountNum);
  if (num == null) return { ok: false, reason: "bad_account" };
  // Statically, from store-lock.mjs, like the tick above. #950 reached for it
  // through a dynamic `import("./cswap-admin.mjs")` to avoid adding a static
  // edge between two modules that already imported each other, which was the
  // right call while the lock lived inside one of them. It no longer does
  // (#1039), and store-lock.mjs imports nothing at all — so there is no edge to
  // avoid, and the same function arrives without loading the admin surface to
  // get it.
  return withStoreLock(async () => {
    const r = await run(await cswapBin(), [enabled ? "enable" : "disable", String(num)]);
    if (!r.ok) return { ok: false, reason: "command_failed", detail: failureDetail(r, 300) };
    invalidateClaudeAccountsCache();
    return { ok: true };
  });
}
