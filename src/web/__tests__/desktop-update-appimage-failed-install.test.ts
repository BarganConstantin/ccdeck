// Linux AppImage: an install that fails says so, and the next one is real.
//
// electron-updater's install() latches the first time it is called and lets
// go only inside its own quitAndInstall, which the AppImage restart does not
// use (#1630). After one failed install — an AppImage in /opt, say, which it
// cannot unlink — the next check found the cached download and said "ready"
// again, and every install from then on was ignored: the quiet install tried
// about every seventy seconds for the rest of the session, and the tray's
// "Restart to update" did nothing. An AppImage in a folder this account
// cannot write to is now not offered as ready at all.
//
// electron-updater is mocked the way desktop-updater-state.test.ts does it,
// keeping BaseUpdater.install's latch, and the update key swapped for one made
// here so a signature can be made. Whether a folder can be written to is
// canReplace's answer, run against a read-only folder in
// desktop-update-unreplaceable-app.test.ts; here it is stood in for.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import * as mac from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import * as relaunch from "../../../desktop/relaunch-linux.mjs";

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const ours = generateKeyPairSync("ed25519");
  const pem = (k: { export: (o: object) => string | Buffer }, type: string) => k.export({ type, format: "pem" }).toString();
  return { pub: pem(ours.publicKey, "spki"), priv: pem(ours.privateKey, "pkcs8"), auto: null as unknown };
});

// Both specifiers, for the reason desktop-updater-state.test.ts gives (#1293).
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/node_modules/electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UPDATE_PUBLIC_KEY: h.pub,
  canReplace: vi.fn(),
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let root = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
  root = mkdtempSync(join(tmpdir(), "ccdeck-appimage-install-"));
  for (const k of ["APPIMAGE", "CCDECK_UPDATE_FEED"]) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.mocked(relaunch.relaunchOnExit).mockReset();
  vi.mocked(mac.canReplace).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(root);
});

/**
 * An AppImage in `folder` with a verified download of 3.27.0 waiting in
 * electron-updater's cache, which every check finds again. `doInstall` is the
 * AppImage install proper; install() around it keeps BaseUpdater's latch.
 */
async function appImageIn(folder: string, doInstall: () => boolean) {
  const home = join(root, folder);
  mkdirSync(home, { recursive: true });
  process.env.APPIMAGE = join(home, "ccdeck-linux-x86_64.AppImage");
  writeFileSync(process.env.APPIMAGE, "the running AppImage");
  const cache = join(root, "cache");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, "ccdeck-linux-x86_64.AppImage");
  const bytes = Buffer.from("the AppImage ccdeck built");
  writeFileSync(file, bytes);
  const info = {
    version: "3.27.0",
    downloadedFile: file,
    files: [{
      url: basename(file), sha512: "x",
      ed25519: sign(null, bytes, h.priv).toString("base64"),
      ed25519Release: sign(null, mac.releaseMessage("3.27.0", basename(file), bytes), h.priv).toString("base64"),
    }],
  };

  const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
  fake.setFeedURL = vi.fn();
  fake.quitAndInstallCalled = false;
  // BaseUpdater.install in electron-updater 6.8.9.
  fake.install = vi.fn(() => {
    if (fake.quitAndInstallCalled) return false; // "install call ignored: quitAndInstallCalled is set to true"
    fake.quitAndInstallCalled = true;
    try {
      return doInstall();
    } catch (err) {
      fake.emit("error", err);
      return false;
    }
  });
  fake.checkForUpdates = vi.fn(async () => {
    fake.emit("update-available", { version: "3.27.0" });
    fake.emit("update-downloaded", info);
    return { isUpdateAvailable: true, downloadPromise: null };
  });
  h.auto = fake;

  const app = { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: vi.fn() };
  const u = createUpdater({ app, onChange: () => {} });
  /** A check, as the six-hourly one or the tray's "Check for updates" makes
   *  it, waited out until the downloaded update has been judged. */
  const check = async () => {
    await u.check();
    for (let i = 0; i < 200 && (u.state.status === "checking" || u.state.status === "downloading"); i++) await sleep(5);
  };
  return { u, app, fake, check };
}

describe("an AppImage install that fails", () => {
  it("leaves an error, not a ready update, and the next install is a real one", async () => {
    let attempts = 0;
    const { u, app, check } = await appImageIn("Applications", () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
      return true;
    });
    await check();
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    expect(u.canInstallUnattended()).toBe(true); // so the quiet install comes here

    u.restartNow();
    expect(attempts).toBe(1);
    expect(u.state.status).toBe("error");
    expect(app.quit).not.toHaveBeenCalled();

    // Six hours on, or "Check for updates": the cached download is ready
    // again, and Restart to update installs it rather than doing nothing.
    await check();
    expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
    u.restartNow();
    expect(attempts).toBe(2);
    expect(relaunch.relaunchOnExit).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("is not left ready when the install did nothing at all", async () => {
    // The latch held by something else: install() answers false and says
    // nothing. The quiet install must not take that as still ready.
    const { u, fake, check } = await appImageIn("Applications", () => true);
    await check();
    fake.quitAndInstallCalled = true;
    u.restartNow();
    expect(u.state.status).toBe("error");
  });
});

describe("an AppImage in a folder this account cannot write to", () => {
  it("is not offered as ready, and nothing tries to install it", async () => {
    // /opt/ccdeck, owned by root.
    const { u, app, fake, check } = await appImageIn("opt/ccdeck", () => true);
    vi.mocked(mac.canReplace).mockResolvedValue(false);
    await check();
    expect(u.state.status).toBe("error");
    expect(u.state.error).toMatch(/cannot update itself/);
    expect(mac.canReplace).toHaveBeenCalledWith(process.env.APPIMAGE);
    u.restartNow();
    u.installOnQuit();
    expect(fake.install).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
