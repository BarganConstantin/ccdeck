// A release the macOS swap could not put in place is said as skipped in the
// tray, not as a failure to try again.
//
// When the swap script fails to put a release in place, it writes that release
// down and the updater does not stage it again (#1927): trying again is
// refused the same way, every time, until a newer release comes out. The tray
// row read "Update failed — try again" all the same (#1930), so it invited the
// one thing that could not work for that release. Now the updater says which
// release it is skipping, and the row says so and offers to look for the next
// one — which is what a click on it does.
//
// The macOS check is stood in for (checkForUpdate, stageUpdate, canReplace), as
// in desktop-update-failed-tray.test.ts. Nothing is downloaded, installed or
// started.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import * as mac from "../../../desktop/updater-mac.mjs";
import { trayMenuItems } from "../../../desktop/tray-menu.mjs";

vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  canReplace: vi.fn(),
}));
vi.mock("../../../desktop/relaunch-linux.mjs", () => ({ relaunchOnExit: vi.fn() }));

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

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

const offered = (version: string) => ({
  version, file: { arch: "arm64", url: "ccdeck-mac-arm64.zip" }, url: "https://x/ccdeck-mac-arm64.zip",
});

let root = "";
let feedEnv: string | undefined;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
  feedEnv = process.env.CCDECK_UPDATE_FEED;
  delete process.env.CCDECK_UPDATE_FEED;
  root = mkdtempSync(join(tmpdir(), "ccdeck-skipped-release-"));
  mkdirSync(join(root, "userData"), { recursive: true });
  vi.mocked(mac.checkForUpdate).mockReset().mockResolvedValue(offered("3.27.0"));
  vi.mocked(mac.stageUpdate).mockReset().mockResolvedValue({ staged: "/tmp/x/ccdeck.app", dir: "/tmp/x" });
  vi.mocked(mac.canReplace).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (feedEnv === undefined) delete process.env.CCDECK_UPDATE_FEED;
  else process.env.CCDECK_UPDATE_FEED = feedEnv;
  rmTempDir(root);
});

/** A ccdeck.app in /Applications whose swap of `version` failed last time —
 *  the note the swap script leaves (updater-mac.mjs). */
function afterFailedSwapOf(version: string) {
  writeFileSync(join(root, "userData", "update-swap-failed"), `${version}\n`);
  return {
    isPackaged: true, getVersion: () => "3.26.0", quit: vi.fn(),
    getPath: (name: string) => (name === "exe" ? "/Applications/ccdeck.app/Contents/MacOS/ccdeck" : join(root, name)),
  };
}

describe("the tray after a release the swap could not put in place", () => {
  it("says that release is skipped rather than inviting a retry", async () => {
    const u = createUpdater({ app: afterFailedSwapOf("3.27.0"), onChange: () => {} });
    await u.check();
    expect(u.state).toMatchObject({ status: "error", kind: "skipped-release", version: "3.27.0" });
    expect(mac.stageUpdate).not.toHaveBeenCalled();
    const row = updateRow(u.state);
    expect(row.label).not.toMatch(/try again/i);
    expect(row.label).toBe("Skipped v3.27.0 — check for the next release");
  });

  it("looks for the next release when clicked, and takes it once there is one", async () => {
    const app = afterFailedSwapOf("3.27.0");
    const on = actions();
    const u = createUpdater({ app, onChange: () => {} });
    on.checkForUpdates.mockImplementation(() => u.check());
    await u.check();
    // Still only 3.27.0 out: the click asks, and the row stays as it was.
    await updateRow(u.state, on).click?.();
    expect(on.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updateRow(u.state).label).toBe("Skipped v3.27.0 — check for the next release");
    // 3.27.1 is out: the same click stages it.
    vi.mocked(mac.checkForUpdate).mockResolvedValue(offered("3.27.1"));
    await updateRow(u.state, on).click?.();
    expect(u.state).toEqual({ status: "ready", version: "3.27.1" });
    expect(updateRow(u.state).label).toBe("Restart to update to v3.27.1");
  });

  it("still says any other failure as one to try again", async () => {
    vi.mocked(mac.checkForUpdate).mockRejectedValue(new Error("getaddrinfo ENOTFOUND ccdeck.dev"));
    const u = createUpdater({ app: afterFailedSwapOf("3.25.0"), onChange: () => {} });
    await u.check();
    expect(u.state.status).toBe("error");
    expect(updateRow(u.state).label).toBe("Update failed — try again");
  });
});
