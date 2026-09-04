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
import { renameWithRetry } from "./installer.mjs";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const TOOL_DIR   = join(homedir(), ".agents-deck", "tools");
const MACMON_DIR = join(TOOL_DIR, "macmon");

/** Where the deck puts its own copy, and where brew puts one on both prefixes —
 *  because ~/.local/bin's lesson applies here too: a tool the user installed is
 *  not always on the PATH of the shell that launched the deck. Ours first, so a
 *  machine that has both uses the one whose version this code was written
 *  against. Apple Silicon's brew prefix before Intel's; that is the only
 *  machine that reaches this file. */
export const MACMON_CANDIDATES = [
  join(MACMON_DIR, "macmon"),
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

// ── fetching it, so the user does not have to ────────────────────────────────
//
// `npx ccdeck` should work, and on Apple Silicon "work" includes the two rows
// this file exists for. Telling somebody to run a brew command first is a step,
// and a step is a thing most people will not take.
//
// So the deck fetches macmon the same way it already fetches uv — see
// uv-bootstrap.mjs, whose shape this follows including the parts that were
// learned the hard way. NOT through Homebrew: a machine without brew would then
// need brew installed first, which is a very large thing to do to somebody who
// asked for a dashboard.
//
// WHAT MAKES THIS SAFE TO RUN ON SOMEBODY'S MACHINE, each verified against the
// real release rather than assumed:
//
//   * There is a prebuilt binary. `macmon-v0.8.2.tar.gz`, 746 KB, containing a
//     `Mach-O 64-bit executable arm64`. No compiler, no toolchain, no Rust.
//   * There is a checksum. The release publishes no `.sha256` file, but the
//     GitHub releases API carries a `digest` field per asset, and it matched
//     the bytes actually downloaded. An unverified binary is not something to
//     run on someone's machine, which is uv-bootstrap's rule and is kept here.
//   * It will execute. Apple Silicon refuses an unsigned binary; this one is
//     `adhoc, linker-signed`, which is what the Rust toolchain emits and what
//     macOS accepts. And a programmatic download carries no
//     com.apple.quarantine — only com.apple.provenance, which blocks nothing —
//     so there is no Gatekeeper prompt and nothing for the user to click.
//
// NEVER ON THE BOOT'S CRITICAL PATH. It is started by the thermal sampler, on
// the tick where it found no reading, and nothing waits for it. The boot was
// just taught not to wait for an install (#742) and this does not undo that.

const RELEASE_API = "https://api.github.com/repos/vladkens/macmon/releases/latest";
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** One attempt per process. A machine that is offline, or behind a proxy that
 *  refuses GitHub, must not re-download every ten seconds for as long as the
 *  deck runs — and a success does not need a second attempt either. */
let _fetched = false;

/** Cleared with the resolution, so a test can run the whole thing twice. */
export function resetMacmonFetch() { _fetched = false; }

/**
 * The asset to download, out of what the release actually published.
 *
 * Pure and exported: this is the part that has to keep working when the project
 * changes its file names, and the only way to check that from here is to feed
 * it a release document. `digest` is `sha256:<hex>` — the prefix is part of the
 * field and dropping it silently would make every download fail verification.
 */
export function macmonAsset(release) {
  const tag = release?.tag_name;
  const a = (release?.assets ?? []).find(x => typeof x?.name === "string" && x.name.endsWith(".tar.gz"));
  if (!a?.browser_download_url) return null;
  const m = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ""));
  if (!m) return null;
  return { version: typeof tag === "string" ? tag : "unknown", url: a.browser_download_url, sha256: m[1] };
}


/**
 * Download macmon into ~/.agents-deck/tools/macmon.
 *
 * Returns `{ ok: true, bin, version }` or `{ ok: false, reason }`, and never
 * throws: every caller treats a missing macmon as an ordinary state.
 *
 * Apple Silicon only, because that is the only build published and the only
 * machine that has anything to gain — an Intel Mac already answers through
 * ioreg and never reaches this file at all.
 */
export async function bootstrapMacmon({
  platform = process.platform, arch = process.arch, env = process.env,
  fetchFn = fetch, dir = MACMON_DIR, findBin = macmonBin,
} = {}) {
  if (platform !== "darwin") return { ok: false, reason: "unsupported_platform" };
  // ARM64 ONLY, checked rather than merely documented. The release publishes
  // one asset and it is an arm64 Mach-O, so an Intel Mac downloaded 746 KB it
  // could not execute and failed its own --version check afterwards. That is
  // the small half. The larger half is the promise: the README says an Intel
  // Mac never downloads anything, and this reached api.github.com on any Mac
  // whose sensors happened to stay silent — which an Intel Mac's do whenever
  // ioreg publishes no Temperature(C).
  if (arch !== "arm64") return { ok: false, reason: "unsupported_arch" };
  // A macmon the user already has is the other thing the README promises to
  // notice, and until now the skip was emergent rather than checked: a working
  // copy produces a reading, the reading sets thermalEverAnswered, and the
  // give-up branch never fires. That chain breaks on a macmon which runs but
  // reports values this deck rejects as implausible — and then a machine with
  // macmon on PATH downloaded a second one.
  if (await findBin()) return { ok: false, reason: "already_installed" };
  // Both switches, for the reason uv-bootstrap has both: downloading an
  // executable is a bigger step than installing a package with a tool the user
  // already chose, so somebody may want the managed installs and not this.
  if (env.AGENTS_DECK_NO_INSTALL === "1") return { ok: false, reason: "installs_disabled" };
  if (env.AGENTS_DECK_NO_DOWNLOAD === "1") return { ok: false, reason: "download_disabled" };
  if (_fetched) return { ok: false, reason: "already_tried" };
  _fetched = true;

  let staging = null;
  let partial = null;
  try {
    const res = await fetchFn(RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: "release_lookup_failed" };
    const asset = macmonAsset(await res.json());
    // No published digest means no way to know what was downloaded. There is no
    // fallback version here on purpose: uv can have one because any recent uv
    // installs claude-swap, while a hard-coded macmon URL would be a checksum
    // this file invented for bytes it has never seen.
    if (!asset) return { ok: false, reason: "no_verifiable_asset" };

    const dl = await fetchFn(asset.url, {
      redirect: "follow",
      headers: { "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!dl.ok) return { ok: false, reason: "download_failed" };
    const archive = Buffer.from(await dl.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== asset.sha256) {
      return { ok: false, reason: "checksum_mismatch" };
    }

    // mkdtemp under a directory the user already owns, for every reason
    // uv-bootstrap gives: the name cannot be guessed, and mkdtemp CREATES
    // rather than accepting a directory somebody else made.
    // Staged beside the destination rather than in the system temp directory,
    // so the rename below is same-filesystem and therefore atomic.
    await mkdir(dir, { recursive: true });
    staging = await mkdtemp(join(dir, "macmon-staging-"));
    const archivePath = join(staging, "macmon.tar.gz");
    await writeFile(archivePath, archive);
    if (!(await run("tar", ["-xzf", archivePath, "-C", staging], { timeout: 60_000 })).ok) {
      return { ok: false, reason: "extract_failed" };
    }

    // The archive is flat — readme.md, LICENSE, macmon — so this is a name
    // rather than a search. It is checked instead of assumed because a layout
    // change upstream should read as "not in the archive", not as a crash.
    const found = join(staging, "macmon");
    if (!existsSync(found)) return { ok: false, reason: "not_in_archive" };

    // Copied to a name of its own inside the destination — same filesystem, so
    // the rename below is the atomic kind — and only becomes `macmon` once it
    // is whole, flushed, executable, and has answered `--version`. Interrupt
    // this and all that is left is an inert temp file.
    partial = join(dir, `.macmon-${process.pid}-${Date.now().toString(36)}`);
    await copyFile(found, partial);
    const handle = await open(partial, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await chmod(partial, 0o755);

    // The binary is adhoc/linker-signed and carries no quarantine, so this
    // should simply run — and if some future build does not, the deck finds out
    // here rather than by leaving a file every later boot trusts.
    if (!(await run(partial, ["--version"], { timeout: 20_000 })).ok) {
      return { ok: false, reason: "does_not_run" };
    }

    const dest = join(dir, "macmon");
    await renameWithRetry(partial, dest);
    partial = null;
    // The resolution memo remembers a failure, and the failure it remembers is
    // "there is no macmon". There is one now.
    resetMacmonBin();
    return { ok: true, bin: dest, version: asset.version };
  } catch (err) {
    return { ok: false, reason: "error", detail: String(err?.message ?? err).slice(0, 200) };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }).catch(() => {});
    if (partial) await rm(partial, { force: true }).catch(() => {});
  }
}
