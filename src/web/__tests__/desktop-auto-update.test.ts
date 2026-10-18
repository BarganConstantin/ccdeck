// The app updating itself, and the ways it may not (#1187).
//
// A staged update used to wait for a press in the tray menu or for a quit, and
// the app is built to be left alone in the menu bar, so it waited. It then
// installed itself once the PERSON had left it alone for a minute, whatever
// the agents were doing — the owner's call of 2026-09-22, since the hook
// survives a restart. A user read that as the app restarting "randomly" under
// their agents (feedback, 2026-10-16), so on 2026-10-18 the owner chose the
// middle way: it waits for the agents too, for a day at most, "Later" holds
// it off for a day, and it installs only the newest release it knows of.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canInstallQuietly, FRESH_MS, idleSinceNext, isFresh, MAX_WAIT_MS, overdue, POSTPONE_MS, postponed, QUIET_MS, quietSinceNext,
} from "../../../desktop/auto-update.mjs";

const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const quiet = { windowFocused: false, busy: false, now: NOW };
/** Quiet for long enough, with the update verified and staged an hour ago, an
 *  install that asks nobody for anything (#1755), the agents idle for as long
 *  as the window, and a look for a newer release that has just come back. */
const ripe = {
  status: "ready", unattended: true, quietSince: NOW - QUIET_MS, ...quiet,
  idleSince: NOW - QUIET_MS, behindSince: NOW - HOUR, postponedUntil: null,
  lookedAt: NOW - 60_000, looking: false,
};

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

  it("waits while an agent is working or waiting, and for a full quiet minute after", () => {
    // idleSince is null while any session runs or waits on a person: the
    // restart would cut the drawing of that turn, and from the chair it looks
    // like the app restarting at random.
    expect(canInstallQuietly({ ...ripe, idleSince: null })).toBe(false);
    // Idle for less than the window: the gap between two turns of one agent.
    expect(canInstallQuietly({ ...ripe, idleSince: NOW - QUIET_MS + 1 })).toBe(false);
    expect(canInstallQuietly({ ...ripe, idleSince: NOW - QUIET_MS })).toBe(true);
  });

  it("stops waiting for the agents after a day behind, so a machine that is never idle still updates", () => {
    // The reason the old rule ignored the agents survives as this limit.
    const busyAllDay = { ...ripe, idleSince: null, behindSince: NOW - MAX_WAIT_MS };
    expect(canInstallQuietly(busyAllDay)).toBe(true);
    expect(canInstallQuietly({ ...busyAllDay, behindSince: NOW - MAX_WAIT_MS + 1 })).toBe(false);
    // The person is still not interrupted: the window rule and the quiet hold.
    expect(canInstallQuietly({ ...busyAllDay, windowFocused: true })).toBe(false);
    expect(canInstallQuietly({ ...busyAllDay, quietSince: NOW - 1_000 })).toBe(false);
    expect(MAX_WAIT_MS).toBe(24 * HOUR);
  });

  it("holds off while Later holds, and counts the day's limit from the end of it", () => {
    const later = { ...ripe, postponedUntil: NOW + 1 };
    expect(canInstallQuietly(later)).toBe(false);
    // Overdue by the download's clock does not beat a Later the person pressed.
    expect(canInstallQuietly({ ...later, idleSince: null, behindSince: NOW - 3 * MAX_WAIT_MS })).toBe(false);
    // Once it has run out, the agents are waited for again — a Later is not a
    // promise to restart under them the moment it ends …
    const after = { ...ripe, idleSince: null, behindSince: NOW - 2 * MAX_WAIT_MS, postponedUntil: NOW - HOUR };
    expect(canInstallQuietly(after)).toBe(false);
    expect(canInstallQuietly({ ...after, idleSince: NOW - QUIET_MS })).toBe(true);
    // … for a day from its end, not from the download.
    expect(canInstallQuietly({ ...after, postponedUntil: NOW - MAX_WAIT_MS })).toBe(true);
    expect(POSTPONE_MS).toBe(24 * HOUR);
  });

  it("installs only after a recent look for a newer release, and never during one", () => {
    // The staged release may have been overtaken while it waited; installing
    // it would be followed by a second update soon after.
    expect(canInstallQuietly({ ...ripe, looking: true })).toBe(false);
    expect(canInstallQuietly({ ...ripe, lookedAt: NOW - FRESH_MS })).toBe(false);
    expect(canInstallQuietly({ ...ripe, lookedAt: null })).toBe(false);
    expect(canInstallQuietly({ ...ripe, lookedAt: NOW - FRESH_MS + 1 })).toBe(true);
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

describe("the clocks the rule reads", () => {
  it("says Later holds until the moment it ends, and not after", () => {
    expect(postponed({ postponedUntil: NOW + 1, now: NOW })).toBe(true);
    expect(postponed({ postponedUntil: NOW, now: NOW })).toBe(false);
    expect(postponed({ postponedUntil: null, now: NOW })).toBe(false);
  });

  it("is never overdue without an update that was ready", () => {
    expect(overdue({ behindSince: null, postponedUntil: null, now: NOW })).toBe(false);
    expect(overdue({ behindSince: NOW - MAX_WAIT_MS, postponedUntil: null, now: NOW })).toBe(true);
  });

  it("calls a look fresh only once it has come back", () => {
    expect(isFresh({ lookedAt: NOW, looking: false, now: NOW })).toBe(true);
    expect(isFresh({ lookedAt: NOW, looking: true, now: NOW })).toBe(false);
  });

  it("starts the agents' idle at the first idle moment, and loses it to any work or wait", () => {
    expect(idleSinceNext(null, { agentsBusy: false, now: NOW })).toBe(NOW);
    expect(idleSinceNext(NOW, { agentsBusy: false, now: NOW + 60_000 })).toBe(NOW);
    expect(idleSinceNext(NOW, { agentsBusy: true, now: NOW + 60_000 })).toBeNull();
  });
});

describe("the quiet the rule measures", () => {
  it("starts at the first quiet moment and keeps it while nothing happens", () => {
    const started = quietSinceNext(null, quiet);
    expect(started).toBe(NOW);
    expect(quietSinceNext(started, { ...quiet, now: NOW + 60_000 })).toBe(NOW);
  });

  it("is lost the moment somebody is there, so an app being clicked through does not update mid-click", () => {
    expect(quietSinceNext(NOW, { ...quiet, windowFocused: true })).toBeNull();
    expect(quietSinceNext(NOW, { ...quiet, busy: true })).toBeNull();
    // And it starts again from the moment it goes quiet, not from the old one.
    expect(quietSinceNext(null, { ...quiet, now: NOW + 5_000 })).toBe(NOW + 5_000);
  });
});

describe("the app's wiring", () => {
  it("measures the quiet and the agents on the same tick that draws the tray", () => {
    expect(main).toMatch(/setInterval\(\(\) => \{ model\?\.tick\(\); scheduleRedraw\(\); lookAgainWhileReady\(\); updateWhenQuiet\(\); \}, 10_000\);/);
    const fn = main.match(/function updateWhenQuiet\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/windowFocused: !!win && !win\.isDestroyed\(\) && win\.isFocused\(\)/);
    // The agents, from the snapshot the tray icon is drawn from: a waiting
    // session holds the update as a working one does.
    expect(fn).toContain("agentsBusy: snapshot.running > 0 || snapshot.waiting > 0");
    for (const field of ["idleSince,", "behindSince,", "postponedUntil,", "lookedAt: updater?.lookedAt ?? null,", "looking: updater?.looking ?? false,"]) {
      expect(fn).toContain(field);
    }
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

  it("dates the wait from the first ready update, through a newer one staged over it", () => {
    expect(main).toMatch(/onChange: s => \{[\s\S]*?if \(s\.status === "ready" && behindSince === null\) behindSince = Date\.now\(\);/);
    // Nothing resets it but a new process, which is what an installed update is.
    expect(main.match(/(?<!let )behindSince = /g)).toHaveLength(1);
  });

  it("looks again for a newer release while one waits, before anything installs it", () => {
    const fn = main.match(/function lookAgainWhileReady\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain('updater.state.status !== "ready" || updater.looking');
    expect(fn).toContain("isFresh({ lookedAt: updater.lookedAt, looking: false, now: Date.now() })");
    expect(fn).toContain("updater.check()");
  });

  it("makes Later hold the install off, kept with the version that was asked", () => {
    const offer = main.match(/async function offerReadyUpdate\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(offer).toMatch(/cancelId: 1,[\s\S]*?if \(response === 1\) postponeUpdate\(\);/);
    const postpone = main.match(/function postponeUpdate\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(postpone).toContain("postponedUntil = Date.now() + POSTPONE_MS;");
    expect(postpone).toContain("desktopState.merge({ updatePostponedUntil: postponedUntil, updatePostponedOn: app.getVersion() });");
    // Read back at the next launch only by the same version: an app that has
    // updated since owes the next release no Later it never showed.
    const held = main.match(/function postponementHeld\(state\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(held).toContain("until <= Date.now()");
    expect(held).toContain("state.updatePostponedOn === app.getVersion()");
    expect(main).toContain("postponedUntil = postponementHeld(desktopState.read());");
  });

  it("says on the sheet what happens with each answer", () => {
    const offer = main.match(/async function offerReadyUpdate\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(offer).toContain("ccdeck installs it by itself once no agent is working. Later holds that off for the next 24 hours;");
    // A .deb never installs by itself (#1755), so its sheet does not say it will.
    expect(offer).toMatch(/asksPassword\s*\? `It has been downloaded and verified\. Installing it asks for your password, so it waits for you/);
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
