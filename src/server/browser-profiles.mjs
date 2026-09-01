// Which Chromium-family browsers are on this machine, which of their profiles
// exist, and which of those carry the Claude in Chrome extension.
//
// This is the floor of Browser Watch: every other part of the feature opens a
// profile's History or its Secure Preferences, and neither is findable until
// something has answered "where are the profiles". The whole module is a claim
// about somebody else's directory layout, which is why nothing here reaches the
// disk except through an injected `deps` — the Windows layout and the two Linux
// sandbox layouts have to be exercisable from a Mac, exactly as
// claudeCliCandidates() and cswapCandidates() are, or the list rots on every
// platform its author does not sit at.
//
// THE ASYMMETRY THAT SILENTLY BREAKS IT. Chromium's user-data directory is the
// parent of `Default` and `Profile N`, and macOS spells it differently from
// everywhere else:
//
//   macOS    ~/Library/Application Support/Google/Chrome/Default
//   Windows  %LOCALAPPDATA%\Google\Chrome\User Data\Default
//   Linux    ~/.config/google-chrome/Default
//
// There is NO `User Data` level on macOS — the app-support directory is itself
// the user-data directory — and the mistake is invisible in both directions.
// Insert the level on macOS and every root misses by one; drop it on Windows
// and every root misses by one. Both produce an empty list, and an empty list
// is also the honest answer for a machine that has no Chrome. So a bug here
// never looks like a bug. It looks like a user who does not use Chrome, on a
// panel whose entire job is to say which browsers are watched.
//
// Arc is the exception that proves the rule: it keeps `User Data` under its own
// app-support directory on macOS, because Arc is Chromium shipped by people who
// did not inherit Chrome's macOS habit. It is the reason the macOS list is a
// table of paths rather than a directory name plus a formula.
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from "node:fs";
import { homedir } from "node:os";
import { posix as posixPath, win32 as winPath } from "node:path";

/**
 * Claude in Chrome's extension id, which is the same 32 characters in every
 * Chromium-family browser that can install it.
 *
 * A Chrome extension id is derived from the packing key, not from the store or
 * the browser, so Brave, Edge and Vivaldi all hold it under this exact name.
 * That is what makes a directory test sufficient here and what lets one
 * constant serve every row this module returns.
 */
export const CLAUDE_EXT_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/**
 * The directories inside a user-data root that are browsing profiles.
 *
 * `Default` and `Profile N` only. Chromium also keeps `Guest Profile` and
 * `System Profile` beside them on every install — the second exists before the
 * user has ever opened a window — and both carry a History file that never gets
 * a row. Reporting them would put two permanently empty entries on the panel of
 * every machine in the world and make "no browsing here yet" indistinguishable
 * from "this is not a profile at all".
 */
const PROFILE_DIR = /^(?:Default|Profile \d+)$/;

/**
 * The path rules a root is written in, read off the root itself.
 *
 * `profileDirs` and `hasExtension` take a path and no platform — they are handed
 * a root `browserRoots` already spelled — so the flavour has to come out of the
 * string. It matters more than it looks. POSIX `join` would answer
 * `C:\…\User Data/Default`, a mixed-separator path that Windows itself would
 * happily open, so nothing on a real machine would ever complain; but
 * `posixPath.basename` of that string is the WHOLE string, so `profile` would
 * come back as an absolute path instead of `Default` and every caller keying on
 * the profile name would miss. The failure only ever appears on the leg that
 * checks Windows from a Mac, which is every leg that exists for this module.
 *
 * Anchored at the front rather than sniffing for a backslash anywhere: a POSIX
 * directory may legally be named `Brave\Browser`, and every root built here is
 * absolute, so a drive letter or a UNC prefix is the entire test.
 */
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const flavourOf = p => (WINDOWS_ROOT.test(String(p)) ? winPath : posixPath);

/**
 * Whether `p` is a directory, answering false for everything else a real disk
 * can put there.
 *
 * Never throws, and that is the point rather than tidiness. This runs once per
 * candidate profile across every browser on the machine: one profile on a
 * disconnected network home, one `Default` that a sync tool left as a file, one
 * broken symlink into an unmounted volume would otherwise abort the whole walk
 * and take every other browser's profiles down with it.
 */
function isDirectory(p, statSync) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Every known Chromium-family user-data root for this platform, whether or not
 * it exists.
 *
 * Pure, and platform, environment and home are parameters, so the Windows and
 * Linux answers are checkable from a Mac — the same reason claudeCliCandidates()
 * takes them. Deliberately does NOT stat anything: "which browsers could be
 * here" and "which are" are separate questions, and keeping the first one pure
 * is what lets a test assert the whole table without a disk of any kind.
 *
 * `key` is the stable identifier the rest of Browser Watch keys rows on; `name`
 * is the string a human reads. They are separate because Brave's directory is
 * `Brave-Browser` on one platform and `com.brave.Browser` on another, and no
 * panel should ever show either.
 */
export function browserRoots(platform = process.platform, env = process.env, home = homedir()) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host: node's `join`
  // emits forward slashes when the Windows table is built on a Mac, which is
  // both wrong for the caller and invisible in a test that only compares
  // against a string it built the same wrong way.
  const path = platform === "win32" ? winPath : posixPath;

  if (platform === "darwin") {
    // No `User Data` anywhere in here except Arc. See the module header.
    const support = path.join(home, "Library", "Application Support");
    return [
      { key: "chrome",        name: "Google Chrome",        root: path.join(support, "Google", "Chrome") },
      { key: "chrome-beta",   name: "Google Chrome Beta",   root: path.join(support, "Google", "Chrome Beta") },
      { key: "chrome-canary", name: "Google Chrome Canary", root: path.join(support, "Google", "Chrome Canary") },
      { key: "chromium",      name: "Chromium",             root: path.join(support, "Chromium") },
      { key: "brave",         name: "Brave",                root: path.join(support, "BraveSoftware", "Brave-Browser") },
      { key: "edge",          name: "Microsoft Edge",       root: path.join(support, "Microsoft Edge") },
      { key: "vivaldi",       name: "Vivaldi",              root: path.join(support, "Vivaldi") },
      { key: "arc",           name: "Arc",                  root: path.join(support, "Arc", "User Data") },
    ];
  }

  if (platform === "win32") {
    // %LOCALAPPDATA% rather than a path under the home directory, because a
    // roaming profile puts AppData\Roaming on a network share while Local stays
    // on the machine — the same reason claudeCliCandidates() reads %APPDATA%.
    // An empty value is what a broken login script leaves behind, not a
    // relative path anybody means, so it falls back rather than joining onto "".
    const local = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return [
      { key: "chrome",      name: "Google Chrome",      root: path.join(local, "Google", "Chrome", "User Data") },
      { key: "chrome-beta", name: "Google Chrome Beta", root: path.join(local, "Google", "Chrome Beta", "User Data") },
      // Canary is `Chrome SxS` here and `Chrome Canary` on macOS — the same
      // channel under two names, because the Windows installer has always used
      // the side-by-side codename. Spelling it the macOS way finds nothing, and
      // finding nothing is this module's indistinguishable failure. Linux has
      // no Canary channel at all, which is why the third table has no such row.
      { key: "chrome-canary", name: "Google Chrome Canary", root: path.join(local, "Google", "Chrome SxS", "User Data") },
      { key: "chromium",    name: "Chromium",           root: path.join(local, "Chromium", "User Data") },
      { key: "brave",       name: "Brave",              root: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { key: "edge",        name: "Microsoft Edge",     root: path.join(local, "Microsoft", "Edge", "User Data") },
      { key: "vivaldi",     name: "Vivaldi",            root: path.join(local, "Vivaldi", "User Data") },
    ];
  }

  // Linux, and every other POSIX that is not macOS. Falling through rather than
  // testing for "linux" is deliberate: a deck on FreeBSD gets the XDG layout,
  // which is the one its Chromium package actually uses, instead of nothing.
  //
  // XDG_CONFIG_HOME is honoured because Chromium honours it — it is where the
  // browser itself puts the directory, not a preference of ours — and trimmed
  // and truthiness-tested for the reason codexHome() spells out: an empty
  // variable is a shell accident, and joining onto it yields a CWD-relative
  // path that would have the deck reading profiles out of wherever it was
  // started from.
  const config = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return [
    { key: "chrome",         name: "Google Chrome",       root: path.join(config, "google-chrome") },
    { key: "chrome-beta",    name: "Google Chrome Beta",  root: path.join(config, "google-chrome-beta") },
    { key: "chromium",       name: "Chromium",            root: path.join(config, "chromium") },
    { key: "brave",          name: "Brave",               root: path.join(config, "BraveSoftware", "Brave-Browser") },
    { key: "edge",           name: "Microsoft Edge",      root: path.join(config, "microsoft-edge") },
    { key: "vivaldi",        name: "Vivaldi",             root: path.join(config, "vivaldi") },
    // Snap and Flatpak confine the browser to a private filesystem, so their
    // profiles are NOT under XDG_CONFIG_HOME and never appear in the six above.
    // On Ubuntu this is not an edge case: `chromium` from the archive has been
    // a snap-only transitional package for years, so the snap path is the only
    // Chromium root a default Ubuntu install has.
    { key: "chromium-snap",  name: "Chromium (snap)",     root: path.join(home, "snap", "chromium", "common", "chromium") },
    { key: "brave-flatpak",  name: "Brave (Flatpak)",     root: path.join(home, ".var", "app", "com.brave.Browser", "config", "BraveSoftware", "Brave-Browser") },
  ];
}

/** Where a profile name sits in the browser's own numbering; `Default` is first. */
const profileIndex = name => (name === "Default" ? -1 : Number(name.slice("Profile ".length)));

/**
 * The profile directories that actually exist inside `root`, `Default` first
 * and then `Profile N` in numeric order.
 *
 * A root that is absent, unreadable, or a file is not an error — it is the
 * ordinary state of five of the eight roots on any real machine — so it answers
 * with an empty list and the caller moves on.
 *
 * THE SORT IS NUMERIC ON PURPOSE. readdir returns whatever order the filesystem
 * feels like, and the obvious repair — a plain `.sort()` — puts `Profile 10`
 * between `Profile 1` and `Profile 2`. Nothing breaks visibly; the panel just
 * lists a user's profiles in an order that changes meaning as soon as they
 * create their tenth, which is the sort of wrongness nobody reports and
 * everybody notices.
 */
export function profileDirs(root, { readdirSync = fsReaddirSync, statSync = fsStatSync } = {}) {
  const path = flavourOf(root);
  let names;
  try { names = readdirSync(root); } catch { return []; }
  return names
    .map(String)
    .filter(name => PROFILE_DIR.test(name))
    // `Default` is profile zero in everything but its name, and it sorts ahead
    // of `Profile 1` here rather than by luck of the alphabet.
    .sort((a, b) => profileIndex(a) - profileIndex(b))
    .map(name => path.join(root, name))
    .filter(dir => isDirectory(dir, statSync));
}

/**
 * Whether this profile has the extension's payload on disk.
 *
 * Chromium unpacks an extension to `Extensions/<id>/<version>/`, one directory
 * per profile, so the id directory is the cheap and complete answer to "is it
 * installed here" — one stat per profile, at boot, across every browser found.
 *
 * It deliberately does NOT answer "is it enabled". That state lives in Secure
 * Preferences, which is signed against the profile and is another part of this
 * feature's job; conflating the two here would mean parsing a several-megabyte
 * JSON file per profile to answer a question this function is not being asked.
 */
export function hasExtension(profileDir, extId = CLAUDE_EXT_ID, { existsSync = fsExistsSync } = {}) {
  const path = flavourOf(profileDir);
  return existsSync(path.join(profileDir, "Extensions", extId));
}

/**
 * Every browsing profile on this machine, with the two files Browser Watch
 * reads and whether Claude in Chrome is installed in it.
 *
 * A PROFILE WITHOUT THE EXTENSION IS REPORTED, NOT DROPPED. "You have Brave
 * here and the extension is not in it" is the one sentence on this panel that
 * gets somebody unstuck, and it can only be said by a row that exists. Filtering
 * to extension-carrying profiles would make an un-extended browser look exactly
 * like an absent one — the same indistinguishable-from-nothing failure the
 * `User Data` trap produces, arrived at on purpose.
 *
 * A ROOT WITH NO PROFILES CONTRIBUTES NOTHING, which is not the same thing. On
 * the machine this was written against, Edge, Vivaldi, Chromium and Arc all have
 * a root and no profile inside it — installed, or merely left behind by an
 * uninstall — and a row for one of them would point the History reader at a
 * path that will never exist.
 */
export function discoverProfiles(platform = process.platform, env = process.env, home = homedir(), deps = {}) {
  const profiles = [];
  for (const { key, name, root } of browserRoots(platform, env, home)) {
    // Read off the root rather than off `platform`, so the two can never
    // disagree about which separator this row's paths are spelled with.
    const path = flavourOf(root);
    for (const dir of profileDirs(root, deps)) {
      profiles.push({
        browser: key,
        name,
        profile: path.basename(dir),
        dir,
        historyPath: path.join(dir, "History"),
        securePrefsPath: path.join(dir, "Secure Preferences"),
        hasClaudeExt: hasExtension(dir, CLAUDE_EXT_ID, deps),
      });
    }
  }
  return profiles;
}
