// Last-resort acquisition of `uv`, so claude-swap can be installed on a machine
// with no Python tooling at all.
//
// The alternative everyone reaches for is `curl -LsSf https://astral.sh/uv/
// install.sh | sh`, which executes whatever that URL happens to serve, with the
// user's privileges, and drops files into their global tool path. This does the
// narrower thing instead: fetch one named release artifact from Astral's own
// GitHub releases, check it against the SHA-256 that release publishes beside
// it, and unpack it inside ~/.agents-deck. Nothing is executed until it has
// been verified, nothing lands outside a directory the deck already owns — the
// staging directory included, which is what #551 was about — and deleting that
// directory undoes all of it.
//
// It is still a network fetch of an executable, so it only happens when there
// is no other way: uv, pipx, and python -m pipx have all already been ruled out
// by the caller. AGENTS_DECK_NO_INSTALL=1 disables it along with everything else.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, chmod, readdir, copyFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { run } from "./exec.mjs";
// The same rename used to replace settings.json, for the same reason: on
// Windows a rename over an existing file fails outright while any other process
// holds the target open, and a virus scanner or the search indexer opens a
// freshly written executable the instant it appears. Sharing one implementation
// keeps the retryable-error list from drifting apart between the two callers.
import { renameWithRetry } from "./installer.mjs";

const TOOL_DIR = join(homedir(), ".agents-deck", "tools");
const UV_DIR   = join(TOOL_DIR, "uv");

const RELEASE_API = "https://api.github.com/repos/astral-sh/uv/releases/latest";
const DOWNLOAD_BASE = "https://github.com/astral-sh/uv/releases/download";

// Used when the releases API cannot be reached — rate limiting is per-IP and
// unauthenticated, so this is a normal outcome rather than an error. Any
// reasonably recent uv can install claude-swap; it self-updates later.
const FALLBACK_VERSION = "0.12.3";

const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Release artifact for this machine, or null if uv does not publish one.
 *
 * Rosetta is deliberately not special-cased: an x64 Node on Apple Silicon
 * reports x64 and gets the x64 build, which runs.
 */
export function assetName(platform = process.platform, arch = process.arch) {
  const a = { x64: "x86_64", arm64: "aarch64", ia32: "i686" }[arch];
  if (!a) return null;
  // Apple publishes no i686 build, and never will.
  if (platform === "darwin") return a === "i686" ? null : `uv-${a}-apple-darwin.tar.gz`;
  if (platform === "win32")  return `uv-${a}-pc-windows-msvc.zip`;
  if (platform === "linux")  return `uv-${a}-unknown-linux-gnu.tar.gz`;
  return null;
}

/** Path to a uv this function installed earlier, or null. */
export function existingBootstrappedUv() {
  const bin = join(UV_DIR, process.platform === "win32" ? "uv.exe" : "uv");
  return existsSync(bin) ? bin : null;
}

async function latestVersion() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return FALLBACK_VERSION;
    const tag = (await res.json())?.tag_name;
    return typeof tag === "string" && /^\d/.test(tag) ? tag : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

async function download(url, { asText = false } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "agents-deck" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return asText ? (await res.text()) : Buffer.from(await res.arrayBuffer());
}

/**
 * A path as a PowerShell single-quoted string literal.
 *
 * Inside single quotes PowerShell expands nothing, so a doubled quote is both
 * the only escape it has and the only one needed. Windows filenames cannot
 * contain `"`, `<`, `>` or `|`, but they can contain an apostrophe — and the
 * archive lands under the user's own profile either way, which is where an
 * apostrophe comes from: C:\Users\O'Brien\.agents-deck\tools. Pasted in raw,
 * that apostrophe ended the string mid-path and Expand-Archive died of a syntax
 * error, so uv could never be bootstrapped on an account whose owner has that
 * name.
 */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The command that unpacks the artifact, as file + argv.
 *
 * `tar` is present on macOS, on Linux, and on Windows 10 1803 and later (as
 * bsdtar), but Windows ships .zip and older Windows has no tar at all — so zip
 * goes through PowerShell's Expand-Archive, which is always there.
 *
 * Exported, pure, and with the platform as a parameter, because the branch that
 * needs checking is the one that never runs on the machine running the tests.
 *
 * Only the tar branch gets to pass its paths as arguments. `powershell.exe
 * -Command` has no argument channel to pass them through — everything after
 * -Command is joined back into the script text — so the paths are part of a
 * PowerShell program either way, and quoting them for PowerShell is the whole
 * job. Nothing else is quoting them on the way there: powershell.exe is an .exe,
 * so exec.mjs spawns it directly with shell:false and the -Command string
 * arrives as one intact argv entry, never seeing cmd.exe.
 */
export function extractCommand(archivePath, destDir, platform = process.platform) {
  if (platform === "win32" && archivePath.endsWith(".zip")) {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath ${psQuote(archivePath)} ` +
        `-DestinationPath ${psQuote(destDir)} -Force`,
      ],
    };
  }
  return { file: "tar", args: ["-xzf", archivePath, "-C", destDir] };
}

/** Unpack the artifact. */
async function extract(archivePath, destDir) {
  const { file, args } = extractCommand(archivePath, destDir);
  const r = await run(file, args, { timeout: 120_000 });
  return r.ok;
}

/**
 * Find the uv executable somewhere under `dir`.
 *
 * The archives put it in a versioned subdirectory whose name has changed
 * between releases, so it is located rather than assumed.
 */
async function findUv(dir, depth = 0) {
  const wanted = process.platform === "win32" ? "uv.exe" : "uv";
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name === wanted) return join(dir, e.name);
  }
  if (depth >= 2) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findUv(join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Download and verify uv into ~/.agents-deck/tools/uv.
 *
 * Returns { ok: true, bin, version } or { ok: false, reason }. Never throws:
 * every caller treats a missing uv as an expected state.
 */
export async function bootstrapUv() {
  // A uv from an earlier run is reused, but only once it has proved it still
  // runs. Existing-and-therefore-good was a one-way door: the caller has no
  // other installer left by the time it gets here, and nothing anywhere ever
  // deletes or re-checks this path, so a uv that had been damaged — by an
  // interrupted copy from a deck older than this fix, a half-finished disk
  // restore, a truncating backup tool — made every boot from then on fail with
  // `install_failed` until the user found and deleted the directory by hand.
  // One `--version` costs milliseconds and turns that into a re-download.
  const already = existingBootstrappedUv();
  if (already && (await run(already, ["--version"], { timeout: 15_000 })).ok) {
    return { ok: true, bin: already, version: "existing" };
  }
  // A broken one is deliberately left where it is rather than deleted: the
  // download below renames its replacement over it, and if the download cannot
  // happen the file is harmless — every caller probes `--version` before using
  // it, so a uv that does not answer is already treated as absent.

  // Downloading an executable is a bigger step than installing a package with a
  // tool the user already chose, so it gets its own off switch as well as the
  // blanket one — someone may want the managed installs and not this.
  if (process.env.AGENTS_DECK_NO_DOWNLOAD === "1") return { ok: false, reason: "download_disabled" };

  const asset = assetName();
  if (!asset) return { ok: false, reason: "unsupported_platform" };

  const version = await latestVersion();
  const base = `${DOWNLOAD_BASE}/${version}/${asset}`;

  // Created inside the try, because it is created rather than merely named:
  // see the mkdtemp below for why that distinction is the whole fix.
  let staging = null;
  // Set while a half-finished binary exists under a name of its own, cleared the
  // moment it is renamed into place; the finally below removes whatever is left.
  let partial = null;
  try {
    const [archive, sumText] = await Promise.all([
      download(base),
      download(`${base}.sha256`, { asText: true }),
    ]);
    if (!archive) return { ok: false, reason: "download_failed" };

    // No published checksum means no way to know what was downloaded, and an
    // unverified binary is not something to run on someone's machine.
    const expected = sumText?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      return { ok: false, reason: "no_checksum" };
    }
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expected) return { ok: false, reason: "checksum_mismatch" };

    // ── where the archive is unpacked, and why it is not the system temp dir ──
    //
    // This used to be `join(tmpdir(), `agents-deck-uv-${process.pid}`)`, created
    // with `mkdir(..., { recursive: true })` — which does not fail on a
    // directory that is already there.
    //
    // On macOS tmpdir() is a per-user `/var/folders/…/T` and on Windows it is
    // inside the profile, so the header's promise held on both. On Linux it is
    // `/tmp`, mode 1777, writable by every account on the box. The comment two
    // hundred lines up reasons carefully about tmpdir() being inside the user's
    // profile ON WINDOWS and never asks the Linux question.
    //
    // Three things then line up. The name is derived from a pid, so it is
    // cheap to blanket the whole plausible range in advance. `findUv` returns a
    // depth-0 file before it recurses, while the genuine uv always sits one
    // level down inside the archive's versioned directory — so a planted
    // `/tmp/agents-deck-uv-<pid>/uv` wins deterministically rather than by
    // racing. And the SHA-256 above is computed on the downloaded buffer, never
    // on the extracted file, so it does not cover the thing that is executed.
    // What followed was a copy, a chmod 0755, a `--version` run, a rename to
    // the permanent name and reuse of that name forever.
    //
    // `mkdtemp` under TOOL_DIR fixes all three at once: the directory is inside
    // a tree the user already owns, its name is unpredictable, and mkdtemp
    // CREATES — it cannot be handed a directory somebody else made. findUv's
    // ordering is left alone deliberately; it is not wrong on its own, and it
    // stops being reachable once nobody else can write here.
    await mkdir(TOOL_DIR, { recursive: true });
    staging = await mkdtemp(join(TOOL_DIR, "uv-staging-"));
    const archivePath = join(staging, asset);
    await writeFile(archivePath, archive);
    if (!(await extract(archivePath, staging))) return { ok: false, reason: "extract_failed" };

    const found = await findUv(staging);
    if (!found) return { ok: false, reason: "not_in_archive" };

    await mkdir(UV_DIR, { recursive: true });
    const dest = join(UV_DIR, process.platform === "win32" ? "uv.exe" : "uv");

    // Copy rather than rename out of staging: the staging dir is in the system
    // temp directory, which is often a different filesystem, and rename across
    // one fails. But the copy goes to a name of its own INSIDE UV_DIR — same
    // filesystem as the destination, so THAT rename is the atomic kind — and
    // only becomes `uv` once it is whole, flushed, executable and has answered
    // `--version`. Copying 40MB straight to the final name is many writes long,
    // and a Ctrl-C in the middle of them (the boot install runs before the
    // signal handlers are up) left a truncated file under the name every later
    // run trusts. Interrupt this instead and all that is left is an inert temp
    // file: `uv` either does not exist or is a binary that ran once already.
    // The pid keeps two decks starting at once off each other's copy, and the
    // .exe keeps the file executable on Windows, where the version check below
    // would otherwise have nothing to spawn.
    const suffix = process.platform === "win32" ? ".exe" : "";
    partial = join(UV_DIR, `.uv-${process.pid}-${Date.now().toString(36)}${suffix}`);
    await copyFile(found, partial);
    // Flushed before the rename, so a crash or power cut just after a
    // successful bootstrap cannot leave the name pointing at blocks that were
    // never written — the same guarantee writeFileAtomic gives settings.json.
    const handle = await open(partial, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== "win32") await chmod(partial, 0o755);

    const check = await run(partial, ["--version"], { timeout: 15_000 });
    if (!check.ok) return { ok: false, reason: "does_not_run" };

    await renameWithRetry(partial, dest);
    partial = null;

    return { ok: true, bin: dest, version };
  } catch (err) {
    return { ok: false, reason: "error", detail: String(err?.message ?? err).slice(0, 200) };
  } finally {
    // maxRetries for the reason the ccusage repair gives: the archive was just
    // unpacked here and `partial` was just run out of it, and on Windows a file
    // a handle has not finished releasing cannot be deleted — the directory
    // then refuses to go with ENOTEMPTY. Litter rather than a failure, since
    // this is swallowed, but litter in the user's home that nothing else sweeps.
    if (staging) await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }).catch(() => {});
    if (partial) await rm(partial, { force: true }).catch(() => {});
  }
}
