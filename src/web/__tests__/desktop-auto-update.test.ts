// The app updating itself, and the two ways it may not (#1187).
//
// A staged update used to wait for a press in the tray menu or for a quit, and
// the app is built to be left alone in the menu bar, so it waited. It now
// installs itself once the app has been quiet for a while — and "quiet" is the
// whole of the safety here, because an update restarts the app and the app
// restarts the deck it hosts. Every clause below is one way of saying: not
// while somebody is there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canInstallQuietly, QUIET_MS, quietSinceNext } from "../../../desktop/auto-update.mjs";

const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
const NOW = 1_800_000_000_000;
const quiet = { windowFocused: false, waiting: 0, running: 0, busy: false, now: NOW };
/** Quiet for long enough, with the update verified and staged. */
const ripe = { status: "ready", quietSince: NOW - QUIET_MS, ...quiet };

describe("installing an update by itself", () => {
  it("happens when the update is ready and the app has been left alone", () => {
    expect(canInstallQuietly(ripe)).toBe(true);
  });

  it("never installs anything that is not ready", () => {
    // "ready" is the only state that means downloaded, hashed and signed by
    // ccdeck's own key. Everything else is a download in flight, a refusal, or
    // nothing at all.
    for (const status of ["idle", "checking", "downloading", "current", "error"]) {
      expect(canInstallQuietly({ ...ripe, status }), status).toBe(false);
    }
  });

  it("waits while a session is running or waiting on somebody", () => {
    expect(canInstallQuietly({ ...ripe, running: 1 })).toBe(false);
    expect(canInstallQuietly({ ...ripe, waiting: 1 })).toBe(false);
  });

  it("waits while somebody is in the window, or while the deck is starting or restarting", () => {
    // Focused, not merely open: a window left behind other things is nobody
    // there, and it comes back by itself after the restart.
    expect(canInstallQuietly({ ...ripe, windowFocused: true })).toBe(false);
    expect(canInstallQuietly({ ...ripe, busy: true })).toBe(false);
  });

  it("waits out the whole quiet window, and does not count an app that just started", () => {
    expect(canInstallQuietly({ ...ripe, quietSince: NOW - QUIET_MS + 1 })).toBe(false);
    expect(canInstallQuietly({ ...ripe, quietSince: null as unknown as number })).toBe(false);
    // Long enough that it cannot land in the gap between two turns of one
    // agent, and short enough that an app left alone for an afternoon is on
    // the current version by itself.
    expect(QUIET_MS).toBeGreaterThanOrEqual(30_000);
    expect(QUIET_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("the quiet the rule measures", () => {
  it("starts at the first quiet moment and keeps it while nothing happens", () => {
    const started = quietSinceNext(null, quiet);
    expect(started).toBe(NOW);
    expect(quietSinceNext(started, { ...quiet, now: NOW + 60_000 })).toBe(NOW);
  });

  it("is lost the moment anything happens, so a gap between two turns is not a quiet spell", () => {
    // An agent between turns reads as idle for a few seconds, which is the
    // worst moment of all to take the deck away.
    expect(quietSinceNext(NOW, { ...quiet, running: 1 })).toBeNull();
    expect(quietSinceNext(NOW, { ...quiet, waiting: 1 })).toBeNull();
    expect(quietSinceNext(NOW, { ...quiet, windowFocused: true })).toBeNull();
    expect(quietSinceNext(NOW, { ...quiet, busy: true })).toBeNull();
    // And it starts again from the moment it goes quiet, not from the old one.
    expect(quietSinceNext(null, { ...quiet, now: NOW + 5_000 })).toBe(NOW + 5_000);
  });
});

describe("the app's wiring", () => {
  it("measures the quiet on the same tick that draws the tray", () => {
    // From the same snapshot the icon is drawn from, so the two can never
    // disagree about whether anything is running.
    expect(main).toMatch(/setInterval\(\(\) => \{ model\?\.tick\(\); scheduleRedraw\(\); updateWhenQuiet\(\); \}, 10_000\);/);
    const fn = main.match(/function updateWhenQuiet\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/windowFocused: !!win && !win\.isDestroyed\(\) && win\.isFocused\(\)/);
    expect(fn).toMatch(/waiting: snapshot\.waiting/);
    expect(fn).toMatch(/running: snapshot\.running/);
    expect(fn).toMatch(/busy: !!starting \|\| !!restarting/);
    expect(fn).toMatch(/canInstallQuietly\(/);
    // The install itself is the same one the menu item does — quit into the
    // new version, through the deck's own shutdown.
    expect(fn).toMatch(/updater\.restartNow\(\)/);
  });

  it("looks for an update at every start, not only on the six-hour timer", () => {
    // An app opened, used and closed inside a day never reached a check on the
    // timer alone, and stayed on whatever version it was installed with.
    expect(main).toMatch(/setTimeout\(\(\) => updater\.check\(\), 15_000\);/);
    expect(main).toMatch(/setInterval\(\(\) => updater\.check\(\), 6 \* 60 \* 60_000\);/);
    // And an update that lands while the app is already quiet is taken then,
    // rather than at the next tick.
    expect(main).toMatch(/onChange: s => \{[\s\S]*?updateWhenQuiet\(\);[\s\S]*?\},/);
  });

  it("takes a staged update through a restart the person asked for anyway", () => {
    const fn = main.match(/async function restartDeck\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/updater\?\.state\.status === "ready"/);
    expect(fn).toMatch(/updater\.restartNow\(\);\n    return;/);
  });

  it("ships the rule inside the app, where main.mjs can import it", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../desktop/electron-builder.config.cjs", import.meta.url)), "utf8");
    expect(config).toMatch(/"auto-update\.mjs"/);
  });
});
