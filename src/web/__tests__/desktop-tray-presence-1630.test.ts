// The Linux tray icon, brought back when the panel has lost it (#1630).
//
// A StatusNotifierItem registration that fails once — at startup, or when the
// panel's watcher comes back and the app registers again — leaves Electron on a
// GTK fallback that a Wayland panel never shows, for as long as the app runs,
// and a new Tray in the same process never registers again. The app now asks
// the watcher every half minute, through busctl, whether it holds an item on
// one of this process's bus names; after two checks that say no, it restarts
// by itself at its next quiet spell, at most once in six hours.
//
// What loses the icon turned out to be the app STARTING while GNOME has the
// watcher switched off for a locked screen — which is when a self-update gets
// installed. Checked on a private session bus: a tray made before the watcher
// came up never registered; one already registered came back by itself when
// the watcher left and returned. So every restart the app makes by itself now
// waits while a watcher it has seen is away.
//
// What is checked here is the reading of busctl's answers, the decisions, and
// the wiring in main.mjs. The end-to-end run — a watcher that refuses the
// first registration, on a private session bus, and the app coming back with
// its icon — needs a desktop session and is not part of the suite.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs, no types
import { itemBusName, trayRegistered, trayCheck, watcherOnBusNow, screenLockedNow, selfRestartHeld, trayRestartOutcome, trayOutcomeNext, trayMissesNext, canRestartForTray, MISSES_BEFORE_RESTART, TRAY_RESTART_GAP_MS } from "../../../desktop/tray-presence.mjs";
// @ts-expect-error — plain .mjs, no types
import { QUIET_MS } from "../../../desktop/auto-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { restartApp } from "../../../desktop/relaunch-linux.mjs";

const PID = 3220839;
// busctl --user --json=short list, trimmed to what is read.
const NAMES = [
  { name: ":1.140", pid: 38033 },
  { name: ":1.67051", pid: PID },
  { name: ":1.67052", pid: PID },
  { name: "org.kde.StatusNotifierWatcher", pid: 4841 },
];
// The watcher's RegisteredStatusNotifierItems on the machine it was seen on.
const OTHERS = [":1.4047@/StatusNotifierItem", ":1.54@/org/ayatana/NotificationItem/livepatch", ":1.140@/StatusNotifierItem", "org.kde.StatusNotifierItem-731552-1"];

describe("reading the watcher's items", () => {
  it("takes the bus name from every panel's spelling of an item", () => {
    // GNOME's AppIndicator extension: name@/path.
    expect(itemBusName(":1.140@/StatusNotifierItem")).toBe(":1.140");
    expect(itemBusName(":1.54@/org/ayatana/NotificationItem/livepatch")).toBe(":1.54");
    // KDE Plasma and Waybar: the path straight after the name.
    expect(itemBusName(":1.52/StatusNotifierItem")).toBe(":1.52");
    expect(itemBusName("org.kde.StatusNotifierItem-4242-1/StatusNotifierItem")).toBe("org.kde.StatusNotifierItem-4242-1");
    // Registered by name alone.
    expect(itemBusName("org.kde.StatusNotifierItem-731552-1")).toBe("org.kde.StatusNotifierItem-731552-1");
  });

  it("finds this process's icon as KDE Plasma and Waybar list it, not only as GNOME does", () => {
    // Read the GNOME way only, a showing icon counted as lost on these panels,
    // and the app restarted every six hours for nothing.
    expect(trayRegistered({ items: [":1.140/StatusNotifierItem", ":1.67052/StatusNotifierItem"], names: NAMES, pid: PID })).toBe(true);
    const names = [...NAMES, { name: `org.kde.StatusNotifierItem-${PID}-1`, pid: PID }];
    expect(trayRegistered({ items: [`org.kde.StatusNotifierItem-${PID}-1/StatusNotifierItem`], names, pid: PID })).toBe(true);
  });

  it("says no when every item is somebody else's — the app that had lost its icon", () => {
    expect(trayRegistered({ items: OTHERS, names: NAMES, pid: PID })).toBe(false);
  });

  it("says yes for an item on one of this process's unique names", () => {
    expect(trayRegistered({ items: [...OTHERS, ":1.67052@/StatusNotifierItem"], names: NAMES, pid: PID })).toBe(true);
  });

  it("says yes for an item under a well-known name this process owns", () => {
    const names = [...NAMES, { name: `org.kde.StatusNotifierItem-${PID}-1`, pid: PID }];
    expect(trayRegistered({ items: [...OTHERS, `org.kde.StatusNotifierItem-${PID}-1`], names, pid: PID })).toBe(true);
  });

  it("cannot tell when no name in the list is this process's", () => {
    expect(trayRegistered({ items: OTHERS, names: NAMES, pid: 1 })).toBeNull();
    // busctl without the credentials to name a pid: nothing to compare against.
    expect(trayRegistered({ items: OTHERS, names: NAMES.map(n => ({ ...n, pid: null })), pid: PID })).toBeNull();
  });
});

describe("asking the session bus", () => {
  const HAS = ["--user", "--json=short", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "s", "org.kde.StatusNotifierWatcher"];
  const answers = (watcher: unknown, items: unknown, names: unknown) => async (args: string[]) =>
    JSON.stringify(args.includes("NameHasOwner") ? watcher : args.includes("get-property") ? items : names);
  const UP = { type: "b", data: [true] }, GONE = { type: "b", data: [false] };

  it("asks whether the watcher is there, then for its items and every name's pid", async () => {
    const asked: string[][] = [];
    const run = async (args: string[]) => {
      asked.push(args);
      return answers(UP, { type: "as", data: OTHERS }, NAMES)(args);
    };
    await expect(trayCheck({ pid: PID, run })).resolves.toEqual({ watcher: true, registered: false });
    expect(asked).toEqual([
      HAS,
      ["--user", "--json=short", "get-property", "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"],
      ["--user", "--json=short", "list"],
    ]);
  });

  it("finds the icon once it is back", async () => {
    const run = answers(UP, { type: "as", data: [...OTHERS, ":1.67051@/StatusNotifierItem"] }, NAMES);
    await expect(trayCheck({ pid: PID, run })).resolves.toEqual({ watcher: true, registered: true });
  });

  it("says the watcher is gone — a locked GNOME screen — and asks nothing more", async () => {
    const asked: string[][] = [];
    const run = async (args: string[]) => { asked.push(args); return JSON.stringify(GONE); };
    await expect(trayCheck({ pid: PID, run })).resolves.toEqual({ watcher: false, registered: null });
    expect(asked).toEqual([HAS]);
  });

  it("cannot tell with no busctl, or an answer it cannot read", async () => {
    const noBusctl = async () => { throw new Error("spawn busctl ENOENT"); };
    await expect(trayCheck({ pid: PID, run: noBusctl })).resolves.toEqual({ watcher: null, registered: null });
    await expect(trayCheck({ pid: PID, run: async () => "not json" })).resolves.toEqual({ watcher: null, registered: null });
    await expect(trayCheck({ pid: PID, run: answers(UP, { type: "as" }, NAMES) })).resolves.toEqual({ watcher: true, registered: null });
  });

  it("asks the bus once more at the moment of a restart", () => {
    expect(watcherOnBusNow({ runSync: (args: string[]) => { expect(args).toEqual(HAS); return JSON.stringify(GONE); } })).toBe(false);
    expect(watcherOnBusNow({ runSync: () => JSON.stringify(UP) })).toBe(true);
    expect(watcherOnBusNow({ runSync: () => { throw new Error("timed out"); } })).toBeNull();
  });
});

describe("a restart the app makes by itself, under a locked screen", () => {
  it("waits while a watcher it has seen is gone under a locked screen", () => {
    expect(selfRestartHeld({ watcherSeen: true, watcherNow: false, locked: true })).toBe(true);
    // A lock logind cannot report is taken as one.
    expect(selfRestartHeld({ watcherSeen: true, watcherNow: false, locked: null })).toBe(true);
    expect(selfRestartHeld({ watcherSeen: true, watcherNow: true, locked: true })).toBe(false);
  });

  it("does not wait for a panel that went with the screen unlocked, so updates are not held all session", () => {
    // The extension switched off, or the bar stopped.
    expect(selfRestartHeld({ watcherSeen: true, watcherNow: false, locked: false })).toBe(false);
  });

  it("does not wait when busctl cannot say, or on a desktop that never had a watcher", () => {
    // GNOME without the AppIndicator extension: there is no icon to lose, and
    // its updates must not wait for a panel that never comes.
    expect(selfRestartHeld({ watcherSeen: true, watcherNow: null, locked: true })).toBe(false);
    expect(selfRestartHeld({ watcherSeen: false, watcherNow: false, locked: true })).toBe(false);
  });

  it("asks logind whether this session's screen is locked", () => {
    const asked: string[][] = [];
    const locked = screenLockedNow({ runSync: (args: string[]) => { asked.push(args); return JSON.stringify({ type: "b", data: true }); } });
    expect(locked).toBe(true);
    expect(asked).toEqual([["--json=short", "get-property", "org.freedesktop.login1", "/org/freedesktop/login1/session/auto", "org.freedesktop.login1.Session", "LockedHint"]]);
    expect(screenLockedNow({ runSync: () => JSON.stringify({ type: "b", data: false }) })).toBe(false);
    expect(screenLockedNow({ runSync: () => { throw new Error("no session"); } })).toBeNull();
  });
});

describe("when the app restarts for its icon", () => {
  const NOW = 10_000_000;
  // Lost, and left alone for as long as a quiet update waits.
  const ripe = {
    misses: MISSES_BEFORE_RESTART, lastRestartAt: null as number | null, lastOutcome: undefined as string | undefined,
    updateStatus: "idle", windowFocused: false, busy: false, quietSince: NOW - QUIET_MS as number | null, now: NOW,
  };

  it("counts checks that find no icon, and starts again on one that finds it or cannot tell", () => {
    expect(trayMissesNext(0, false)).toBe(1);
    expect(trayMissesNext(1, false)).toBe(2);
    expect(trayMissesNext(2, true)).toBe(0);
    expect(trayMissesNext(2, null)).toBe(0);
  });

  it("restarts once two checks in a row found no icon, not after one", () => {
    expect(MISSES_BEFORE_RESTART).toBe(2);
    expect(canRestartForTray(ripe)).toBe(true);
    expect(canRestartForTray({ ...ripe, misses: 1 })).toBe(false);
    expect(canRestartForTray({ ...ripe, misses: 0 })).toBe(false);
  });

  it("waits for the same quiet a self-update waits for", () => {
    expect(canRestartForTray({ ...ripe, windowFocused: true })).toBe(false);
    expect(canRestartForTray({ ...ripe, busy: true })).toBe(false);
    expect(canRestartForTray({ ...ripe, quietSince: NOW - QUIET_MS + 1 })).toBe(false);
    expect(canRestartForTray({ ...ripe, quietSince: null })).toBe(false);
  });

  it("does not throw away an update being looked for or downloaded", () => {
    expect(canRestartForTray({ ...ripe, updateStatus: "checking" })).toBe(false);
    expect(canRestartForTray({ ...ripe, updateStatus: "downloading" })).toBe(false);
    for (const updateStatus of ["idle", "current", "error"]) expect(canRestartForTray({ ...ripe, updateStatus }), updateStatus).toBe(true);
  });

  it("reads what a restart came to at the new process's first check that can tell", () => {
    expect(trayRestartOutcome({ startedWithWatcher: true, registered: true })).toBe("back");
    expect(trayRestartOutcome({ startedWithWatcher: false, registered: true })).toBe("back");
    // No icon with a watcher there to take it: the restart did not help.
    expect(trayRestartOutcome({ startedWithWatcher: true, registered: false })).toBe("failed");
    // No icon, but the process started under a locked screen: that explains it.
    expect(trayRestartOutcome({ startedWithWatcher: false, registered: false })).toBe("explained");
    // No icon, and the check at startup could not say: not held against it.
    expect(trayRestartOutcome({ startedWithWatcher: null, registered: false })).toBe("unclear");
    expect(trayRestartOutcome({ startedWithWatcher: true, registered: null })).toBeNull();
  });

  it("is read only by the process the restart started, never by the one still shutting down", () => {
    // The restarting process checks while its deck stops, sees its own lost
    // icon, and must not write that down as the restart having failed.
    expect(trayOutcomeNext({ said: "pending", toRead: false, startedWithWatcher: true, registered: false })).toBeNull();
    expect(trayOutcomeNext({ said: "pending", toRead: true, startedWithWatcher: true, registered: false })).toBe("failed");
    expect(trayOutcomeNext({ said: "pending", toRead: true, startedWithWatcher: true, registered: true })).toBe("back");
    expect(trayOutcomeNext({ said: "pending", toRead: true, startedWithWatcher: true, registered: null })).toBeNull();
  });

  it("lifts a failed one once the icon is seen, after a restart the person made", () => {
    expect(trayOutcomeNext({ said: "failed", toRead: false, startedWithWatcher: true, registered: true })).toBe("back");
    expect(trayOutcomeNext({ said: "failed", toRead: false, startedWithWatcher: true, registered: false })).toBeNull();
    expect(trayOutcomeNext({ said: "back", toRead: false, startedWithWatcher: true, registered: true })).toBeNull();
  });

  it("restarts at most once in six hours after one that brought the icon back", () => {
    expect(TRAY_RESTART_GAP_MS).toBe(6 * 60 * 60_000);
    for (const lastOutcome of ["back", "unclear", undefined]) {
      const after = { ...ripe, lastOutcome };
      expect(canRestartForTray({ ...after, lastRestartAt: NOW - TRAY_RESTART_GAP_MS + 1 }), String(lastOutcome)).toBe(false);
      expect(canRestartForTray({ ...after, lastRestartAt: NOW - TRAY_RESTART_GAP_MS }), String(lastOutcome)).toBe(true);
    }
  });

  it("never again after one that failed with a watcher there, so a panel it cannot read costs one restart", () => {
    expect(canRestartForTray({ ...ripe, lastOutcome: "failed", lastRestartAt: NOW - TRAY_RESTART_GAP_MS * 10 })).toBe(false);
    // Nor while the one before has not been read yet.
    expect(canRestartForTray({ ...ripe, lastOutcome: "pending", lastRestartAt: NOW - TRAY_RESTART_GAP_MS * 10 })).toBe(false);
  });

  it("again straight away after one the lock screen explains", () => {
    expect(canRestartForTray({ ...ripe, lastOutcome: "explained", lastRestartAt: NOW - 60_000 })).toBe(true);
  });
});

describe("the restart itself", () => {
  const fakeApp = () => {
    const calls: string[] = [];
    return { calls, app: { relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") } };
  };

  it("is Electron's own relaunch outside an AppImage", () => {
    const { calls, app } = fakeApp();
    restartApp(app, { env: {} });
    expect(calls).toEqual(["relaunch", "quit"]);
  });

  it("goes through the helper that waits for this process inside an AppImage", () => {
    const { calls, app } = fakeApp();
    const handed: unknown[] = [];
    const env = { APPIMAGE: "/home/u/Applications/ccdeck-linux-x86_64.AppImage", HOME: "/home/u" };
    restartApp(app, { env, pid: 4242, relaunch: (o: unknown) => handed.push(o) });
    expect(handed).toEqual([{ pid: 4242, appImage: env.APPIMAGE, env }]);
    expect(calls).toEqual(["quit"]);
  });
});

describe("the app", () => {
  const desktop = join(__dirname, "..", "..", "..", "desktop");
  const main = readFileSync(join(desktop, "main.mjs"), "utf8");
  const fn = (name: string) => main.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";

  it("watches on Linux only, every half minute, from right after the tray is made", () => {
    const body = fn("watchTray");
    expect(body).toContain('if (process.platform !== "linux") return;');
    expect(body).toContain("const { watcher, registered } = await trayCheck();");
    expect(body).toContain("trayMisses = trayMissesNext(trayMisses, registered);");
    expect(body).toContain("}, 30_000);");
    expect(body).toContain("trayRestartAt = state.trayRestartAt ?? null;");
    // Whether a watcher has been seen, at startup and at every check.
    expect(body.match(/if \(watcher\) trayWatcherSeen = true;/g)).toHaveLength(2);
    expect(body).toContain("trayStartedWithWatcher = watcher;");
    // Nothing is checked once a restart or a Quit is under way.
    expect(body).toContain("if (leaving || quitting) return;");
    // Back from a locked screen, the quiet is measured from there.
    expect(body).toContain("if (watcher === true && trayWatcherLast === false) quietSince = null;");
    // Including a watcher that was missing when the app started.
    expect(body).toMatch(/trayStartedWithWatcher = watcher;\n\s+trayWatcherLast = watcher;/);
    expect(main).toMatch(/tray\.on\("click", \(\) => openWindow\(\)\);\n\s+watchTray\(\);/);
  });

  it("restarts on the quiet-update tick, after an update that is ready and never instead of it", () => {
    const quiet = fn("updateWhenQuiet");
    expect(quiet.indexOf("restartForTrayWhenQuiet(where);")).toBeGreaterThan(quiet.indexOf("if (!canInstallQuietly("));
    expect(quiet.indexOf("restartForTrayWhenQuiet(where);")).toBeLessThan(quiet.indexOf("updater.restartNow();"));
  });

  it("writes down what a restart came to, read against how this process started", () => {
    const body = fn("watchTray");
    expect(body).toContain('trayOutcomeToRead = trayRestartOutcomeSaid === "pending";');
    expect(body).toContain("const outcome = trayOutcomeNext({ said: trayRestartOutcomeSaid, toRead: trayOutcomeToRead, startedWithWatcher: trayStartedWithWatcher, registered });");
    expect(body).toContain("desktopState.merge({ trayRestartOutcome: outcome, trayBackAfterRestart: undefined });");
    // 3.32.1 wrote a boolean: true was an icon back, false a restart not read yet.
    expect(body).toContain('?? (state.trayBackAfterRestart === true ? "back" : state.trayBackAfterRestart === false ? "pending" : undefined);');
  });

  it("holds every restart it makes by itself while the panel it has seen is away, asking the bus at that moment", () => {
    const away = fn("panelAway");
    expect(away).toContain('if (process.platform !== "linux" || !trayWatcherSeen) return false;');
    expect(away).toContain("selfRestartHeld({ watcherSeen: trayWatcherSeen, watcherNow, locked: watcherNow === false ? screenLockedNow() : null })");
    // The quiet self-update: after it is found installable, before anything is
    // written or restarted — and the quiet starts again after the unlock.
    const quiet = fn("updateWhenQuiet");
    const held = quiet.indexOf("if (panelAway()) { quietSince = null; return; }");
    expect(held).toBeGreaterThan(quiet.indexOf("if (!canInstallQuietly("));
    expect(held).toBeLessThan(quiet.indexOf("windowOpenAtSelfRestart"));
    expect(held).toBeLessThan(quiet.indexOf("updater.restartNow();"));
    // The restart for the icon.
    const tray = fn("restartForTrayWhenQuiet");
    const trayHeld = tray.indexOf("if (panelAway()) { quietSince = null; return; }");
    expect(trayHeld).toBeGreaterThan(tray.indexOf("canRestartForTray("));
    expect(trayHeld).toBeLessThan(tray.indexOf("desktopState.merge("));
  });

  it("does not take a Quit being carried out for a quiet spell", () => {
    const quiet = fn("updateWhenQuiet");
    expect(quiet.indexOf("if (quitting) return;")).toBeGreaterThan(-1);
    expect(quiet.indexOf("if (quitting) return;")).toBeLessThan(quiet.indexOf("const where"));
  });

  it("puts the window back as it was after a restart it made by itself, and only then", () => {
    // An open window is a page, and the deck holds its notifications while a
    // page is open: one reopened that nobody had open would silence them.
    expect(fn("updateWhenQuiet")).toMatch(/desktopState\.merge\(\{ windowOpenAtSelfRestart: windowOpen\(\) \}\)[^\n]*\n\s+updater\.restartNow\(\);/);
    expect(fn("restartForTrayWhenQuiet")).toContain("windowOpenAtSelfRestart: windowOpen()");
    expect(fn("windowOpen")).toContain("return !!win && !win.isDestroyed() && win.isVisible();");
    expect(main).toContain("desktopState.merge({ windowOpenAtSelfRestart: undefined })");
    expect(main).toContain("if (deck && windowOpenAtSelfRestart !== false) openWindow(false);");
  });

  it("writes the restart down before going, and does not go when it cannot", () => {
    const body = fn("restartForTrayWhenQuiet");
    expect(body).toContain("canRestartForTray({ misses: trayMisses, lastRestartAt: trayRestartAt, lastOutcome: trayRestartOutcomeSaid, updateStatus, quietSince, ...where })");
    const written = body.indexOf('desktopState.merge({ trayRestartAt, trayRestartOutcome: "pending", trayBackAfterRestart: undefined, windowOpenAtSelfRestart: windowOpen() });');
    expect(written).toBeGreaterThan(-1);
    expect(body.indexOf("return;", written)).toBeLessThan(body.indexOf("restartApp(app);"));
    expect(body.indexOf("restartApp(app);")).toBeGreaterThan(written);
    expect(body).toMatch(/leaving = true;\n\s+restartApp\(app\);/);
  });

  it("packs the module into the app", () => {
    const config = readFileSync(join(desktop, "electron-builder.config.cjs"), "utf8");
    expect(config).toContain('"tray-presence.mjs"');
  });
});
