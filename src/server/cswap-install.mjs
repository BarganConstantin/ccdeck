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
import { failureDetail } from "./exec-output.mjs";
// The version comparator was written out here as well, identical apart from a
// type guard this copy lacked, and only the self-update one was under test
// (#374). No cycle: self-update.mjs and the four modules it reads from
// (install-layout, npm-latest, restart-note, npm-upgrade) import node:* and
// three modules that reach nothing but leaves — exec.mjs, app-host.mjs and
// deck-probe.mjs — and none of them imports this file.
import { isOlder } from "./self-update.mjs";
import { bootstrapUv, existingBootstrappedUv } from "./uv-bootstrap.mjs";
// Where installers leave claude-swap and which one owns this machine's copy —
// pure layout, with the platform a parameter, so it lives on its own.
import { PKG, cswapCandidates, cswapOwner } from "./cswap-layout.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

// Same throttle the ccusage installer uses: check once a day, tracked by a
// marker file's mtime so the interval survives restarts.
const UPDATE_CHECK_MS = 24 * 3600_000;
const MARKER = join(homedir(), ".agents-deck", ".cswap-update-check");

// ── which versions of it this deck is willing to install ─────────────────────
//
// The install used to be the bare name — `uv tool install claude-swap` — which
// means "whatever that project publishes next, forever", resolved on a machine
// the author will never see, and then handed `cswap export -`, `add` and
// `import`: every command in the accounts panel that carries a Claude refresh
// token. On the same install path, uv itself is fetched only after its SHA-256
// is checked against the one Astral publishes beside it (uv-bootstrap.mjs). The
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

let _bin = null;

// ── a copy this deck refused ─────────────────────────────────────────────────
//
// #1799. installAndConfirm refuses a claude-swap whose version is not the one it
// asked for, and the refusal used to exist only in the value it returned. The
// copy was still on disk, cswapBin memoized it the moment it answered
// `--version`, and everything after the boot row drove it anyway: the roster
// called it installed-and-empty and offered Add account, `/api/cswap-auto` ran
// `cswap config` with it, and the NEXT launch could not tell it from a copy the
// user installed themselves — which ensureCswap deliberately accepts whatever
// its number — so it read "accounts panel enabled" and was seeded with
// `cswap add`.
//
// So a refusal is written down, next to the update marker, and kept until
// something changes: while a copy answering the refused version is what
// resolves, cswapBin hands out REFUSED_BIN instead of it and cswapVersion
// answers null. It is matched on the VERSION, not on the spelling: the same
// file answers as `cswap` once ~/.local/bin is on PATH and by its absolute path
// before, and telling those apart would need a PATH walk to be right in both
// directions. A copy answering any other version clears the record — that is a
// different copy, most likely one the user installed, and it is left alone the
// way any other is — and so does an install that lands an acceptable one.
// AGENTS_DECK_CSWAP wins over all of it, as it wins over every other lookup
// here: someone who names a binary has chosen it.
const REFUSED_RECORD = join(homedir(), ".agents-deck", "cswap-refused.json");

/**
 * What cswapBin answers while the refusal holds: a path under the deck's own
 * state directory that nothing creates, with an extension so that Windows spawns
 * it as given rather than trying `.cmd` spellings through cmd.exe. Every caller
 * already handles a cswap that is not there, and this is one — so a mutation
 * that reaches it (an Add pressed from a panel drawn before the refusal) fails
 * the way a missing tool fails, and runs nothing.
 */
const REFUSED_BIN = join(homedir(), ".agents-deck", "cswap-refused", "cswap.refused");

/** The refusal in effect for THIS process, `{ path, version, want, via }` — set
 *  when an install is refused, or when cswapBin resolves a copy the record
 *  names. */
let _refused = null;

function readRefusal() {
  try {
    const r = JSON.parse(readFileSync(REFUSED_RECORD, "utf8"));
    return r && typeof r.version === "string" ? r : null;
  } catch {
    return null;
  }
}

function clearRefusal() {
  try { rmSync(REFUSED_RECORD, { force: true }); } catch { /* best-effort */ }
}

/** Refuse this copy from now on, in this process and in the next. */
function refuse(entry) {
  _refused = entry;
  _bin = null;
  _probe = null;
  try {
    mkdirSync(join(homedir(), ".agents-deck"), { recursive: true });
    writeFileSync(REFUSED_RECORD, JSON.stringify({ ...entry, at: new Date().toISOString() }, null, 2) + "\n");
  } catch { /* the in-process refusal still holds; a note on disk is the next launch's */ }
}

/**
 * The refusal cswapBin's resolution found, or null — `{ path, version, want,
 * via }`. As of the last cswapBin(), so a caller that has just awaited one can
 * ask this without another hop; one that has not wants cswapRefusal.
 */
export function cswapRefused() {
  return process.env.AGENTS_DECK_CSWAP ? null : _refused;
}

/**
 * The refusal this deck is keeping, or null, for a caller that may be asking
 * before anything has resolved the binary: the roster and the first-run seed.
 * Resolves it first only when there is a record to match and nothing has been
 * resolved yet, so a process pays one `--version` for the question and a
 * machine with no record pays a missing file.
 */
export async function cswapRefusal() {
  if (process.env.AGENTS_DECK_CSWAP) return null;
  if (!_refused && !_bin && existsSync(REFUSED_RECORD)) await cswapBin();
  return _refused;
}

/** ensureCswap's answer for a refused copy: the install-time row's shape, so
 *  the boot says the same thing on every launch the refusal holds. */
function refusedState(r) {
  return { state: "unavailable", reason: "unexpected_version", version: r.version, want: r.want ?? RANGE_SPEC, via: r.via ?? null };
}

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
export async function cswapBin() {
  // An explicit path wins over everything and is never cached away — someone
  // debugging a bad resolution needs it to take effect immediately.
  if (process.env.AGENTS_DECK_CSWAP) return process.env.AGENTS_DECK_CSWAP;
  if (_bin) return _bin;
  if (_refused) return REFUSED_BIN;

  const take = (spelling, r) => {
    const version = versionIn(r);
    // The copy the deck refused, still answering: decline it (#1799). Any
    // other version is another copy, and the record goes.
    const refused = readRefusal();
    if (refused && refused.version === version) {
      _refused = refused;
      return REFUSED_BIN;
    }
    if (refused) clearRefusal();
    _probe = { version, at: Date.now() };
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
export function resetCswapBin() { _bin = null; _probe = null; _refused = null; }

/** Installed version string, or null when cswap cannot be found. */
export async function cswapVersion() {
  const bin = await cswapBin();
  if (bin === REFUSED_BIN) return null;   // declined, not asked — see _refused
  // The call above may have just asked this very question — see _probe. Nothing
  // is remembered past PROBE_FRESH_MS, so this is the second half of one
  // lookup rather than a cache of the answer.
  if (_probe && Date.now() - _probe.at < PROBE_FRESH_MS) return _probe.version;
  const r = await run(bin, ["--version"]);
  if (!r.ok) return null;
  return versionIn(r);
}

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

/**
 * Install claude-swap with whichever Python tool installer is present.
 *
 * `uv` first because it is what claude-swap documents and it is dramatically
 * faster; `pipx` as the established alternative. Deliberately NOT falling back
 * to bare `pip install --user`: that drops the package into the user's default
 * Python environment where it can collide with their own dependencies, which
 * is not a thing to do to someone without asking.
 */
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
    return { ok: false, reason: "install_failed", via, spec, detail: failureDetail(r, 300) };
  }

  // Nothing on the machine can install a Python application. Rather than hand
  // the user a command and stop, fetch uv itself — verified, and into the
  // deck's own directory, see uv-bootstrap.mjs — and use that.
  const boot = await bootstrapUv();
  if (!boot.ok) return { ok: false, reason: "no_installer", bootstrap: boot.reason, hint: await installHint() };

  const r = await run(boot.bin, ["tool", "install", spec], { timeout: INSTALL_TIMEOUT_MS });
  if (r.ok) return { ok: true, via: `uv ${boot.version} (fetched)`, want, spec };
  return { ok: false, reason: "install_failed", via: "uv (fetched)", spec, detail: failureDetail(r, 300) };
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
 * Whether ensureCswap is installing claude-swap right now.
 *
 * The install runs behind a deck that is already serving — reportStartup stops
 * waiting the moment `onInstalling` fires — so for the minutes a first run takes
 * the accounts panel is asking about a tool that is on its way. Absence alone
 * read as `no_cswap`, and the panel answered it the only way that reason
 * allows: "claude-swap isn't installed", and a command to install it by hand.
 * Somebody who ran it then had two installers racing for one directory, over a
 * tool that would have arrived by itself a minute later.
 *
 * True from the moment ensureCswap commits to an install until it has checked
 * what arrived, whichever way that went. A failed install is `no_cswap` again,
 * and then the hand-typed command is the right answer.
 */
let _installing = false;
export function cswapInstalling() { return _installing; }

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
        detail: r.ok ? null : failureDetail(r, 300),
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
    if (cswapRefused()) return refusedState(cswapRefused());
    return version ? { state: "present", version } : { state: "skipped" };
  }

  const existing = await cswapVersion();
  // STILL THE COPY IT REFUSED (#1799). Asked before the existing-install branch,
  // which accepts any version on purpose and would call this one present, and
  // before the install below, which would fetch the same answer from the same
  // index on every launch. The boot row repeats the refusal instead, and nothing
  // is seeded.
  if (cswapRefused()) return refusedState(cswapRefused());
  if (existing) {
    // Installed — the only question left is whether it's stale. One PyPI
    // request a day, and the upgrade itself never blocks startup.
    if (!updateCheckDue()) return { state: "present", version: existing };
    // The marker is stamped AFTER the request, not before it. Stamped first, a
    // boot with no network yet — a laptop opened on a train, the ten seconds
    // before Wi-Fi associates — burned the whole shared 24-hour window on a
    // check that never reached PyPI, and the next real chance was the day
    // after. npm-latest.mjs states this rule for itself in as many words.
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

  _installing = true;
  try {
    // Said before the install starts rather than after it, because after it is
    // three minutes later and the whole point is not to be waited for.
    try { onInstalling?.(); } catch { /* a caller's notification is not our problem */ }
    return await installAndConfirm();
  } finally {
    _installing = false;
  }
}

/** The install half of ensureCswap: run it, then check what arrived. */
async function installAndConfirm() {
  const result = await installCswap();
  if (!result.ok) return { state: "unavailable", ...result };
  // Something was just installed, so any path resolved before it is a guess made
  // against a different filesystem. Nothing is cached when the earlier lookup
  // found nothing — see resetCswapBin — but a lookup that DID resolve, to a copy
  // whose `--version` then failed, is exactly the case that got us here.
  resetCswapBin();
  // And whatever was refused before: what arrived is judged below, afresh, and
  // an acceptable version is the end of the refusal.
  clearRefusal();

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
      // Kept, not only reported (#1799): see REFUSED_RECORD.
      refuse({ path: _bin, version, want: result.want ?? RANGE_SPEC, via: result.via });
      return { state: "unavailable", reason: "unexpected_version", version, want: result.want ?? RANGE_SPEC, via: result.via };
    }
  }
  return { state: "installed", via: result.via, version };
}
