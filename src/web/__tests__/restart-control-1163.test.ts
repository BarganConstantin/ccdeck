// #1163: the deck restarted from the page and from the tray, without a terminal.
//
// The only restart the page offered was inside the update notice, and the tray
// had Quit and nothing that brought the deck back. Both now go through the one
// route that already existed — POST /api/restart, which the supervisor in
// bin/agent-dag.js answers by bringing the replacement up on the same port.
// Pinned by reading the sources: the tray is an Electron main process the suite
// cannot import, and the dialog's door is one conditional.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MODAL = read("../components/ReleaseNotesModal.tsx");
/** The dialog's action strip, where its Restart is drawn. */
const STRIP = read("../components/ReleaseActions.tsx");
const APP = read("../App.tsx");
/** The dialogs App.tsx mounts, the release notes among them. */
const DIALOGS = read("../components/DeckDialogs.tsx");
const TRAY = read("../../../desktop/main.mjs");
/** The tray's rows, which main.mjs draws through trayMenuItems. */
const TRAY_MENU = read("../../../desktop/tray-menu.mjs");

describe("restart in the page", () => {
  it("is a door in the dialog the version chip opens, drawn only when it is offered", () => {
    expect(MODAL).toMatch(/onRestart\?: \(\) => void;/);
    // The last button of the dialog's action strip, which the owner asked for
    // in place of three stacked rows: set apart at the end, its sentence in its
    // hint and its description, and still drawn only when it is offered.
    expect(MODAL).toMatch(/<ReleaseActions [^>]*onRestart=\{onRestart\}/);
    // Standing down only while the line under the strip offers an update,
    // which restarts too: two restarts side by side, one of which updates, is
    // the guess #1187 already took off this dialog for the app's update.
    expect(STRIP).toContain("const restartDoor = updates ? undefined : onRestart;");
    expect(STRIP).toMatch(/\{restartDoor && \(\s*<button type="button" className="btn rn-act rn-act-restart" onClick=\{restartDoor\}/);
    expect(STRIP).toMatch(/<RestartGlyph \/>Restart\s*<\/button>/);
    expect(STRIP).toContain('RESTART_WHY = "Restart the deck. Sessions, settings and pairings come back as they were."');
  });

  it("is offered only where the server would do it, and goes through the page's own restart", () => {
    // askRestart is the path the update notice already uses: it shows
    // "Restarting ccdeck…" while the socket is down and reconnects on its own.
    // Except while the desktop app has a verified update ready (#1187): the
    // dialog's Update and restart is then the restart it offers, the way the
    // tray's Restart ccdeck takes a staged update on its way through.
    // Two links: the door is written where the dialog is mounted, and App.tsx
    // hands that the restart, the version and the desktop update whole.
    expect(DIALOGS).toMatch(/onRestart=\{!readyAppUpdate && version\?\.canRestart \? \(\) => \{ closeReleaseNotes\(\); void askRestart\(\); \} : undefined\}/);
    expect(APP).toMatch(/<DeckDialogs\b[^>]*\bdesktopUpdate=\{desktopUpdate\} versionCheck=\{versionCheck\} restart=\{restart\}/);
  });
});

describe("restart in the tray", () => {
  // From trayMenuItems to the next function, or to the end of the file.
  const from = TRAY_MENU.indexOf("export function trayMenuItems(");
  const next = TRAY_MENU.indexOf("\nexport function ", from + 1);
  const menu = TRAY_MENU.slice(from, next === -1 ? undefined : next);

  it("sits above Quit, and only while there is a deck to restart", () => {
    expect(from, "trayMenuItems is gone or renamed").toBeGreaterThan(-1);
    const restart = menu.indexOf('label: "Restart ccdeck"');
    const quit = menu.indexOf('label: "Quit ccdeck"');
    expect(restart).toBeGreaterThan(-1);
    expect(restart).toBeLessThan(quit);
    expect(menu).toMatch(/label: "Restart ccdeck", enabled: !!deck && !starting && !restarting, click: \(\) => on\.restartDeck\(\)/);
    // And the row's action is this app's restartDeck.
    expect(TRAY).toMatch(/restartDeck: \(\) => restartDeck\(\),/);
  });

  it("asks the deck's own restart route, with the app's token, and says it is restarting", () => {
    const fn = TRAY.slice(TRAY.indexOf("async function restartDeck()"), TRAY.indexOf("async function stopOwnDeck()"));
    expect(fn).toMatch(/deckJson\(deck, "\/api\/restart", \{ method: "POST"/);
    // A deck this app started that cannot restart itself is stopped and
    // started again; one from a terminal is left alone.
    expect(fn).toMatch(/if \(!asked && ownDeck\.current\(\)\) \{\s*await stopOwnDeck\(\);/);
    expect(TRAY_MENU).toMatch(/if \(restarting\) return "Restarting the deck…";/);
    // And the new deck answering is what ends it.
    expect(TRAY).toMatch(/if \(found && restarting\) restarting = null;/);
  });
});
