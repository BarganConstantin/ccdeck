// What the watch does when it finds something, beyond writing it down.
//
// THREE REACTIONS, AND ONLY TWO OF THEM EXIST EVERYWHERE. The panel offers a
// browser exactly the reactions its platform can actually perform, because a
// mode that silently does nothing is worse than one that was never offered —
// the user arms it, believes they are covered, and finds out on the day it
// mattered.
//
//   notify        every platform. A system notification.
//   quit-browser  every platform. Blunt, and the only one that takes the
//                 session away from whoever was driving it.
//   close-tab     macOS only. AppleScript is the one interface that can close
//                 ONE tab by URL. On Windows the nearest thing is walking the
//                 accessibility tree and matching on the page TITLE, which two
//                 tabs can share; under Wayland there is nothing at all.
//
// WHY CLOSING A TAB IS THE WEAKEST OF THE THREE, said plainly because the
// panel should not oversell it: by the time the deck sees the visit, Chrome has
// already loaded the page and sent the user's cookies. Closing it is cleanup.
// The session that opened it is still attached and can still read every other
// tab. Only quitting takes anything back.
import { run } from "./exec.mjs";

/** Reactions this platform can actually carry out, in the order the panel
 *  should offer them. Never a list the caller has to filter again. */
export function available(platform = process.platform) {
  return platform === "darwin"
    ? ["notify", "close-tab", "quit-browser"]
    : ["notify", "quit-browser"];
}

/** Whether a stored setting is still performable here. A store written on a Mac
 *  and carried to a Linux machine — or a browser that is not the one the
 *  setting was chosen for — must not silently do nothing. */
export const performable = (reaction, platform = process.platform) =>
  available(platform).includes(reaction);

/**
 * The AppleScript that closes one tab, given its URL through argv.
 *
 * THE URL GOES THROUGH argv AND NEVER INTO THE SOURCE. It is attacker-chosen
 * text: the whole premise of this feature is that somebody else may have opened
 * that page, so its address is the last string in the deck that should be
 * pasted into a script. The shell tool this descends from verified that an
 * interpolated URL could reach `do shell script`.
 *
 * The application name IS interpolated, because AppleScript will not load an
 * app's terminology from a variable — `tell application appName` leaves `tabs`
 * and `URL` unresolvable. It comes from the fixed table below and from nowhere
 * else.
 *
 * The `is not running` guard is not politeness either: `tell application "X"`
 * LAUNCHES X when it is not running, so without it a watch would resurrect a
 * browser the user had quit in order to close a tab in it.
 */
export function closeTabScript(app) {
  return `on run argv
  set wanted to item 1 of argv
  if application "${app}" is not running then return "not-running"
  tell application "${app}"
    repeat with w in windows
      repeat with t in tabs of w
        if (URL of t as string) is wanted then
          close t
          return "closed"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;
}

/** The application name for a browser key, or null when the deck does not know
 *  one — which is a reason to do nothing rather than to guess. */
const APP = {
  chrome: "Google Chrome",
  "chrome-beta": "Google Chrome Beta",
  "chrome-canary": "Google Chrome Canary",
  chromium: "Chromium",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
  vivaldi: "Vivaldi",
  arc: "Arc",
};
export const appName = key => APP[key] ?? null;

/**
 * A system notification.
 *
 * The text is passed as an argument on every platform rather than built into a
 * script, for the reason above: a host name reaching this function came out of
 * a browser's history and is not the deck's own string.
 */
export async function notify(title, body, platform = process.platform, deps = {}) {
  const exec = deps.run ?? run;
  if (platform === "darwin") {
    // `-e` with argv, so neither string is interpolated into the source. The
    // shell tool this descends from built its notification by interpolation and
    // that is the one place it had left the pattern it had banned everywhere
    // else.
    const r = await exec("osascript", [
      "-e",
      'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
      title, body,
    ]).catch(() => null);
    return r?.ok === true;
  }
  if (platform === "win32") {
    // PowerShell's own toast, through the same argv discipline: the strings go
    // in as parameters rather than as script text.
    const r = await exec("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "param($t,$b); [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime];"
      + "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0);"
      + "$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode($t)) > $null;"
      + "$n.Item(1).AppendChild($x.CreateTextNode($b)) > $null;"
      + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ccdeck').Show($x)",
      "-t", title, "-b", body,
    ]).catch(() => null);
    return r?.ok === true;
  }
  const r = await exec("notify-send", [title, body]).catch(() => null);
  return r?.ok === true;
}

/** Close one tab by its exact URL. macOS only; see `available`. */
export async function closeTab(browserKey, url, platform = process.platform, deps = {}) {
  if (platform !== "darwin") return { ok: false, reason: "unsupported" };
  const app = appName(browserKey);
  if (!app) return { ok: false, reason: "unknown_browser" };
  const exec = deps.run ?? run;
  // Through `-e` rather than stdin: `run` closes the child's stdin immediately
  // and says so in its own contract, so `osascript -` would read an empty
  // script and report success having done nothing. The URL still travels as
  // argv, which is the part that matters.
  const r = await exec("osascript", ["-e", closeTabScript(app), url]).catch(() => null);
  if (!r?.ok) return { ok: false, reason: "script_failed" };
  const said = String(r.stdout ?? "").trim();
  return { ok: said === "closed", reason: said || "unknown" };
}

/** Quit a browser. The only reaction that takes the session back. */
export async function quitBrowser(browserKey, platform = process.platform, deps = {}) {
  const app = appName(browserKey);
  if (!app) return { ok: false, reason: "unknown_browser" };
  const exec = deps.run ?? run;
  if (platform === "darwin") {
    const r = await exec("osascript", [
      "-e", 'on run argv\ntell application (item 1 of argv) to quit\nend run', app,
    ]).catch(() => null);
    return { ok: r?.ok === true, reason: r?.ok ? "quit" : "script_failed" };
  }
  if (platform === "win32") {
    const r = await exec("taskkill", ["/IM", `${app.replace(/ /g, "")}.exe`, "/F"]).catch(() => null);
    return { ok: r?.ok === true, reason: r?.ok ? "quit" : "taskkill_failed" };
  }
  const r = await exec("pkill", ["-x", app.toLowerCase().replace(/ /g, "-")]).catch(() => null);
  return { ok: r?.ok === true, reason: r?.ok ? "quit" : "pkill_failed" };
}

/**
 * Carry out the armed reaction for one episode.
 *
 * Always notifies, whatever else it does. A tab that closed itself with no
 * explanation is a mystery rather than a warning, and the point of the feature
 * is that the user finds out.
 */
export async function react(reaction, episode, { platform = process.platform, deps = {} } = {}) {
  const done = [];
  const pages = `${episode.count} page${episode.count === 1 ? "" : "s"}`;
  if (await notify("Browser watch", `${episode.host} — ${pages} while you were away`, platform, deps)) {
    done.push("notified");
  } else {
    done.push("could not notify");
  }

  if (!performable(reaction, platform) || reaction === "notify") return done;

  // A REACTION THAT COULD NOT ACT MUST SAY SO. This reported only its
  // successes, so every failure was silent — and there were two whole months of
  // them: `episode.browser` was null until it was fixed, `appName(null)` is
  // null, and both destructive reactions returned `unknown_browser` and pushed
  // nothing. The panel said a finding had been handled and nothing had been.
  //
  // The failures that remain are ordinary and will happen: macOS asks once for
  // permission to control another application and refuses forever if declined;
  // a tab can be closed by hand before the poll reaches it; a browser can quit
  // on its own. Each of those is something the reader has to be able to see,
  // because the alternative is believing a tab was closed that is still open.
  if (reaction === "close-tab") {
    // Every URL in the episode, because an episode is a run and closing only
    // its first page leaves the rest of the run open.
    for (const u of episode.urls ?? []) {
      const out = await closeTab(episode.browser, u.url, platform, deps);
      done.push(out.ok ? `closed ${u.url}` : `could not close ${u.url} — ${out.reason}`);
    }
    return done;
  }

  const out = await quitBrowser(episode.browser, platform, deps);
  done.push(out.ok ? "quit the browser" : `could not quit the browser — ${out.reason}`);
  return done;
}
