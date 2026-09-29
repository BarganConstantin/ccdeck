// A second launch of the desktop app starts nothing of its own (#1725).
//
// Opening ccdeck while it already runs starts a second copy. It is refused the
// single-instance lock, hands its launch to the running one — whose
// "second-instance" opens its window — and quits. But quitting before `ready`
// does not stop `ready` from firing: checked against Electron itself, the
// refused copy still reached its whenReady handler. Its startup then drew a
// tray icon, whose image file went with the copy, so GNOME's panel showed a
// "…" that appeared and vanished. The same startup also loaded the tray model,
// set up the updater and began looking for a deck.
//
// The fix is a gate on the lock's answer. Electron cannot run in the suite, so
// what is checked is the gate itself, in the app's source.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(__dirname, "..", "..", "..", "desktop", "main.mjs"), "utf8");

/** The body of the app's whenReady handler, up to its first blank line. */
function readyHead(): string {
  const at = main.indexOf("app.whenReady().then(async () => {");
  expect(at).toBeGreaterThan(-1);
  return main.slice(at, main.indexOf("\n\n", at));
}

describe("the copy that is refused the single-instance lock", () => {
  it("keeps the lock's answer, and quits when refused", () => {
    expect(main).toMatch(/const primary = app\.requestSingleInstanceLock\(\);\nif \(!primary\) \{\n {2}app\.quit\(\);/);
  });

  it("starts nothing when ready fires anyway — no tray, no model, no updater, no deck", () => {
    const head = readyHead();
    const lines = head.split("\n").map(l => l.trim());
    // The gate is the handler's first statement, before anything it could start.
    expect(lines[1]).toBe("if (!primary) return;");
    for (const started of ["new Tray(", "loadModel()", "createUpdater(", "ensureDeck()"]) {
      expect(head.indexOf(started)).toBeGreaterThan(head.indexOf("if (!primary) return;"));
    }
  });

  it("opens no window of its own when macOS reactivates it", () => {
    expect(main).toContain('app.on("activate", () => { if (primary) openWindow(); });');
  });

  it("is the only whenReady handler, so no other startup slips past the gate", () => {
    expect(main.match(/app\.whenReady\(\)/g)).toHaveLength(1);
    expect(main).not.toMatch(/app\.on\("ready"/);
  });
});
