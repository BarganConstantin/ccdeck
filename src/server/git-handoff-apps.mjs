// Which git client, editor and terminal this machine has, for the git view's
// hand-off buttons: open the session's folder in Fork, in an editor, or in a
// terminal. Nothing here launches anything — git-handoff-launch.mjs builds the
// command line and git-handoff-routes.mjs runs it.
//
// FOUND BY LOOKING WHERE THEY INSTALL, never by asking another program. macOS
// apps are bundles in /Applications or ~/Applications (no Spotlight, which can
// be off and is slow when it is not), Windows apps sit at the folders their
// installers use (no registry walk, which would mean spawning `reg`), and Linux
// tools are on PATH or at the handful of fixed places packages and snaps put
// them. A miss only hides a button, so the lists lean towards the common
// installs rather than every possible one.
//
// Every filesystem question goes through `exists` and `readdir`, injected, and
// the platform, the environment and the home folder are parameters, so each
// OS's answer is testable from any other. The checks are asynchronous: a PATH
// entry on a network drive that has gone away can take seconds to answer a
// stat on Windows, and the deck's event loop must not wait for it.
import { lstat, readdir as readDirectory } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { candidates } from "./exec-spec.mjs";

/** The three buttons, in the order they are drawn. */
export const SLOTS = Object.freeze(["git", "editor", "terminal"]);

// ── where things install ────────────────────────────────────────────────────

/** A macOS app bundle, in the system's Applications folder or the user's. */
const macApp = (...names) => (ctx) => names.flatMap((n) => [
  { kind: "app", path: `/Applications/${n}.app` },
  { kind: "app", path: posix.join(ctx.home, "Applications", `${n}.app`) },
]);

/** A command-line tool inside a macOS bundle, in either Applications folder:
 *  the launcher a vendor ships for its app, found where the app is. */
const macTool = (name, rel) => (ctx) => ["/Applications", posix.join(ctx.home, "Applications")]
  .map((dir) => ({ kind: "exe", path: posix.join(dir, `${name}.app`, rel) }));

/** A command on PATH. */
const onPath = (...names) => () => names.map((name) => ({ kind: "path", name }));

/** Fixed POSIX paths; a leading `~/` is the user's home. */
const fixed = (...paths) => (ctx) => paths.map((p) => ({
  kind: "exe",
  path: p.startsWith("~/") ? posix.join(ctx.home, p.slice(2)) : p,
}));

/** Windows paths under one of the folders the environment names. A folder the
 *  environment does not name yields nothing rather than a relative path. */
const winUnder = (envName, ...rel) => (ctx) => {
  const base = ctx.env[envName];
  return typeof base === "string" && base ? rel.map((r) => ({ kind: "exe", path: win32.join(base, r) })) : [];
};

const both = (...gens) => async (ctx) => (await Promise.all(gens.map((g) => g(ctx)))).flat();

// JetBrains IDEs: one entry per product, all in the editor slot. Their Linux
// launchers come from the Toolbox (a script per product in its `scripts`
// folder), from snaps, or from a launcher somebody put on PATH; on macOS the
// bundle; on Windows the Toolbox's `.cmd` scripts or a standalone install under
// Program Files\JetBrains\<product and version>\bin.
const JETBRAINS = [
  // `intellij-idea` is the snap of the single IntelliJ IDEA that replaced the
  // two editions in 2025.3; "Community Edition" is the Toolbox's bundle name
  // for the free edition, "CE" the download's.
  { id: "idea", name: "IntelliJ IDEA", launchers: ["idea", "intellij-idea", "intellij-idea-ultimate", "intellij-idea-community"], apps: ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"], dir: "IntelliJ IDEA", exe: "idea64.exe" },
  { id: "webstorm", name: "WebStorm", launchers: ["webstorm"], apps: ["WebStorm"], dir: "WebStorm", exe: "webstorm64.exe" },
  { id: "pycharm", name: "PyCharm", launchers: ["pycharm", "pycharm-professional", "pycharm-community"], apps: ["PyCharm", "PyCharm Professional Edition", "PyCharm CE", "PyCharm Community Edition"], dir: "PyCharm", exe: "pycharm64.exe" },
  { id: "goland", name: "GoLand", launchers: ["goland"], apps: ["GoLand"], dir: "GoLand", exe: "goland64.exe" },
  { id: "rider", name: "Rider", launchers: ["rider"], apps: ["Rider"], dir: ["JetBrains Rider", "Rider"], exe: "rider64.exe" },
  { id: "clion", name: "CLion", launchers: ["clion"], apps: ["CLion"], dir: "CLion", exe: "clion64.exe" },
  { id: "phpstorm", name: "PhpStorm", launchers: ["phpstorm"], apps: ["PhpStorm"], dir: "PhpStorm", exe: "phpstorm64.exe" },
  { id: "rubymine", name: "RubyMine", launchers: ["rubymine"], apps: ["RubyMine"], dir: "RubyMine", exe: "rubymine64.exe" },
  { id: "rustrover", name: "RustRover", launchers: ["rustrover"], apps: ["RustRover"], dir: "RustRover", exe: "rustrover64.exe" },
];

/** The product folders under `base` whose name starts with `prefix` — a
 *  standalone JetBrains install is `<product> <version>`, so the folder name is
 *  not known in advance. Newest version first, by name. */
async function versionedDirs(ctx, base, prefix) {
  if (typeof base !== "string" || !base) return [];
  let names = [];
  try { names = await ctx.readdir(base); } catch { return []; }
  return names
    .filter((n) => typeof n === "string" && (n === prefix || n.startsWith(`${prefix} `)))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((n) => win32.join(base, n));
}

function jetbrainsProbes(p) {
  return {
    darwin: both(
      macApp(...p.apps),
      fixed(...p.launchers.map((l) => `~/Library/Application Support/JetBrains/Toolbox/scripts/${l}`)),
    ),
    linux: both(
      fixed(...p.launchers.map((l) => `~/.local/share/JetBrains/Toolbox/scripts/${l}`)),
      fixed(...p.launchers.map((l) => `/snap/bin/${l}`)),
      onPath(...p.launchers),
    ),
    win32: async (ctx) => {
      // Executables before the Toolbox's `.cmd` scripts: a batch file has to go
      // through cmd.exe, which git-handoff-launch.mjs allows only for folders it
      // can quote safely.
      const out = [];
      const dirs = Array.isArray(p.dir) ? p.dir : [p.dir];
      const roots = [
        ctx.env.LOCALAPPDATA && win32.join(ctx.env.LOCALAPPDATA, "Programs"),
        ctx.env.ProgramFiles && win32.join(ctx.env.ProgramFiles, "JetBrains"),
      ];
      for (const root of roots) {
        for (const prefix of dirs) {
          for (const d of await versionedDirs(ctx, root, prefix)) out.push({ kind: "exe", path: win32.join(d, "bin", p.exe) });
        }
      }
      if (ctx.env.LOCALAPPDATA) {
        for (const l of p.launchers) out.push({ kind: "exe", path: win32.join(ctx.env.LOCALAPPDATA, "JetBrains", "Toolbox", "scripts", `${l}.cmd`) });
      }
      return out;
    },
  };
}

/**
 * Every app the buttons know, slot by slot, each slot in the order the default
 * is chosen from: the first one found wins until somebody picks another in
 * Settings. Fork first because it is the client this view is modelled on; VS
 * Code first because it is the editor most people have.
 *
 * `name` is what the button and the Settings list say. `needsTerminal` marks
 * the one entry that is not a window of its own — lazygit runs inside the
 * terminal slot's app, except on Windows, where it gets a console of its own.
 */
export const CATALOGUE = Object.freeze([
  // git clients
  // On macOS through the command line tool each app installs (`fork`,
  // `gittower`), which is a link to the file inside its bundle; the bundle is
  // only the fallback. Fork opened by `open -a` with a folder crashes when it is
  // not already running (github.com/fork-dev/Tracker/issues/2468), and Tower's
  // bundle claims no folders at all. On Windows both are Velopack installs,
  // per user: %LOCALAPPDATA%\<app>\current\<app>.exe with a stub of the same
  // name beside current\ (docs.velopack.io/packaging/installer).
  { id: "fork", slot: "git", name: "Fork", probes: {
    darwin: both(macTool("Fork", "Contents/Resources/fork_cli"), macApp("Fork")),
    win32: winUnder("LOCALAPPDATA", "Fork\\Fork.exe", "Fork\\current\\Fork.exe"),
  } },
  { id: "tower", slot: "git", name: "Tower", probes: {
    darwin: both(macTool("Tower", "Contents/MacOS/gittower"), macApp("Tower")),
    win32: winUnder("LOCALAPPDATA", "Tower\\current\\Tower.exe", "Tower\\Tower.exe"),
  } },
  { id: "sublime-merge", slot: "git", name: "Sublime Merge", probes: {
    darwin: macApp("Sublime Merge"),
    linux: both(onPath("smerge"), fixed("/opt/sublime_merge/sublime_merge", "/snap/bin/sublime-merge")),
    win32: winUnder("ProgramFiles", "Sublime Merge\\smerge.exe"),
  } },
  { id: "gitkraken", slot: "git", name: "GitKraken", probes: {
    darwin: macApp("GitKraken"),
    linux: both(onPath("gitkraken"), fixed("/usr/share/gitkraken/gitkraken", "/snap/bin/gitkraken")),
    win32: winUnder("LOCALAPPDATA", "gitkraken\\gitkraken.exe"),
  } },
  { id: "github-desktop", slot: "git", name: "GitHub Desktop", probes: {
    darwin: macApp("GitHub Desktop"),
    win32: winUnder("LOCALAPPDATA", "GitHubDesktop\\GitHubDesktop.exe"),
  } },
  { id: "lazygit", slot: "git", name: "lazygit", needsTerminal: true, probes: {
    darwin: both(onPath("lazygit"), fixed("/opt/homebrew/bin/lazygit", "/usr/local/bin/lazygit", "/opt/local/bin/lazygit", "~/go/bin/lazygit")),
    linux: both(onPath("lazygit"), fixed("~/.local/bin/lazygit", "~/go/bin/lazygit", "/snap/bin/lazygit")),
    win32: both(onPath("lazygit"), winUnder("LOCALAPPDATA", "Microsoft\\WinGet\\Links\\lazygit.exe")),
  } },

  // editors
  { id: "vscode", slot: "editor", name: "VS Code", probes: {
    darwin: macApp("Visual Studio Code"),
    linux: both(fixed("/usr/share/code/bin/code", "/snap/bin/code"), onPath("code")),
    win32: both(
      winUnder("LOCALAPPDATA", "Programs\\Microsoft VS Code\\Code.exe"),
      winUnder("ProgramFiles", "Microsoft VS Code\\Code.exe"),
    ),
  } },
  { id: "cursor", slot: "editor", name: "Cursor", probes: {
    darwin: macApp("Cursor"),
    linux: both(onPath("cursor"), fixed("/usr/share/cursor/bin/cursor", "/opt/cursor/cursor")),
    // The user installer, then the system one, which puts it under Program
    // Files by the same folder name, as VS Code's installer does.
    win32: both(
      winUnder("LOCALAPPDATA", "Programs\\cursor\\Cursor.exe"),
      winUnder("ProgramFiles", "cursor\\Cursor.exe"),
    ),
  } },
  { id: "zed", slot: "editor", name: "Zed", probes: {
    darwin: macApp("Zed"),
    linux: both(onPath("zed", "zeditor", "zedit", "zed-editor"), fixed("~/.local/bin/zed")),
    // Zed's installer is per user only (PrivilegesRequired=lowest,
    // {autopf}\Zed in crates/zed/resources/windows/zed.iss), its command line
    // tool in bin\ beside Zed.exe.
    win32: both(onPath("zed"), winUnder("LOCALAPPDATA", "Programs\\Zed\\Zed.exe")),
  } },
  ...JETBRAINS.map((p) => ({ id: p.id, slot: "editor", name: p.name, jetbrains: true, probes: jetbrainsProbes(p) })),
  { id: "sublime-text", slot: "editor", name: "Sublime Text", probes: {
    darwin: macApp("Sublime Text"),
    linux: both(onPath("subl"), fixed("/opt/sublime_text/sublime_text", "/snap/bin/subl")),
    win32: both(
      winUnder("ProgramFiles", "Sublime Text\\subl.exe", "Sublime Text 3\\subl.exe"),
      winUnder("ProgramFiles(x86)", "Sublime Text\\subl.exe"),
    ),
  } },

  // terminals: the system's own first on each OS
  { id: "terminal", slot: "terminal", name: "Terminal", probes: {
    darwin: () => [
      { kind: "app", path: "/System/Applications/Utilities/Terminal.app" },
      { kind: "app", path: "/Applications/Utilities/Terminal.app" },
    ],
  } },
  { id: "iterm", slot: "terminal", name: "iTerm", probes: { darwin: macApp("iTerm") } },
  { id: "windows-terminal", slot: "terminal", name: "Windows Terminal", probes: {
    win32: winUnder("LOCALAPPDATA", "Microsoft\\WindowsApps\\wt.exe"),
  } },
  { id: "pwsh", slot: "terminal", name: "PowerShell 7", probes: {
    win32: both(winUnder("ProgramFiles", "PowerShell\\7\\pwsh.exe"), onPath("pwsh")),
  } },
  { id: "powershell", slot: "terminal", name: "Windows PowerShell", probes: {
    win32: winUnder("SystemRoot", "System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
  } },
  { id: "x-terminal-emulator", slot: "terminal", name: "System terminal", probes: {
    linux: both(fixed("/usr/bin/x-terminal-emulator"), onPath("x-terminal-emulator")),
  } },
  { id: "gnome-terminal", slot: "terminal", name: "GNOME Terminal", probes: { linux: both(fixed("/usr/bin/gnome-terminal"), onPath("gnome-terminal")) } },
  { id: "ptyxis", slot: "terminal", name: "Ptyxis", probes: { linux: both(fixed("/usr/bin/ptyxis"), onPath("ptyxis")) } },
  { id: "konsole", slot: "terminal", name: "Konsole", probes: { linux: both(fixed("/usr/bin/konsole"), onPath("konsole")) } },
  { id: "ghostty", slot: "terminal", name: "Ghostty", probes: {
    darwin: macApp("Ghostty"),
    linux: both(fixed("/usr/bin/ghostty", "/snap/bin/ghostty"), onPath("ghostty")),
  } },
  { id: "kitty", slot: "terminal", name: "kitty", probes: { linux: both(onPath("kitty"), fixed("~/.local/kitty.app/bin/kitty")) } },
  { id: "wezterm", slot: "terminal", name: "WezTerm", probes: {
    darwin: macApp("WezTerm"),
    linux: both(onPath("wezterm"), fixed("/usr/bin/wezterm", "/snap/bin/wezterm")),
  } },
  { id: "alacritty", slot: "terminal", name: "Alacritty", probes: { linux: both(onPath("alacritty"), fixed("/usr/bin/alacritty", "/snap/bin/alacritty")) } },
]);

const KNOWN = new Map(CATALOGUE.map((a) => [a.id, a]));

/** The catalogue entry for `id`, or undefined. */
export const appInfo = (id) => KNOWN.get(id);

// ── looking ─────────────────────────────────────────────────────────────────

/** Whether anything is at `p`, for detection and for the route's look before a
 *  launch alike. lstat rather than stat: Windows Terminal's `wt.exe` is an app
 *  execution alias, a reparse point that stat refuses with EACCES
 *  (github.com/nodejs/node/issues/36790) but CreateProcess runs, and a broken
 *  symlink is still something to report and let the launch fail on with its
 *  own message. */
export async function pathExists(p) {
  try { await lstat(p); return true; } catch { return false; }
}

/** The first directory on PATH holding `name` (under each of the Windows
 *  spellings `candidates` offers), as an absolute path, or null. The walk
 *  pathLookup in exec-spec.mjs does, asynchronous. */
async function lookPath(name, ctx) {
  const win = ctx.platform === "win32";
  const sep = win ? "\\" : "/";
  const raw = ctx.env.PATH ?? ctx.env.Path ?? "";
  const dirs = String(raw).split(win ? ";" : ":")
    .map((d) => d.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, ""))
    // Only absolute entries. A relative one (`.`, `bin`) would resolve against
    // the deck's own working directory — the planted-binary case exec.mjs's
    // NoDefaultCurrentDirectoryInExePath note is about.
    .filter((d) => (win ? win32.isAbsolute(d) : d.startsWith("/")));
  for (const dir of dirs) {
    for (const spelling of candidates(name, ctx.platform)) {
      // A bare spelling on Windows is not something CreateProcess runs.
      if (win && !/\.(exe|cmd|bat)$/i.test(spelling)) continue;
      const full = `${dir}${sep}${spelling}`;
      if (await ctx.exists(full)) return full;
    }
  }
  return null;
}

/** The first probe of `entry` that answers on this machine, as
 *  `{ kind: "app" | "exe", path }`, or null. */
async function resolveEntry(entry, ctx) {
  const probe = entry.probes[ctx.platform];
  if (!probe) return null;
  let list = [];
  try { list = await probe(ctx); } catch { return null; }
  for (const c of list) {
    if (c.kind === "path") {
      const found = await lookPath(c.name, ctx);
      if (found) return { kind: "exe", path: found };
    } else if (typeof c.path === "string" && c.path && await ctx.exists(c.path)) {
      return { kind: c.kind, path: c.path };
    }
  }
  return null;
}

/** On a KDE desktop its own terminal is the system's when Debian's alternative
 *  is not there to say otherwise; everywhere else the catalogue's order. */
function terminalOrder(found, ctx) {
  if (ctx.platform !== "linux") return found;
  const desktop = String(ctx.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase();
  if (!desktop.includes("KDE")) return found;
  const konsole = found.find((a) => a.id === "konsole");
  if (!konsole) return found;
  const rest = found.filter((a) => a !== konsole);
  const at = rest[0]?.id === "x-terminal-emulator" ? 1 : 0;
  return [...rest.slice(0, at), konsole, ...rest.slice(at)];
}

/**
 * Every app of the catalogue this machine has, in preference order within each
 * slot: `[{ id, slot, name, target: { kind, path } }]`. lazygit is listed only
 * when there is a terminal for it to run in (or on Windows, where it opens a
 * console of its own).
 */
export async function detectApps({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = pathExists,
  readdir = (p) => readDirectory(p),
} = {}) {
  const ctx = { platform, env: env ?? {}, home: String(home ?? ""), exists, readdir };
  const resolved = await Promise.all(CATALOGUE.map(async (entry) => {
    const target = await resolveEntry(entry, ctx);
    return target ? { id: entry.id, slot: entry.slot, name: entry.name, target } : null;
  }));
  let found = resolved.filter(Boolean);
  const terminals = terminalOrder(found.filter((a) => a.slot === "terminal"), ctx);
  if (!terminals.length && platform !== "win32") found = found.filter((a) => a.id !== "lazygit");
  return [...found.filter((a) => a.slot !== "terminal"), ...terminals];
}

/**
 * The app a slot's button opens: the one picked in Settings while it is still
 * on this machine, else the first found. Null when the slot has none.
 */
export function chooseApp(found, slot, pick) {
  const inSlot = (found ?? []).filter((a) => a.slot === slot);
  return inSlot.find((a) => a.id === pick) ?? inSlot[0] ?? null;
}
