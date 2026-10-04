// Restart to update on a .deb, .rpm or pacman install restarts the package way,
// even with APPIMAGE in its environment.
//
// A package install started from a shell or a launcher that had APPIMAGE set —
// one started from inside another AppImage's environment — is still the
// package manager's: the `package-type` file electron-builder writes into
// Resources says so, and that is what the unattended rule already went by
// (#1755). Restart to update went by APPIMAGE alone, so it took the AppImage
// restart: an install() that swaps the AppImage's own file, and a relaunch of
// a file that is not this app.
//
// electron-updater is mocked the way desktop-unattended-install-1755.test.ts
// does it, and the update key swapped for one made here so a signature can be
// made. Nothing is installed and nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { releaseMessage } from "../../../desktop/updater-mac.mjs";
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
  canReplace: async () => true,
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

type Fake = {
  emit: (event: string, ...args: unknown[]) => boolean;
  on: (event: string, fn: (...args: unknown[]) => void) => unknown;
  off: (event: string, fn: (...args: unknown[]) => void) => unknown;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  setFeedURL: ReturnType<typeof vi.fn>;
};

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const APPIMAGE = "/home/u/Applications/ccdeck-linux-x86_64.AppImage";

let fake: Fake;
let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  const { EventEmitter } = await import("node:events");
  fake = new EventEmitter() as unknown as Fake;
  fake.checkForUpdates = vi.fn(async () => {});
  fake.quitAndInstall = vi.fn();
  fake.install = vi.fn(() => true);
  fake.setFeedURL = vi.fn();
  h.auto = fake;
  vi.mocked(relaunch.relaunchOnExit).mockReset();
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
  dir = mkdtempSync(join(tmpdir(), "ccdeck-package-restart-"));
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

/** A Resources folder that says which package it was installed from. */
const installedAs = (type: string) => {
  const resources = join(dir, "resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "package-type"), `${type}\n`);
  return resources;
};

/** An updater with a verified download ready, installed from `resourcesPath`. */
async function ready(resourcesPath: string) {
  const app = { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: vi.fn() };
  const u = createUpdater({ app, onChange: () => {}, resourcesPath });
  await u.check();
  const file = join(dir, "ccdeck-linux-download");
  const bytes = Buffer.from("the update ccdeck built");
  writeFileSync(file, bytes);
  fake.emit("update-downloaded", {
    version: "3.27.0",
    downloadedFile: file,
    files: [{
      url: basename(file), sha512: "x",
      ed25519: sign(null, bytes, h.priv).toString("base64"),
      ed25519Release: sign(null, releaseMessage("3.27.0", basename(file), bytes), h.priv).toString("base64"),
    }],
  });
  for (let i = 0; i < 200 && u.state.status !== "ready"; i++) await new Promise(r => setTimeout(r, 5));
  expect(u.state).toEqual({ status: "ready", version: "3.27.0" });
  return { u, app };
}

describe("Restart to update on a package install with APPIMAGE inherited", () => {
  it.each(["deb", "rpm", "pacman"])("restarts a %s install through its package manager", async (type) => {
    process.env.APPIMAGE = APPIMAGE;
    const { u } = await ready(installedAs(type));
    expect(u.canInstallUnattended()).toBe(false);
    u.restartNow();
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);
    // Not the AppImage's swap of its own file, and no relaunch of a file that
    // is not this app.
    expect(fake.install).not.toHaveBeenCalled();
    expect(relaunch.relaunchOnExit).not.toHaveBeenCalled();
  });

  it("still restarts the AppImage itself the AppImage way", async () => {
    process.env.APPIMAGE = APPIMAGE;
    const { u, app } = await ready(join(dir, "no-resources"));
    expect(u.canInstallUnattended()).toBe(true);
    u.restartNow();
    expect(fake.install).toHaveBeenCalledWith(true, false);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(relaunch.relaunchOnExit).toHaveBeenCalledWith({ pid: process.pid, appImage: APPIMAGE });
    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});
