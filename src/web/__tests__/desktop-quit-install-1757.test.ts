// Quit installs a verified update on Windows and Linux too (#1757).
//
// electron-updater decides whether to install on quit at one instant: when a
// download finishes, it emits `update-downloaded` and at once registers its
// quit hook — or not, if `autoInstallOnAppQuit` is false right then. The app
// keeps that flag false until its own Ed25519 check has passed, and the check
// is async, so by the time it passed the decision had been made: no hook, and
// Quit installed nothing on these platforms, although the README says updates
// install on Quit. A cached download at the next launch went the same way.
//
// The fake below applies that rule exactly, so the only way the install can
// happen is the app making it itself, from installOnQuit.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { releaseMessage } from "../../../desktop/updater-mac.mjs";

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
  // The AppImage here is at a path that is not on this disk; one that cannot
  // be replaced is desktop-update-appimage-failed-install.test.ts's.
  canReplace: async () => true,
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

type Fake = {
  emit: (event: string, ...args: unknown[]) => boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  setFeedURL: ReturnType<typeof vi.fn>;
  autoInstallOnAppQuit?: boolean;
  /** BaseUpdater's download `done`: emit, then register the quit hook only if
   *  the flag is true at this instant (electron-updater 6.8.9, BaseUpdater.js). */
  finishDownload: (info: unknown) => void;
  /** The app quitting with `code`: electron-updater's quit hooks run. */
  quit: (code: number) => void;
};

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const onPlatform = (p: string) => Object.defineProperty(process, "platform", { ...realPlatform, value: p });
const APPIMAGE = "/home/u/Applications/ccdeck-linux-x86_64.AppImage";

let fake: Fake;
let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  const { EventEmitter } = await import("node:events");
  fake = new EventEmitter() as unknown as Fake;
  const hooks: Array<(code: number) => void> = [];
  fake.checkForUpdates = vi.fn(async () => {});
  fake.quitAndInstall = vi.fn();
  fake.install = vi.fn(() => true);
  fake.setFeedURL = vi.fn();
  fake.finishDownload = info => {
    fake.emit("update-downloaded", info);
    if (fake.autoInstallOnAppQuit) hooks.push(code => { if (code === 0) fake.install(true, false); });
  };
  fake.quit = code => { for (const hook of hooks) hook(code); };
  h.auto = fake;
  dir = mkdtempSync(join(tmpdir(), "ccdeck-quit-install-"));
  for (const k of ["APPIMAGE", "CCDECK_UPDATE_FEED"]) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(dir);
});

/** An updater that has been handed a download, `signed` by ccdeck's key or not. */
async function downloaded(signed: boolean) {
  const u = createUpdater({
    app: { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: vi.fn() },
    onChange: () => {},
  });
  await u.check();
  const file = join(dir, "ccdeck-win-x64.exe");
  const bytes = Buffer.from("the installer ccdeck built");
  writeFileSync(file, bytes);
  fake.finishDownload({
    version: "3.27.0",
    downloadedFile: file,
    files: [{ url: basename(file), sha512: "x", ...(signed ? {
      ed25519: sign(null, bytes, h.priv).toString("base64"),
      ed25519Release: sign(null, releaseMessage("3.27.0", basename(file), bytes), h.priv).toString("base64"),
    } : {}) }],
  });
  const settled = signed ? "ready" : "error";
  for (let i = 0; i < 200 && u.state.status !== settled; i++) await new Promise(r => setTimeout(r, 5));
  expect(u.state.status).toBe(settled);
  return u;
}

/** What main.mjs does on a normal Quit: will-quit, then the process exits 0. */
const quitNormally = (u: { installOnQuit: () => void }) => { u.installOnQuit(); fake.quit(0); };

describe.each([
  ["Windows", () => onPlatform("win32")],
  ["the Linux AppImage", () => { onPlatform("linux"); process.env.APPIMAGE = APPIMAGE; }],
])("Quit on %s", (_where, setUp) => {
  beforeEach(() => setUp());

  it("installs the verified update, once, without starting it again", async () => {
    const u = await downloaded(true);
    quitNormally(u);
    expect(fake.install).toHaveBeenCalledTimes(1);
    expect(fake.install).toHaveBeenCalledWith(true, false);
    // And electron-updater's own install-on-quit is never armed: it would
    // install whatever it downloaded, verified or not.
    expect(fake.autoInstallOnAppQuit).toBe(false);
  });

  it("installs nothing that failed ccdeck's signature check", async () => {
    const u = await downloaded(false);
    quitNormally(u);
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("does not install a second time after Restart to update has", async () => {
    const u = await downloaded(true);
    u.restartNow();
    const already = fake.install.mock.calls.length + fake.quitAndInstall.mock.calls.length;
    expect(already).toBe(1);
    quitNormally(u);
    expect(fake.install.mock.calls.length + fake.quitAndInstall.mock.calls.length).toBe(1);
  });
});

describe("Quit on a Linux package install", () => {
  it("leaves the update for Restart to update, which says it will ask for a password", async () => {
    // A .deb's install is dpkg under pkexec or sudo (#1755); a Quit is not
    // somebody agreeing to a password prompt.
    onPlatform("linux");
    const u = await downloaded(true);
    quitNormally(u);
    expect(fake.install).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});
