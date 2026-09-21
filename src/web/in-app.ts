// Is this page inside the ccdeck desktop app (#1160)?
//
// The app appends `ccdeck-desktop/<version>` to its window's user agent. Inside
// it, a few sentences written for a browser tab are wrong: the thing you close
// is a window, and notifications are the app's own — the browser's permission,
// and the section that asks for it, do not apply.
//
// A user agent rather than an injected global: the page runs sandboxed with no
// preload script, and the user agent is set before the first request, so the
// answer is right from the first render and cannot be changed by the page.
export function inDesktopApp(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bccdeck-desktop\/\d/.test(ua);
}
