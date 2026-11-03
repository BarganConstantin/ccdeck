// How the Command Panel's engine gets from the npm package that carries it
// into the deck's own engine folder, verified.
//
// ONE PACKAGE PER PLATFORM, installed beside the deck. `npm i -g ccdeck` also
// brings the engine for the machine it runs on, as esbuild does for its
// binary: each platform's engine is its own package (ENGINE_PACKAGE_NAMES) with
// `os` and `cpu` fields, listed as an optional dependency of the deck, so npm
// installs the one that fits and skips the rest. The package holds exactly what
// an installation holds: the engine executable and its signed `manifest.json`.
//
// NOTHING HAPPENS UNTIL A ROUTE ASKS, WITH THE SWITCH ON. Importing this does
// no I/O. command-panel-engine.mjs calls importEngine only when a question for
// the Command Panel arrives while its switch is on, on a platform that has the
// panel, and only when the deck holds keys to verify with. With the switch off
// (the default) nothing here is called: the package folder is never looked at.
//
// THE PACKAGE IS FOUND BY WALKING UP FROM THE DECK'S OWN FOLDER through each
// `node_modules`, the way Node finds a dependency, and nowhere else: not on
// PATH, not in the working directory, not in NODE_PATH, not from any path a
// user, a setting or a request supplies. No package, no import, and the panel
// answers what it always has (`not-installed`).
//
// WHAT IS CHECKED BEFORE A BYTE IS COPIED, on the bytes read once through
// O_NOFOLLOW (a link anywhere in the source is refused) from files owned by
// the user or root and writable by nobody else:
//   - the manifest's Ed25519 signature, by one of the deck's keys, and its six
//     signed fields for this machine's target;
//   - the executable's size and SHA-256 against the manifest;
//   - the executable's own header: ELF, Mach-O or PE, with the machine of this
//     OS and arch (an x64 engine on an arm64 machine is refused);
//   - the version against the floor: never lower than the engine already
//     installed, nor than the lowest version the deck has ever kept
//     (MINIMUM_VERSION_FILE, below).
// What is written is those same bytes, not a second read of the source.
//
// HOW IT IS INSTALLED. The bytes go to a new folder inside the deck's data
// folder (0700, files 0700 and 0600, each fsynced), which the installer's own
// verifier (pro-engine-install.mjs) must accept before anything moves. Then the
// old folder is set aside, the new one renamed to `engine`, the result verified
// again where it now stands, and only then the old one removed. A step that
// fails puts the old folder back: the previous installation is never touched
// by an import that did not complete. A source whose signed digest and version
// are those of an installation that verifies is not copied again.
//
// THE FLOOR. The lowest version the deck accepts is kept in one small file
// beside the engine folder, written after each completed import to the highest
// version seen. It is the deck's own record, read only by the deck: nothing
// from a request or a setting reaches it. Same-user tampering with it is out of
// scope, as it is for the engine folder itself.
//
// WINDOWS stays off until the engine side ships: ENGINE_ON_WINDOWS below is the
// one switch, and flipping it also needs an ACL reader handed to the installer
// (pro-engine-install.mjs), which the deck does not build yet.
import { constants, promises as fs } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { deckDataDir } from "./deck-home.mjs";
import {
  ENGINE_MANIFEST_MAX, TARGETS, compareVersions, executableMatchesMachine, readTrusted, signedEntry, trustGate,
  verifyEngineInstallation,
} from "./pro-engine-install.mjs";

/** The npm package that carries the engine for each `<platform>-<arch>`. The
 *  one place the names live. */
export const ENGINE_PACKAGE_NAMES = Object.freeze({
  "linux-x64": "@ccdeck/engine-linux-x64",
  "linux-arm64": "@ccdeck/engine-linux-arm64",
  "darwin-x64": "@ccdeck/engine-darwin-x64",
  "darwin-arm64": "@ccdeck/engine-darwin-arm64",
  "win32-x64": "@ccdeck/engine-win32-x64",
});

/** Whether the Command Panel is offered on Windows. False until the engine
 *  side ships there, so no Windows user is shown a path that half works. */
export const ENGINE_ON_WINDOWS = false;

/** The lowest engine version the deck has kept, beside the engine folder. */
export const MINIMUM_VERSION_FILE = "engine-minimum-version";

/** Where the deck itself lives: the folder lookups of the package start at. */
const DECK_FOLDER = dirname(fileURLToPath(import.meta.url));

/** The package name for a platform and arch, or null. */
export function enginePackageName(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(ENGINE_PACKAGE_NAMES, `${platform}-${arch}`) ? ENGINE_PACKAGE_NAMES[`${platform}-${arch}`] : null;
}

/** The folder of the installed package `name`, found by walking up from
 *  `from` through each `node_modules` (never PATH, the working directory or
 *  NODE_PATH), or null. Its package.json must be a regular file naming it. */
export async function findEnginePackage(name, from = DECK_FOLDER) {
  let dir = from;
  while (true) {
    const modules = basename(dir) === "node_modules" ? dir : join(dir, "node_modules");
    const candidate = join(modules, name);
    try {
      const manifest = await fs.lstat(join(candidate, "package.json"));
      if (manifest.isFile() || manifest.isSymbolicLink()) {
        const root = await fs.realpath(candidate);
        const handle = await fs.open(join(root, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024 && JSON.parse(await handle.readFile("utf8"))?.name === name) return root;
        } finally { await handle.close(); }
      }
    } catch { /* not here: look further up */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The kept floor as text, `undefined` when there is none, and a text that is
 *  no version when the file cannot be trusted (which refuses every engine). */
async function readFloor(dataDir, gateOptions) {
  const file = join(dataDir, MINIMUM_VERSION_FILE);
  try {
    await fs.lstat(file);
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? undefined : "unreadable";
  }
  try {
    const { data } = await readTrusted(file, 64, await trustGate(gateOptions));
    const text = data.toString("utf8").trim();
    compareVersions(text, "0.0.0");
    return text;
  } catch {
    return "unreadable";
  }
}

const higher = (a, b) => (a === undefined ? b : b === undefined ? a : compareVersions(a, b) >= 0 ? a : b);

/** Writes `bytes` to a new file, owner-only, flushed. */
async function writeNew(file, bytes, mode) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Flushes a directory's entries where the OS lets one be opened. */
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch { /* Windows cannot open a directory: nothing to flush there */ } finally { await handle?.close().catch(() => {}); }
}

async function writeFloor(dataDir, version) {
  const temporary = join(dataDir, `${MINIMUM_VERSION_FILE}.${randomBytes(6).toString("hex")}`);
  try {
    await writeNew(temporary, Buffer.from(`${version}\n`), 0o600);
    await fs.rename(temporary, join(dataDir, MINIMUM_VERSION_FILE));
    await syncDirectory(dataDir);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Brings the engine from its npm package into the engine folder, verified.
 * Resolves to `{ status, minimumVersion? }`:
 *   "absent"    no package for this machine (nothing is read from anywhere else);
 *   "current"   the installation already is this package's engine, left alone;
 *   "imported"  installed now;
 *   "refused"   with `reason` "unverified", "wrong-machine" or "downgrade":
 *               nothing was changed.
 * `minimumVersion` is what the installer is to hold the engine to, when
 * there is one. Never throws.
 *
 * `platform`, `arch`, `env`, `keys`, `from` (where the package lookup starts),
 * `dataFolder` (instead of the one `env` names), `windowsAcl` and `uid` are
 * there for tests; the deck passes `platform`, `env` and `keys` only.
 */
export async function importEngine({
  platform = process.platform, arch = process.arch, env = process.env, keys, from, dataFolder, windowsAcl, uid,
} = {}) {
  const name = enginePackageName(platform, arch);
  const target = TARGETS[`${platform}-${arch}`];
  const dataDir = dataFolder ?? deckDataDir(platform, env);
  const destination = join(dataDir, "engine");
  const gateOptions = { platform, windowsAcl, uid };
  if (!name || !target || !Array.isArray(keys) || keys.length === 0) return { status: "absent" };
  let staging = null;
  let aside = null;
  try {
    const source = await findEnginePackage(name, from);
    const floor = await readFloor(dataDir, gateOptions);
    if (!source) return { status: "absent", ...(floor === undefined ? {} : { minimumVersion: floor }) };

    // The package, checked as read: files owned by the user or root, no links.
    const gate = await trustGate({ ...gateOptions, allowRoot: true });
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory()) throw new Error("source");
    await gate.directory(source, sourceStat);
    const { data: manifestBytes } = await readTrusted(join(source, "manifest.json"), ENGINE_MANIFEST_MAX, gate);
    const entry = signedEntry(manifestBytes, keys, target, platform);
    const { data: executable } = await readTrusted(join(source, entry.file), entry.size, gate);
    if (executable.length !== entry.size || createHash("sha256").update(executable).digest("hex") !== entry.sha256) throw new Error("digest");
    if (!executableMatchesMachine(executable, platform, arch)) return { status: "refused", reason: "wrong-machine", ...(floor === undefined ? {} : { minimumVersion: floor }) };

    // What is installed now, if it still verifies, and the floor it sets.
    const installed = await verifyEngineInstallation({ directory: destination, publicKey: keys, windowsAcl, platform, arch }).catch(() => null);
    const minimum = higher(floor, installed?.version);
    if (minimum !== undefined && compareVersions(entry.version, minimum) < 0) {
      return { status: "refused", reason: "downgrade", minimumVersion: minimum };
    }
    if (installed && installed.digest === entry.sha256 && installed.version === entry.version) {
      return { status: "current", minimumVersion: higher(minimum, entry.version) };
    }

    // Staged beside the destination, so the final rename never crosses a volume.
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    staging = await fs.mkdtemp(join(dataDir, "engine-import-"));
    await fs.chmod(staging, 0o700).catch(() => {});
    await writeNew(join(staging, entry.file), executable, 0o700);
    await writeNew(join(staging, "manifest.json"), manifestBytes, 0o600);
    await syncDirectory(staging);
    await verifyEngineInstallation({ directory: staging, publicKey: keys, minimumVersion: minimum, windowsAcl, platform, arch });

    // Swap: the old folder aside, the new one in, the result verified where
    // it stands, the old one removed last. Any failure puts the old one back.
    const previous = await fs.lstat(destination).then(() => true, (error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
      throw error;
    });
    if (previous) {
      aside = join(dataDir, `engine-previous-${randomBytes(6).toString("hex")}`);
      await fs.rename(destination, aside);
    }
    try {
      await fs.rename(staging, destination);
      staging = null;
      await verifyEngineInstallation({ directory: destination, publicKey: keys, minimumVersion: minimum, windowsAcl, platform, arch });
    } catch (error) {
      if (staging === null) await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      if (aside) {
        // Put back; if even that fails the old folder stays where it is, never deleted.
        const old = aside;
        aside = null;
        await fs.rename(old, destination).catch(() => {});
      }
      throw error;
    }
    await syncDirectory(dataDir);
    if (aside) await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
    aside = null;
    const kept = higher(minimum, entry.version);
    await writeFloor(dataDir, kept);
    return { status: "imported", minimumVersion: kept };
  } catch {
    return { status: "refused", reason: "unverified" };
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (aside) await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
  }
}
