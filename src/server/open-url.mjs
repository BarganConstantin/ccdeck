// Opening the browser, without the ten packages it used to cost.
//
// `open@10` was this package's ONLY runtime dependency, and it brought nine
// more with it — bundle-name, default-browser, default-browser-id,
// define-lazy-prop, is-docker, is-inside-container, is-wsl, run-applescript,
// wsl-utils. Ten tarballs to fetch, extract and link on a machine whose npm
// cache is empty, for one call, made once, whose whole job is to hand a
// localhost URL to whatever the desktop already uses. On a fast link that is a
// second; on the links the people who reported a hung `npx ccdeck` are on, it
// is ten more round trips before the deck's own tarball is even unpacked.
//
// What it did that is worth keeping is the platform knowledge, and that is
// small enough to hold here: three commands, plus the WSL case where
// `process.platform` says linux and the browser is on the Windows side.
//
// DELIBERATELY FIRE AND FORGET. `open` returned a promise the boot awaited;
// nothing downstream of that await needed the child, and a launcher that takes
// its time — xdg-open on a machine with no desktop session hunting through
// every handler it knows — held the boot behind it. Here the candidates are
// tried in order, the failures move to the next one on their own, and the boot
// never waits for any of it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** How long a launcher gets to prove it worked before the next one is tried.
 *  A launcher that is still running is a launcher that found something: macOS
 *  `open` and cmd's `start` both exit at once, and xdg-open stays up as the
 *  browser's parent. So only an EARLY non-zero exit moves on. */
export const LAUNCH_GRACE_MS = 1_500;

/**
 * Is this a Linux that is really Windows?
 *
 * WSL reports `process.platform === "linux"`, has no desktop session of its
 * own on a default install, and its browser lives on the Windows side — so
 * xdg-open there either is not installed or opens nothing anybody can see.
 * Both signals are read because either can be absent: the env var is set by
 * the WSL launcher and lost by anything that scrubs the environment, and
 * /proc/version is the kernel's own answer and cannot be.
 */
export function isWsl(platform = process.platform, env = process.env, readProcVersion = defaultProcVersion) {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return /microsoft/i.test(readProcVersion());
}

function defaultProcVersion() {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

/**
 * The launchers to try for `url`, best first.
 *
 * A list rather than one answer, because every platform below has a case where
 * the first choice is missing: a Linux without xdg-utils, a WSL without
 * wslview, a Windows whose comspec has been moved. Each entry is exactly what
 * `spawn` is given, so the test can read the command line rather than infer it.
 *
 * Exported with platform and env as parameters for the reason exec.mjs exports
 * its own that way: the Windows and Linux answers have to be checkable from the
 * Mac this is written on.
 */
export function launchers(url, { platform = process.platform, env = process.env, wsl } = {}) {
  const inWsl = wsl === undefined ? isWsl(platform, env) : wsl;

  if (platform === "darwin") {
    // The absolute path first: `open` is also a shell builtin in a few setups
    // and a user's own script called `open` on the PATH is not unheard of, and
    // /usr/bin/open has been on every macOS this package supports.
    return [
      { file: "/usr/bin/open", args: [url] },
      { file: "open", args: [url] },
    ];
  }

  if (platform === "win32") {
    // PowerShell FIRST, and this order is the one thing here that was decided by
    // evidence rather than by taste.
    //
    // `open@10` — the dependency this file replaces — launches a Windows URL
    // through `powershell -EncodedCommand` running `Start "<url>"`. That is what
    // every ccdeck install on Windows has been using, so it is the path with a
    // year of field evidence behind it and `cmd /c start` has none.
    //
    // And the fallback below cannot rescue a wrong first choice. `start` exits 0
    // whether or not anything opened — measured on a real Windows 10 box, exit
    // code 0 with no browser process created — so a candidate list that led with
    // it would never reach a second candidate, however badly the first had done.
    // Leading with the one whose failure is visible is the only ordering where
    // having a fallback means anything.
    //
    // The cost is PowerShell's startup, a few hundred milliseconds, and it is
    // paid by nobody: openUrl does not wait for the launcher and the boot does
    // not wait for openUrl.
    const tries = [{
      file: "powershell.exe",
      // The URL as its own argv entry rather than inside a script string, where
      // `;` and `&` are PowerShell's own operators.
      args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url],
    }];
    const viaCmd = startCommand(url, env);
    tries.push(viaCmd);
    // comspec is read by startCommand, and a comspec pointing somewhere that is
    // no longer there is the one way that line fails on a machine which is
    // otherwise fine. The bare name is what the PATH would have answered.
    if (viaCmd.file.toLowerCase() !== "cmd.exe") tries.push(startCommand(url, env, "cmd.exe"));
    return tries;
  }

  if (inWsl) {
    return [
      // Ships with wslu and is what a WSL user's own `xdg-open` is usually
      // symlinked to anyway. It knows how to hand a URL across the boundary.
      { file: "wslview", args: [url] },
      // No wslu: go to Windows directly. cmd.exe is reachable from WSL through
      // the interop path and needs no PATH entry of its own.
      startCommand(url, env, "/mnt/c/Windows/System32/cmd.exe"),
      startCommand(url, env, "cmd.exe"),
      // Last, and only useful on a WSL that really does run a desktop.
      { file: "xdg-open", args: [url] },
    ];
  }

  // Plain Linux, and every other Unix. xdg-open is the standard answer; the
  // rest are the ones that exist on machines that never installed xdg-utils,
  // in the order of how likely they are to be configured rather than merely
  // present.
  return [
    { file: "xdg-open", args: [url] },
    { file: "gio", args: ["open", url] },
    { file: "x-www-browser", args: [url] },
    { file: "sensible-browser", args: [url] },
    { file: "wslview", args: [url] },
  ];
}

/**
 * `start` the way cmd.exe needs to be given it.
 *
 * Three details, each of which is a bug if it is missing. The empty `""` is the
 * window TITLE — `start "http://…"` opens a console window titled with the URL
 * and nothing else happens. The URL is quoted so an `&` in a query string ends
 * the argument instead of the command. And `windowsVerbatimArguments` stops
 * Node quoting the line a second time, which is exactly what exec.mjs's
 * `viaCmd` does for the same reason.
 */
export function startCommand(url, env = process.env, comspec) {
  const shell = comspec || env.comspec || env.ComSpec || "cmd.exe";
  return {
    file: shell,
    args: ["/d", "/s", "/c", `start "" "${url}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

/**
 * Refuse anything that is not an http(s) URL.
 *
 * The one caller passes a localhost address it built itself, so this is not
 * guarding against a hostile input today — it is guarding against the day a
 * second caller passes a path, because every launcher above would happily open
 * it and `start` would run it.
 */
export function isOpenable(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Hand `url` to the desktop. Returns nothing, waits for nothing, throws never.
 *
 * The boot calls this between binding the port and starting the pulse line, and
 * neither of those has anything to learn from how it went — a browser that does
 * not open leaves a URL on screen that the user can click or paste, which is
 * the same recovery an error row would have offered.
 */
export function openUrl(url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  if (!isOpenable(url)) return;
  const tries = launchers(url, { platform, env });

  const attempt = (i) => {
    if (i >= tries.length) return;
    const { file, args, opts } = tries[i];
    let child;
    try {
      child = spawnFn(file, args, {
        stdio: "ignore",
        // The launcher outlives us on purpose: xdg-open is the browser's parent
        // process on a cold start, and a deck stopped with Ctrl+C two seconds
        // later should not take the window with it. Not on Windows, where a
        // detached child is a child with its own console — the thing
        // windowsHide exists to prevent.
        detached: platform !== "win32",
        windowsHide: true,
        ...opts,
      });
    } catch {
      attempt(i + 1);
      return;
    }
    // ENOENT and EACCES both land here rather than throwing, because the failure
    // happens after spawn returns.
    child.on("error", () => attempt(i + 1));
    // An early non-zero exit is xdg-open saying it found no handler (exit 3) or
    // cmd saying it could not find `start`. A launcher still alive after the
    // grace period is one that worked, so the timer is what closes the question.
    let open = true;
    const settled = setTimeout(() => { open = false; }, LAUNCH_GRACE_MS);
    settled.unref?.();
    child.on("exit", (code) => {
      clearTimeout(settled);
      if (open && code !== 0) attempt(i + 1);
    });
    child.unref?.();
  };

  attempt(0);
}
