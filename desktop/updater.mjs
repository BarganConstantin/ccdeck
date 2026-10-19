// The app keeping itself current from GitHub Releases (#1160) — one state
// machine over two mechanisms.
//
//   macOS: updater-mac.mjs, ccdeck's own. Squirrel.Mac, which electron-updater
//   uses there, only installs an update that satisfies the running app's
//   designated requirement, and with no Developer ID that is a promise nobody
//   has kept in practice. Ours checks the same thing itself.
//
//   Windows and Linux: electron-updater, over the latest.yml / latest-linux.yml
//   electron-builder publishes. With no paid signature on the installer it
//   checks only a SHA-512 that sits in the same release as the file — anyone
//   able to replace one could replace both — so every download must ALSO carry
//   two Ed25519 signatures by ccdeck's update key, which CI writes into the yml
//   (scripts/sign-yml.mjs): `ed25519` over the file's bytes, and
//   `ed25519Release` over its bytes, name and version. Both are verified here
//   before the update is allowed to install, with the key compiled into
//   updater-mac.mjs.
//
// Updates install as the app quits — on Quit, on "Restart to update", or when
// the app restarts itself into one after a quiet spell (auto-update.mjs, #1187)
// — always after the app has stopped the deck it started, never under a
// running deck. The one exception is an install a package manager makes,
// which asks for a password: that waits for Restart to update (#1755).
//
// A READY UPDATE IS NOT THE END OF LOOKING. One can now wait a day for the
// agents, or for a "Later", and a release can come out in that day; installed
// as staged, the app would come back already behind and update again an hour
// later. So check() goes on asking while one is ready — for a release newer
// than the READY one, not the running one — and stages that instead. Finding
// nothing newer changes nothing, and a newer one that fails leaves the staged
// one ready wherever it is still there to install.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { bundleOf, canReplace, checkForUpdate, discard, failedSwap, installOnExit, isNewer, stageUpdate, UPDATE_PUBLIC_KEY, verifyRelease } from "./updater-mac.mjs";
import { relaunchOnExit } from "./relaunch-linux.mjs";

/** Where releases are published. `releases/latest/download/<file>` is
 *  GitHub's own redirect to the newest release's asset. */
export const FEED = "https://github.com/BarganConstantin/ccdeck/releases/latest/download";

/** macOS: the file in the app's data folder the swap script names a release
 *  in when it could not put it in place (updater-mac.mjs SWAP_SCRIPT). */
const SWAP_FAILED = "update-swap-failed";

/** The installs electron-updater hands to a package manager (#1755): dpkg,
 *  rpm or pacman, run under pkexec or sudo. electron-builder names them in a
 *  `package-type` file in Resources, which is what electron-updater picks its
 *  installer by; the AppImage has none. */
const PACKAGE_MANAGED = new Set(["deb", "rpm", "pacman"]);

function packageTypeIn(resourcesPath) {
  if (!resourcesPath) return null;
  try {
    return readFileSync(join(resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return null;
  }
}

/** An update this copy cannot take where it is, and what kind, so the tray can
 *  say what to do about it (tray-menu.mjs) rather than only that it failed —
 *  and, for one about a single release, which release. */
function cannotUpdateHere(message, kind, version) {
  return Object.assign(new Error(message), { kind, version });
}

/** The error state for a failure, with its kind and release when it has them. */
function errorState(err) {
  const state = { status: "error", error: String(err?.message ?? err) };
  if (err?.kind) state.kind = err.kind;
  if (err?.version) state.version = err.version;
  return state;
}

/** Verify an Ed25519 signature over a file's bytes with ccdeck's update key. */
export function verifyFileSignature(bytes, signatureB64, publicKeyPem = UPDATE_PUBLIC_KEY) {
  if (!signatureB64) return false;
  try {
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(String(signatureB64), "base64"));
  } catch {
    return false;
  }
}

/** The `ed25519` signature the yml lists for a downloaded file, by name. */
export function signatureFor(info, file, field = "ed25519") {
  const name = basename(file);
  const entry = (info?.files ?? []).find(f => f && typeof f.url === "string" && basename(f.url) === name);
  return entry?.[field] ?? (info?.path && basename(info.path) === name ? info[field] : null) ?? null;
}

/**
 * Both of ccdeck's signatures on a downloaded file: `ed25519` over its bytes,
 * and `ed25519Release` over its bytes, its name and the version the yml offers
 * it as, so it installs only as the version it was released as.
 */
export function verifyDownload(bytes, info, file, publicKeyPem = UPDATE_PUBLIC_KEY) {
  return verifyFileSignature(bytes, signatureFor(info, file), publicKeyPem)
    && verifyRelease(bytes, { version: info?.version, name: basename(file), signature: signatureFor(info, file, "ed25519Release") }, publicKeyPem);
}

/**
 * @param {object} o
 * @param {import("electron").App} o.app
 * @param {(state: {status: string, version?: string, error?: string, kind?: string}) => void} o.onChange
 * @param {(line: string) => void} [o.log]
 * @param {string} [o.feed]  override for testing against a local server
 * @param {string} [o.resourcesPath]  where the installed app's package-type
 *   file is, if it has one
 */
export function createUpdater({ app, onChange, log = () => {}, feed = process.env.CCDECK_UPDATE_FEED || FEED, resourcesPath = process.resourcesPath }) {
  let state = { status: "idle" };
  let staged = null;        // macOS: { staged, dir, version }
  let auto = null;          // Windows/Linux: electron-updater's autoUpdater
  let lastInfo = null;
  let packageType;          // read once, when first asked
  let installing = false;   // Windows/Linux: an install has been started
  let relaunch = false;     // macOS/Windows: Restart to update, not Quit
  let lookedAt = null;      // when the last look at the feed started
  let inFlight = false;     // a check() has not returned yet
  let refreshing = false;   // Windows/Linux: this check is a look past a ready update
  let superseding = false;  // Windows/Linux: …and it found a newer one, now downloading

  const set = next => { state = next; onChange?.(state); };

  async function setUpAuto() {
    if (auto) return auto;
    const { autoUpdater } = (await import("electron-updater")).default ?? (await import("electron-updater"));
    auto = autoUpdater;
    auto.autoDownload = true;
    // Never armed. electron-updater decides whether to install on quit the
    // moment a download finishes — before the signature check below has had a
    // chance to pass — and from then on installs whatever it downloaded. So
    // the verified update is installed by installOnQuit instead (#1757).
    auto.autoInstallOnAppQuit = false;
    if (process.env.CCDECK_UPDATE_FEED) auto.setFeedURL({ provider: "generic", url: feed });
    auto.logger = { info: log, warn: log, error: log, debug: () => {} };
    // While an update is ready, a look past it is not news: the state stays
    // ready unless a NEWER release turns up (see the header).
    auto.on("checking-for-update", () => { if (state.status !== "ready") set({ status: "checking" }); });
    auto.on("update-not-available", () => { if (state.status !== "ready") set({ status: "current" }); });
    auto.on("update-available", info => {
      lastInfo = info;
      if (state.status === "ready") {
        if (!isNewer(info.version, state.version)) return;
        superseding = true;
      }
      set({ status: "downloading", version: info.version });
    });
    auto.on("error", err => {
      // A look past a ready update that failed before anything newer started
      // downloading — the feed unreachable — leaves the ready one where it is.
      // Once a newer download has started, electron-updater has cleared the
      // older one from its cache, and the error is the truth.
      if (refreshing && !superseding && state.status === "ready") { log(`update check failed, keeping ${state.version}: ${err?.message ?? err}`); return; }
      set({ status: "error", error: String(err?.message ?? err) });
    });
    auto.on("update-downloaded", async info => {
      // The ready one, found again in electron-updater's cache by a look past it.
      if (state.status === "ready" && state.version === info.version) return;
      lastInfo = info;
      const file = info.downloadedFile;
      try {
        // Only ever forward: the version this app already is, or one it has
        // passed, is not an update.
        if (!isNewer(info.version, app.getVersion())) throw new Error(`${info.version} is not newer than the running ${app.getVersion()}`);
        const ok = verifyDownload(await readFile(file), info, file);
        if (!ok) throw new Error(`the download is not signed by ccdeck's update key as ${info.version}`);
        // The AppImage replaces its own file. One kept where this account
        // cannot write is not ready: nothing could install it.
        if (process.platform === "linux" && isAppImage() && !(await canReplace(process.env.APPIMAGE))) {
          throw cannotUpdateHere(`ccdeck cannot update itself in ${dirname(process.env.APPIMAGE)}, which cannot be written to`, "unwritable-appimage");
        }
        superseding = false;
        set({ status: "ready", version: info.version });
      } catch (err) {
        log(`update refused: ${err.message}`);
        set(errorState(err));
      }
    });
    return auto;
  }

  async function check() {
    if (!app.isPackaged && !process.env.CCDECK_UPDATE_FEED) return state;
    if (inFlight || state.status === "checking" || state.status === "downloading") return state;
    // The update already staged, when there is one: this look is for a release
    // newer than it, and it stays ready unless one is found.
    const held = state.status === "ready" ? state : null;
    inFlight = true;
    lookedAt = Date.now();
    refreshing = !!held;
    superseding = false;
    try {
      if (process.platform === "darwin") {
        if (!held) set({ status: "checking" });
        const update = await checkForUpdate({ manifestUrl: `${feed}/latest-mac.json`, currentVersion: held?.version ?? app.getVersion() });
        if (!update) { if (!held) set({ status: "current" }); return state; }
        const runningApp = bundleOf(app.getPath("exe"));
        // Nothing is staged that the swap cannot put in place: ready, it would
        // quit the app at the next quiet spell into a swap that fails.
        if (!(await canReplace(runningApp))) {
          throw cannotUpdateHere(`ccdeck cannot update itself in ${dirname(runningApp)}, which cannot be written to — move it to Applications`, "unwritable-app");
        }
        const failed = join(app.getPath("userData"), SWAP_FAILED);
        // Skipped, not failed: trying again is refused the same way until a
        // newer release is out, so the tray says that (tray-menu.mjs).
        if (await failedSwap(failed) === update.version) {
          throw cannotUpdateHere(`ccdeck ${update.version} could not be put in place last time, and is not tried again`, "skipped-release", update.version);
        }
        set({ status: "downloading", version: update.version });
        const s = await stageUpdate(update, { runningApp });
        // The one it overtook is thrown away only now that its successor has
        // staged: until then it was still the one a Quit would install.
        const overtaken = staged;
        staged = { ...s, version: update.version, target: runningApp, failed };
        if (overtaken) await discard(overtaken.dir).catch(() => {});
        set({ status: "ready", version: update.version });
      } else {
        // With autoDownload, the download comes back as a promise of its own,
        // which rejects after its failure has reached the 'error' listener.
        // Left unheld, that rejection would end in Electron's modal error box.
        const result = await (await setUpAuto()).checkForUpdates();
        result?.downloadPromise?.catch(() => {});
      }
    } catch (err) {
      log(`update check failed: ${err?.message ?? err}`);
      if (!keepHeld(held, err)) set(errorState(err));
    } finally {
      inFlight = false;
      refreshing = false;
    }
    return state;
  }

  /** A look past a ready update that failed: put the ready one back, when it is
   *  still there to install. On macOS it is, until a successor has staged; on
   *  Windows and Linux only until electron-updater starts downloading one. */
  function keepHeld(held, err) {
    if (!held) return false;
    if (process.platform === "darwin" ? !staged || staged.version !== held.version : superseding) return false;
    log(`keeping ${held.version}: ${err?.message ?? err}`);
    if (state.status !== "ready" || state.version !== held.version) set({ status: "ready", version: held.version });
    return true;
  }

  /** Called as the app quits (will-quit, which a normal Quit reaches and
   *  app.exit does not): install what is ready without starting it again.
   *  macOS hands the staged bundle to the swap script, which opens the new
   *  version only after Restart to update (#1758). Windows and Linux make
   *  the call electron-updater's own install-on-quit would have made (#1757),
   *  silent and with no relaunch — only for a verified update, and not for an
   *  install that would ask for a password (#1755). */
  function installOnQuit() {
    if (process.platform === "darwin") {
      if (staged) {
        installOnExit({ pid: process.pid, target: staged.target, staged: staged.staged, dir: staged.dir, relaunch, failed: staged.failed, version: staged.version });
        staged = null;
      }
      return;
    }
    if (state.status !== "ready" || !auto || installing || !canInstallUnattended()) return;
    installing = true;
    auto.install(!relaunch, relaunch);
  }

  /**
   * Can the install run with nobody there to answer it (#1755)? The macOS
   * swap, the per-user Windows installer and the AppImage, which replaces its
   * own file, ask nothing. A .deb, .rpm or pacman install is the package
   * manager under pkexec or sudo: a password prompt nobody asked for, run on
   * the main thread, which freezes the app until somebody answers it. Those
   * install only when the person chooses Restart to update.
   */
  function canInstallUnattended() {
    if (process.platform === "darwin" || process.platform === "win32") return true;
    return isAppImage();
  }

  /** Linux: is this the AppImage, rather than a package manager's install
   *  started with APPIMAGE inherited from wherever it was started? */
  function isAppImage() {
    if (packageType === undefined) packageType = packageTypeIn(resourcesPath);
    return !!process.env.APPIMAGE && !PACKAGE_MANAGED.has(packageType);
  }

  /** "Restart to update": quit into the new version now — and only into one
   *  that is ready. electron-updater's quitAndInstall installs whatever it
   *  downloaded, signed by ccdeck's key or not, so the menu offering this only
   *  while ready is not the only thing between a refused download and an
   *  install (#1176). */
  function restartNow() {
    if (state.status !== "ready") return;
    // macOS installs on the way out either way; what makes this a restart
    // rather than a Quit is the swap opening the new version after (#1758).
    if (process.platform === "darwin") { relaunch = true; app.quit(); return; }
    // BaseUpdater.quitAndInstall starts NSIS before asking Electron to quit.
    // Our before-quit handler holds that quit while the owned deck shuts down,
    // so NSIS otherwise races its live supervisor and worker. Keep the same
    // interactive installer/relaunch, but start it from will-quit after that
    // cleanup, as a normal Quit already does. Repeated clicks must not ask for
    // a second quit while the first is held by asynchronous cleanup.
    if (process.platform === "win32") {
      if (relaunch) return;
      relaunch = true;
      app.quit();
      return;
    }
    // The same test the unattended rule makes: a package install that
    // inherited APPIMAGE restarts the package way, not as that AppImage.
    if (process.platform === "linux" && isAppImage()) { restartAppImage(); return; }
    if (!auto) return;
    installing = true;
    auto.quitAndInstall(false, true);
  }

  /**
   * The AppImage swaps its file in now and starts again only after this
   * process has gone (#1630): quitAndInstall(…, true) would start the new one
   * while this one still runs, and it inherited this one's open files.
   *
   * install(…, false) swaps the file and runs the new AppImage with
   * APPIMAGE_EXIT_AFTER_INSTALL, which makes its AppRun return without
   * starting the app. electron-updater renames the file when the old name
   * carried a version; the relaunch follows it.
   */
  function restartAppImage() {
    if (!auto) return;
    let target = process.env.APPIMAGE;
    const renamed = path => { target = path; };
    auto.on("appimage-filename-updated", renamed);
    let installed = false;
    installing = true;
    try {
      installed = auto.install(true, false);
    } finally {
      auto.off("appimage-filename-updated", renamed);
    }
    if (!installed) {
      // install() latches on its first call, and only electron-updater's own
      // quitAndInstall lets go after one that failed. Let go here too, or every
      // later install is ignored while the next check says ready again — and
      // the quiet install tries it every minute. The failure is the state
      // until then, so nothing tries again by itself before that check.
      auto.quitAndInstallCalled = false;
      installing = false;
      if (state.status === "ready") set({ status: "error", error: `ccdeck ${state.version} could not be installed` });
      return;
    }
    relaunchOnExit({ pid: process.pid, appImage: target });
    app.quit();
  }

  async function dispose() {
    if (staged) await discard(staged.dir).catch(() => {});
  }

  return {
    check, installOnQuit, restartNow, canInstallUnattended, dispose,
    get state() { return state; },
    /** When the last look at the feed started, or null before the first. */
    get lookedAt() { return lookedAt; },
    /** A look is in flight: a check() not yet returned, or a download it
     *  started that has not ended in ready or an error. */
    get looking() { return inFlight || state.status === "checking" || state.status === "downloading"; },
  };
}
