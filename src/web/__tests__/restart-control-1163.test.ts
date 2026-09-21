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
const APP = read("../App.tsx");
const TRAY = read("../../../desktop/main.mjs");

describe("restart in the page", () => {
  it("is a door in the dialog the version chip opens, drawn only when it is offered", () => {
    expect(MODAL).toMatch(/onRestart\?: \(\) => void;/);
    expect(MODAL).toMatch(/\{onRestart && \(\s*<div className="guide-door">/);
    expect(MODAL).toMatch(/<button type="button" className="btn" onClick=\{onRestart\}>Restart<\/button>/);
  });

  it("is offered only where the server would do it, and goes through the page's own restart", () => {
    // askRestart is the path the update notice already uses: it shows
    // "Restarting ccdeck…" while the socket is down and reconnects on its own.
    expect(APP).toMatch(/onRestart=\{version\?\.canRestart \? \(\) => \{ setReleaseNotes\(null\); void askRestart\(\); \} : undefined\}/);
  });
});

describe("restart in the tray", () => {
  const menu = TRAY.slice(TRAY.indexOf("function buildMenu()"), TRAY.indexOf("function updateItem()"));

  it("sits above Quit, and only while there is a deck to restart", () => {
    const restart = menu.indexOf('label: "Restart ccdeck"');
    const quit = menu.indexOf('label: "Quit ccdeck"');
    expect(restart).toBeGreaterThan(-1);
    expect(restart).toBeLessThan(quit);
    expect(menu).toMatch(/label: "Restart ccdeck", enabled: !!deck && !starting && !restarting, click: \(\) => restartDeck\(\)/);
  });

  it("asks the deck's own restart route, with the app's token, and says it is restarting", () => {
    const fn = TRAY.slice(TRAY.indexOf("async function restartDeck()"), TRAY.indexOf("async function stopOwnDeck()"));
    expect(fn).toMatch(/deckJson\(deck, "\/api\/restart", \{ method: "POST"/);
    // A deck this app started that cannot restart itself is stopped and
    // started again; one from a terminal is left alone.
    expect(fn).toMatch(/if \(!asked && ownDeck\) \{\s*await stopOwnDeck\(\);/);
    expect(TRAY).toMatch(/if \(restarting\) return "Restarting the deck…";/);
    // And the new deck answering is what ends it.
    expect(TRAY).toMatch(/if \(found && restarting\) restarting = null;/);
  });
});
