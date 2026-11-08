// Getting the Command Panel's engine onto this machine when the terminal
// needs it, and taking it off again: the one install at a time, its progress,
// its failure, and what an install cut short left behind.
//
// THREE SOURCES, ONE INSTALLER. The package npm put beside the deck, and the
// desktop app's copy, are brought in by command-panel-engine.mjs with no
// question (engine-package.mjs). This file adds the third source the page
// offers when neither is there: the same package from the npm registry after
// an Install press (engine-download.mjs), or a package file the person picks.
// Each ends in importEngine, so every engine is held to the one standard:
// signed manifest, size and SHA-256, header, no downgrade, an atomic swap.
//
// NOTHING STARTS BY ITSELF. Importing this does no I/O; `status` reads only
// this machine (no network); a download starts only from `install`, which
// only the Install route calls. AGENTS_DECK_NO_INSTALL=1 or
// AGENTS_DECK_NO_DOWNLOAD=1 turn the download off, as they do for tmux; a
// package file can still be installed.
//
// ONE AT A TIME, ACROSS TABS AND DECKS. In this process the job is one value
// that every tab reads (so a second tab mirrors the first one's progress),
// and every change to the engine folder runs under `withEngineLock`, which
// command-panel-engine.mjs's own import takes too. Across processes sharing
// the data folder, a lock file beside the engine folder names the holder;
// a holder that is gone, or a lock older than LOCK_STALE_MS, is taken over.
//
// CUT SHORT IS PUT RIGHT. A deck that stopped mid-install can leave a
// download or an import folder, or the previous engine set aside with no
// engine in its place (importEngine renames the old folder away before the
// new one lands). The next status, when nothing is installing, removes the
// leftovers and renames the previous engine back, and says so once.
import { constants, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import {
  EngineDownloadError, ENGINE_REGISTRY, enginePin, fetchEngineTarball, placePackage, readPackageTarball,
} from "./engine-download.mjs";
import { ENGINE_PACKAGE_NAMES, importEngine } from "./engine-package.mjs";
import { TARGETS, compareVersions, verifyEngineInstallation } from "./pro-engine-install.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";

/** The lock file beside the engine folder. */
export const LOCK_FILE = "engine.lock";
/** A lock this old is a deck that died holding it. An install is a download
 *  of tens of MB and a copy; ten minutes is far past one. */
export const LOCK_STALE_MS = 10 * 60_000;
/**
 * ccdeck's own data folder, made writable by its owner alone. The engine is
 * verified only where no parent folder is writable by anyone else
 * (pro-engine-install.mjs), and several of the deck's writers create this
 * folder with the default mode, so under a 0002 umask (Ubuntu's default) it
 * can be 0775 and every engine in it refused, read as a check that failed.
 * Only this one folder, only when it is the user's own and never on Windows,
 * whose ACLs are checked their own way; any parent above it is left as is.
 */
export async function tightenDataFolder(dir, platform = process.platform) {
  if (platform === "win32" || typeof process.getuid !== "function") return;
  try {
    const s = await fs.stat(dir);
    if (!s.isDirectory() || s.uid !== process.getuid() || !(s.mode & 0o022)) return;
    await fs.chmod(dir, s.mode & 0o7755 & ~0o022);
  } catch {
    // Not there yet, or not ours to change: the check says why later.
  }
}

/** How long the page is told an install cut short was put right. */
const RECOVERED_SAID_MS = 15_000;

// Every change to the engine folder in this process, one after another.
let lockTail = Promise.resolve();
let lockHeld = 0;

/** Runs `fn` once every earlier change to the engine folder has finished. */
export function withEngineLock(fn) {
  lockHeld += 1;
  const run = lockTail.then(fn);
  lockTail = run.catch(() => {}).finally(() => { lockHeld -= 1; });
  return run;
}

/** Whether a change to the engine folder runs, or waits, in this process. */
export const engineLockHeld = () => lockHeld > 0;

/** Whether process `pid` is alive (EPERM: alive, another user's). */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** Takes the data folder's lock file, or answers false when a live holder
 *  has it. A gone or stale holder's lock is taken over once. */
async function takeLock(dataDir, now) {
  const file = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() })); } finally { await handle.close(); }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let holder = null;
    try { holder = JSON.parse(await fs.readFile(file, "utf8")); } catch { /* unreadable: treated as stale */ }
    const fresh = holder && Number.isFinite(holder.at) && now() - holder.at < LOCK_STALE_MS;
    if (fresh && holder.pid !== process.pid && alive(holder.pid)) return false;
    if (fresh && holder.pid === process.pid) return false;
    await fs.rm(file, { force: true });
  }
  return false;
}

async function dropLock(dataDir) {
  const file = join(dataDir, LOCK_FILE);
  try {
    const holder = JSON.parse(await fs.readFile(file, "utf8"));
    if (holder?.pid === process.pid) await fs.rm(file, { force: true });
  } catch { /* already gone */ }
}

/** Whether another live process holds the data folder's lock now. */
async function lockedElsewhere(dataDir, now) {
  try {
    const holder = JSON.parse(await fs.readFile(join(dataDir, LOCK_FILE), "utf8"));
    return holder?.pid !== process.pid && Number.isFinite(holder?.at) && now() - holder.at < LOCK_STALE_MS && alive(holder.pid);
  } catch {
    return false;
  }
}

/** The bytes under `dir`, for "Frees N MB": the engine folder is a handful
 *  of files, so a walk is cheap. Links are counted as themselves. */
async function folderBytes(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else total += (await fs.lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** The data folder as `~/…` for the one command that gives it back to its
 *  user, or null where it is not under the home folder (a path with another
 *  user's name is never sent) or on Windows, which has no such one line.
 *  Only plain names: nothing a shell would read as more than a path. */
function fixPathOf(dir, platform, home) {
  if (platform === "win32" || !home) return null;
  const rel = relative(home, dir);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  const parts = rel.split(sep);
  if (!parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part))) return null;
  return `~/${parts.join("/")}`;
}

/** The failure an error is, with the step it happened at. */
function failureOf(error, step) {
  if (error instanceof EngineDownloadError) return { code: error.code === "too-large" ? "check-failed" : error.code, step: error.step };
  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") return { code: "no-permission", step };
  if (error?.code === "ENOSPC" || error?.code === "EDQUOT") return { code: "no-space", step };
  return { code: "failed", step };
}

/**
 * The deck's engine installer. `status()`, `install()`, `installFile(bytes)`,
 * `cancel()`, `remove()`, `recover()`.
 *
 * `keys` are the deck's trusted keys (ENGINE_PUBLIC_KEYS); with none, nothing
 * can be verified, so nothing is offered. `beforeChange` stops the running
 * engine before its folder is swapped or removed (a running executable cannot
 * be replaced on Windows). `platform`, `arch`, `env`, `dataFolder`, `root`
 * (where the deck's package.json is), `registry`, `fetchImpl`,
 * `importPackage`, `now` and `home` are there for tests.
 */
export function createEngineInstaller({
  platform = process.platform, arch = process.arch, env = process.env, keys = [], dataFolder, root,
  registry = ENGINE_REGISTRY, fetchImpl, importPackage = importEngine, beforeChange = async () => {}, now = Date.now,
  home = () => { try { return homedir(); } catch { return ""; } },
} = {}) {
  const dataDir = () => dataFolder ?? deckDataDir(platform, env);
  const destination = () => join(dataDir(), "engine");
  const machine = `${platform}-${arch}`;
  const packageName = Object.hasOwn(ENGINE_PACKAGE_NAMES, machine) ? ENGINE_PACKAGE_NAMES[machine] : null;
  const supported = !!packageName && !!TARGETS[machine];
  let job = null; // { id, phase, received, total, source, startedAt, controller }
  let last = null; // { id, outcome, code?, step?, version?, at }
  let recoveredAt = null;

  const downloadOff = () => env.AGENTS_DECK_NO_INSTALL === "1" || env.AGENTS_DECK_NO_DOWNLOAD === "1";

  /** Why nothing can be installed here at all, or null. */
  const blockedAlways = () => (!supported ? "unsupported" : keys.length === 0 ? "no-keys" : null);

  const installed = async () => {
    if (keys.length === 0) return null;
    try {
      const found = await verifyEngineInstallation({ directory: destination(), publicKey: keys, platform, arch });
      return { version: found.version, bytes: await folderBytes(destination()) };
    } catch {
      return null;
    }
  };

  /** Removes what an install cut short left behind, and puts a set-aside
   *  engine back where none stands. Only while nothing installs, here or in
   *  another deck. Answers whether anything was put right. */
  async function recover() {
    if (job || engineLockHeld()) return false;
    const dir = dataDir();
    if (await lockedElsewhere(dir, now)) return false;
    return withEngineLock(async () => {
      let names;
      try { names = await fs.readdir(dir); } catch { return false; }
      let changed = false;
      for (const name of names) {
        if (/^engine-(?:download|import)-/.test(name)) {
          await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
          changed = true;
        }
      }
      const aside = names.filter((name) => /^engine-previous-/.test(name));
      if (aside.length) {
        const standing = await fs.lstat(destination()).then(() => true, () => false);
        const stats = await Promise.all(aside.map(async (name) => ({ name, at: (await fs.lstat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
        stats.sort((a, b) => b.at - a.at);
        let rest = stats;
        if (!standing) {
          await fs.rename(join(dir, stats[0].name), destination()).catch(() => {});
          rest = stats.slice(1);
        }
        for (const { name } of rest) await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
        changed = true;
      }
      if (changed) recoveredAt = now();
      return changed;
    });
  }

  /** What the page reads: this machine only, never the network. */
  async function status() {
    await recover().catch(() => {});
    const pin = await enginePin({ platform, arch, ...(root ? { root } : {}) });
    const always = blockedAlways();
    const blocked = always ?? (!pin ? "not-published" : downloadOff() ? "download-disabled" : null);
    const present = await fs.lstat(destination()).then(() => true, () => false);
    return {
      platform: machine,
      app: RUNNING_VERSION ?? null,
      fixPath: fixPathOf(dataDir(), platform, home()),
      supported,
      blocked,
      canInstallFile: always === null,
      installed: await installed(),
      present,
      pinned: pin?.version ?? null,
      job: job ? { id: job.id, phase: job.phase, received: job.received, total: job.total, source: job.source, startedAt: job.startedAt } : null,
      last,
      recovered: recoveredAt !== null && now() - recoveredAt < RECOVERED_SAID_MS,
      elsewhere: !job && await lockedElsewhere(dataDir(), now),
    };
  }

  /** Runs one job: `getBytes` brings the package tarball (a download or a
   *  file), then it is unpacked, checked and installed. */
  function run(source, getBytes, expectVersion) {
    const id = randomBytes(8).toString("hex");
    const controller = new AbortController();
    job = { id, phase: source === "download" ? "downloading" : "verifying", received: 0, total: null, source, startedAt: now(), controller };
    const mine = job;
    (async () => {
      const dir = dataDir();
      let staging = null;
      let locked = false;
      let step = mine.phase === "downloading" ? "download" : "verify";
      try {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await tightenDataFolder(dir, platform);
        locked = await takeLock(dir, now);
        if (!locked) throw new EngineDownloadError("elsewhere", "install");
        const tgz = await getBytes(mine);
        step = "verify";
        mine.phase = "verifying";
        const files = readPackageTarball(tgz);
        let manifest;
        try { manifest = JSON.parse(files.find((f) => f.name === "package.json").data.toString("utf8")); } catch { manifest = null; }
        // Another platform's package, or not one of ours at all.
        if (manifest?.name !== packageName) {
          const ours = Object.values(ENGINE_PACKAGE_NAMES).includes(manifest?.name);
          throw new EngineDownloadError(ours ? "wrong-machine" : "check-failed", "verify");
        }
        if (expectVersion && manifest.version !== expectVersion) throw new EngineDownloadError("check-failed", "verify");
        staging = await fs.mkdtemp(join(dir, "engine-download-"));
        await fs.chmod(staging, 0o700).catch(() => {});
        await placePackage(staging, packageName, files);
        step = "install";
        mine.phase = "installing";
        await beforeChange();
        const result = await withEngineLock(() => importPackage({ platform, arch, env, keys: [...keys], from: staging, ...(dataFolder ? { dataFolder } : {}) }));
        if (result?.status === "imported" || result?.status === "current") {
          last = { id, outcome: "done", version: (await installed())?.version ?? manifest.version, at: now() };
        } else {
          const code = result?.reason === "downgrade" ? "downgrade" : result?.reason === "wrong-machine" ? "wrong-machine" : "check-failed";
          last = { id, outcome: "failed", code, step: "verify", version: manifest.version, at: now() };
        }
      } catch (error) {
        const failure = failureOf(error, step);
        // How far a download got, so the page can say where it stopped.
        last = failure.code === "cancelled"
          ? { id, outcome: "cancelled", at: now() }
          : { id, outcome: "failed", ...failure, received: mine.received, total: mine.total, version: expectVersion ?? null, at: now() };
      } finally {
        if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        if (locked) await dropLock(dir);
        if (job === mine) job = null;
      }
    })();
    return id;
  }

  return Object.freeze({
    status,
    recover,
    /** Starts the download and install of the pinned package, or joins the
     *  one running. `{ ok: true, id }`, or `{ ok: false, code }` naming why
     *  not: unsupported, no-keys, not-published, download-disabled. */
    async install() {
      if (job) return { ok: true, id: job.id };
      const pin = await enginePin({ platform, arch, ...(root ? { root } : {}) });
      const blocked = blockedAlways() ?? (!pin ? "not-published" : downloadOff() ? "download-disabled" : null);
      if (blocked) return { ok: false, code: blocked };
      const id = run("download", (mine) => fetchEngineTarball({
        name: pin.name, version: pin.version, registry, ...(fetchImpl ? { fetchImpl } : {}), signal: mine.controller.signal,
        onProgress: ({ received, total }) => { mine.received = received; mine.total = total; },
      }), pin.version);
      return { ok: true, id };
    },
    /** Installs a package file the person picked: the same checks as a
     *  download, any version the floor allows. */
    async installFile(bytes) {
      if (job) return { ok: false, code: "busy" };
      const blocked = blockedAlways();
      if (blocked) return { ok: false, code: blocked };
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, code: "check-failed" };
      return { ok: true, id: run("file", async () => bytes, null) };
    },
    /** Cancels a download; past the download there is nothing safe to cut. */
    cancel() {
      if (!job || job.phase !== "downloading") return { ok: false, code: "nothing-to-cancel" };
      job.controller.abort();
      return { ok: true };
    },
    /** Removes the installed engine (the kept floor stays, so a removed
     *  engine is never replaced by an older one). */
    async remove() {
      if (job) return { ok: false, code: "busy" };
      const dir = dataDir();
      if (!(await takeLock(dir, now).catch(() => false))) return { ok: false, code: "elsewhere" };
      try {
        await beforeChange();
        await withEngineLock(() => fs.rm(destination(), { recursive: true, force: true }));
        return { ok: true };
      } catch (error) {
        return { ok: false, code: failureOf(error, "remove").code };
      } finally {
        await dropLock(dir);
      }
    },
    /** Whether an installed version is older than the pinned one. */
    olderThanPin(installedVersion, pinned) {
      try { return !!installedVersion && !!pinned && compareVersions(installedVersion, pinned) < 0; } catch { return false; }
    },
  });
}
