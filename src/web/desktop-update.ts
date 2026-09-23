export type DesktopUpdateState = {
  status: "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  version: string | null;
};

const STATUSES = new Set<DesktopUpdateState["status"]>([
  "idle", "checking", "current", "downloading", "ready", "error",
]);

export function readDesktopUpdate(value: unknown): DesktopUpdateState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { status?: unknown; version?: unknown };
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status as DesktopUpdateState["status"])) return null;
  const version = typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : null;
  if (raw.status === "ready" && !version) return null;
  return { status: raw.status as DesktopUpdateState["status"], version };
}

export function readyDesktopUpdate(value: DesktopUpdateState | null): { version: string } | null {
  return value?.status === "ready" && value.version ? { version: value.version } : null;
}

/** The desktop app's own version, read off the `ccdeck-desktop/<version>`
 *  token the app appends to its window's user agent (in-app.ts), or null in a
 *  browser. Not the deck's: the app can be attached to a deck it did not start
 *  (`npx ccdeck`, an npm login item) at another version entirely, and its
 *  update moves the app, so "from" has to be the app's number (#1187). */
export function desktopAppVersion(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  return /\bccdeck-desktop\/(\d[^\s]*)/.exec(ua)?.[1] ?? null;
}

/** The one phrase for applying the app's verified update, on all three
 *  surfaces that offer it: this window's dialog, the native sheet and the tray
 *  line (desktop/main.mjs spells the same words, and a test holds the two
 *  files to each other). It was "Update and restart" here, "Restart now" on the
 *  sheet and "Restart to update" in the tray, so the place a failed press sends
 *  people to did not use the words of the button that failed. The tray's was
 *  kept because it names both halves in the order they happen, and it is what
 *  the updater itself calls the action. */
export const RESTART_TO_UPDATE = "Restart to update";

/** How long a press waits for the window to close before it is handed back.
 *  A restart that worked ends this page; one still here after this did not
 *  happen. */
export const UPDATE_RESTART_WAIT_MS = 30_000;

/** Where the app's own menu is, in the words the platform uses for it: the
 *  README says "the menu bar (the tray on Windows and Linux)". */
export function trayMenuName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "the ccdeck menu in the menu bar" : "the ccdeck tray menu";
}

/** The version chip while the app's update is ready (#1187).
 *
 *  The accessible name STARTS with what the chip prints (WCAG 2.5.3): it used
 *  to be a sentence that never said the from-version, so "click v1.63.0" from
 *  a voice-control user matched nothing on screen. The tooltip says what a
 *  click does — it opens What's new, with the update's action first — rather
 *  than promising the restart itself, which a click on the chip never did. */
export function readyChipCopy(from: string, to: string): { text: string; label: string; title: string } {
  const text = `v${from} → v${to}`;
  return {
    text,
    label: `${text}, update downloaded and verified`,
    title: `ccdeck v${to} is downloaded and verified · click to open What's new, where ${RESTART_TO_UPDATE} comes first`,
  };
}

/** Why a press of Restart to update did not end in a restart. The first two
 *  are the server's own 409 reasons (see handleDesktopUpdateRequest); the rest
 *  are what the page can tell on its own. */
export type UpdateRestartFailure = "app_disconnected" | "update_not_ready" | "refused" | "unreachable" | "timeout";

/** The server's answer to a refused request, as one of the failures above. */
export function updateRestartRefusal(body: unknown): UpdateRestartFailure {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return reason === "app_disconnected" || reason === "update_not_ready" ? reason : "refused";
}

/** What the dialog says when the restart did not happen: what went wrong, in
 *  one clause, and the way out that does not go through this page at all. The
 *  tray line talks to the updater directly, so it works in every case here —
 *  including the one where this deck has lost the app entirely. */
export function updateRestartFailureText(
  failure: UpdateRestartFailure,
  version: string,
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): string {
  const menu = trayMenuName(ua);
  const way = `Use ${RESTART_TO_UPDATE} in ${menu}.`;
  switch (failure) {
    case "app_disconnected":
      return `Nothing restarted: the app is not connected to this deck, so the request had nowhere to go. ${way}`;
    case "update_not_ready":
      return `Nothing restarted: the app no longer has v${version} ready. When it has one, ${RESTART_TO_UPDATE} is in ${menu}.`;
    case "timeout":
      return `ccdeck has not restarted after ${UPDATE_RESTART_WAIT_MS / 1000} seconds. ${way}`;
    case "refused":
      return `Nothing restarted: the deck turned the request down. ${way}`;
    case "unreachable":
      return `Nothing restarted: the request did not reach the deck. ${way}`;
  }
}
