import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { restartReadyUpdate } from "../../../desktop/window-update.mjs";
import { readDesktopUpdate, readyDesktopUpdate } from "../desktop-update";

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
});

describe("the one-button window wiring", () => {
  it("publishes updater state and routes the window request through the native gate", () => {
    const main = read("../../../desktop/main.mjs");
    const config = read("../../../desktop/electron-builder.config.cjs");
    expect(main).toContain('deckJson(deck, "/api/desktop-update", { method: "POST", body: { status, version } })');
    expect(main).toContain("restartReadyUpdate(updater, version)");
    expect(config).toContain('"window-update.mjs"');
  });

  it("shows the verified target version and one Update and restart action", () => {
    const app = read("../App.tsx");
    const modal = read("../components/ReleaseNotesModal.tsx");
    expect(app).toContain('es.addEventListener("desktop-update"');
    expect(app).toMatch(/es\.addEventListener\("desktop-update"[\s\S]*?if \(!inDesktopApp\(\)\) return;/);
    expect(app).toContain('fetch("/api/desktop-update/restart"');
    expect(app).toContain("v{chipVersion} → v{readyAppUpdate.version}");
    expect(app).toContain("onRestart={!readyAppUpdate && version?.canRestart");
    expect(modal).toContain("ccdeck v{updateVersion} is downloaded and verified.");
    expect(modal).toContain('"Update and restart"');
    expect(modal).toContain("{!onUpdateRestart && onRestart && (");
  });
});
