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
//
// Split three ways: this module writes the settings, answers the status route
// and holds an account out of rotation; cswap-auto-readers.mjs takes the two
// readings behind that route, and cswap-auto-loop.mjs runs the ticks.
import { run } from "./exec.mjs";
import { failureDetail } from "./exec-output.mjs";
import { cswapBin } from "./cswap-install.mjs";
import {
  commandTokens, externalAutoRunning, invalidateCswapAutoCache, looksLikeAutoLoop, readCswapConfig,
} from "./cswap-auto-readers.mjs";
import { initCswapAuto, lastTick, loopEnabled, restartLoop, setAutoEnabled } from "./cswap-auto-loop.mjs";
import { invalidateClaudeAccountsCache, slotNumber } from "./claude-accounts.mjs";
// The one store mutex, which the rotation flag below holds like every other
// writer of claude-swap's store.
import { withStoreLock } from "./store-lock.mjs";

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
  if (r.ok && key === "autoswitch.intervalSeconds" && loopEnabled()) {
    await restartLoop();
  }
  return r.ok ? { ok: true } : { ok: false, reason: "set_failed", detail: failureDetail(r, 300) };
}

// Whether the user is already running `cswap auto` themselves, and the rule
// that tells their loop from the deck's own ticks: cswap-auto-readers.mjs.
export { commandTokens, externalAutoRunning, looksLikeAutoLoop };

// The deck-managed loop — its interval, one tick at a time, the switch that
// turns it on and the boot that restores it — and what one tick is:
// cswap-auto-loop.mjs.
export { initCswapAuto, setAutoEnabled };

export async function autoStatus() {
  const [config, external] = await Promise.all([readCswapConfig(), externalAutoRunning()]);
  return {
    ok:        config != null,
    enabled:   loopEnabled(),
    external,                       // user is running their own `cswap auto`
    lastTick:  lastTick(),
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
 *  press reloads with ?refresh=1 milliseconds after the read before it, and a
 *  forced read needs `now - _lastReadAt` past its floor — then FORCE_POLL_MS
 *  (60s), which the panel's 15s poll never let it reach; the cache's 5s since
 *  #1798, which the reload after a press still cannot. The read was refused
 *  and `heldReading` handed back the pre-press roster: the chip did not move,
 *  the button still said "hold out", and nothing had failed.
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
