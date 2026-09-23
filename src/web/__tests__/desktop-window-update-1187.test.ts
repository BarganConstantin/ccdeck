import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchesReadyUpdate, restartReadyUpdate } from "../../../desktop/window-update.mjs";
import { desktopAppVersion, readDesktopUpdate, readyDesktopUpdate } from "../desktop-update";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("desktop update state in the window", () => {
  it("accepts known states and requires a version for ready", () => {
    expect(readDesktopUpdate({ status: "downloading", version: " 3.28.0 " }))
      .toEqual({ status: "downloading", version: "3.28.0" });
    expect(readDesktopUpdate({ status: "ready", version: "3.28.0" }))
      .toEqual({ status: "ready", version: "3.28.0" });
    expect(readDesktopUpdate({ status: "ready", version: "" })).toBeNull();
    expect(readDesktopUpdate({ status: "invented", version: "3.28.0" })).toBeNull();
    expect(readDesktopUpdate(null)).toBeNull();
  });

  it("only exposes an actionable update when Electron reported ready", () => {
    expect(readyDesktopUpdate({ status: "ready", version: "3.28.0" }))
      .toEqual({ version: "3.28.0" });
    expect(readyDesktopUpdate({ status: "downloading", version: "3.28.0" })).toBeNull();
    expect(readyDesktopUpdate(null)).toBeNull();
  });

  it("names the app's own version as the one being updated, not the deck's", () => {
    // The app may be attached to an npm deck at another version entirely.
    expect(desktopAppVersion("Mozilla/5.0 Chrome/140 Electron/38 ccdeck-desktop/3.28.1")).toBe("3.28.1");
    expect(desktopAppVersion("Mozilla/5.0 ccdeck-desktop/3.29.0-beta.1 extra")).toBe("3.29.0-beta.1");
    expect(desktopAppVersion("Mozilla/5.0 Chrome/140")).toBeNull();
  });
});

describe("the native restart gate", () => {
  it("restarts only the exact version Electron still considers ready", () => {
    const restartNow = vi.fn();
    const updater = { state: { status: "ready", version: "3.28.0" }, restartNow };

    expect(restartReadyUpdate(updater, "3.28.0")).toBe(true);
    expect(restartNow).toHaveBeenCalledTimes(1);

    restartNow.mockClear();
    expect(restartReadyUpdate(updater, "3.28.1")).toBe(false);
    expect(restartReadyUpdate({ ...updater, state: { status: "downloading", version: "3.28.0" } }, "3.28.0")).toBe(false);
    expect(restartNow).not.toHaveBeenCalled();
  });

  it("holds the window's 'shown' notice to the same exact-version test", () => {
    const updater = { state: { status: "ready", version: "3.28.0" } };
    expect(matchesReadyUpdate(updater, " 3.28.0 ")).toBe(true);
    expect(matchesReadyUpdate(updater, "3.28.1")).toBe(false);
    expect(matchesReadyUpdate(updater, "")).toBe(false);
    expect(matchesReadyUpdate(updater, 3.28)).toBe(false);
    expect(matchesReadyUpdate({ state: { status: "downloading", version: "3.28.0" } }, "3.28.0")).toBe(false);
    expect(matchesReadyUpdate(null, "3.28.0")).toBe(false);
  });
});

describe("the one-button window wiring", () => {
  it("publishes updater state and routes the window request through the native gate", () => {
    const main = read("../../../desktop/main.mjs");
    const config = read("../../../desktop/electron-builder.config.cjs");
    expect(main).toContain('deckJson(deck, "/api/desktop-update", { method: "POST", body: { status, version } })');
    expect(main).toContain("restartReadyUpdate(updater, version)");
    // The window having shown the offer counts as this version's one notice,
    // so the native sheet does not ask again on top of it (#1182).
    expect(main).toMatch(/updateSeen: request => \{[\s\S]*?rememberUpdateNotice\(/);
    expect(config).toContain('"window-update.mjs"');
  });

  it("shows the verified target version and one Update and restart action", () => {
    const app = read("../App.tsx");
    const modal = read("../components/ReleaseNotesModal.tsx");
    expect(app).toContain('es.addEventListener("desktop-update"');
    expect(app).toMatch(/es\.addEventListener\("desktop-update"[\s\S]*?if \(!inDesktopApp\(\)\) return;/);
    expect(app).toContain('fetch("/api/desktop-update/restart"');
    expect(app).toContain("v{desktopAppVersion() ?? chipVersion} → v{readyAppUpdate.version}");
    // One restart door: the deck's own Restart is not offered beside it.
    expect(app).toContain("onRestart={!readyAppUpdate && version?.canRestart");
    expect(modal).toContain("ccdeck v{updateVersion} is downloaded and verified.");
    expect(modal).toContain('"Update and restart"');
    // Busy but never disabled (#620); the guard is App's ref.
    expect(modal).toContain("onClick={onUpdateRestart} aria-busy={updateBusy || undefined}>");
    expect(app).toContain("if (!selfPressAccepted(desktopUpdateAskedRef.current)) return;");
  });

  it("tells the app when the dialog has offered the update", () => {
    const app = read("../App.tsx");
    expect(app).toContain("const offeredAppUpdate = releaseNotes && readyAppUpdate ? readyAppUpdate.version : null;");
    expect(app).toContain('fetch("/api/desktop-update/seen"');
  });

  it("asks for the app's state again on every reconnect, not only on load", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/if \(!live \|\| !inDesktopApp\(\)\) return;[\s\S]*?fetch\("\/api\/desktop-update"\)[\s\S]*?\}, \[live\]\);/);
  });
});
