// ccdeck's own tmux, fetched for a machine that has no usable one.
//
// The terminal panel runs every session inside tmux 3.2 or newer, and most of
// the people who run ccdeck have never installed tmux. Installing it for them
// system-wide needs sudo, which a deck that installs nothing outside its own
// folder will not ask for. So ccdeck builds tmux itself — scripts/tmux/build.sh,
// compiled by the `tmux` workflow — and publishes it as a prerelease of its own
// repository. This file fetches the build for this machine into the deck's
// data folder.
//
// THE TRUST IS IN THIS FILE, NOT IN THE RELEASE PAGE. uv-bootstrap.mjs checks
// uv against the SHA-256 that Astral publishes beside it, because Astral is the
// publisher and the deck is not. Here the deck is the publisher, so the hashes
// are written below, in the package the user already chose to run: a release
// asset that was swapped after publication does not match, and is never run.
// Nothing is executed before it matches, nothing lands outside
// <data>/tools/tmux, and deleting that folder undoes all of it.
//
// AGENTS_DECK_NO_INSTALL=1 turns this off with every other managed install, and
// AGENTS_DECK_NO_DOWNLOAD=1 turns off executable downloads alone, as for uv.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { deckDataDir } from "./deck-home.mjs";

/** The build the deck fetches. A new build is a new tag and four new hashes,
 *  copied from the release's SHA256SUMS after reading the workflow run that
 *  made them; tmux-download.test.ts holds the shape. */
export const TMUX_BUILD = Object.freeze({
  tag: "tmux-3.8-1",
  version: "3.8",
  sha256: Object.freeze({
    "linux-x64": "",
    "linux-arm64": "",
    "darwin-x64": "",
    "darwin-arm64": "",
  }),
});

const RELEASES = "https://github.com/BarganConstantin/ccdeck/releases/download";
/** A build is about 1 MB; anything near this is not one. */
const MAX_BYTES = 32 << 20;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Which build this machine runs, or null where ccdeck publishes none.
 *  Rosetta is not special-cased: an x64 Node on Apple silicon gets the x64
 *  build, which runs. Windows has no tmux at all. */
export function tmuxBuildKey(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" && platform !== "darwin") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `${platform}-${arch}`;
}

/** The archive's name in the release, matching build.sh's output. */
export function tmuxAssetName(key, build = TMUX_BUILD) {
  return `tmux-${build.version}-${key}.tar.gz`;
}

/** Where the fetched tmux lives. One folder per build, so a newer build never
 *  replaces a binary a running tmux server was started from. */
export function managedTmuxDir(dataDir = deckDataDir(), build = TMUX_BUILD) {
  return join(dataDir, "tools", "tmux", build.tag);
}

/** The fetched binary's path, whether or not it has been fetched. */
export function managedTmuxPath(dataDir = deckDataDir(), build = TMUX_BUILD) {
  return join(managedTmuxDir(dataDir, build), "tmux");
}

/** Why a download cannot be offered here, or null when it can. */
export function tmuxDownloadBlocked({
  env = process.env, platform = process.platform, arch = process.arch, build = TMUX_BUILD,
} = {}) {
  if (env.AGENTS_DECK_NO_INSTALL === "1") return "install_disabled";
  if (env.AGENTS_DECK_NO_DOWNLOAD === "1") return "download_disabled";
  const key = tmuxBuildKey(platform, arch);
  if (!key) return "unsupported_platform";
  if (!/^[0-9a-f]{64}$/.test(build.sha256[key] ?? "")) return "not_published";
  return null;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** execFile, resolved rather than thrown: `{ code, stdout }`. */
function exec(file, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? "") });
    });
  });
}

/**
 * Fetch, verify and unpack this machine's build into managedTmuxDir.
 *
 * Resolves `{ ok: true, path }` or `{ ok: false, reason }` and never rejects:
 * a deck without tmux is an expected state, and the panel says why. Reasons:
 * install_disabled, download_disabled, unsupported_platform, not_published,
 * download_failed, too_large, checksum_mismatch, extract_failed, does_not_run.
 */
export async function downloadTmux({
  dataDir = deckDataDir(), env = process.env, platform = process.platform, arch = process.arch,
  build = TMUX_BUILD, fetchImpl = globalThis.fetch, execImpl = exec,
} = {}) {
  const blocked = tmuxDownloadBlocked({ env, platform, arch, build });
  if (blocked) return { ok: false, reason: blocked };
  const key = tmuxBuildKey(platform, arch);
  const dest = managedTmuxDir(dataDir, build);

  let archive;
  try {
    const res = await fetchImpl(`${RELEASES}/${build.tag}/${tmuxAssetName(key, build)}`, {
      redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: "download_failed" };
    const length = Number(res.headers?.get?.("content-length") ?? 0);
    if (length > MAX_BYTES) return { ok: false, reason: "too_large" };
    archive = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: "download_failed" };
  }
  if (archive.length > MAX_BYTES) return { ok: false, reason: "too_large" };
  if (sha256(archive) !== build.sha256[key]) return { ok: false, reason: "checksum_mismatch" };

  // Unpacked inside the tools folder, under a name nobody can predict — the
  // lesson uv-bootstrap.mjs records about a staging directory in /tmp — and
  // moved into place only after the binary has run.
  const parent = join(dataDir, "tools", "tmux");
  let staging = null;
  try {
    await mkdir(parent, { recursive: true });
    staging = await mkdtemp(join(parent, ".staging-"));
    const file = join(staging, "build.tar.gz");
    await writeFile(file, archive);
    const untar = await execImpl("tar", ["-xzf", file, "-C", staging]);
    await rm(file, { force: true });
    const bin = join(staging, "tmux");
    if (untar.code !== 0 || !existsSync(bin)) return { ok: false, reason: "extract_failed" };
    await chmod(bin, 0o755);
    const v = await execImpl(bin, ["-V"]);
    if (v.code !== 0 || !v.stdout.trim().startsWith(`tmux ${build.version}`)) return { ok: false, reason: "does_not_run" };
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    staging = null;
    return { ok: true, path: join(dest, "tmux") };
  } catch {
    return { ok: false, reason: "extract_failed" };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

let flight = null;
let lastFailure = null;
/** How long a failed download is believed before the next status asks again:
 *  long enough that a panel polling while offline does not hammer GitHub,
 *  short enough that a reconnect is noticed without a deck restart. */
export const RETRY_AFTER_MS = 5 * 60_000;

/**
 * downloadTmux, once at a time: every caller while a download is out shares
 * it, and a finished one — good or bad — lets the next caller try again.
 */
export function ensureManagedTmux(options, now = Date.now) {
  flight ??= downloadTmux(options).then((r) => {
    lastFailure = r.ok ? null : { reason: r.reason, at: now() };
    return r;
  }).finally(() => { flight = null; });
  return flight;
}

/** Whether a download is out right now, for the panel's "setting up" line. */
export const tmuxDownloading = () => flight !== null;

/** The last download's failure while it is still believed, else null. */
export function recentTmuxFailure(now = Date.now) {
  return lastFailure && now() - lastFailure.at < RETRY_AFTER_MS ? lastFailure : null;
}

/** For tests: forget the last failure. */
export function resetTmuxDownload() { lastFailure = null; }
