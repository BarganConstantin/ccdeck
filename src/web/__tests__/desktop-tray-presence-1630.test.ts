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
// What is checked here is the reading of busctl's answers, the decisions, and
// the wiring in main.mjs. The end-to-end run — a watcher that refuses the
// first registration, on a private session bus, and the app coming back with
// its icon — needs a desktop session and is not part of the suite.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs, no types
import { itemBusName, trayRegistered, trayPresence, trayMissesNext, canRestartForTray, MISSES_BEFORE_RESTART, TRAY_RESTART_GAP_MS } from "../../../desktop/tray-presence.mjs";
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
  const answers = (items: unknown, names: unknown) => async (args: string[]) =>
    JSON.stringify(args.includes("get-property") ? items : names);

  it("asks the watcher for its items and busctl for every name's pid", async () => {
    const asked: string[][] = [];
    const run = async (args: string[]) => {
      asked.push(args);
      return answers({ type: "as", data: OTHERS }, NAMES)(args);
    };
    await expect(trayPresence({ pid: PID, run })).resolves.toBe(false);
    expect(asked).toEqual([
      ["--user", "--json=short", "get-property", "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"],
      ["--user", "--json=short", "list"],
    ]);
  });

  it("finds the icon once it is back", async () => {
    const run = answers({ type: "as", data: [...OTHERS, ":1.67051@/StatusNotifierItem"] }, NAMES);
    await expect(trayPresence({ pid: PID, run })).resolves.toBe(true);
  });

  it("cannot tell with no watcher on the bus, no busctl, or an answer it cannot read", async () => {
    const noWatcher = async () => { throw new Error("Failed to get property: The name is not activatable"); };
    await expect(trayPresence({ pid: PID, run: noWatcher })).resolves.toBeNull();
    await expect(trayPresence({ pid: PID, run: async () => "not json" })).resolves.toBeNull();
    await expect(trayPresence({ pid: PID, run: answers({ type: "as" }, NAMES) })).resolves.toBeNull();
  });
});

describe("when the app restarts for its icon", () => {
  const NOW = 10_000_000;
  // Lost, and left alone for as long as a quiet update waits.
  const ripe = {
    misses: MISSES_BEFORE_RESTART, lastRestartAt: null as number | null, backAfterRestart: undefined as boolean | undefined,
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

  it("does it at most once in six hours after a restart that brought the icon back", () => {
    expect(TRAY_RESTART_GAP_MS).toBe(6 * 60 * 60_000);
    const back = { ...ripe, backAfterRestart: true };
    expect(canRestartForTray({ ...back, lastRestartAt: NOW - TRAY_RESTART_GAP_MS + 1 })).toBe(false);
    expect(canRestartForTray({ ...back, lastRestartAt: NOW - TRAY_RESTART_GAP_MS })).toBe(true);
  });

  it("never again after a restart that did not bring it back, so a panel it cannot read costs one restart", () => {
    const notBack = { ...ripe, backAfterRestart: false };
    expect(canRestartForTray({ ...notBack, lastRestartAt: NOW - TRAY_RESTART_GAP_MS * 10 })).toBe(false);
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
    expect(body).toContain("trayMisses = trayMissesNext(trayMisses, present);");
    expect(body).toContain("const present = await trayPresence();");
    expect(body).toContain("}, 30_000);");
    expect(body).toContain("({ trayRestartAt = null, trayBackAfterRestart } = desktopState.read());");
    expect(main).toMatch(/tray\.on\("click", \(\) => openWindow\(\)\);\n\s+watchTray\(\);/);
  });

  it("restarts on the quiet-update tick, after an update that is ready and never instead of it", () => {
    const quiet = fn("updateWhenQuiet");
    expect(quiet.indexOf("restartForTrayWhenQuiet(where);")).toBeGreaterThan(quiet.indexOf("if (!canInstallQuietly("));
    expect(quiet.indexOf("restartForTrayWhenQuiet(where);")).toBeLessThan(quiet.indexOf("updater.restartNow();"));
  });

  it("writes down that the icon is back once a check finds it after a restart", () => {
    const body = fn("watchTray");
    expect(body).toMatch(/if \(present === true && trayBackAfterRestart === false\) \{\n\s+trayBackAfterRestart = true;\n\s+try \{ desktopState\.merge\(\{ trayBackAfterRestart \}\);/);
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
    expect(body).toContain("canRestartForTray({ misses: trayMisses, lastRestartAt: trayRestartAt, backAfterRestart: trayBackAfterRestart, updateStatus, quietSince, ...where })");
    const written = body.indexOf("desktopState.merge({ trayRestartAt, trayBackAfterRestart: false, windowOpenAtSelfRestart: windowOpen() });");
    expect(written).toBeGreaterThan(-1);
    expect(body.indexOf("return;", written)).toBeLessThan(body.indexOf("restartApp(app);"));
    expect(body.indexOf("restartApp(app);")).toBeGreaterThan(written);
  });

  it("packs the module into the app", () => {
    const config = readFileSync(join(desktop, "electron-builder.config.cjs"), "utf8");
    expect(config).toContain('"tray-presence.mjs"');
  });
});
