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
