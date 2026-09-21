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
import { notifyViaMenuBar } from "./menubar.mjs";
// The one table of process names, shared with the presence probe so the reaction
// and the "is it running" answer can never disagree about what to look for —
// and, with it, the two questions that table cannot answer on its own: which
// browsers this platform cannot tell apart by name, and where each of those is
// installed.
import { installMarker, processName, sharesProcessName } from "./browser-presence.mjs";

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
    // The menu-bar app first, when this install has one: the notification then
    // carries ccdeck's name, icon and permission instead of Script Editor's
    // (menubar.mjs). `null` means no app, and only that falls through to
    // osascript — a refusal is the person's answer and is kept.
    const viaApp = await notifyViaMenuBar(title, body, {
      exec, platform, env: deps.env ?? process.env, root: deps.root, exists: deps.exists,
    });
    if (viaApp !== null) return viaApp;
    // `-e` with argv, so neither string is interpolated into the source. The
    // shell tool this descends from built its notification by interpolation and
    // that is the one place it had left the pattern it had banned everywhere
    // else.
    //
    // AND `--` BEFORE THE OPERANDS, WHICH IS THE HALF THAT WAS MISSING. Passing
    // a string as argv is not the same as it being treated as data: osascript's
    // option parser reads any LEADING-DASH operand as an option, so a title
    // beginning with `-e` was taken as a second script chunk and COMPILED. The
    // note above asserted the argv form made an attacker-chosen host name safe;
    // it did not.
    //
    // The reach was the whole of it. `title` is `basename(cwd) — ccdeck` from
    // block-notify.mjs, `cwd` arrives in the body of `POST /api/event`, and
    // that route is in OPEN_MUTATIONS — no token, no browser identity, which is
    // exactly the sandboxed-subprocess-with-loopback-egress case the gate
    // comments name. Verified on Darwin 25.5 with no payload at all: without
    // `--`, a leading `-e` operand answers "The run handler is specified more
    // than once", which is the compiler reporting on the attacker's string;
    // with `--`, the same string arrives as `item 1 of argv`.
    const r = await exec("osascript", [
      "-e",
      'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
      "--", title, body,
    ]).catch(() => null);
    return r?.ok === true;
  }
  if (platform === "win32") {
    // THE STRINGS GO THROUGH THE ENVIRONMENT, and the previous spelling could
    // not have worked at all. PowerShell documents that a string `-Command`
    // must be the LAST parameter: everything after it is appended to the
    // command text. So `… -t <title> -b <body>` was not two parameters, it was
    // more script — pasted after `…Show($x)`, where it failed to parse — and
    // `param($t,$b)` cannot receive arguments through `-Command` in any case.
    // The toast therefore never appeared on Windows, for the reaction that is
    // the default.
    //
    // That mistake also put attacker-chosen text into a script. `body` carries
    // `episode.host`, which is `new URL(row.url).host` out of the browser's own
    // history — the whole premise of this feature is that somebody else may
    // have opened that page. `$env:` reads it as data at runtime, which is the
    // same discipline the argv paths above keep.
    // TEMPLATE 5, ToastText02: a bold heading and a body line, and the ONLY
    // stock template with exactly the two text nodes this fills.
    //
    // It was 0 — ToastImageAndText01 — from the day this was written until it
    // was run on Windows. That template has ONE text node and an image slot, so
    // `$n.Item(1)` below threw "Specified argument was out of the range of
    // valid values" every time, the catch turned that into `null`, and `notify`
    // returned false. Not intermittently and not on some machines: this branch
    // could never once have raised a toast.
    //
    // It took this long to find because everything around it is right. The type
    // loads, the AppUserModelID is accepted, the reaction is offered on the
    // platform — `available()` lists "notify" on win32 — and the failure is a
    // rejected promise on a fire-and-forget path whose whole contract is to
    // stay quiet. The only surface that ever said anything was a boolean
    // nobody read.
    //
    // Verified on Windows 10 19045 in the logged-on user's own session
    // (schtasks /IT, session 2): template 0 FAILED, template 5 SHOWN. Over SSH
    // both fail with "The notification platform is unavailable" — every SSH
    // process lands in session 0, which has no desktop — so a check that runs
    // there proves nothing about this line either way, and that is a property
    // of the transport rather than of the code.
    const r = await exec("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime];"
      + "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(5);"
      + "$n = $x.GetElementsByTagName('text');"
      + "$n.Item(0).AppendChild($x.CreateTextNode($env:CCDECK_TOAST_TITLE)) > $null;"
      + "$n.Item(1).AppendChild($x.CreateTextNode($env:CCDECK_TOAST_BODY)) > $null;"
      + "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ccdeck').Show($x)",
    ], { env: { ...process.env, CCDECK_TOAST_TITLE: title, CCDECK_TOAST_BODY: body } }).catch(() => null);
    return r?.ok === true;
  }
  // `--` for the same reason as the darwin branch above, and it is worth having
  // even though the consequence here is smaller: notify-send parses a leading
  // dash as an option too, so an attacker-chosen title could suppress or
  // misdirect the notification. There is no script compiler behind it, so this
  // is a broken notification rather than an execution — fixed anyway, because
  // the rule is "never let a user string be read as an option" and a rule with
  // an exception is a rule somebody will apply to the wrong call next time.
  const r = await exec("notify-send", ["--", title, body]).catch(() => null);
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
  // `--` here too. The url comes from a real http(s) history row so it cannot
  // begin with a dash today, but that is a property of the caller rather than
  // of this line, and the next caller will not know it.
  const r = await exec("osascript", ["-e", closeTabScript(app), "--", url]).catch(() => null);
  if (!r?.ok) return { ok: false, reason: "script_failed" };
  const said = String(r.stdout ?? "").trim();
  return { ok: said === "closed", reason: said || "unknown" };
}

/** Quit a browser. The only reaction that takes the session back. */
export async function quitBrowser(browserKey, platform = process.platform, deps = {}) {
  const exec = deps.run ?? run;
  if (platform === "darwin") {
    // The darwin display-name table is consulted HERE rather than at the top of
    // the function (#794). It used to gate every platform, so a browser missing
    // from a macOS-only table — `chromium-snap` and `brave-flatpak`, the two
    // roots a default Ubuntu install actually has — answered `unknown_browser`
    // on Linux before the branch that would have known what to do with it was
    // ever reached.
    const app = appName(browserKey);
    if (!app) return { ok: false, reason: "unknown_browser" };
    const r = await exec("osascript", [
      // `--`, as everywhere else that hands osascript an operand. `app` comes
      // from a fixed table so it is safe by construction; the separator costs
      // nothing and means no reader has to go and check that.
      "-e", 'on run argv\ntell application (item 1 of argv) to quit\nend run', "--", app,
    ]).catch(() => null);
    return { ok: r?.ok === true, reason: r?.ok ? "quit" : "script_failed" };
  }
  // NOT THE DISPLAY NAME WITH ITS SPACES REMOVED. `"Google Chrome"` became
  // `GoogleChrome.exe` and `google-chrome`, and neither is a process on either
  // platform — so this reaction was offered on Windows and Linux and could
  // never once have worked. The names live in browser-presence, which is where
  // the other probe reads them from, so the two cannot drift apart.
  const proc = processName(browserKey, platform);
  if (!proc) return { ok: false, reason: "unknown_browser" };
  if (platform === "win32") return await quitWindows(browserKey, proc, exec);
  const r = await exec("pkill", ["-x", proc]).catch(() => null);
  return { ok: r?.ok === true, reason: r?.ok ? "quit" : "pkill_failed" };
}

/**
 * The windowed processes of one image name, and where each was run from.
 *
 * `MainWindowHandle -ne 0` is the filter that makes the whole thing safe to
 * send a close to. Every renderer, GPU process and utility process a Chromium
 * browser starts carries the SAME image name as the browser itself, has no
 * window, and cannot be asked to close — only forced. Selecting on the window
 * handle leaves exactly the processes a WM_CLOSE means something to, which is
 * the set the user is thinking of when they arm this reaction.
 *
 * `Path` rides along because it is what tells the four Chrome-family channels
 * apart; see installMarker.
 *
 * `-ErrorAction SilentlyContinue` because "no process of that name" is the
 * ordinary answer — the browser may have been closed by hand between the visit
 * and the poll — and it is not a reason to print a stack.
 *
 * SINGLE QUOTES THROUGHOUT AND NOT ONE DOUBLE QUOTE, deliberately. This is a
 * `-Command` string and the whole of it has to survive being one argv entry on
 * a Windows command line; the repo has already paid for the other spelling once
 * (see notify, above: PowerShell documents that a string `-Command` must be the
 * LAST parameter, and everything after it is appended to the command TEXT). A
 * script with no embedded double quote has nothing in it for Node's
 * command-line construction to have to escape.
 *
 * `proc` is interpolated, and it comes from the fixed APP_NAME table in
 * browser-presence.mjs and from nowhere else — the same rule closeTabScript
 * keeps for the application name it interpolates. No value a user or a web page
 * chose reaches this string.
 */
export const windowedProcessesPs = proc =>
  `Get-Process -Name ${proc} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,Path | ConvertTo-Json -Compress`;

/**
 * The process ids from that listing which belong to this install.
 *
 * `marker` null means the image name IS the install — `msedge`, `brave`,
 * `vivaldi` — so every windowed process of that name is wanted. A marker means
 * the name is shared and only the ones whose executable sits under it are.
 *
 * A row with NO readable path is dropped rather than kept. `Get-Process` cannot
 * read `.Path` for a process this session may not open, and a row the deck
 * cannot attribute is one it must not claim: keeping it would put the
 * unattributable processes back into a set whose entire purpose is to exclude
 * the ones that are not this browser. Erring towards closing nothing is the
 * only direction that cannot take somebody's tabs with it.
 *
 * `ConvertTo-Json` emits a bare object rather than an array when the listing
 * has exactly one row — one browser window is the common case — so a single
 * object is read as readily as a list.
 */
export function pickInstallPids(json, marker) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const want = marker ? marker.toLowerCase() : null;
  const out = [];
  for (const r of rows) {
    const pid = Number(r?.Id);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (want) {
      const path = typeof r?.Path === "string" ? r.Path : "";
      if (!path.toLowerCase().includes(want)) continue;
    }
    if (!out.includes(pid)) out.push(pid);
  }
  return out;
}

/**
 * Quit a browser on Windows — by asking it to close, and asking only the one
 * the finding came from.
 *
 * WHAT THIS USED TO BE, because it is the reason the function exists (#1028):
 *
 *     exec("taskkill", ["/IM", `${proc}.exe`, "/F"])
 *
 * Two separate faults, and both of them cost the user work.
 *
 * `/F` is TerminateProcess. It is not a request and nothing gets to refuse it:
 * no beforeunload, no session write, no "restore pages?" on the next launch.
 * The other two legs of this same function are graceful — macOS sends the
 * AppleScript `quit`, Linux sends SIGTERM through `pkill -x` — so Windows was
 * the one platform where arming this reaction meant losing whatever was typed
 * into every open form. Without `/F`, taskkill posts WM_CLOSE, which is the
 * Windows spelling of the same polite request the other two legs make, and
 * which Chrome honours by saving its session first.
 *
 * `/IM chrome.exe` is every Chrome-family process on the machine. Four browser
 * keys share that image name (see sharesProcessName), so a user who armed this
 * for a finding in Canary lost stable Chrome, Beta, Canary and Chromium at
 * once — while the very same reaction on the very same finding quits Canary
 * alone on macOS, where the table distinguishes "Google Chrome" from "Google
 * Chrome Canary". Selecting the pids first and passing them with `/PID` is what
 * makes the Windows reaction as narrow as the macOS one.
 *
 * THE FALLBACK NEVER WIDENS THE DAMAGE, only the reach. If PowerShell cannot be
 * reached at all, this asks the image name to close — the same set the old code
 * touched, and still without `/F`, so the worst case here is strictly gentler
 * than the best case was before. It says which of the two it did, because a
 * reaction that quietly closed three more browsers than it was asked to is
 * something the reader has to be able to see in the log.
 *
 * And a browser with no window open is reported, not worked around. That is the
 * case where the old code would have closed somebody else's browser instead of
 * this one, and "could not" is the honest answer — the same rule react() keeps
 * for every other failure it prints.
 */
async function quitWindows(browserKey, proc, exec) {
  // The filter is applied only where the name is ambiguous. Narrowing an image
  // name that already names one browser would mean a Brave installed somewhere
  // this table did not predict is a Brave the reaction refuses to close.
  const shared = sharesProcessName(browserKey, "win32").length > 0;
  const marker = shared ? installMarker(browserKey, "win32") : null;

  // Ambiguous AND unknown to the install table: there is no way to tell this
  // browser's processes from three others', so the only honest answers are the
  // broad graceful close or nothing. Broad-and-graceful, said out loud.
  if (shared && !marker) return await closeByImage(proc, exec, "quit_family");

  const listed = await exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", windowedProcessesPs(proc),
  ]).catch(() => null);

  if (!listed?.ok) return await closeByImage(proc, exec, "quit_family");

  const pids = pickInstallPids(String(listed.stdout ?? "").trim(), marker);
  if (!pids.length) return { ok: false, reason: "no_window" };

  // One taskkill with every pid on it rather than one per pid: a browser with
  // four windows open is four processes only on the rarest Chromium build, but
  // a profile the user runs twice is two, and closing one of them and reporting
  // success would leave the session this reaction exists to take back.
  const r = await exec("taskkill", pids.flatMap(pid => ["/PID", String(pid)])).catch(() => null);
  return { ok: r?.ok === true, reason: r?.ok ? "quit" : "taskkill_failed" };
}

/** Ask every window of an image name to close. Graceful — never `/F`. */
async function closeByImage(proc, exec, reason) {
  const r = await exec("taskkill", ["/IM", `${proc}.exe`]).catch(() => null);
  return { ok: r?.ok === true, reason: r?.ok ? reason : "taskkill_failed" };
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
  // `quit_family` is the Windows fallback that could not tell four browsers
  // sharing one image name apart and asked all of them to close. It succeeded,
  // so it is not a `could not` line — but a reaction that closed three more
  // browsers than the reader armed it for is not "quit the browser" either, and
  // the log is the only place they would ever find out.
  done.push(
    out.reason === "quit_family"
      ? "asked every window of that browser's family to close — this platform cannot tell its channels apart by process name"
      : out.ok ? "quit the browser" : `could not quit the browser — ${out.reason}`);
  return done;
}
