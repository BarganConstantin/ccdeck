// "Restart to update" for the Linux AppImage (#1630): start the new version
// only after this one has gone, and hand it nothing this one had open.
//
// electron-updater's own restart spawns the new AppImage from inside this
// process while it is still running, and a spawned child keeps every
// descriptor that was opened without close-on-exec. Chromium opens its pak,
// ICU and V8 snapshot files exactly that way, so it can pass them to its
// zygote. The new app therefore held the old version's files, the old
// AppImage could never unmount, and every self-update left one more runtime
// and one more /tmp/.mount_ccdeck* behind. The app it started also came up
// with no tray icon.
//
// So the updater only swaps the file in (see restartNow in updater.mjs), and
// this starts the new one: a detached bash, handed everything as argv — never
// interpolated. It closes whatever it inherited before it waits, so it is not
// the thing holding the old mount either, then starts the AppImage once this
// pid is gone. bash because the AppImage's own AppRun already needs it; /dev/fd
// because it is the same list on Linux and macOS.
import { spawn } from "node:child_process";

export const RELAUNCH_SCRIPT = `
pid="$1"; appimage="$2"
for fd in /dev/fd/*; do
  fd="\${fd##*/}"
  if [ "$fd" -gt 2 ]; then eval "exec $fd>&-"; fi
done
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
exec "$appimage"
`;

/** Variables the AppImage runtime and AppRun set for THIS mount. */
const APPIMAGE_VARS = ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "APPIMAGE_SILENT_INSTALL", "APPIMAGE_EXIT_AFTER_INSTALL"];

/** Search paths AppRun prefixes with the mount it runs from. */
const PATH_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

/**
 * The environment the new version starts with: this one's, less what the
 * running AppImage added to it.
 *
 * AppRun prefixes PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR
 * with its own mount, and appends the system share dirs to XDG_DATA_DIRS every
 * time it runs. Handed on as they are, the next app would look for libraries in
 * a mount that is about to disappear, and the lists would grow by one version
 * per update. Entries under APPDIR are dropped and repeats removed; a list left
 * empty is unset. Pure, so it can be checked without an AppImage.
 *
 * So are entries under an OLDER mount of the same AppImage, which relaunches
 * from before this cleaning left behind and nothing took out since: an app
 * seen after a few self-updates still carried two mounts that no longer
 * existed in XDG_DATA_DIRS, LD_LIBRARY_PATH and GSETTINGS_SCHEMA_DIR (#1630).
 * The runtime names every mount `.mount_` plus six characters of the file's
 * name plus six random ones, so all of this AppImage's mounts share all but
 * the last six.
 */
export function relaunchEnv(env = process.env) {
  const appDir = env.APPDIR;
  const stem = appDir ? /^(.*\/\.mount_[^/]*?)[^/]{6}$/.exec(appDir)?.[1] : null;
  const olderMount = stem ? new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/]{6}(/|$)`) : null;
  const out = { ...env };
  for (const name of APPIMAGE_VARS) delete out[name];
  for (const name of PATH_LISTS) {
    if (out[name] == null) continue;
    const kept = [];
    for (const entry of out[name].split(":")) {
      if (!entry) continue;
      if (appDir && (entry === appDir || entry.startsWith(`${appDir}/`))) continue;
      if (olderMount?.test(entry)) continue;
      if (!kept.includes(entry)) kept.push(entry);
    }
    if (kept.length) out[name] = kept.join(":");
    else delete out[name];
  }
  return out;
}

/** Start `appImage` once `pid` has exited, with a clean slate. */
export function relaunchOnExit({ pid, appImage, env = process.env }) {
  const child = spawn("bash", ["-c", RELAUNCH_SCRIPT, "ccdeck-relaunch", String(pid), appImage], {
    detached: true,
    stdio: "ignore",
    env: relaunchEnv(env),
  });
  child.unref();
}

/**
 * Quit and start again for a reason other than an update — a tray icon the
 * panel has lost (tray-presence.mjs). The AppImage goes through
 * relaunchOnExit, for everything said above; any other build through
 * Electron's own relaunch, which starts it once this one has quit.
 */
export function restartApp(app, { env = process.env, pid = process.pid, relaunch = relaunchOnExit } = {}) {
  if (env.APPIMAGE) relaunch({ pid, appImage: env.APPIMAGE, env });
  else app.relaunch();
  app.quit();
}
