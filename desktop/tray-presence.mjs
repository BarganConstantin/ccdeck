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
// not at all after a restart that did not bring the icon back with a watcher
// there to take it — so a panel that refuses every registration costs one
// restart and not a loop.
//
// WHAT LOSES IT, found afterwards: the app STARTING while the watcher is not
// on the bus. GNOME switches its extensions off while the screen is locked,
// the AppIndicator one included, and Chromium, asking at startup, finds no
// watcher and falls back for good — it does not register when the watcher
// comes back, while an app that was already running does. A self-update is
// installed when the app has been left alone, which is exactly when the
// screen gets locked: the relaunched version came up under the lock screen
// with no icon, every time. So a restart the app makes by itself waits while
// the watcher it has seen is away (selfRestartHeld), and the restart above is
// the net under anything else that loses the icon.
//
// Whether it is lost is asked from the outside, the way anybody could: busctl
// reads the items the watcher holds and which process owns each bus name, and
// an item on a name this process owns is its icon. A null answer is "cannot
// tell" — no watcher on the bus (a panel with no tray at all, where there is
// nothing to repair), no busctl, or no name of this process's in the list —
// and it never counts toward a restart.
import { execFile, execFileSync } from "node:child_process";
import { quietLongEnough } from "./auto-update.mjs";

const WATCHER = ["org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher"];
const HAS_WATCHER = ["--user", "--json=short", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "s", "org.kde.StatusNotifierWatcher"];

/** busctl's answer to NameHasOwner: whether the watcher is on the bus, or
 *  null when the answer cannot be read. */
function watcherAnswer(out) {
  const data = JSON.parse(out)?.data;
  return Array.isArray(data) && typeof data[0] === "boolean" ? data[0] : null;
}

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
 * Ask the session bus whether the panel's watcher is there, and whether it
 * holds this process's tray icon.
 * @returns {Promise<{ watcher: boolean|null, registered: boolean|null }>}
 *   `registered` as trayRegistered says, and null too with no watcher on the
 *   bus or a question that cannot be asked; `watcher` null when busctl
 *   cannot say.
 */
export async function trayCheck({ pid = process.pid, run = busctl } = {}) {
  let watcher = null;
  try {
    watcher = watcherAnswer(await run(HAS_WATCHER));
    if (watcher !== true) return { watcher, registered: null };
    const items = JSON.parse(await run(["--user", "--json=short", "get-property", ...WATCHER, "RegisteredStatusNotifierItems"]))?.data;
    const names = JSON.parse(await run(["--user", "--json=short", "list"]));
    if (!Array.isArray(items) || !Array.isArray(names)) return { watcher, registered: null };
    return { watcher, registered: trayRegistered({ items, names, pid }) };
  } catch {
    return { watcher, registered: null };
  }
}

/**
 * Is the watcher on the bus at this moment? Asked once, right before the app
 * restarts by itself, so a screen locked since the last half-minute check is
 * not missed. Synchronous on purpose: the restart it guards is.
 * @returns {boolean|null} null when busctl cannot say
 */
export function watcherOnBusNow({ runSync = args => execFileSync("busctl", args, { timeout: 2000, windowsHide: true, encoding: "utf8" }) } = {}) {
  try { return watcherAnswer(runSync(HAS_WATCHER)); } catch { return null; }
}

/**
 * Hold a restart the app would make by itself? Yes while a watcher it has
 * seen in this run is gone from the bus — a locked GNOME screen — because
 * the version it starts would find none and never show its icon. A desktop
 * where no watcher has been seen at all has no icon to lose, and holds
 * nothing: its updates are not kept waiting for a panel that never comes.
 */
export function selfRestartHeld({ watcherSeen, watcherNow }) {
  return watcherSeen === true && watcherNow === false;
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
 * What a restart for the icon's sake came to, as the process it started
 * reads it at its first check that can tell: the icon is `back`; or it is
 * not, and that is `explained` when this process started with no watcher on
 * the bus (see above) and `failed` when there was one to register with.
 * @returns {"back"|"explained"|"failed"|null} null when it cannot tell yet
 */
export function trayRestartOutcome({ startedWithWatcher, registered }) {
  if (registered === true) return "back";
  if (registered === false) return startedWithWatcher === false ? "explained" : "failed";
  return null;
}

/**
 * Restart the app now to bring its icon back? Only once it is lost; only when
 * the app has been quiet as long as an update waits; not while an update is
 * being looked for or downloaded, which would be thrown away; and after an
 * earlier one, by what it came to:
 *   - `failed` — the icon did not come back with a watcher to register with:
 *     never again, so a panel this cannot read, or one that refuses every
 *     icon, costs one restart and not four a day. An icon seen after a
 *     restart the person made lifts it;
 *   - `pending` — not read yet: not now;
 *   - `explained` — that process started with no watcher: again, now;
 *   - `back`, or a restart from before these were written: six hours after.
 */
export function canRestartForTray({ misses, lastRestartAt, lastOutcome, updateStatus, windowFocused, busy, quietSince, now }) {
  if (misses < MISSES_BEFORE_RESTART) return false;
  if (updateStatus === "checking" || updateStatus === "downloading") return false;
  if (typeof lastRestartAt === "number") {
    if (lastOutcome === "failed" || lastOutcome === "pending") return false;
    if (lastOutcome !== "explained" && now - lastRestartAt < TRAY_RESTART_GAP_MS) return false;
  }
  return quietLongEnough({ windowFocused, busy, quietSince, now });
}
