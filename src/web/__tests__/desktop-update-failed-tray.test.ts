// An update that failed says so in the tray.
//
// Every failure — a download that dropped, a release that would not verify, an
// app that cannot replace itself where it is — went to the trace log and
// nowhere else: the tray's row read "Check for updates", exactly as it did
// before any update had been looked for. The one failure with a remedy the
// person can carry out, an app in a folder it cannot write to (#1927), said
// what to do only in a log nobody reads.
//
// Now the row says the update failed, and for that one says what to do. The
// updater's state carries which failure it was; tray-menu.mjs words it.
//
// electron-updater is mocked the way desktop-updater-state.test.ts does it, the
// macOS check and whether a folder can be written to are stood in for, and the
// update key swapped for one made here so a signature can be made. Nothing is
// installed and nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import * as mac from "../../../desktop/updater-mac.mjs";
import { trayMenuItems, updateItem } from "../../../desktop/tray-menu.mjs";

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
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  canReplace: vi.fn(),
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const onPlatform = (p: string) => Object.defineProperty(process, "platform", { ...realPlatform, value: p });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Item = { label?: string; enabled?: boolean; click?: () => unknown };

function actions() {
  return {
    openWindow: vi.fn(), startDeck: vi.fn(), openInBrowser: vi.fn(), toggleNotifications: vi.fn(),
    setOpenAtLogin: vi.fn(), restartToUpdate: vi.fn(), checkForUpdates: vi.fn(), restartDeck: vi.fn(),
    openStatusPage: vi.fn(), quit: vi.fn(),
  };
}

/** The tray's update row for the updater's state, as main.mjs draws it. */
function updateRow(update: unknown, on = actions()): Item {
  const items = trayMenuItems({
    now: 0, snapshot: { icon: "idle", waiting: 0, running: 0, blocked: [] }, deck: { port: 4317 },
    starting: null, restarting: null, notifyOn: true, openAtLogin: false, appVersion: "3.26.0", update,
  }, on) as Item[];
  return items[items.findIndex(i => i.label?.startsWith("ccdeck v3.26.0")) + 1];
}

let root = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccdeck-update-failed-"));
  for (const k of ["APPIMAGE", "CCDECK_UPDATE_FEED"]) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.mocked(mac.checkForUpdate).mockReset().mockResolvedValue({ version: "3.27.0", file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: "https://x/ccdeck-mac-arm64.zip" });
  vi.mocked(mac.stageUpdate).mockReset().mockResolvedValue({ staged: "/tmp/x/ccdeck.app", dir: "/tmp/x" });
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

/** Windows and Linux: an electron-updater whose check offers 3.27.0 and runs
 *  `download` for what happens next. */
function fakeAuto(download: (fake: EventEmitter) => void) {
  const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
  fake.setFeedURL = vi.fn();
  fake.checkForUpdates = vi.fn(async () => {
    fake.emit("update-available", { version: "3.27.0" });
    download(fake);
    return { isUpdateAvailable: true, downloadPromise: null };
  });
  h.auto = fake;
  return fake;
}

async function settle(u: { state: { status: string } }) {
  for (let i = 0; i < 200 && (u.state.status === "checking" || u.state.status === "downloading"); i++) await sleep(5);
}

const app = (exe = "/nowhere") => ({
  isPackaged: true, getVersion: () => "3.26.0", getPath: (name: string) => (name === "exe" ? exe : join(root, name)), quit: vi.fn(),
});

describe("the tray after an update that failed", () => {
  it("says it failed, and trying again checks again", () => {
    const on = actions();
    const row = updateItem({ status: "error", error: "net::ERR_NETWORK_CHANGED" }, on);
    expect(row.label).toBe("Update failed — try again");
    row.click();
    expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
    // Nothing looked for yet is not a failure.
    expect(updateItem({ status: "idle" }, on).label).toBe("Check for updates");
  });

  it("after a download that dropped", async () => {
    onPlatform("linux");
    fakeAuto(fake => setTimeout(() => fake.emit("error", new Error("net::ERR_NETWORK_CHANGED")), 5));
    const u = createUpdater({ app: app(), onChange: () => {} });
    await u.check();
    await settle(u);
    expect(u.state.status).toBe("error");
    expect(updateRow(u.state).label).toBe("Update failed — try again");
  });

  it("macOS: says to move ccdeck to Applications when it cannot replace itself where it is", async () => {
    onPlatform("darwin");
    vi.mocked(mac.canReplace).mockResolvedValue(false);
    const u = createUpdater({ app: app("/Volumes/ccdeck/ccdeck.app/Contents/MacOS/ccdeck"), onChange: () => {} });
    await u.check();
    expect(u.state.status).toBe("error");
    expect(u.state.error).toMatch(/move it to Applications/);
    const on = actions();
    const row = updateRow(u.state, on);
    expect(row.label).toBe("Move ccdeck to Applications to update");
    row.click?.();
    expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("Linux: says to move the AppImage when its folder cannot be written to", async () => {
    onPlatform("linux");
    process.env.APPIMAGE = join(root, "opt", "ccdeck", "ccdeck-linux-x86_64.AppImage");
    mkdirSync(dirname(process.env.APPIMAGE), { recursive: true });
    const file = join(root, "ccdeck-linux-x86_64.AppImage");
    const bytes = Buffer.from("the AppImage ccdeck built");
    writeFileSync(file, bytes);
    fakeAuto(fake => fake.emit("update-downloaded", {
      version: "3.27.0",
      downloadedFile: file,
      files: [{
        url: basename(file), sha512: "x",
        ed25519: sign(null, bytes, h.priv).toString("base64"),
        ed25519Release: sign(null, mac.releaseMessage("3.27.0", basename(file), bytes), h.priv).toString("base64"),
      }],
    }));
    vi.mocked(mac.canReplace).mockResolvedValue(false);
    const u = createUpdater({ app: app(), onChange: () => {}, resourcesPath: join(root, "no-resources") });
    await u.check();
    await settle(u);
    expect(u.state.status).toBe("error");
    expect(updateRow(u.state).label).toBe("Move the AppImage to a writable folder to update");
  });
});
