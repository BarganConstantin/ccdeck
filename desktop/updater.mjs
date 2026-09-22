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
// without the person choosing to quit.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { bundleOf, checkForUpdate, discard, installOnExit, stageUpdate, UPDATE_PUBLIC_KEY } from "./updater-mac.mjs";

/** Where releases are published. `releases/latest/download/<file>` is
 *  GitHub's own redirect to the newest release's asset. */
export const FEED = "https://github.com/BarganConstantin/ccdeck/releases/latest/download";

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
 */
export function createUpdater({ app, onChange, log = () => {}, feed = process.env.CCDECK_UPDATE_FEED || FEED }) {
  let state = { status: "idle" };
  let staged = null;        // macOS: { staged, dir, version }
  let auto = null;          // Windows/Linux: electron-updater's autoUpdater
  let lastInfo = null;

  const set = next => { state = next; onChange?.(state); };

  async function setUpAuto() {
    if (auto) return auto;
    const { autoUpdater } = (await import("electron-updater")).default ?? (await import("electron-updater"));
    auto = autoUpdater;
    auto.autoDownload = true;
    // Held until our own signature check passes (below).
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
        auto.autoInstallOnAppQuit = true;
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

  /** Called as the app quits: hand the staged macOS update to the swap
   *  script. electron-updater installs on its own once allowed above. */
  function installOnQuit() {
    if (process.platform === "darwin" && staged) {
      installOnExit({ pid: process.pid, target: staged.target, staged: staged.staged, dir: staged.dir });
      staged = null;
    }
  }

  /** "Restart to update": quit into the new version now — and only into one
   *  that is ready. electron-updater's quitAndInstall installs whatever it
   *  downloaded, signed by ccdeck's key or not, so the menu offering this only
   *  while ready is not the only thing between a refused download and an
   *  install (#1176). */
  function restartNow() {
    if (state.status !== "ready") return;
    if (process.platform === "darwin") { app.quit(); return; }
    auto?.quitAndInstall(false, true);
  }

  async function dispose() {
    if (staged) await discard(staged.dir).catch(() => {});
  }

  return { check, installOnQuit, restartNow, dispose, get state() { return state; } };
}
