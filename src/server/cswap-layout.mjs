// Where claude-swap lives on disk: every place its installers are known to
// leave the `cswap` executable, and which installer owns the copy this machine
// actually runs.
//
// Nothing here spawns anything. What the two answers depend on — the platform,
// the environment, the home directory, a directory listing, whether a path
// exists — arrives as a parameter with the real one as its default, because a
// Windows layout has to be checkable from a Mac: these lists exist entirely for
// machines the author is not sitting at. cswap-install.mjs resolves the binary
// against cswapCandidates and aims its daily upgrade with cswapOwner.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";
import { homedir } from "node:os";

// The distribution name, which is what both installers key their directories on
// — `cswap` is only the console script.
export const PKG = "claude-swap";

/**
 * The subdirectories of `dir`, newest-looking first, or [] when it cannot be
 * read at all.
 *
 * Injected into cswapCandidates below rather than called from it, for the reason
 * the platform is a parameter there: a Windows layout has to be describable from
 * a Mac. A missing directory, a disconnected network drive and a profile the
 * process cannot read are all the same answer — nothing here — never a throw,
 * because this runs unprompted at startup for an optional panel.
 *
 * The sort is numeric so `Python313` sorts above `Python39` rather than below
 * it: when two interpreters both have a cswap, the newer one is the one the user
 * most likely installed it with, and the order this returns is the order the
 * caller probes in.
 *
 * Exported for its test rather than for a caller. Every part of it that can be
 * wrong — which names count as an interpreter, what order they come back in,
 * what a directory that cannot be read answers — is invisible from
 * cswapCandidates, which injects a substitute precisely so its own Windows
 * layout can be checked from a Mac. Driven against real directories in
 * cswap-admin.test.ts, on whichever OS is running the suite.
 */
export function pythonVersionDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name)
      // `Python312`, and the tagged builds the installer also writes:
      // `Python312-32`, `Python313-arm64`.
      .filter(n => /^Python\d[\w.-]*$/i.test(n))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  } catch {
    return [];
  }
}

/**
 * Every place an installer is known to leave cswap. The platform is a parameter
 * and the directory listing is injected, so the Windows list can be checked from
 * a Mac — which is the only way this list stays right, since it exists entirely
 * for machines the author is not sitting at.
 */
export function cswapCandidates(platform = process.platform, env = process.env, home = homedir(), {
  versionDirs = pythonVersionDirs,
} = {}) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host: node's `join`
  // would emit forward slashes when this is exercised from a Mac, which is both
  // wrong for the caller and invisible in a test.
  const { join } = platform === "win32" ? winPath : posixPath;
  const exe = platform === "win32" ? "cswap.exe" : "cswap";
  const dirs = [];
  // Explicit configuration first: someone who set these means them.
  if (env.UV_TOOL_BIN_DIR) dirs.push(env.UV_TOOL_BIN_DIR);
  if (env.XDG_BIN_HOME) dirs.push(env.XDG_BIN_HOME);
  // Where `uv tool install` and `pipx install` put executables, everywhere.
  dirs.push(join(home, ".local", "bin"));
  if (platform === "win32") {
    // pipx before 1.5, and any `pip install --user`. APPDATA is respected when
    // set because a roaming profile moves it off the home directory.
    //
    // THE VERSION SEGMENT IS NOT OPTIONAL (#552). CPython on Windows always
    // puts the interpreter between the root and `Scripts`:
    //
    //     %APPDATA%\Python\Python312\Scripts               pip install --user
    //     %LOCALAPPDATA%\Programs\Python\Python312\Scripts per-user installer
    //
    // — `{userbase}\Python{version_nodot}\Scripts` is sysconfig's `nt_user`
    // scheme, not a convention. The two paths this used to build omitted it, so
    // NEITHER could exist on a real machine: every candidate missed,
    // `cswapVersion` answered null, `ensureCswap` reported `not_on_path`, and
    // the deck re-ran a whole install attempt on every launch for a user who
    // already had cswap.exe sitting there. The POSIX side never had the bug —
    // `~/.local/bin` carries no version — which is why this stayed a Windows
    // false negative in the one function whose whole purpose is to not depend
    // on PATH.
    //
    // Which versions exist is a fact about the machine, so it is read rather
    // than guessed: enumerating Python38…Python315 would be eight wrong paths
    // and a ninth wrong one next year.
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    for (const root of [join(appData, "Python"), join(localAppData, "Programs", "Python")]) {
      for (const version of versionDirs(root)) dirs.push(join(root, version, "Scripts"));
    }
    dirs.push(join(home, "scoop", "shims"));
  } else {
    dirs.push(join(home, ".pyenv", "shims"));
    // uv keeps the tool's own venv here and only symlinks into ~/.local/bin; if
    // that link was never made, this is still a working executable.
    dirs.push(join(home, ".local", "share", "uv", "tools", "claude-swap", "bin"));
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs.map(d => join(d, exe));
}

/** True when `child` is `dir` or lives under it, in `platform`'s path flavour. */
function underDir(child, dir, platform) {
  const { sep, normalize } = platform === "win32" ? winPath : posixPath;
  const norm = p => {
    // Windows paths compare case-insensitively, and `C:\x\` and `C:\x` are one
    // directory.
    let s = normalize(String(p));
    if (platform === "win32") s = s.toLowerCase();
    return s.length > 1 && s.endsWith(sep) ? s.slice(0, -sep.length) : s;
  };
  const c = norm(child), d = norm(dir);
  return c === d || c.startsWith(d + sep);
}

/**
 * Where `uv tool install claude-swap` puts the tool's own venv.
 *
 * UV_TOOL_DIR wins outright; otherwise uv's persistent data directory, which is
 * `$XDG_DATA_HOME/uv` or `~/.local/share/uv` on Unix — macOS included, uv does
 * not use `~/Library` — and `%APPDATA%\uv\data` on Windows. The `data` segment
 * is Windows-only and is not optional there.
 */
function uvToolVenvs(platform, env, home) {
  const { join } = platform === "win32" ? winPath : posixPath;
  if (env.UV_TOOL_DIR) return [join(env.UV_TOOL_DIR, PKG)];
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return [join(appData, "uv", "data", "tools", PKG)];
  }
  return [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "uv", "tools", PKG)];
}

/**
 * Where `pipx install claude-swap` puts the package's venv.
 *
 * Read off pipx's own `paths.py`: the venvs are always `<home>/venvs`, and the
 * home is PIPX_HOME when set, else the first EXISTING legacy fallback
 * (`~/.local/pipx`, plus `~/pipx` on Windows), else platformdirs'
 * `user_data_path("pipx")`. Since what gets asked here is whether one specific
 * venv is on disk, every candidate home can simply be tried rather than
 * replaying pipx's precedence.
 *
 * platformdirs on Windows appends the app name twice when no author is given,
 * which pipx does not give — `%LOCALAPPDATA%\pipx\pipx`, not `%LOCALAPPDATA%\
 * pipx`. That doubled segment is real and is the whole path on a modern
 * Windows pipx.
 */
function pipxVenvs(platform, env, home) {
  const { join } = platform === "win32" ? winPath : posixPath;
  if (env.PIPX_HOME) return [join(env.PIPX_HOME, "venvs", PKG)];
  const homes = [join(home, ".local", "pipx")];
  if (platform === "win32") {
    homes.push(join(home, "pipx"));
    homes.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "pipx", "pipx"));
  } else if (platform === "darwin") {
    homes.push(join(home, "Library", "Application Support", "pipx"));
  } else {
    homes.push(join(env.XDG_DATA_HOME || join(home, ".local", "share"), "pipx"));
  }
  return homes.map(h => join(h, "venvs", PKG));
}

function realpathOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Which installer OWNS the claude-swap this machine runs — "uv", "pipx", or
 * null when nothing offered here does, or when the evidence is ambiguous.
 *
 * The daily upgrade used to be handed to `findInstaller()`, which returns the
 * first tool that answers `--version`. That is the right question when choosing
 * something to install WITH and the wrong one when upgrading something already
 * installed: on a machine with uv present and claude-swap installed some other
 * way — a `pip install --user` copy, which #574 taught cswapBin to find, or a
 * pipx one — the upgrade went to uv, which answers
 *
 *     error: Failed to upgrade claude-swap
 *       Caused by: `claude-swap` is not installed; run `uv tool install …`
 *
 * and pipx, given someone else's package, answers "Package is not installed.
 * Expected to find <PIPX_HOME>/venvs/claude-swap, but it does not exist." Both
 * went through runDetached, which read no output and waited for no exit, so the
 * refusal reached nobody while ensureCswap still reported "upgrading" and the
 * marker was already burned for the day. The version never moved and the deck
 * said it was moving, every launch, forever. The upgrade is captured now (#1000)
 * and a refusal is at least written down — but aiming it correctly is still
 * this function's job, and a recorded failure is a worse outcome than one that
 * never had to happen.
 *
 * Two signals, strongest first. The executable the deck actually runs, with its
 * symlinks followed, sitting inside one installer's directory is decisive —
 * that is the POSIX case, where both installers link `~/.local/bin/cswap` at
 * their own venv. Windows copies the launcher instead, so there the layout
 * question is asked directly: exactly one of the two venv directories exists.
 * Zero means nothing offered here owns it — a `pip install --user` copy is the
 * common shape, and cswap-install.mjs's `installers()` deliberately refuses to
 * offer bare pip — and two means the machine has both and the resolved path did
 * not say which is on PATH. Both answer null, because a silent boot is better
 * than a daily sentence that is not true.
 *
 * Pure, and platform/env/home/filesystem all arrive as arguments, for the reason
 * cswapCandidates gives: a Windows layout has to be checkable from a Mac.
 */
export function cswapOwner(bin, platform = process.platform, env = process.env, home = homedir(), {
  exists = existsSync,
  realpath = realpathOrSelf,
} = {}) {
  const roots = [
    ...uvToolVenvs(platform, env, home).map(dir => ({ owner: "uv", dir })),
    ...pipxVenvs(platform, env, home).map(dir => ({ owner: "pipx", dir })),
  ];

  // cswapBin answers the bare word whenever PATH resolved it, and a bare word
  // points at no layout at all — only a path can be followed.
  if (typeof bin === "string" && /[\\/]/.test(bin)) {
    // BOTH sides get resolved, or the comparison is between two spellings of one
    // directory rather than between two directories. A symlinked home is the
    // ordinary way that happens — /var → /private/var on macOS, a network or
    // container-mounted profile on Linux — and it would silently turn the
    // strongest signal here into no signal at all.
    const real = realpath(bin);
    const hit = roots.find(r => underDir(real, realpath(r.dir), platform));
    if (hit) return hit.owner;
  }

  const owners = new Set(roots.filter(r => exists(r.dir)).map(r => r.owner));
  return owners.size === 1 ? [...owners][0] : null;
}
