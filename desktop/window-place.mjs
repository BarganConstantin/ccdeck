// Where the window opens again (#2466).
//
// Closing the window closes it: the app stays in the tray, and the tray, the
// Dock or a second launch builds a new one. That new window used to be
// 1440×900 in the middle of the main display every time, so a window someone
// had made full screen, maximized, moved to another monitor or resized came
// back as a plain centred window.
//
// What it was is kept in desktop-state.json as it closes, and the next window
// opens the same way. Its place is checked against the displays connected at
// that moment: a window last seen on a monitor that is gone opens at the usual
// size on the main display, and one partly off its display is moved inside.
//
// The size and place kept are the window's normal bounds, out of maximized and
// full screen. On macOS Electron's getNormalBounds of a zoomed or full-screen
// window is the frame Electron itself last gave it — when it was made, or by
// setBounds, maximize() or setFullScreen() — and nothing the person does
// changes that: not dragging the window to another monitor, not the green
// button, not a double click on the title bar. A window opened on the main
// display, dragged to the other one and put full screen there was kept on the
// main display, and after an automatic update it came back there. So for a
// maximized or full-screen window, the display it is on now wins over the one
// its normal bounds name. Windows and Linux track the normal bounds
// themselves, and theirs are on the window's display already.
//
// Knows nothing about Electron: main.mjs reads the window and the displays
// and hands them here.

/** The window's size when nothing better is known. */
export const WINDOW_SIZE = Object.freeze({ width: 1440, height: 900 });

/** Below this the deck's layout breaks; main.mjs gives Electron the same. */
export const WINDOW_MIN = Object.freeze({ width: 720, height: 480 });

/** A rectangle with finite numbers and some area, or null. */
function rectangle(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** The work areas that are rectangles, out of whatever was handed in. */
function workAreasOf(workAreas) {
  return (Array.isArray(workAreas) ? workAreas : []).map(rectangle).filter(Boolean);
}

/** The work area `bounds` is mostly on, or null when it is on none. */
function displayOf(bounds, areas) {
  let area = null;
  let most = 0;
  if (bounds) {
    for (const each of areas) {
      const shared = overlap(bounds, each);
      if (shared > most) { most = shared; area = each; }
    }
  }
  return area;
}

/**
 * What to keep of a window as it closes.
 * @param {{ normal: { x: number, y: number, width: number, height: number }, bounds?: { x: number, y: number, width: number, height: number }, maximized: boolean, fullScreen: boolean }} window
 *   `normal` is the window's size and place out of maximized and full screen
 *   (Electron's getNormalBounds), so that leaving either after it opens again
 *   goes back to where the person had it. `bounds` is where the window is
 *   drawn now (getBounds), maximized or full screen included.
 * @param {Array<{ x: number, y: number, width: number, height: number }>} [workAreas]
 *   The work area of every display connected now.
 * @returns {{ x: number, y: number, width: number, height: number, maximized: boolean, fullScreen: boolean } | null}
 *   null for bounds that are not a window's, which is then not written.
 */
export function windowPlaceToKeep({ normal, bounds, maximized, fullScreen }, workAreas) {
  let kept = rectangle(normal);
  if (!kept) return null;
  // A maximized or full-screen window whose normal bounds are on another
  // display than the window itself (macOS, see above): its normal size goes in
  // the middle of the display it is on. Where it sat on that display before it
  // grew is not known, and opening maximized or full screen again it fills
  // the display anyway.
  if (maximized === true || fullScreen === true) {
    const areas = workAreasOf(workAreas);
    const here = displayOf(rectangle(bounds), areas);
    if (here && displayOf(kept, areas) !== here) {
      const width = Math.min(kept.width, here.width);
      const height = Math.min(kept.height, here.height);
      kept = {
        x: Math.round(here.x + (here.width - width) / 2),
        y: Math.round(here.y + (here.height - height) / 2),
        width: Math.round(width),
        height: Math.round(height),
      };
    }
  }
  return { ...kept, maximized: maximized === true, fullScreen: fullScreen === true };
}

/**
 * A place as the desktop log writes it — its numbers and nothing else, so a
 * window that opens on the wrong monitor leaves a trail that says why.
 * @param {unknown} value A rectangle, with or without x and y, and with
 *   `maximized` and `fullScreen` when it is a kept place; anything else from
 *   desktop-state.json reads "none".
 */
export function placeText(value) {
  if (!value || typeof value !== "object") return "none";
  const { x, y, width, height } = value;
  if (![width, height].every(Number.isFinite)) return "none";
  const size = `${Math.round(width)}x${Math.round(height)}`;
  const where = [x, y].every(Number.isFinite) ? `${size} at ${Math.round(x)},${Math.round(y)}` : `${size} centred`;
  return `${where}${value.maximized === true ? ", maximized" : ""}${value.fullScreen === true ? ", full screen" : ""}`;
}

/**
 * Where to open the window.
 * @param {unknown} saved What desktop-state.json holds under `window`, if
 *   anything: whatever is in that file is read with suspicion.
 * @param {Array<{ x: number, y: number, width: number, height: number }>} workAreas
 *   The work area of every display connected now.
 * @returns {{ bounds: { x?: number, y?: number, width: number, height: number }, maximized: boolean, fullScreen: boolean }}
 *   `bounds` without x and y when the window is to be centred on the main
 *   display.
 */
export function windowPlaceToOpen(saved, workAreas) {
  const flags = saved && typeof saved === "object"
    ? { maximized: saved.maximized === true, fullScreen: saved.fullScreen === true }
    : { maximized: false, fullScreen: false };
  const bounds = rectangle(saved);
  // The display the window was mostly on, if it is still there.
  const area = displayOf(bounds, workAreasOf(workAreas));
  // Maximized or full screen still holds on the main display: that is how the
  // person wanted it, whichever monitor they did it on.
  if (!bounds || !area) return { bounds: { ...WINDOW_SIZE }, ...flags };
  const width = Math.min(Math.max(bounds.width, WINDOW_MIN.width), area.width);
  const height = Math.min(Math.max(bounds.height, WINDOW_MIN.height), area.height);
  return {
    bounds: {
      x: Math.round(clamp(bounds.x, area.x, area.x + area.width - width)),
      y: Math.round(clamp(bounds.y, area.y, area.y + area.height - height)),
      width: Math.round(width),
      height: Math.round(height),
    },
    ...flags,
  };
}
