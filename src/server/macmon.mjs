// The one thermal reading a Mac will not give up on its own.
//
// #747. On Apple Silicon there is no command shipped with macOS that prints a
// CPU or GPU temperature. `powermetrics` needs root. `pmset -g therm` records
// nothing on M-series and answers "No CPU power status has been recorded", so
// there is no throttle row either. The AGX driver does not publish the
// `"Temperature(C)"` that ioreg reads on Intel GPUs. And the SMC keys changed
// with M1 and are inconsistent between models sharing one chip — an M1 Mac mini
// uses different FourCCs from an M1 MacBook Pro, with no public mapping — so
// there is nothing to hard-code either.
//
// The sensors are reachable, and without root: they come through a HID sensor
// hub, which is a private C API. Every tool that shows a temperature on Apple
// Silicon calls it, and every one of them is native code. A Node process cannot,
// and this package has zero runtime dependencies, which is worth more than a
// number.
//
// So it asks a tool the user already has, exactly the way the deck already asks
// `cswap` about accounts and `ccusage` about spend. `macmon` is in
// homebrew-core — `brew install macmon`, no third-party tap — runs without
// sudo, supports M1 through M5, and prints JSON.
//
// COSTS INTEL NOTHING. This is reached only when ioreg has already answered
// with nothing, which on an Intel Mac it never does. Deliberately not gated on
// `process.arch`: a Node built for x64 running under Rosetta on an Apple
// Silicon Mac reports "x64", and gating on that would skip the one machine this
// exists for.
import { run } from "./exec.mjs";
import { existsSync } from "node:fs";

/** Where brew puts it, on both prefixes, because ~/.local/bin's lesson applies
 *  here too: a tool the user installed is not always on the PATH of the shell
 *  that launched the deck. Apple Silicon's prefix first — that is the only
 *  machine that reaches this file. */
export const MACMON_CANDIDATES = [
  "/opt/homebrew/bin/macmon",
  "/usr/local/bin/macmon",
];

/** One sample, then exit. `-i` is the sampling window and its default is a full
 *  second; 200ms is long enough for an average the tool is willing to publish
 *  and short enough that a poll every ten seconds costs nothing anybody can
 *  feel. */
export const MACMON_ARGS = ["pipe", "-s", "1", "-i", "200"];

/**
 * The resolution, remembered — including the failure.
 *
 * `null` means "not looked yet" and `false` means "looked, not there", which is
 * the distinction that keeps a machine without macmon from paying a lookup
 * every ten seconds forever. cswapBin memoizes only success and re-probes on
 * failure; that is right for a tool the deck installs and wrong for one it
 * never will.
 */
let _bin = null;

/** Forget it. For the test, and for the day something installs macmon while the
 *  deck is up — nothing calls this on that path yet, and it is one line. */
export function resetMacmonBin() { _bin = null; }

export async function macmonBin({
  exists = existsSync, probe = defaultProbe, candidates = MACMON_CANDIDATES,
} = {}) {
  if (_bin !== null) return _bin || null;
  // The bare name first, because PATH is the cheap answer and the one a user
  // who installed it themselves will usually have.
  if (await probe("macmon")) return (_bin = "macmon");
  for (const c of candidates) {
    if (exists(c) && await probe(c)) return (_bin = c);
  }
  _bin = false;
  return null;
}

async function defaultProbe(bin) {
  return (await run(bin, ["--version"], { timeout: 4_000 })).ok;
}

/**
 * CPU and GPU degrees out of one `macmon pipe` sample.
 *
 * The shape is `{ temp: { cpu_temp_avg, gpu_temp_avg } }`, both in Celsius —
 * read off macmon's own `TempMetrics` struct rather than guessed from an
 * example, because a field renamed upstream should read as "no sensor" and not
 * as zero.
 *
 * A zero is dropped rather than shown. macmon defaults both fields to 0.0 and
 * fills what it read, so a machine that answered for the CPU and not the GPU
 * arrives as `{ cpu_temp_avg: 47.3, gpu_temp_avg: 0 }` — and 0 °C is not a
 * reading, it is the absence of one wearing a number.
 */
export function tempsFromMacmonJson(json) {
  let d;
  try { d = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return {}; }
  const t = d?.temp;
  if (!t || typeof t !== "object") return {};
  const out = {};
  for (const [key, field] of [["cpu", "cpu_temp_avg"], ["gpu", "gpu_temp_avg"]]) {
    const v = Number(t[field]);
    // The same plausibility floor the rest of the thermal code uses, stated
    // here rather than imported so this module has no opinion to disagree with.
    if (Number.isFinite(v) && v > 0 && v < 150) out[key] = Math.round(v);
  }
  return out;
}

/**
 * Ask macmon, or answer nothing.
 *
 * Never throws and never waits long: `run` does not reject, the sample is
 * capped, and a machine without macmon returns before it spawns anything at
 * all after the first lookup.
 */
export async function readMacmonTemps(deps = {}) {
  const bin = await macmonBin(deps);
  if (!bin) return {};
  const r = await run(bin, MACMON_ARGS, { timeout: 6_000 });
  if (!r.ok) return {};
  // `pipe` prints one JSON object per sample and `-s 1` asks for one, but a
  // build that ever printed a banner first would put it on the same stream.
  const line = r.stdout.split("\n").find(l => l.trim().startsWith("{"));
  return line ? tempsFromMacmonJson(line) : {};
}
