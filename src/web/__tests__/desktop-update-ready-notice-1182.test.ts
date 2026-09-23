// A verified desktop update should be visible to somebody already using the
// app, without the updater raising a window just to announce itself (#1182).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shouldOfferReadyUpdate } from "../../../desktop/update-notice.mjs";

const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
const ready = {
  status: "ready",
  version: "3.28.0",
  shownVersion: null,
  windowOpen: true,
  windowVisible: true,
  windowFocused: true,
  running: 0,
  waiting: 0,
  prompting: false,
};

describe("the ready-update notice", () => {
  it("appears for a new verified version in the focused idle window", () => {
    expect(shouldOfferReadyUpdate(ready)).toBe(true);
  });

  it("waits until there is an existing window the person is looking at", () => {
    expect(shouldOfferReadyUpdate({ ...ready, windowOpen: false })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, windowVisible: false })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, windowFocused: false })).toBe(false);
  });

  it("waits until the deck is idle", () => {
    expect(shouldOfferReadyUpdate({ ...ready, running: 1 })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, waiting: 1 })).toBe(false);
  });

  it("is once per version and cannot open a duplicate sheet", () => {
    expect(shouldOfferReadyUpdate({ ...ready, shownVersion: ready.version })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, prompting: true })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, status: "downloading" })).toBe(false);
    expect(shouldOfferReadyUpdate({ ...ready, version: "" })).toBe(false);
  });
});

describe("the desktop wiring", () => {
  it("offers Restart now and Later and restarts through the existing updater", () => {
    const fn = main.match(/async function offerReadyUpdate\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain('buttons: ["Restart now", "Later"]');
    expect(fn).toMatch(/response === 0[\s\S]*?updater\.restartNow\(\)/);
    expect(fn).toContain("rememberUpdateNotice(version)");
    expect(fn).not.toContain("new BrowserWindow");
  });

  it("keeps one on-disk memory for the sheet and the window's own offer (#1187)", () => {
    // The window's version dialog offers the same Update and restart. Seeing
    // it there is this version's one notice, so the sheet must not follow it.
    const remember = main.match(/function rememberUpdateNotice\(version\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(remember).toContain("updateNoticeVersion = version");
    expect(remember).toContain("readyUpdateNoticeVersion: version");
    expect(main).toMatch(/updateSeen: request => \{\s*if \(matchesReadyUpdate\(updater, request\?\.version\)\) rememberUpdateNotice\(updater\.state\.version\);/);
  });

  it("retries the offer when readiness, focus, or idle state changes", () => {
    expect(main).toMatch(/onChange: s => \{[\s\S]*?offerReadyUpdate\(\);/);
    expect(main).toMatch(/win\.on\("focus", \(\) => \{[\s\S]*?offerReadyUpdate\(\);/);
    expect(main).toMatch(/if \(model\) snapshot = model\.snapshot\(\);\n    offerReadyUpdate\(\);/);
  });

  it("ships the notice rule in the desktop bundle", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../desktop/electron-builder.config.cjs", import.meta.url)), "utf8");
    expect(config).toMatch(/"update-notice\.mjs"/);
  });
});
