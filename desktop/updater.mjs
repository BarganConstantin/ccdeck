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
//   an Ed25519 signature by ccdeck's update key (the `ed25519` field CI writes
//   into the yml, scripts/sign-yml.mjs). It is verified here before the update
//   is allowed to install, with the key compiled into updater-mac.mjs.
//
// Updates install on Quit (or "Restart to update"), after the app has stopped
// the deck it started — never under a running deck, and never mid-session
// without the person choosing to quit. The one exception is an install a
// package manager makes, which asks for a password: that waits for Restart to
// update (#1755).
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { bundleOf, checkForUpdate, discard, installOnExit, stageUpdate, UPDATE_PUBLIC_KEY } from "./updater-mac.mjs";
import { relaunchOnExit } from "./relaunch-linux.mjs";

/** Where releases are published. `releases/latest/download/<file>` is
 *  GitHub's own redirect to the newest release's asset. */
export const FEED = "https://github.com/BarganConstantin/ccdeck/releases/latest/download";

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
export function signatureFor(info, file) {
  const name = basename(file);
  const entry = (info?.files ?? []).find(f => f && typeof f.url === "string" && basename(f.url) === name);
  return entry?.ed25519 ?? (info?.path && basename(info.path) === name ? info.ed25519 : null) ?? null;
}

/**
 * @param {object} o
 * @param {import("electron").App} o.app
 * @param {(state: {status: string, version?: string, error?: string}) => void} o.onChange
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
    auto.on("checking-for-update", () => set({ status: "checking" }));
    auto.on("update-not-available", () => set({ status: "current" }));
    auto.on("update-available", info => { lastInfo = info; set({ status: "downloading", version: info.version }); });
    auto.on("error", err => set({ status: "error", error: String(err?.message ?? err) }));
    auto.on("update-downloaded", async info => {
      lastInfo = info;
      const file = info.downloadedFile;
      try {
        const ok = verifyFileSignature(await readFile(file), signatureFor(info, file));
        if (!ok) throw new Error("the download is not signed by ccdeck's update key");
        set({ status: "ready", version: info.version });
      } catch (err) {
        log(`update refused: ${err.message}`);
        set({ status: "error", error: err.message });
      }
    });
    return auto;
  }

  async function check() {
    if (!app.isPackaged && !process.env.CCDECK_UPDATE_FEED) return state;
    if (state.status === "checking" || state.status === "downloading" || state.status === "ready") return state;
    try {
      if (process.platform === "darwin") {
        set({ status: "checking" });
        const update = await checkForUpdate({ manifestUrl: `${feed}/latest-mac.json`, currentVersion: app.getVersion() });
        if (!update) { set({ status: "current" }); return state; }
        set({ status: "downloading", version: update.version });
        const runningApp = bundleOf(app.getPath("exe"));
        const s = await stageUpdate(update, { runningApp });
        staged = { ...s, version: update.version, target: runningApp };
        set({ status: "ready", version: update.version });
      } else {
        await (await setUpAuto()).checkForUpdates();
      }
    } catch (err) {
      log(`update check failed: ${err?.message ?? err}`);
      set({ status: "error", error: String(err?.message ?? err) });
    }
    return state;
  }

  /** Called as the app quits (will-quit, which a normal Quit reaches and
   *  app.exit does not): install what is ready without starting it again.
   *  macOS hands the staged bundle to the swap script. Windows and Linux make
   *  the call electron-updater's own install-on-quit would have made (#1757),
   *  silent and with no relaunch — only for a verified update, and not for an
   *  install that would ask for a password (#1755). */
  function installOnQuit() {
    if (process.platform === "darwin") {
      if (staged) {
        installOnExit({ pid: process.pid, target: staged.target, staged: staged.staged, dir: staged.dir });
        staged = null;
      }
      return;
    }
    if (state.status !== "ready" || !auto || installing || !canInstallUnattended()) return;
    installing = true;
    auto.install(true, false);
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
    if (process.platform === "darwin") { app.quit(); return; }
    if (process.platform === "linux" && process.env.APPIMAGE) { restartAppImage(); return; }
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
    if (!installed) return;
    relaunchOnExit({ pid: process.pid, appImage: target });
    app.quit();
  }

  async function dispose() {
    if (staged) await discard(staged.dir).catch(() => {});
  }

  return { check, installOnQuit, restartNow, canInstallUnattended, dispose, get state() { return state; } };
}
