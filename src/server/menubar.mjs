// The macOS menu-bar icon (#1160), as the server sees it: where the app is,
// starting it, and raising notifications through it.
//
// The app itself is native/macos/main.swift, built by native/macos/build.sh
// into dist/native/macos/ccdeck.app and shipped inside the tarball. This file
// never assumes it is there. A checkout nobody built, a tarball packed on
// Linux, an older install — all of them have no app, and every function here
// answers that by stepping aside, so the deck behaves exactly as it did before
// the app existed.
//
// WHY NOTIFICATIONS GO THROUGH IT, EVEN WHEN NOBODY HAS THE ICON RUNNING. A
// notification raised by `osascript` belongs to Script Editor: it is listed
// under that name, it needs that app's permission, and on a Mac where Script
// Editor was never allowed it is reported as sent and silently dropped — which
// is how #1159 was first tested and seen to do nothing. The same notification
// raised by `ccdeck.app --notify` carries the deck's name, its icon, its own
// permission, and a click that opens the deck. The helper process lives only
// as long as it takes macOS to accept the notification, so none of this needs
// the menu-bar instance to be up.
//
// Pure decisions and injected effects, like block-notify.mjs: `exec` and
// `exists` come from the caller so the suite can drive this on any platform.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.mjs";

/** Set to "1" to keep the deck from starting the menu-bar icon and from
 *  raising notifications through it — `osascript` again, as before the app
 *  existed. Same sheet as AGENTS_DECK_NO_NOTIFY and AGENTS_DECK_NO_LAN, and it
 *  is how the suite keeps the decks it boots from putting icons in the menu bar
 *  of whoever runs it (__tests__/no-menubar.ts). */
export const OFF_ENV = "AGENTS_DECK_NO_MENUBAR";

/** The package root: src/server/ is two levels down, in a checkout and in an
 *  installed tarball alike. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The app, if this install has one and this machine may use it — or null.
 *
 * `bin` is what is checked, not the bundle directory: a half-copied or
 * half-deleted bundle has the directory and no executable, and handing that to
 * LaunchServices produces a dialog about a damaged app.
 */
export function menuBarApp({ platform = process.platform, env = process.env, root = PKG_ROOT, exists = existsSync } = {}) {
  if (platform !== "darwin") return null;
  if (env[OFF_ENV] === "1") return null;
  const app = join(root, "dist", "native", "macos", "ccdeck.app");
  const bin = join(app, "Contents", "MacOS", "ccdeck");
  return exists(bin) ? { app, bin } : null;
}

/**
 * Put the icon in the menu bar.
 *
 * Through `open` rather than by spawning the binary, so LaunchServices treats
 * it as the app it is — one instance per bundle id, and a second launch
 * reaching the running one. `-g` keeps focus where the person left it: a deck
 * starting at login or restarting into an update must not steal the keyboard.
 *
 * Answers what it did, for the banner and the tests: "launched", "absent" (no
 * app in this install, or not macOS, or switched off) or "failed".
 */
export async function launchMenuBar({ exec = run, ...where } = {}) {
  const found = menuBarApp(where);
  if (!found) return "absent";
  const r = await exec("open", ["-g", found.app]).catch(() => null);
  return r?.ok ? "launched" : "failed";
}

/**
 * Raise one notification as ccdeck.
 *
 * `null` when there is no app to raise it with, so the caller falls back to
 * whatever it did before. Otherwise the app's answer, and a `false` here is
 * NOT a reason to fall back: the likeliest cause is that the person refused
 * ccdeck's notifications, and routing round that refusal through Script
 * Editor would be the deck overruling them.
 *
 * The strings are positional argv — the app reads `--notify <title> <body>`
 * by position, never as options, so a title that begins with a dash is data.
 */
export async function notifyViaMenuBar(title, body, { exec = run, ...where } = {}) {
  const found = menuBarApp(where);
  if (!found) return null;
  const r = await exec(found.bin, ["--notify", String(title), String(body)], { timeout: 35_000 }).catch(() => null);
  return r?.ok === true;
}
