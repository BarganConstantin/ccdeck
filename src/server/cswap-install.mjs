// Ensures `cswap` (claude-swap) is available, because the accounts panel is
// built entirely on the store it maintains.
//
// Unlike the ccusage install, this one lands in the user's GLOBAL tool path
// rather than a private prefix under ~/.agents-deck, and claude-swap handles
// Claude credentials. That makes it something the user should see happen: the
// caller prints what this returns, and AGENTS_DECK_NO_INSTALL=1 turns it off
// entirely. It is always best-effort — the deck's core function does not
// depend on it, so a failure is reported and then ignored.
import { run } from "./exec.mjs";
// The version comparator was written out here as well, identical apart from a
// type guard this copy lacked, and only the self-update one was under test
// (#374). No cycle: self-update.mjs imports node:* and ./exec.mjs, which this
// file already imports itself.
import { isOlder } from "./self-update.mjs";
import { bootstrapUv, existingBootstrappedUv } from "./uv-bootstrap.mjs";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, posix as posixPath, win32 as winPath } from "node:path";
import { homedir } from "node:os";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

// Same throttle the ccusage installer uses: check once a day, tracked by a
// marker file's mtime so the interval survives restarts.
const UPDATE_CHECK_MS = 24 * 3600_000;
const MARKER = join(homedir(), ".agents-deck", ".cswap-update-check");

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
 * How to invoke cswap: the bare name when PATH resolves it, otherwise an
 * absolute path to where its installers actually put it.
 *
 * ~/.local/bin is where both `uv tool install` and `pipx install` place
 * executables, on every platform, and it is famously not on PATH — that is the
 * whole reason `pipx ensurepath` exists. Installing claude-swap successfully
 * and then reporting it as missing because the shell cannot see it is a bad
 * enough outcome on its own; it is worse now that the deck may have done the
 * installing. So PATH is a convenience here, not the source of truth.
 *
 * Re-resolved when a lookup fails so an install during this process is picked
 * up without a restart.
 */
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

// The distribution name, which is what both installers key their directories on
// — `cswap` is only the console script.
const PKG = "claude-swap";

// ── which versions of it this deck is willing to install ─────────────────────
//
// The install used to be the bare name — `uv tool install claude-swap` — which
// means "whatever that project publishes next, forever", resolved on a machine
// the author will never see, and then handed `cswap export -`, `add` and
// `import`: every command in the accounts panel that carries a Claude refresh
// token. Forty lines away, uv itself is fetched only after its SHA-256 is
// checked against the one Astral publishes beside it (uv-bootstrap.mjs). The
// package that holds the credentials had no bound of any kind.
//
// FLOOR: the newest release at the time this bound was written, which is the
// version the accounts panel is developed and exercised against. It is NOT a
// claim that 0.25 would fail — nothing here has tested that, and a copy the
// user installed themselves is left alone whatever its number. What it says is
// that the deck has an opinion at all, so that a resolver answering an install
// with something much older — a stale mirror, a private index on
// PIP_INDEX_URL, a yank of everything newer — is answering a question the deck
// did not ask, and can be told so. Raise it deliberately, with claude-swap's
// release notes open.
//
// CEILING: the next major. claude-swap is 0.x and ships a minor every couple of
// weeks, so a ceiling tight enough to stop a hostile 0.27 would stop every real
// release too and rot within the month. What this ceiling does stop is the
// shape a takeover actually takes — a version number picked to win every
// resolution, `9.9.9` — and a 1.0 arriving unattended while the deck's caller
// list still speaks 0.x.
//
// Spelled `~=0.26` and not `>=0.26,<1`, which is the same set. PEP 440's
// compatible-release operator expands to `>= 0.26, == 0.*`, and the spelling
// with no `<` or `>` in it cannot be read as redirection by anything that ever
// sees this argument as text: `run` spawns with shell:false, but the Windows
// leg routes a `.cmd`/`.bat` shim through cmd.exe (exec.mjs viaCmd), where `<`
// and `>` are syntax while outside quotes. That quoting is correct and tested;
// not needing it is better.
// Dated for the reason uv-bootstrap.mjs dates its FALLBACK_VERSION: a floor
// rots silently. Nothing fails when it falls behind — it simply stops being the
// version anyone is developing against — so no test and no user will report it.
const MIN_VERSION = "0.26";                       // latest on PyPI as of 2026-09-15
const MAX_VERSION = "1";                          // the first one this deck will not run
const RANGE_SPEC  = `${PKG}~=${MIN_VERSION}`;     // >= 0.26, == 0.*

/**
 * True when `v` is a version this deck is willing to put in front of the user's
 * credentials.
 *
 * Deliberately false for anything without a leading number, which is what
 * `versionIn` answers ("installed") for a copy that printed no version at all.
 * That is an absence of evidence rather than evidence of a bad version, so the
 * two callers that can act on it check for it themselves rather than reading a
 * `false` here as a verdict.
 */
export function isAcceptableVersion(v) {
  if (typeof v !== "string" || !/^\d/.test(v)) return false;
  return !isOlder(v, MIN_VERSION) && isOlder(v, MAX_VERSION);
}

/** Two version strings naming the same release — `0.26` and `0.26.0` do. */
function sameVersion(a, b) { return !isOlder(a, b) && !isOlder(b, a); }

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
 * common shape, and `installers()` deliberately refuses to offer bare pip — and
 * two means the machine has both and the resolved path did not say which is on
 * PATH. Both answer null, because a silent boot is better than a daily sentence
 * that is not true.
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

let _bin = null;

/**
 * What the probe that resolved `_bin` printed, and when.
 *
 * #742: resolving the binary means running `cswap --version`, and reading the
 * version means running `cswap --version`. Those were two separate spawns of a
 * Python CLI a moment apart, and on this Mac each one costs between one and two
 * and a half seconds — which made a probe of an ALREADY INSTALLED claude-swap
 * the single largest thing in an ordinary boot.
 *
 * The second spawn is what this retires, and only the second: anything asking
 * later gets a fresh answer, because a version read once at boot is not a
 * version for the life of a deck that runs for days and may upgrade the tool
 * underneath itself. Five seconds is long enough to cover cswapBin handing
 * straight over to cswapVersion and far too short to be a cache.
 */
let _probe = null;
const PROBE_FRESH_MS = 5_000;

/** "claude-swap 0.25.0" → "0.25.0", and "installed" for a copy that answered
 *  without a number in it. Shared so the memo and the spawn cannot disagree. */
function versionIn(r) {
  const m = (r.stdout || r.stderr).trim().match(/(\d+\.\d+\.\d+\S*)/);
  return m ? m[1] : "installed";
}

export async function cswapBin() {
  // An explicit path wins over everything and is never cached away — someone
  // debugging a bad resolution needs it to take effect immediately.
  if (process.env.AGENTS_DECK_CSWAP) return process.env.AGENTS_DECK_CSWAP;
  if (_bin) return _bin;

  const take = (spelling, r) => {
    _probe = { version: versionIn(r), at: Date.now() };
    return (_bin = spelling);
  };

  const bare = await run("cswap", ["--version"], { timeout: 8_000 });
  if (bare.ok) return take("cswap", bare);

  for (const c of cswapCandidates()) {
    if (!existsSync(c)) continue;
    const r = await run(c, ["--version"], { timeout: 8_000 });
    if (r.ok) return take(c, r);
  }
  return "cswap";   // not found; leave the bare name so errors read sensibly
}

/**
 * Forget the cached resolution — call after installing.
 *
 * WHAT IS ACTUALLY STALE HERE (#383). Note that `cswapBin` above memoizes only
 * SUCCESS: the "not found" answer is the bare name returned without ever being
 * written to `_bin`, so a lookup that found nothing is already re-run on the
 * next call and there is no negative result for this to clear. What it clears is
 * a positive one — a path that resolved, was cached, and has since been
 * superseded. That is not hypothetical on the install path: `cswapVersion` runs
 * `--version` a SECOND time under the default timeout after `cswapBin` has
 * already cached the copy its own 8s probe accepted, so a copy that is present
 * but too slow, half-written or broken caches a path and still reports no
 * version — and the install that follows lands a working cswap somewhere the
 * cached path may not point at. Clearing is cheap; a deck driving the wrong
 * binary for the life of the process is not.
 *
 * Exported for its test rather than for a caller (#383): the one caller is
 * ensureCswap below, whose return value says nothing about which binary the
 * following twenty account operations will be sent to. See cswap-bin-memo.test.ts.
 */
export function resetCswapBin() { _bin = null; _probe = null; }

/** Installed version string, or null when cswap cannot be found. */
export async function cswapVersion() {
  const bin = await cswapBin();
  // The call above may have just asked this very question — see _probe. Nothing
  // is remembered past PROBE_FRESH_MS, so this is the second half of one
  // lookup rather than a cache of the answer.
  if (_probe && Date.now() - _probe.at < PROBE_FRESH_MS) return _probe.version;
  const r = await run(bin, ["--version"]);
  if (!r.ok) return null;
  return versionIn(r);
}

/**
 * Install claude-swap with whichever Python tool installer is present.
 *
 * `uv` first because it is what claude-swap documents and it is dramatically
 * faster; `pipx` as the established alternative. Deliberately NOT falling back
 * to bare `pip install --user`: that drops the package into the user's default
 * Python environment where it can collide with their own dependencies, which
 * is not a thing to do to someone without asking.
 */
/**
 * Python interpreters that are safe to execute on this machine.
 *
 * Both desktop platforms ship a fake python that does something other than run
 * python when none is installed, and this code runs unprompted at startup for
 * an optional panel — so neither may be executed on spec.
 *
 * macOS: /usr/bin/python3 is a shim that opens the "install developer tools?"
 * dialog. `xcode-select -p` says whether the real thing is behind it, and is
 * itself only a path lookup.
 *
 * Windows: `python` and `python3` are App Execution Aliases under
 * WindowsApps — zero-length reparse points that open the Microsoft Store. They
 * are on PATH whether or not Python exists, so presence proves nothing and
 * running one opens the Store. `where` reports the paths without executing
 * anything, so the aliases can be filtered out and the real interpreter (if
 * any) called by absolute path. `py`, the Python launcher, only exists when
 * Python was actually installed and is safe as-is.
 *
 * Returns absolute paths or bare command names, best first; empty when there
 * is nothing safe to run.
 */
let _pythons = null;
async function safePythons() {
  if (_pythons != null) return _pythons;

  if (process.platform === "darwin") {
    _pythons = (await run("xcode-select", ["-p"], { timeout: 5_000 })).ok
      ? ["python3", "python"]
      : [];
    return _pythons;
  }

  if (process.platform !== "win32") {
    _pythons = ["python3", "python"];
    return _pythons;
  }

  const found = [];
  // The launcher first: it is never an alias.
  if ((await run("py", ["-0"], { timeout: 8_000 })).ok) found.push("py");
  for (const name of ["python", "python3"]) {
    const r = await run("where", [name], { timeout: 8_000 });
    if (!r.ok) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (!p || /\\WindowsApps\\/i.test(p)) continue;   // Store alias, not an interpreter
      found.push(p);
      break;
    }
  }
  _pythons = found;
  return _pythons;
}

/**
 * Ways to install a Python application, best first.
 *
 * `python -m pipx` matters more than it looks: pipx is very often present as a
 * module without a `pipx` on PATH — every Debian/Ubuntu `apt install pipx`, and
 * any `pip install --user pipx` where ~/.local/bin was never added to PATH. The
 * two-entry version of this list reported "needs uv or pipx" to people who had
 * pipx installed, which is the kind of wrong answer that stops someone looking.
 *
 * Every entry carries its UPGRADE command line as well as its install one. The
 * upgrade used to be re-derived from the `via` label instead, and any label that
 * derivation did not recognise fell through to `-m pipx upgrade` — so the
 * bundled uv, which is the only installer present on a machine that had neither
 * uv nor pipx nor a usable python, was asked to run a pipx command it rejects.
 *
 * Every entry also carries the `owner` it speaks for, which is what an upgrade
 * is matched against. It is a field rather than something read back off `via`
 * because deriving behaviour from that label is precisely what went wrong the
 * first time: three of these five spellings are one uv and two are one pipx,
 * and a fourth spelling arriving later must not silently mean "pipx" by
 * default. Several entries can share an owner — the bundled uv upgrades what
 * the system uv installed and vice versa, since both read UV_TOOL_DIR — so the
 * probe still decides WHICH of an owner's spellings runs.
 *
 * The INSTALL line carries a version specifier and the UPGRADE line carries the
 * bare name, which is not an inconsistency: both installers record what they
 * were asked for and re-resolve an upgrade against that recorded requirement —
 * uv in the tool's `uv-receipt.toml`, pipx in `pipx_metadata.json`'s
 * `package_or_url` — and neither `uv tool upgrade` nor `pipx upgrade` accepts a
 * specifier in the first place. So the bound set here at install time is the
 * bound every later upgrade of that install is resolved inside, and the deck
 * states it once, where it is actually read.
 */
async function installers(spec = RANGE_SPEC) {
  const out = [
    { cmd: "uv",   probe: ["--version"], args: ["tool", "install", spec], upgrade: ["tool", "upgrade", PKG], via: "uv",   owner: "uv" },
    { cmd: "pipx", probe: ["--version"], args: ["install", spec],         upgrade: ["upgrade", PKG],         via: "pipx", owner: "pipx" },
  ];
  // A uv fetched on an earlier run counts as installed tooling from here on.
  const own = existingBootstrappedUv();
  if (own) {
    out.push({
      cmd: own,
      probe: ["--version"],
      args: ["tool", "install", spec],
      upgrade: ["tool", "upgrade", PKG],
      via: "uv (bundled)",
      owner: "uv",
    });
  }
  for (const py of await safePythons()) {
    out.push({
      cmd: py,
      probe: ["-m", "pipx", "--version"],
      args: ["-m", "pipx", "install", spec],
      upgrade: ["-m", "pipx", "upgrade", PKG],
      via: `${py} -m pipx`,
      owner: "pipx",
    });
  }
  return out;
}

async function installCswap() {
  // What to ask for is decided HERE, before anything is installed, so that what
  // arrives can be checked against it afterwards — see ensureCswap. When the
  // registry answers, the deck names one exact version and can then confirm
  // that exact version came back; when it does not, the range still holds and
  // the check falls back to the range. The lookup is the same one request the
  // daily check already makes, bounded at six seconds in front of an install
  // that takes minutes.
  const want = await newestAcceptableOnPypi();
  const spec = want ? `${PKG}==${want}` : RANGE_SPEC;

  for (const { cmd, probe, args, via } of await installers(spec)) {
    if (!(await run(cmd, probe, { timeout: 8_000 })).ok) continue;
    const r = await run(cmd, args, { timeout: INSTALL_TIMEOUT_MS });
    if (r.ok) return { ok: true, via, want, spec };
    return { ok: false, reason: "install_failed", via, spec, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
  }

  // Nothing on the machine can install a Python application. Rather than hand
  // the user a command and stop, fetch uv itself — verified, and into the
  // deck's own directory, see uv-bootstrap.mjs — and use that.
  const boot = await bootstrapUv();
  if (!boot.ok) return { ok: false, reason: "no_installer", bootstrap: boot.reason, hint: await installHint() };

  const r = await run(boot.bin, ["tool", "install", spec], { timeout: INSTALL_TIMEOUT_MS });
  if (r.ok) return { ok: true, via: `uv ${boot.version} (fetched)`, want, spec };
  return { ok: false, reason: "install_failed", via: "uv (fetched)", spec, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

/**
 * What to actually type, for this machine.
 *
 * "needs uv or pipx" is a dead end for the person who has neither and no
 * opinion about Python packaging — which is most people running a Node CLI.
 * uv is a single self-contained binary and is what claude-swap documents, so
 * that is what gets recommended; if the machine already has Python, pipx via
 * pip is offered instead because it uses something already installed.
 *
 * WHAT IS NOT HERE, AND WHY. This used to end in
 * `curl -LsSf https://astral.sh/uv/install.sh | sh` — and its PowerShell twin
 * `irm … | iex` — which is the exact command uv-bootstrap.mjs opens by naming
 * and declining, for the exact reason given there: it executes whatever that
 * URL happens to serve, with the user's privileges. This string is not
 * scrollback. It reaches the browser as `hint` on the `no_cswap` roster reply
 * and renders in the accounts panel as the command to run, and the machines
 * that see it are disproportionately the ones that set
 * AGENTS_DECK_NO_DOWNLOAD=1 — the reason the deck could not fetch a verified uv
 * for them is often that they asked it not to fetch binaries. Handing that user
 * a shell pipe is the same thing at one remove. A package manager's name is
 * offered instead: slower to type, and the artifact is one somebody else has
 * already checked.
 */
export async function installHint() {
  const getUv = {
    darwin: "brew install uv",
    win32: "winget install --id astral-sh.uv -e",
  }[process.platform]
    // No pipe, and no command invented for a distribution that may not carry
    // one: on Linux uv is packaged by some distributions and not others, so the
    // honest answer is where to look.
    || "install uv from your package manager — https://docs.astral.sh/uv/getting-started/installation/";
  for (const py of await safePythons()) {
    if ((await run(py, ["-c", "import sys"], { timeout: 5_000 })).ok) {
      // Quoted: a resolved Windows path routinely contains spaces.
      const q = /\s/.test(py) ? `"${py}"` : py;
      return `${q} -m pip install --user pipx && ${q} -m pipx install "${RANGE_SPEC}"`;
    }
  }
  return `${getUv}  (then: uv tool install "${RANGE_SPEC}")`;
}

function updateCheckDue() {
  try { return Date.now() - statSync(MARKER).mtimeMs > UPDATE_CHECK_MS; }
  catch { return true; }   // no marker yet
}
function touchMarker() {
  try {
    mkdirSync(join(homedir(), ".agents-deck"), { recursive: true });
    writeFileSync(MARKER, String(Date.now()));
  } catch { /* ignore */ }
}

/**
 * The newest claude-swap on PyPI that this deck would actually install, or null
 * when the registry cannot be asked.
 *
 * "Newest acceptable" and not `info.version`, which is PyPI's own idea of
 * latest and is bounded by nothing here. Reading that one and then installing
 * inside a bound is two different questions answered by two different parties,
 * and the disagreement between them is a daily lie of the kind this file has
 * already been bitten by twice (#579): the day claude-swap ships 1.0.0, every
 * deck would see a newer version, fire an upgrade its own specifier forbids,
 * and print "upgrading to v1.0.0 in background" at every launch, forever, about
 * a version that can never arrive. So the bound decides what "newest" means,
 * once, and the upgrade decision and the install target are the same answer.
 *
 * Pre-releases are skipped — claude-swap publishes `0.21.0b1` and friends, and
 * an unattended upgrade is not the place to chase them — as are releases whose
 * every file has been yanked, which is the author withdrawing them.
 */
async function newestAcceptableOnPypi() {
  try {
    const res = await fetch("https://pypi.org/pypi/claude-swap/json", {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const releases = body?.releases;
    const names = releases && typeof releases === "object"
      ? Object.keys(releases)
      // A body with no `releases` map still names one version, and it is judged
      // by exactly the same rule as any other.
      : (typeof body?.info?.version === "string" ? [body.info.version] : []);

    let best = null;
    for (const v of names) {
      if (!/^\d+(\.\d+)*$/.test(v)) continue;          // final releases only
      if (!isAcceptableVersion(v)) continue;
      const files = releases?.[v];
      if (Array.isArray(files) && files.length > 0 && files.every(f => f?.yanked)) continue;
      if (best === null || isOlder(best, v)) best = v;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * What the last background upgrade did, written where a person can read it.
 *
 * One file, overwritten, holding the last outcome only: this is a record of
 * what landed on the machine, not a history of the project's releases.
 */
const UPGRADE_RECORD = join(homedir(), ".agents-deck", "cswap-upgrade.json");

function recordUpgrade(entry) {
  try {
    mkdirSync(join(homedir(), ".agents-deck"), { recursive: true });
    writeFileSync(UPGRADE_RECORD, JSON.stringify(entry, null, 2) + "\n");
  } catch { /* a note about an upgrade is not worth failing the upgrade over */ }
}

let _upgrade = null;

/**
 * The background upgrade started by the most recent `ensureCswap`, as a promise
 * that resolves to what was recorded — or null when this run started none.
 *
 * Exported for its test rather than for a caller, the way resetCswapBin and
 * cswapCandidates are: ensureCswap deliberately does not await this, so without
 * a handle on it the only observable part of an upgrade would once again be the
 * sentence printed before it happens.
 */
export function upgradeSettled() { return _upgrade; }

/**
 * Upgrade claude-swap in the background when a newer release exists, and find
 * out what happened.
 *
 * STILL UNAWAITED, and that has not changed: an upgrade resolves a Python
 * environment and can take tens of seconds, which is not a thing to put in
 * front of the server starting. The running copy keeps working; the new one is
 * there next launch.
 *
 * What changed is that it is no longer spawned BLIND. This was `runDetached`,
 * which is `stdio: "ignore"` and no exit listener — so the deck fired a command
 * that replaces the binary holding Claude refresh tokens and then had no way,
 * ever, to say whether it ran, what it exited with, or which version came back.
 * The whole announcement was one boot row naming the version being LEFT. A
 * captured `run` costs nothing the detached one saved — nobody waits for either
 * — and it buys the three facts worth having: it ran, it exited zero, and the
 * version now answering is one this deck is willing to drive.
 *
 * `INSTALL_TIMEOUT_MS`, not `run`'s 20-second default: this is the same
 * environment build the install path allows three minutes for, and a 20-second
 * cap would report a healthy slow upgrade as a killed one.
 *
 * The command line comes from the installer entry rather than from its label,
 * and the ENTRY comes from cswapOwner rather than from whichever tool answers a
 * probe first: an upgrade aimed at the wrong tool is refused, and used to be
 * refused where nobody could see it while the caller still reported
 * "upgrading". Those are the two halves of "aimed at the wrong tool" — a right
 * argv sent to a tool that does not own the package is just as invisible as a
 * wrong argv, and was the longer-lived of the two. Both are now written down.
 */
function upgradeInBackground({ cmd, upgrade, via }, { from, want }) {
  _upgrade = (async () => {
    let entry;
    try {
      const r = await run(cmd, upgrade, { timeout: INSTALL_TIMEOUT_MS });
      // The version read below must be taken AFTER the upgrade, and cswapBin
      // memoizes the last `--version` it saw for PROBE_FRESH_MS. An upgrade
      // that finds nothing to do returns in well under those five seconds, so
      // without this the recorded "to" could be the reading from before the
      // command ran — the one number this whole function exists to replace.
      resetCswapBin();
      const to = await cswapVersion();
      entry = {
        from,
        want: want ?? null,
        to,
        at: new Date().toISOString(),
        via: via ?? null,
        ok: r.ok && typeof to === "string" && (to === "installed" || isAcceptableVersion(to)),
        // Why not, when not. An upgrade that exits non-zero and one that lands
        // a version outside the bound are very different events, and the second
        // is the one worth a person's attention: the specifier this deck
        // installs with does not permit it, so something other than that
        // specifier decided what to install.
        reason: !r.ok
          ? "command_failed"
          : (typeof to === "string" && to !== "installed" && !isAcceptableVersion(to))
            ? "unexpected_version"
            : null,
        detail: r.ok ? null : (r.stderr || r.stdout).trim().slice(0, 300),
      };
    } catch (e) {
      entry = { from, want: want ?? null, to: null, at: new Date().toISOString(), via: via ?? null,
        ok: false, reason: "threw", detail: String(e?.message ?? e).slice(0, 300) };
    }
    recordUpgrade(entry);
    return entry;
  })();
}

/**
 * A runnable spelling of the installer that OWNS this claude-swap, or null.
 *
 * The owner is decided from the install layout before anything is probed, and
 * only that owner's entries are then tried — so a uv sitting on a machine whose
 * claude-swap came from pipx is skipped rather than handed an upgrade it will
 * refuse. A null owner probes nothing at all: there is no tool here to ask.
 */
async function findUpgrader(owner) {
  if (!owner) return null;
  for (const { cmd, probe, upgrade, via, owner: speaksFor } of await installers()) {
    if (speaksFor !== owner) continue;
    if ((await run(cmd, probe, { timeout: 8_000 })).ok) return { cmd, upgrade, via };
  }
  return null;
}

/**
 * Make sure cswap exists and is reasonably current, installing it if missing.
 *
 * Returns a small status the CLI prints verbatim:
 *   { state: "present" | "installed" | "upgrading" | "skipped" | "unavailable", ... }
 *
 * `onInstalling` is called at most once, at the moment this stops asking
 * questions and commits to an install — which is the moment the answer stops
 * being seconds away and starts being minutes away. #742: the boot used to have
 * no way to tell those two apart, so it waited out its whole deadline on a
 * machine whose answer was already decided. Everything before that call is
 * probes; everything after it is a uv download and an environment build.
 *
 * Deliberately a callback and not a state on the return value: what the caller
 * needs is the news, not the outcome, and the outcome is the thing that takes
 * three minutes to arrive.
 */
export async function ensureCswap({ onInstalling = null } = {}) {
  // Whatever a previous call left behind is a previous call's outcome, and
  // upgradeSettled() answering with it would be the same class of stale reading
  // resetCswapBin exists to prevent.
  _upgrade = null;

  if (process.env.AGENTS_DECK_NO_INSTALL === "1") {
    const version = await cswapVersion();
    return version ? { state: "present", version } : { state: "skipped" };
  }

  const existing = await cswapVersion();
  if (existing) {
    // Installed — the only question left is whether it's stale. One PyPI
    // request a day, and the upgrade itself never blocks startup.
    if (!updateCheckDue()) return { state: "present", version: existing };
    // The marker is stamped AFTER the request, not before it. Stamped first, a
    // boot with no network yet — a laptop opened on a train, the ten seconds
    // before Wi-Fi associates — burned the whole shared 24-hour window on a
    // check that never reached PyPI, and the next real chance was the day
    // after. self-update.mjs states this rule for itself in as many words.
    const latest = await newestAcceptableOnPypi();
    touchMarker();
    if (latest && existing !== "installed" && isOlder(existing, latest)) {
      // Who owns it, not what is installed on the machine: an upgrade aimed at
      // a tool that never installed this package is refused, and "upgrading"
      // would then be a sentence printed daily about nothing. When nobody
      // offered here owns it, "present" is the whole truth and is what gets
      // said.
      const found = await findUpgrader(cswapOwner(await cswapBin()));
      if (found) {
        upgradeInBackground(found, { from: existing, want: latest });
        return { state: "upgrading", version: existing, latest, via: found.via };
      }
    }
    return { state: "present", version: existing };
  }

  // Said before the install starts rather than after it, because after it is
  // three minutes later and the whole point is not to be waited for.
  try { onInstalling?.(); } catch { /* a caller's notification is not our problem */ }

  const result = await installCswap();
  if (!result.ok) return { state: "unavailable", ...result };
  // Something was just installed, so any path resolved before it is a guess made
  // against a different filesystem. Nothing is cached when the earlier lookup
  // found nothing — see resetCswapBin — but a lookup that DID resolve, to a copy
  // whose `--version` then failed, is exactly the case that got us here.
  resetCswapBin();

  // Freshly installed tools land in ~/.local/bin, which may not be on the PATH
  // of the shell that launched us — cswapBin looks there directly, so this
  // confirms the install rather than confirming the user's PATH.
  const version = await cswapVersion();
  if (!version) return { state: "unavailable", reason: "not_on_path", via: result.via };

  // WHAT WAS ASKED FOR IS NOT WHAT ARRIVED. The deck names an exact version
  // (or, with no registry answer, a range) on the install command line, so a
  // different one coming back means something other than that specifier chose
  // it — a local index, a shadowed `cswap` earlier on PATH, a resolver that did
  // not honour the bound. The next thing this binary is handed is
  // `cswap export -`, which prints a Claude refresh token to stdout. Refusing
  // is the cheap half of that trade: the accounts panel stays dark and the boot
  // row says why, against a copy of the tool the deck cannot account for.
  //
  // A version that does not parse at all — `versionIn` answers "installed" —
  // is deliberately NOT refused. That is an absence of evidence, it is an
  // outcome this file already treats as ordinary (see the `existing !==
  // "installed"` guard above), and turning it into a dark panel would trade a
  // supply-chain risk for a certain outage the day `cswap --version` changes
  // how it prints.
  if (version !== "installed") {
    const wrong = result.want ? !sameVersion(version, result.want) : !isAcceptableVersion(version);
    if (wrong) {
      return { state: "unavailable", reason: "unexpected_version", version, want: result.want ?? RANGE_SPEC, via: result.via };
    }
  }
  return { state: "installed", via: result.via, version };
}
