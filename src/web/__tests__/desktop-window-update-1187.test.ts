import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchesReadyUpdate, restartReadyUpdate } from "../../../desktop/window-update.mjs";
import {
  desktopAppVersion,
  readDesktopUpdate,
  readyChipCopy,
  readyDesktopUpdate,
  RESTART_TO_UPDATE,
  trayMenuName,
  UPDATE_RESTART_WAIT_MS,
  updateRestartFailureText,
  updateRestartRefusal,
  type UpdateRestartFailure,
} from "../desktop-update";

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

  it("shows the verified target version and one Restart to update action", () => {
    const app = read("../App.tsx");
    const modal = read("../components/ReleaseNotesModal.tsx");
    expect(app).toContain('es.addEventListener("desktop-update"');
    expect(app).toMatch(/es\.addEventListener\("desktop-update"[\s\S]*?if \(!inDesktopApp\(\)\) return;/);
    expect(app).toContain('fetch("/api/desktop-update/restart"');
    expect(app).toContain("readyChipCopy(desktopAppVersion() ?? chipVersion, readyAppUpdate.version)");
    // One restart door: the deck's own Restart is not offered beside it.
    expect(app).toContain("onRestart={!readyAppUpdate && version?.canRestart");
    expect(modal).toContain("ccdeck v{updateVersion} is downloaded and verified.");
    expect(modal).toContain('{updateBusy ? "Restarting…" : RESTART_TO_UPDATE}');
    // Busy but never disabled (#620); the guard is App's ref.
    expect(modal).toContain("onClick={onUpdateRestart} aria-busy={updateBusy || undefined}>");
    expect(app).toContain("if (!selfPressAccepted(desktopUpdateAskedRef.current)) return;");
  });

  it("puts the update first and holds the tour back while it is ready", () => {
    const modal = read("../components/ReleaseNotesModal.tsx");
    const body = modal.slice(modal.indexOf('<section className="modal-body">'));
    const update = body.indexOf("onClick={onUpdateRestart}");
    expect(update).toBeGreaterThan(-1);
    // Ahead of the intro, the tour and the deck's own Restart.
    expect(update).toBeLessThan(body.indexOf('<p className="modal-note">'));
    expect(update).toBeLessThan(body.indexOf("onClick={onTour}"));
    expect(update).toBeLessThan(body.indexOf("onClick={onRestart}"));
    expect(body).toMatch(/\{onTour && !updateVersion && \(/);
  });

  it("wears its own chip, not the stale chip's warning", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("readyChipCopy(desktopAppVersion()");
    const chip = app.slice(at, app.indexOf("</button>", at));
    expect(chip).toContain('className="v ready"');
    expect(chip).not.toContain("stale");
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

describe("the ready chip's words (#1187)", () => {
  it("starts its accessible name with what it prints (WCAG 2.5.3)", () => {
    const copy = readyChipCopy("1.63.0", "1.64.0");
    expect(copy.text).toBe("v1.63.0 → v1.64.0");
    expect(copy.label.startsWith(copy.text)).toBe(true);
  });

  it("says what a click does, which is open What's new, not restart", () => {
    const { title } = readyChipCopy("1.63.0", "1.64.0");
    expect(title).toContain("v1.64.0 is downloaded and verified");
    expect(title).toContain("click to open What's new");
    expect(title).toContain(RESTART_TO_UPDATE);
    expect(title).not.toMatch(/click to (?:update|restart)/i);
    const app = read("../App.tsx");
    expect(app).not.toContain("click to update and restart");
  });
});

describe("one phrase and one version spelling on all three surfaces (#1187)", () => {
  const main = read("../../../desktop/main.mjs");
  const modal = read("../components/ReleaseNotesModal.tsx");

  it("says Restart to update in the window, the native sheet and the tray", () => {
    expect(RESTART_TO_UPDATE).toBe("Restart to update");
    expect(modal).toContain("RESTART_TO_UPDATE");
    expect(main).toContain('buttons: ["Restart to update", "Later"]');
    expect(main).toContain("label: `Restart to update to v${u.version}`");
    for (const src of [main, modal, read("../App.tsx")]) {
      expect(src).not.toMatch(/"Update and restart"|"Restart now", "Later"/);
    }
  });

  it("spells the version with its v everywhere the update is named", () => {
    expect(main).toContain("message: `ccdeck v${version} is ready`");
    expect(main).toContain("label: `Downloading ccdeck v${u.version}…`");
    expect(main).toContain("`ccdeck v${app.getVersion()}");
    expect(modal).toContain("ccdeck v{updateVersion} is downloaded and verified.");
    // No bare version after "ccdeck " or "update to " in the desktop copy.
    expect(main).not.toMatch(/(?:ccdeck|update to|deck) \$\{(?:u\.version|version|app\.getVersion\(\)|deck\.version)\}/);
  });

  it("names the tray menu the way the native sheet does", () => {
    expect(trayMenuName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ccdeck-desktop/1.63.0")).toBe("the ccdeck menu in the menu bar");
    expect(trayMenuName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) ccdeck-desktop/1.63.0")).toBe("the ccdeck tray menu");
    expect(trayMenuName("Mozilla/5.0 (X11; Linux x86_64) ccdeck-desktop/1.63.0")).toBe("the ccdeck tray menu");
    expect(main).toContain('process.platform === "darwin" ? "the ccdeck menu in the menu bar" : "the ccdeck tray menu"');
  });
});

describe("a restart that did not happen says so (#1187)", () => {
  const linux = "Mozilla/5.0 (X11; Linux x86_64) ccdeck-desktop/1.63.0";

  it("reads the server's two refusals and calls anything else refused", () => {
    expect(updateRestartRefusal({ ok: false, reason: "app_disconnected" })).toBe("app_disconnected");
    expect(updateRestartRefusal({ ok: false, reason: "update_not_ready" })).toBe("update_not_ready");
    expect(updateRestartRefusal({ ok: false, reason: "app_token_required" })).toBe("refused");
    expect(updateRestartRefusal(null)).toBe("refused");
  });

  it("says what happened and names the tray's Restart to update, every time", () => {
    const all: UpdateRestartFailure[] = ["app_disconnected", "update_not_ready", "refused", "unreachable", "timeout"];
    const said = all.map(f => updateRestartFailureText(f, "1.64.0", linux));
    expect(new Set(said).size).toBe(all.length);
    for (const text of said) {
      expect(text).toContain(RESTART_TO_UPDATE);
      expect(text).toContain("the ccdeck tray menu");
    }
    expect(updateRestartFailureText("app_disconnected", "1.64.0", linux)).toMatch(/not connected to this deck/);
    expect(updateRestartFailureText("update_not_ready", "1.64.0", linux)).toMatch(/no longer has v1\.64\.0 ready/);
    expect(updateRestartFailureText("timeout", "1.64.0", linux)).toContain(`${UPDATE_RESTART_WAIT_MS / 1000} seconds`);
  });

  it("hands the press back with a reason, into a live region the dialog already has", () => {
    const app = read("../App.tsx");
    const modal = read("../components/ReleaseNotesModal.tsx");
    expect(app).toContain("handBack(updateRestartRefusal(await response.json().catch(() => null)))");
    expect(app).toContain('return handBack("unreachable");');
    expect(app).toContain('desktopUpdateTimerRef.current = window.setTimeout(() => handBack("timeout"), UPDATE_RESTART_WAIT_MS);');
    expect(app).toContain("setDesktopUpdateFailure({ failure, version: updateVersion });");
    expect(app).toContain("updateFailure={desktopUpdateFailure");
    // Mounted with the door, empty until a press fails.
    expect(modal).toContain('<p className="rn-update-said" role="status">{updateFailure}</p>');
    expect(modal).toMatch(/\{\(updateVersion \|\| updateFailure\) && \(\s*<div className="rn-update">/);
  });

  it("never lets an older press's clock or answer hand back a newer one", () => {
    const app = read("../App.tsx");
    const start = app.indexOf("const askDesktopUpdateRestart = useCallback(");
    const ask = app.slice(start, app.indexOf("}, []);", start));
    // Each press takes a number and stops whatever clock is still running.
    expect(ask).toMatch(/const press = \+\+desktopUpdatePressRef\.current;\s*window\.clearTimeout\(desktopUpdateTimerRef\.current\);/);
    // A hand-back for any press but the latest is ignored, and one that is
    // taken stops the clock.
    expect(ask).toMatch(/const handBack = \(failure: UpdateRestartFailure\) => \{\s*if \(press !== desktopUpdatePressRef\.current\) return;\s*window\.clearTimeout\(desktopUpdateTimerRef\.current\);/);
    // The clock is armed only for a press that is still the current one, and
    // its id is kept so it can be stopped.
    expect(ask).toMatch(/if \(press !== desktopUpdatePressRef\.current\) return;\s*desktopUpdateTimerRef\.current = window\.setTimeout\(/);
    expect(ask).not.toMatch(/window\.setTimeout\(\(\) => \{ if \(desktopUpdateAskedRef\.current\)/);
    // The stream releasing the press ends it too: new number, clock stopped.
    expect(app).toMatch(/if \(next\.status !== "ready"\) \{[\s\S]*?desktopUpdatePressRef\.current\+\+;\s*window\.clearTimeout\(desktopUpdateTimerRef\.current\);\s*desktopUpdateAskedRef\.current = false;/);
    // And the page going away takes the clock with it.
    expect(app).toContain("useEffect(() => () => window.clearTimeout(desktopUpdateTimerRef.current), []);");
  });
});
