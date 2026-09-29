// "Start at login" for the app itself (#1781).
//
// Electron's app.setLoginItemSettings and getLoginItemSettings are macOS and
// Windows only. On Linux the first does nothing and the second always answers
// openAtLogin: false — so the tray's checkbox was always drawn unchecked,
// ticking it did nothing, and the first run's "Start ccdeck when I log in"
// registered nothing at all. Linux gets the XDG way instead: an autostart entry
// in <config>/autostart, which every desktop that starts anything at login
// reads (GNOME, KDE, XFCE, and systemd's xdg-autostart generator), and which
// is read back to draw the checkbox. macOS and Windows keep Electron's call.
//
// The entry starts the AppImage file when the app is one — $APPIMAGE, which the
// AppImage runtime sets — and the binary itself otherwise. Never execPath under
// an AppImage: that is inside the mount this run made, which is gone by the
// next login.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The entry's name, the desktop file name the app already has
 *  (electron-builder's syncDesktopName makes it the package name). */
export const AUTOSTART_FILE = "ccdeck-desktop.desktop";

/** Whether Electron's own login item works here. */
const electronOwnsIt = platform => platform === "darwin" || platform === "win32";

/** <config>/autostart/ccdeck-desktop.desktop. XDG_CONFIG_HOME moves the
 *  config directory, as login-service.mjs reads it for the npm deck's unit. */
export function autostartPath({ configHome, env = process.env, home = homedir() } = {}) {
  const config = configHome ?? (env.XDG_CONFIG_HOME?.trim() || join(home, ".config"));
  return join(config, "autostart", AUTOSTART_FILE);
}

/**
 * One Exec argument, as the Desktop Entry spec reads it: always quoted, with
 * " ` $ and \ escaped inside the quotes — and then the string-level escape on
 * top, which doubles every backslash again (the spec's own "four successive
 * backslashes" for one). % starts a field code, so a literal one is doubled.
 */
function execArg(arg) {
  const quoted = `"${String(arg).replace(/["`$\\]/g, "\\$&")}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/%/g, "%%");
}

/** The entry's text. */
export function autostartEntry({ exec, args = [] }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ccdeck",
    "Comment=Tells you when a Claude Code session needs you",
    `Exec=${[exec, ...args].map(execArg).join(" ")}`,
    "Icon=ccdeck-desktop",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Whether the app starts at login now. On Linux: the entry is there, and the
 *  desktop has not switched it off (KDE writes Hidden=true, GNOME
 *  X-GNOME-Autostart-enabled=false). */
export function openAtLogin({ platform = process.platform, app, ...where } = {}) {
  if (electronOwnsIt(platform)) {
    try { return app.getLoginItemSettings().openAtLogin === true; } catch { return false; }
  }
  const path = autostartPath(where);
  try {
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
  } catch { return false; }
}

/**
 * Start the app at login, or stop. Returns whether that is now so, as read
 * back — never throws: an entry that cannot be written is an answer the caller
 * acts on (replaceNpmLoginItem does), not a crash.
 *
 * `args` are what the binary needs after it, which is the app's directory for
 * a development run and nothing for a built one.
 */
export function setOpenAtLogin(on, { platform = process.platform, app, execPath = process.execPath, args = [], env = process.env, ...where } = {}) {
  const opts = { platform, app, env, ...where };
  try {
    if (electronOwnsIt(platform)) {
      app.setLoginItemSettings({ openAtLogin: on });
    } else {
      const path = autostartPath({ env, ...where });
      if (on) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, autostartEntry({ exec: env.APPIMAGE || execPath, args }));
      } else {
        rmSync(path, { force: true });
      }
    }
  } catch { /* read back below */ }
  return openAtLogin(opts) === on;
}

/**
 * "Replace it with the app": the npm deck's login item is taken away only once
 * the app's own is registered and reads back as on. The other order left a
 * machine that started nothing at login whenever the app's registration did
 * not take — which on Linux was every time.
 *
 * `registerApp()` answers whether the app now starts at login; `uninstall()`
 * is the npm item's removal, and its answer is returned.
 */
export function replaceNpmLoginItem({ registerApp, uninstall }) {
  if (!registerApp()) return { ok: false, reason: "the app could not be set to start at login, so the npm login item was kept" };
  return uninstall();
}
