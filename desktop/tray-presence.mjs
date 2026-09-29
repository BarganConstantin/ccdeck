// Whether the panel is showing this app's tray icon, on Linux (#1630).
//
// On Linux the icon is a StatusNotifierItem: the app registers it with the
// panel's StatusNotifierWatcher over D-Bus (GNOME's AppIndicator extension,
// KDE's plasmashell). Chromium gives that route one chance. When a
// registration fails — at startup, or when the watcher comes back after the
// panel restarted it and the app registers again — Electron drops the item for
// good and falls back to a GTK status icon, which a Wayland panel never shows.
// Nothing reports it: `tray` is still a Tray, and every setImage and
// setContextMenu goes on succeeding into nothing. It was seen as an app that
// had updated itself, run for five hours, and was nowhere in the panel: the
// watcher listed every other app's icon, and no object of the app's own was
// left on the bus.
//
// A NEW TRAY DOES NOT BRING IT BACK. Checked against Electron 42 with a
// watcher that refuses the first registration: a Tray destroyed and made again
// in the same process never calls the watcher at all, straight away or two
// seconds later — nor does a second Tray after a first one that registered.
// A new process does. So the app, once the icon is lost, restarts by itself —
// under the same rule a quiet update does (auto-update.mjs: the window left
// unfocused for a minute, nothing starting), at most once in six hours, and
// not at all after a restart that did not bring the icon back — so a panel
// that refuses every registration costs one restart and not a loop.
//
// Whether it is lost is asked from the outside, the way anybody could: busctl
// reads the items the watcher holds and which process owns each bus name, and
// an item on a name this process owns is its icon. A null answer is "cannot
// tell" — no watcher on the bus (a panel with no tray at all, where there is
// nothing to repair), no busctl, or no name of this process's in the list —
// and it never counts toward a restart.
import { execFile } from "node:child_process";
import { quietLongEnough } from "./auto-update.mjs";

const WATCHER = ["org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher"];

/** The bus name in one of the watcher's entries. Each panel spells them its
 *  own way: GNOME's AppIndicator extension `name@/object/path`, KDE Plasma and
 *  Waybar the name with the path straight after it, `name/object/path`, and
 *  an item registered by name alone is the bare name. Neither `@` nor `/` can
 *  be part of a bus name, so the name ends at the first of them. */
export function itemBusName(item) {
  const end = item.search(/[@/]/);
  return end === -1 ? item : item.slice(0, end);
}

/**
 * Is one of `items` this process's? `names` is busctl's list of every bus
 * name with the pid that owns it.
 * @returns {boolean|null} null when no name in the list is this process's,
 *   so there is nothing to compare against.
 */
export function trayRegistered({ items, names, pid }) {
  const ours = new Set(names.filter(n => n?.pid === pid).map(n => n.name));
  if (ours.size === 0) return null;
  return items.some(item => typeof item === "string" && ours.has(itemBusName(item)));
}

/** @returns {Promise<string>} what busctl printed */
function busctl(args) {
  return new Promise((resolve, reject) => {
    execFile("busctl", args, { timeout: 5000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/**
 * Ask the session bus whether this process's tray icon is registered.
 * @returns {Promise<boolean|null>} see trayRegistered; null too when either
 *   question cannot be asked.
 */
export async function trayPresence({ pid = process.pid, run = busctl } = {}) {
  try {
    const items = JSON.parse(await run(["--user", "--json=short", "get-property", ...WATCHER, "RegisteredStatusNotifierItems"]))?.data;
    const names = JSON.parse(await run(["--user", "--json=short", "list"]));
    if (!Array.isArray(items) || !Array.isArray(names)) return null;
    return trayRegistered({ items, names, pid });
  } catch {
    return null;
  }
}

/** Checks in a row that must find no icon before it counts as lost: an icon
 *  still registering at startup is not a lost one. */
export const MISSES_BEFORE_RESTART = 2;
/** The least time between two restarts for the icon's sake. */
export const TRAY_RESTART_GAP_MS = 6 * 60 * 60_000;

/** Checks in a row that found no icon, after one more. A check that could not
 *  tell starts the count again. */
export function trayMissesNext(misses, present) {
  return present === false ? misses + 1 : 0;
}

/**
 * Restart the app now to bring its icon back? Only once it is lost; only when
 * the app has been quiet as long as an update waits; not while an update is
 * being looked for or downloaded, which would be thrown away; not again within
 * six hours of the last time; and never again after a restart that did not
 * bring the icon back — a panel this cannot read, or one that refuses every
 * icon, costs one restart and not four a day. An icon seen again, after a
 * restart the person made, lifts that.
 * @param {object} o
 * @param {number} o.misses                checks in a row that found no icon
 * @param {number|null} o.lastRestartAt    the last restart for the icon's sake
 * @param {boolean|undefined} o.backAfterRestart whether the icon has been seen
 *   since that restart; undefined before the first one
 * @param {string} o.updateStatus          the updater's state
 */
export function canRestartForTray({ misses, lastRestartAt, backAfterRestart, updateStatus, windowFocused, busy, quietSince, now }) {
  if (misses < MISSES_BEFORE_RESTART) return false;
  if (updateStatus === "checking" || updateStatus === "downloading") return false;
  if (typeof lastRestartAt === "number") {
    if (backAfterRestart === false) return false;
    if (now - lastRestartAt < TRAY_RESTART_GAP_MS) return false;
  }
  return quietLongEnough({ windowFocused, busy, quietSince, now });
}
