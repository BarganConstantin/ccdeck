// Whether the window stands over another app's full-screen Space (#1214).
//
// ccdeck has no window most of the time, and while it has none it is an
// accessory app. macOS lets an accessory app's window onto another app's
// full-screen Space, which is how the window opens over a full-screen browser
// from the menu bar. But a full-screen Space has nothing behind its full-screen
// window: clicking the browser gives it the keyboard and leaves ccdeck drawn
// over it. So when that happens the window closes, and the menu bar opens it
// again over wherever the person is then.
//
// Electron cannot say which Space a window is on, or whether a Space is full
// screen. macOS's own window list can, with no permission asked: it lists only
// the windows on the Spaces being shown, so ccdeck's window is in it only while
// the person can see it, and a full-screen app's window is the one that covers
// its whole display, menu bar included, which no window on a desktop does.

import { execFile } from "node:child_process";

/** Every ordinary window on the Spaces being shown, front to back: layer 0,
 *  the level apps draw their windows at, as JavaScript for Automation. */
const LIST_WINDOWS = `ObjC.import("CoreGraphics");
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject(raw))
  .filter(w => w.kCGWindowLayer === 0)
  .map(w => ({ pid: w.kCGWindowOwnerPID, x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })))`;

const LIST_TIMEOUT_MS = 2_000;

/** @returns {Promise<Array<{ pid: number, x: number, y: number, width: number, height: number }>>}
 *  Empty when the list cannot be read: nothing is then over anything, and
 *  the window stays as it is. */
export function windowsOnScreen(run = execFile) {
  return new Promise(resolve => {
    run("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS], { timeout: LIST_TIMEOUT_MS }, (err, out) => {
      if (err) return resolve([]);
      try {
        const list = JSON.parse(String(out));
        resolve(Array.isArray(list) ? list : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** True when a window of `pid` is on screen and another app's window covers
 *  the whole of `display` — the full-screen app on the Space it stands in. */
export function overFullScreen(windows, pid, display) {
  if (!windows.some(w => w.pid === pid)) return false;
  return windows.some(w => w.pid !== pid
    && w.x === display.x && w.y === display.y && w.width === display.width && w.height === display.height);
}
