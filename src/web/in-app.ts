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

/** The desktop app's own version, from the same user-agent token, or null in a
 *  browser. Not the deck's: the app can be attached to a deck it did not start
 *  (`npx ccdeck`, an npm login item) at another version entirely, and its
 *  update moves the app, so "from" has to be the app's number (#1187). */
export function desktopAppVersion(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  return /\bccdeck-desktop\/(\d[^\s]*)/.exec(ua)?.[1] ?? null;
}
