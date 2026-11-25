// The desktop app's window, as the page needs to know it (desktop/preload.cjs).
//
// On macOS the traffic lights stand in the bar's first 80 window points
// (desktop/window-chrome.mjs, desktop-titlebar.css). Window points are not the
// page's CSS px once the page is zoomed (Cmd+- and Cmd+=): zoom scales CSS px
// and leaves the traffic lights where they are, so a fixed 80px start inset
// shrank to 61 points at 76% and the wordmark slid under the green button. The
// bar divides its 80 by the page's zoom, which only the app knows exactly. Full
// screen, where macOS hides the traffic lights, the app marks on the page
// itself (desktop/main.mjs).
import type { DesktopWindow } from "./components/DesktopTitlebar";

/** Chromium's own bounds for a page's zoom factor. Anything outside them is
 *  not a zoom, and the bar keeps its unzoomed 80. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

/** The factor the bar divides by, from what the app said: 1 for anything that
 *  is not a page zoom. Four decimals keep the 80 within a hundredth of a
 *  point at every zoom step. */
export function zoomFactor(said: unknown): number {
  return typeof said === "number" && Number.isFinite(said) && said >= ZOOM_MIN && said <= ZOOM_MAX
    ? Math.round(said * 10000) / 10000
    : 1;
}

/** Marks the page as drawn in the desktop app's window and, on macOS, keeps the
 *  bar told of the page's zoom. An app older than the zoom call leaves the bar
 *  at its unzoomed 80, as before. */
export function installDesktopChrome(desktop: DesktopWindow, root: HTMLElement = document.documentElement, view: Window = window): void {
  root.dataset.desktopChrome = "true";
  root.dataset.desktopPlatform = desktop.platform;
  const zoom = desktop.zoom;
  if (desktop.platform !== "darwin" || typeof zoom !== "function") return;
  const follow = () => {
    let said: unknown;
    try { said = zoom(); } catch { said = undefined; }
    root.style.setProperty("--desktop-zoom", String(zoomFactor(said)));
    // The device pixel ratio is the display's scale times the page's zoom, so
    // it changes whenever the zoom does (and when the window moves to a
    // display of another scale, which asks again for the same answer).
    view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`).addEventListener("change", follow, { once: true });
  };
  follow();
}
