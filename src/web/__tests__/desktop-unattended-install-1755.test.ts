// An update that needs root never installs by itself (#1755).
//
// electron-builder writes `resources/package-type = deb` into the .deb, and
// electron-updater then installs through `dpkg -i` under pkexec or sudo, run
// with spawnSync on the main thread. The quiet auto-install asked nothing
// about that: a minute after a verified update, with the window unfocused, a
// password prompt came up out of nowhere, the tray froze until it was
// answered, and a cancelled prompt came back at the next check.
//
// So the updater says whether its install can run with nobody there, and the
// quiet rule takes that as an input. Only the AppImage (which replaces its own
// file), the per-user Windows installer and the macOS swap can; a package
// manager's install waits for the person's own "Restart to update", which says
// that it will ask for a password.
//
// electron-updater is mocked the way desktop-updater-state.test.ts does it,
// and the update key swapped for one made here so a signature can be made.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { releaseMessage } from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import { canInstallQuietly } from "../../../desktop/auto-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { trayMenuItems } from "../../../desktop/tray-menu.mjs";

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
  fake.checkForUpdates = vi.fn(async () => {});
  fake.quitAndInstall = vi.fn();
  fake.install = vi.fn(() => true);
  fake.setFeedURL = vi.fn();
  h.auto = fake;
  dir = mkdtempSync(join(tmpdir(), "ccdeck-unattended-"));
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

/** An updater with a verified download ready, installed from `resourcesPath`. */
async function ready(resourcesPath?: string) {
  const u = createUpdater({
    app: { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: vi.fn() },
    onChange: () => {},
    ...(resourcesPath ? { resourcesPath } : {}),
  });
  await u.check();
  const file = join(dir, "ccdeck-linux-amd64.deb");
  const bytes = Buffer.from("the package ccdeck built");
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
  return u;
}

/** A Resources folder that says which package it was installed from. */
const installedAs = (type: string) => {
  const resources = join(dir, "resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "package-type"), `${type}\n`);
  return resources;
};

describe("whether an update can install with nobody there", () => {
  it("cannot on a Linux install that is not an AppImage", async () => {
    onPlatform("linux");
    const u = await ready();
    expect(u.canInstallUnattended()).toBe(false);
  });

  it.each(["deb", "rpm", "pacman"])("cannot on a %s install, even with APPIMAGE in its environment", async (type) => {
    // The package-type file is what electron-updater picks its installer by,
    // so it wins over an APPIMAGE variable inherited from wherever the app
    // was started.
    onPlatform("linux");
    process.env.APPIMAGE = APPIMAGE;
    const u = await ready(installedAs(type));
    expect(u.canInstallUnattended()).toBe(false);
  });

  it("can on the AppImage, which replaces its own file", async () => {
    onPlatform("linux");
    process.env.APPIMAGE = APPIMAGE;
    const u = await ready();
    expect(u.canInstallUnattended()).toBe(true);
  });

  it("can on Windows, whose installer is per-user and asks nothing", async () => {
    onPlatform("win32");
    const u = await ready();
    expect(u.canInstallUnattended()).toBe(true);
  });
});

describe("the quiet install", () => {
  const quiet = { status: "ready", windowFocused: false, busy: false, quietSince: 0, now: 120_000 };

  it("never starts an install that would ask for a password", () => {
    expect(canInstallQuietly({ ...quiet, unattended: false })).toBe(false);
    expect(canInstallQuietly({ ...quiet, unattended: true })).toBe(true);
  });

  it("does not take a restart it cannot finish unattended, and asks the updater", () => {
    const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
    const quietFn = main.match(/function updateWhenQuiet\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(quietFn).toMatch(/unattended: updater\?\.canInstallUnattended\(\) \?\? false/);
    // Restarting the deck is not asking for an update: it takes a staged one
    // only when nothing will be asked on the way.
    const restartFn = main.match(/async function restartDeck\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(restartFn).toMatch(/updater\?\.state\.status === "ready" && updater\.canInstallUnattended\(\)/);
  });
});

describe("the Restart to update the person chooses", () => {
  const on = { openWindow() {}, startDeck() {}, openInBrowser() {}, toggleNotifications() {}, setOpenAtLogin() {}, restartToUpdate() {}, checkForUpdates() {}, restartDeck() {}, openStatusPage() {}, quit() {} };
  const menu = (updateAsksPassword: boolean) => trayMenuItems({
    now: 0,
    snapshot: { icon: "idle", waiting: 0, running: 0, blocked: [] },
    deck: { port: 4317 },
    starting: null,
    restarting: null,
    notifyOn: true,
    openAtLogin: false,
    appVersion: "3.26.0",
    update: { status: "ready", version: "3.27.0" },
    updateAsksPassword,
  }, on) as Array<{ label?: string }>;
  const restartRow = (rows: Array<{ label?: string }>) => rows.find(r => r.label?.startsWith("Restart to update to v3.27.0"));

  it("says that it will ask for a password, where it will", () => {
    expect(restartRow(menu(true))?.label).toMatch(/password/);
    expect(restartRow(menu(false))?.label).toBe("Restart to update to v3.27.0");
  });
});
