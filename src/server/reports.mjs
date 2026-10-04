// Usage reports, on unless the person switched them off (#1853). They are NOT
// anonymous: with reports on, every one carries a stable, hashed device id — an
// identifier for this machine — and the server records the IP the report arrives
// from. What never leaves is the person's sessions, prompts, files, project
// names and paths.
//
// WHAT GOES OUT, to api.ccdeck.dev, while `prefs.reports` is true and the
// machine has not vetoed it (reportsVetoed):
//
//   - an "install" event the first time, with the ccdeck.dev page its command
//     was copied from when the command said (`--ref`, install-ref.mjs) — a
//     page name, never anything about the person,
//   - an "update" event, with the version it came from, when the version moves,
//     and how the new one arrived: the deck's own update, the desktop app's
//     updater, npx, npm, or a source checkout,
//   - an "active" event at most once a UTC day, which is how many people use
//     ccdeck gets counted without counting anything else about them, and which
//     alone also carries coarse counts of how much: how many sessions,
//     subagents and projects the deck heard from on the last day it was used,
//     and that day's date — numbers, never their names (see usage-day.mjs) —
//     and which of the deck's features were used that day, as fixed names
//     ("usage-history", "account-switch") and nothing about what was done
//     with them (feature-use.mjs), and how the deck held up and who runs it:
//     how long this run took to start, that day's peak memory and how many
//     events it took in, each as a bucket ("2s", "512m", "1k"), the Claude and
//     Codex plan as its category ("max-20x", "plus") and nothing else from the
//     credentials it is read off, and how many Claude accounts and paired
//     machines the deck holds, as capped counts (depth-facts.mjs),
//   - an "uninstall" event when somebody runs `ccdeck --uninstall`, with the
//     reason they picked from a short list if they picked one (bin/cli/leaving.js),
//   - an "activated" event, once, when a new install's first session arrives:
//     how long after the install it came, as a bucket ("5m", "1h", "1d", "7d",
//     "later"), and whether it was a Claude or a Codex session (activation.mjs),
//   - a "rated" event, once, if somebody answers the one question the deck asks
//     about itself after about a week of use — "How useful is ccdeck to you?" —
//     with the number picked, 0 to 10, and how many days the deck had been used
//     as a range ("7-13", "30-89"); nothing for a question put off or left
//     unanswered (rating.mjs),
//   - errors: a request handler that threw on this server, or an error the page
//     caught, with home folders, email addresses and key-shaped strings
//     scrubbed out before they leave,
//   - a "ping" heartbeat, every ten minutes or so while the deck runs, which
//     moves the install's "last seen" so the admin can show who is online now,
//     and is counted per day, which is how long the deck stays open.
//     It writes no event and carries the install id alone — no facts, no
//     fingerprint.
//
// Each event carries the install id, the version, the OS and CPU architecture,
// the channel (the desktop app, npm, or a source checkout) and the runtime, plus
// a coarse sketch of the environment: the logical CPU count, the RAM in MB, the
// locale, the shell and terminal names, and the Claude Code and Codex CLI
// versions — and, on install, update, active and activated, what the boot set
// up: whether the Claude hooks went in ("ok", "failed", "off") and whether
// Codex is watched ("on", "off"). Every one of those is a small fixed token or
// a number, safe by construction — no path, no hostname, no user name, no
// project name, no prompt, no free text ever reaches any field, so there is
// nothing in them to scrub. A field that cannot be told is left out rather than
// guessed. The install id is random, made at the first check-in, and tied to
// nothing on the machine.
//
// The one field that IS derived from the machine is `deviceId`: a stable, hashed
// device id sent with EVERY report — install, update and active — while reports
// are on, never on the ping and never on errors. It is an identifier: it follows
// one machine across runs, which is why the reports are no longer anonymous. It
// is personal data, so it leaves only as a one-way hash of stable machine traits,
// never those traits in the clear (see deviceIdToken). It rides with the facts,
// so it stops entirely the moment reports are switched off or vetoed.
//
// NOBODY IS ASKED, AND NOTHING IS HIDDEN. The owner chose on-by-default
// (2026-09-30): the README says what is sent, and AGENTS_DECK_NO_REPORTS=1 keeps it
// off from the first start. The deck has no switch for it since the owner removed
// Appearance's on 2026-10-01.
//
// SWITCHING IT OFF DELETES WHAT WAS SENT. The id is forgotten here and the API
// is asked to drop every event and error it holds for it; if that request
// cannot get through, the id waits in `report.forget` and the ask is repeated
// on the next start, so switching off while offline still ends in a deletion.
//
// NOTHING HERE THROWS OR WAITS FOR ANYBODY. A report that cannot be sent is
// dropped: it is a nicety for the people who make ccdeck, and no part of the
// deck depends on it. An event a check-in owes is tried again on the heartbeat,
// less often the longer the API stays out of reach; one the API itself refuses
// (its 400, 413 or 422 problem+json) is not sent again, since the same body would
// be refused the same way. A 4xx the edge in front of it answers with is tried again.

import { createHash, randomUUID } from "node:crypto";
import { arch as osArch, cpus as osCpus, homedir, hostname, platform as osPlatform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inApp } from "./app-host.mjs";
import { reportsVetoed } from "./deck-prefs.mjs";
import { isGitCheckout, isNpxInstall } from "./install-layout.mjs";
import { bootFoundNoPrefs, heldPrefs, prefsRead } from "./prefs-state.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";
import { FEATURES, usageDay, utcDay } from "./usage-day.mjs";
import { setupFacts, sinceInstallBucket, whenSetupKnown } from "./activation.mjs";
import { notedRef, refSlug } from "./install-ref.mjs";
import {
  CLAUDE_PLANS, CODEX_PLANS, cappedCount, deckDepth, eventsBucket, launchBucket, memoryBucket, updateVia,
} from "./depth-facts.mjs";
import { daysUsedBucket, normaliseRating, ratingDue, scoreOf } from "./rating.mjs";

export const REPORTS_API = "https://api.ccdeck.dev";
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMEOUT_MS = 6000;
/** How often a long-running deck checks in whatever the heartbeat found. The beat
 *  already sends what is due — a new day's "active", a check-in that failed —
 *  so this is the floor under it, not the schedule. */
const CHECK_IN_EVERY_MS = 6 * 60 * 60 * 1000;
/** The heartbeat's beat: a lighter timer than the check-in that only moves the
 *  install's "last seen", so the admin can count who is online now. Ten minutes,
 *  plus up to `PING_JITTER_MS` of random spread, so a fleet started together does
 *  not all beat on the same tick. */
const PING_EVERY_MS = 10 * 60 * 1000;
const PING_JITTER_MS = 2 * 60 * 1000;
/** The longest a 429's or a 503's Retry-After is waited for: a header that asks
 *  for a week does not silence a deck for one. */
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
/** How long a report waits for the CLI versions it is about to carry: a couple
 *  of `--version` answers (cli-versions.mjs). One not known by then is left out. */
const CLI_PROBE_WAIT_MS = 8_000;
/** Errors per hour this deck may send, and how long one error is not repeated. */
const ERRORS_PER_HOUR = 20;
const SAME_ERROR_QUIET_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;

/** Why somebody uninstalled, when they said: the answers `ccdeck --uninstall`
 *  offers (bin/cli/leaving.js), and nothing else ever leaves as a reason. */
export const UNINSTALL_REASONS = Object.freeze(["not-useful", "too-noisy", "broken", "other-tool", "privacy", "other"]);

const EMPTY_REPORT = Object.freeze({
  installId: "", lastVersion: "", lastActiveDay: "", forget: "", usage: null,
  installedAt: "", firstSessionAt: "", firstProvider: "", activationSent: false, ref: "", selfUpdate: null,
  rating: normaliseRating(null),
});

/** Is this deck sending reports right now? The switch, which is on unless
 *  somebody turned it off, and the machine's consent. */
export function reportsOn(prefs, env = process.env) {
  return !reportsVetoed(env) && prefs?.reports !== false;
}

// ── the coarse environment facts ─────────────────────────────────────────────
//
// Everything added to an install's facts here is a count or a small fixed token,
// safe by construction: no path, no hostname, no user name, no free text ever
// reaches any of them, so there is nothing to scrub. The ONE exception is
// `deviceId` below — it is derived from identifying machine traits (the hostname
// among them), so it is personal data, which is exactly why it leaves only as a
// one-way hash and never as the traits themselves (see deviceIdToken). Each is
// optional — a field that cannot be told is left undefined and so never sent, and
// none of these can throw, because a report is a nicety and no part of the deck
// may hang on it.

// The keys the API caps, so a value that would be rejected for length is not
// sent: it is trimmed to the cap here instead. Only ever tokens the shape of a
// terminal name, a shell name, a locale or a version — never anything free.
const TOKEN_CAPS = { locale: 16, shell: 16, term: 32, claudeVersion: 32, codexVersion: 32, deviceId: 64 };

/** A value reduced to the API's token shape `^[0-9A-Za-z.+_-]+$`: spaces become
 *  "_" (so "Apple Terminal" rides as "Apple_Terminal"), every other disallowed
 *  character is dropped, and the result is trimmed to `max`. Empty or nothing
 *  in → nothing out, so the caller omits the field. */
function token(value, max) {
  if (value == null) return undefined;
  const t = String(value).trim().replace(/\s+/g, "_").replace(/[^0-9A-Za-z.+_-]/g, "");
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** A whole count of zero or more, or nothing. */
function count(n) {
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Logical CPUs, or nothing when the platform will not say. */
function cpuCount() {
  try { return count(osCpus().length); } catch { return undefined; }
}

/** Total RAM in whole MB, or nothing. */
function totalMemMb() {
  try { return count(Math.round(totalmem() / 1024 / 1024)); } catch { return undefined; }
}

/**
 * A stable, non-reversible fingerprint of the machine, as an opaque token.
 *
 * PRIVACY — READ THIS. Unlike every other facts field, this is PERSONAL DATA: a
 * stable id that follows one machine across runs, and one of its ingredients
 * (`os.hostname()`) can name a person. That is exactly why it leaves only as a
 * one-way hash, never as the traits in the clear — the traits are concatenated,
 * run through SHA-256, and only the first 16 hex characters ship, so the machine
 * details cannot be read back out of what leaves. It is identifying all the same:
 * it is stable per machine, so it is what makes the reports no longer anonymous,
 * and it ships with every report while reports are on. The token is hex, so it
 * matches the API's `^[0-9A-Za-z.+_-]+$` shape and its 16 characters sit well
 * under the 64 cap.
 * Built from traits that do not change between restarts — platform, arch, CPU
 * model and count, total RAM, and the hostname folded into the hash ONLY — and it
 * never throws: a trait that cannot be read just yields a different, still stable,
 * token. The traits are a parameter so a test can hash a fixed machine.
 */
export function deviceIdToken(traits = machineTraits()) {
  try {
    const seed = [traits.platform, traits.arch, traits.cpuModel, traits.cpuCount, traits.memBytes, traits.hostname]
      .map(part => String(part ?? ""))
      .join("\u0000");
    return createHash("sha256").update(seed).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/** The stable machine traits the fingerprint hashes — never sent themselves,
 *  only the hash of them. `hostname()` is identifying and is read here solely to
 *  be folded into that hash, never returned to a path that sends facts. */
function machineTraits() {
  try {
    const list = osCpus();
    return {
      platform: osPlatform(),
      arch: osArch(),
      cpuModel: list?.[0]?.model,
      cpuCount: list?.length,
      memBytes: totalmem(),
      hostname: hostname(),
    };
  } catch {
    return {};
  }
}

/**
 * The UI locale as a token — "en-US", "de-DE". The runtime's own resolved
 * locale first, then `LANG`/`LC_ALL` with any `.UTF-8` encoding stripped. The
 * resolved locale is a parameter so a test can drive both halves without
 * standing up a second Intl.
 */
export function localeToken(env = process.env, resolved = intlLocale()) {
  const raw = resolved || String(env?.LANG ?? env?.LC_ALL ?? env?.LC_MESSAGES ?? "").split(".")[0];
  return token(raw, TOKEN_CAPS.locale);
}

function intlLocale() {
  try { return Intl.DateTimeFormat().resolvedOptions().locale || ""; } catch { return ""; }
}

/** The shell as a bare name — "zsh", "bash", "fish". `SHELL` names it on POSIX;
 *  on Windows there is no `SHELL` (unless a Git-Bash-style one set it), so it is
 *  read off what each shell leaves for what it starts (windowsShell). */
export function shellToken(env = process.env, platform = process.platform) {
  const sh = env?.SHELL;
  if (sh) return token(baseName(sh), TOKEN_CAPS.shell);
  if (platform === "win32") return windowsShell(env);
  return undefined;
}

/**
 * The Windows shell that started the deck — "pwsh", "powershell", "cmd" — or
 * nothing when it cannot be told.
 *
 * Not `PSModulePath` being set, nor `ComSpec`: Windows sets both machine-wide,
 * so every process has them — cmd.exe, Windows PowerShell, and the desktop app
 * started from the Start menu — and every Windows deck used to say "pwsh".
 * What PowerShell adds for what it starts is its user module folder, under the
 * user's profile: Documents\PowerShell\Modules for PowerShell 7,
 * Documents\WindowsPowerShell\Modules for Windows PowerShell. cmd.exe defines
 * `PROMPT`. PowerShell is asked first, because npm's .cmd shim runs through
 * cmd.exe even from a PowerShell prompt.
 */
function windowsShell(env) {
  const profile = String(env?.USERPROFILE ?? "").replace(/[\\/]+$/, "").toLowerCase();
  const userModules = profile
    ? String(env?.PSModulePath ?? "").split(";")
      .map(p => p.trim().replace(/[\\/]+$/, "").toLowerCase())
      .filter(p => p.startsWith(`${profile}\\`) || p.startsWith(`${profile}/`))
    : [];
  if (userModules.some(p => /[\\/]powershell[\\/]modules$/.test(p))) return "pwsh";
  if (userModules.some(p => /[\\/]windowspowershell[\\/]modules$/.test(p))) return "powershell";
  if (env?.PROMPT) return token(baseName(env?.ComSpec ?? env?.COMSPEC ?? "cmd"), TOKEN_CAPS.shell) ?? "cmd";
  return undefined;
}

/** The terminal program as a token — "iTerm.app", "Apple_Terminal", "vscode",
 *  "WezTerm", "Windows_Terminal", else whatever `TERM` says ("xterm-256color"). */
export function termToken(env = process.env) {
  const prog = env?.TERM_PROGRAM;
  if (prog) return token(prog, TOKEN_CAPS.term);
  if (env?.WT_SESSION) return "Windows_Terminal";
  return token(env?.TERM, TOKEN_CAPS.term);
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop().replace(/\.exe$/i, "");
}

function addIf(target, key, value) {
  if (value !== undefined) target[key] = value;
}

/** What every report says about the install, and nothing else — the version, the
 *  system, the channel and the runtime, plus the coarse environment tokens and
 *  counts the API records as optional. `claudeVersion`/`codexVersion` are
 *  supplied by the reporter once its background probe has them (cli-versions.mjs)
 *  and omitted until then; everything else is read here from the OS and the
 *  environment. */
export function installFacts({
  version = RUNNING_VERSION,
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
  env = process.env,
  checkout = isGitCheckout(PKG_ROOT),
  cpus = cpuCount(),
  memMb = totalMemMb(),
  locale = localeToken(env),
  shell = shellToken(env, platform),
  term = termToken(env),
  deviceId = deviceIdToken(),
  claudeVersion,
  codexVersion,
} = {}) {
  const facts = {
    version: String(version),
    os: platform,
    arch,
    // A deck run out of a git checkout is somebody developing ccdeck, and it
    // says so, so the people counting installs can leave it out.
    channel: inApp(env) ? "desktop" : checkout ? "checkout" : "npm",
    runtime: versions.electron ? `electron-${versions.electron}` : `node-${versions.node}`,
  };
  addIf(facts, "cpus", count(cpus));
  addIf(facts, "memMb", count(memMb));
  addIf(facts, "locale", token(locale, TOKEN_CAPS.locale));
  addIf(facts, "shell", token(shell, TOKEN_CAPS.shell));
  addIf(facts, "term", token(term, TOKEN_CAPS.term));
  // The one derived, hashed, personal field. Present on the events that carry
  // facts; stripped from errors, and never on the heartbeat (see below).
  addIf(facts, "deviceId", token(deviceId, TOKEN_CAPS.deviceId));
  addIf(facts, "claudeVersion", token(claudeVersion, TOKEN_CAPS.claudeVersion));
  addIf(facts, "codexVersion", token(codexVersion, TOKEN_CAPS.codexVersion));
  return facts;
}

/**
 * Take out of an error what could say who someone is.
 *
 * The catch-all for long opaque strings deliberately stops at a slash: with one
 * in it, the pattern swallowed every long file path, and a stack whose frames
 * read `at save (~/.<secret>.mjs:40:3)` tells nobody where the bug is.
 * The API scrubs again;
 * this is the pass that means it never has to: this user's home folder, anyone
 * else's home folder, email addresses, and strings shaped like keys and tokens.
 */
export function scrub(text, home = homedir()) {
  let out = String(text ?? "");
  if (home && home.length > 1) out = out.split(home).join("~");
  return out
    .replace(/\/(?:home|Users)\/[^/\s:'"]+/g, "~")
    .replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\r\n:'"]+/gi, "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(
      /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+_=-]{48,})/g,
      "<secret>",
    );
}

/**
 * The reporter, with everything it touches passed in so the suite can run it
 * against a fake API, a fake clock and a prefs store in memory.
 *
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => Date} [deps.now]
 * @param {{ current: () => any, update: (mutate: (prev: any) => any) => Promise<any> }} [deps.prefs]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {ReturnType<typeof installFacts>} [deps.facts]
 * @param {string} [deps.home]
 * @param {Promise<unknown>} [deps.ready] what start() waits for: the prefs read at import
 * @param {() => { claudeVersion?: string, codexVersion?: string }} [deps.versions] the CLI
 *   versions to fold into the facts, read fresh on every send so a background
 *   probe's answer rides along the moment it arrives. Default: none.
 * @param {() => Promise<unknown>} [deps.probe] asks the CLIs their versions again,
 *   for `versions` to answer with: started by start() once the prefs say reports
 *   are on, again on each new UTC day, and waited for — never past
 *   CLI_PROBE_WAIT_MS — before an install, update or "active" goes out.
 *   Default: none.
 * @param {ReturnType<typeof import("./usage-day.mjs").createUsageDay>} [deps.usage]
 *   the day's tally: the "active" report carries the last finished day's totals,
 *   read only when an "active" is about to be sent, and the tally is saved into
 *   the prefs so a restart does not lose the day. Default: the deck's own.
 * @param {() => { claudeHooks?: string, codexWatch?: string }} [deps.setup] what the
 *   boot set up, folded into install, update and active (activation.mjs).
 * @param {() => Promise<unknown>} [deps.setupKnown] what start() waits for besides the
 *   prefs, so the first install event carries the setup. Bounded.
 * @param {() => string | undefined} [deps.reference] the ref this run's command
 *   carried (install-ref.mjs), for the install event alone.
 * @param {(ctx: { setup: object, prefs: object }) => Promise<object>} [deps.depth] the
 *   plans, accounts and paired machines the "active" carries (depth-facts.mjs),
 *   read only when one is about to go. Default: none — the deck's own reporter
 *   passes deckDepth, so no test reads a real credentials file.
 * @param {() => number} [deps.launchedIn] ms from this process starting to the
 *   deck listening, read once by start(), which runs as the deck starts listening.
 * @param {() => number} [deps.memory] the process's resident memory in bytes,
 *   sampled on the heartbeat's beat for the usage day's peak.
 * @param {boolean} [deps.npx] this copy runs out of an npx cache, which is how an
 *   npm install that changed version under it updated.
 * @param {() => number} [deps.uptime] how long this deck has been up, in ms: the
 *   question about the deck is never asked in the minutes after a launch.
 * @param {() => boolean} [deps.firstRun] this run's boot found no settings file:
 *   the deck had never run here, so an install id made now is a real install and
 *   its first session is timed. Default: the boot read's own answer.
 */
export function createReporter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  prefs = heldPrefs,
  env = process.env,
  facts = installFacts({ env }),
  home = homedir(),
  ready = prefsRead,
  versions = () => ({}),
  probe = async () => {},
  usage = usageDay,
  setup = setupFacts,
  setupKnown = () => whenSetupKnown(),
  reference = notedRef,
  depth = async () => ({}),
  launchedIn = () => process.uptime() * 1000,
  memory = () => process.memoryUsage.rss(),
  npx = false,
  uptime = () => process.uptime() * 1000,
  firstRun = bootFoundNoPrefs,
} = {}) {
  const errorsSent = [];
  const lastSentAt = new Map();
  let timer = null;
  let pingTimer = null;
  /** How long this run took to start, read when start() runs; null before. */
  let launchMs = null;

  /** The CLI versions to add to the facts right now, tokenised and omitted when
   *  not yet known — read on every send so the background probe's result appears
   *  on the first report after it lands, not only on the next restart. */
  function versionFacts() {
    try {
      const v = versions() ?? {};
      const out = {};
      addIf(out, "claudeVersion", token(v.claudeVersion, TOKEN_CAPS.claudeVersion));
      addIf(out, "codexVersion", token(v.codexVersion, TOKEN_CAPS.codexVersion));
      return out;
    } catch {
      return {};
    }
  }

  /** The UTC day the CLIs were last asked their versions, and the asking under way. */
  let probedDay = "";
  let probing = null;

  /** Ask the CLIs their versions, at most once a UTC day — so a deck left running
   *  for a week says the Claude Code it has now, not the one it booted with — and
   *  resolve once the answer is in. Never rejects. */
  function probeVersions() {
    try {
      const today = utcDay(now());
      if (!probing && probedDay !== today) {
        probedDay = today;
        probing = Promise.resolve()
          .then(() => probe())
          .catch(() => { /* a probe that could not run leaves the versions as they were */ })
          .finally(() => { probing = null; });
      }
    } catch {
      // A clock that cannot say the day; the report goes with what is known.
    }
    return probing ?? Promise.resolve();
  }

  /** The versions fresh for a report about to carry them: the day's probe, waited
   *  for, but never past CLI_PROBE_WAIT_MS — a version not known by then is left
   *  out, and rides on a later report. */
  async function versionsReady() {
    let timer;
    await Promise.race([
      probeVersions(),
      new Promise(r => { timer = setTimeout(r, CLI_PROBE_WAIT_MS); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }

  /** The full facts an event carries: the fixed install facts, plus whatever CLI
   *  versions are known this moment. */
  function factsNow() {
    return { ...facts, ...versionFacts() };
  }

  /** What the boot set up — the Claude hooks and the Codex watcher — as the two
   *  fixed tokens activation.mjs names, or nothing while it has not said. */
  function setupNow() {
    try {
      const s = setup() ?? {};
      const out = {};
      addIf(out, "claudeHooks", ["ok", "failed", "off"].includes(s.claudeHooks) ? s.claudeHooks : undefined);
      addIf(out, "codexWatch", ["on", "off"].includes(s.codexWatch) ? s.codexWatch : undefined);
      return out;
    } catch {
      return {};
    }
  }

  /** Whether this is the deck's first run here. Never throws: a run it cannot
   *  tell is not one. */
  function isFirstRun() {
    try {
      return firstRun() === true;
    } catch {
      return false;
    }
  }

  /** This run's ref, if it is one. Never throws. */
  function refNow() {
    try {
      return refSlug(reference());
    } catch {
      return undefined;
    }
  }

  /** The coarse usage the "active" report carries: the last finished day before
   *  `today`, its date as `usageDay` and its counts beside it. Nothing at all
   *  when there is no such day yet — a first launch has no yesterday — and only
   *  whole counts of zero or more survive. A tally that throws costs the report
   *  nothing. */
  function coarseUsage(today) {
    try {
      const raw = usage.finished(today);
      if (!raw || typeof raw.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || raw.day >= today) return {};
      const out = { usageDay: raw.day };
      addIf(out, "sessions", count(raw.sessions));
      addIf(out, "subagents", count(raw.subagents));
      addIf(out, "projects", count(raw.projects));
      // The features used that day, as names off the fixed list — an empty list
      // is a real answer (the deck ran, nothing was opened), not a missing one.
      out.features = Array.isArray(raw.features) ? raw.features.filter(f => FEATURES.includes(f)) : [];
      // How hard the deck worked that day, as buckets (depth-facts.mjs). A peak
      // of zero is a day no beat sampled, which says nothing.
      addIf(out, "events", eventsBucket(raw.events));
      addIf(out, "deckMemory", raw.peakMb > 0 ? memoryBucket(raw.peakMb) : undefined);
      return out;
    } catch {
      return {};
    }
  }

  /** What the "active" says about the deck beyond its day: how long this run
   *  took to start, as a bucket, and the plans, accounts and paired machines
   *  the depth provider reads — each only as a word off its list or a capped
   *  count (depth-facts.mjs). A reading that throws costs the report nothing. */
  async function depthNow() {
    const out = {};
    addIf(out, "launch", launchMs == null ? undefined : launchBucket(launchMs));
    try {
      const d = (await depth({ setup: setupNow(), prefs: prefs.current() })) ?? {};
      addIf(out, "claudePlan", CLAUDE_PLANS.includes(d.claudePlan) ? d.claudePlan : undefined);
      addIf(out, "codexPlan", CODEX_PLANS.includes(d.codexPlan) ? d.codexPlan : undefined);
      addIf(out, "accounts", cappedCount(d.accounts));
      addIf(out, "machines", cappedCount(d.machines));
    } catch {
      // A plan or a count that could not be read is left out.
    }
    return out;
  }

  /** The deck's memory into the day's tally, which keeps the day's highest. */
  function samplePeak() {
    try {
      usage.notePeak?.(memory() / (1024 * 1024));
    } catch {
      // A reading that failed this beat; the next one tries again.
    }
  }

  /** The tally the last save wrote, so a save with nothing new writes nothing. */
  let usageSaved = -1;

  /** Keep the day's tally in the prefs, beside the install id, so a restart
   *  carries it on. Only while reports are on and under the id it belongs to:
   *  switching off drops it with the id. Never throws. */
  async function saveUsage() {
    try {
      const at = usage.version();
      if (at === usageSaved) return;
      const p = prefs.current();
      if (!reportsOn(p, env) || !p.report.installId) return;
      await remember(p.report.installId, { usage: usage.saved() });
      usageSaved = at;
    } catch {
      // A settings file that cannot be written this minute; the next save tries again.
    }
  }

  /** The tally an earlier run saved, merged in once the prefs are read. */
  function restoreUsage() {
    try {
      const saved = prefs.current().report?.usage;
      if (saved) usage.restore(saved);
    } catch {
      // A saved tally that will not read: this run's counting goes on without it.
    }
  }

  /** What became of a send: "sent"; "refused" — the API saying no to this body,
   *  which it will say again to the same body, so it is final; or "failed" —
   *  anything else, worth another try. */
  async function call(method, path, body) {
    try {
      const res = await fetchImpl(REPORTS_API + path, {
        method,
        headers: { "content-type": "application/json", "user-agent": `ccdeck/${facts.version}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return "sent";
      if (res.status === 429 || res.status === 503) waitAsAsked(res);
      return refusedByApi(res) ? "refused" : "failed";
    } catch {
      return "failed";
    }
  }

  /** Whether an answer is the API's own verdict on the body: a 400, 413 or 422
   *  it wrote as application/problem+json, the only way it turns a body down.
   *  Any other 4xx — a 403 or 404 Cloudflare answers with itself (a challenge,
   *  a rule, a tunnel being moved), a proxy's 401 — says nothing about the body,
   *  and a later try can get through, so it is tried again like a 5xx. */
  function refusedByApi(res) {
    try {
      if (res.status !== 400 && res.status !== 413 && res.status !== 422) return false;
      const type = String(res.headers?.get?.("content-type") ?? "").toLowerCase();
      return type.split(";")[0].trim() === "application/problem+json";
    } catch {
      return false;
    }
  }

  /** Delivered, or refused for good: either way nothing more to send. */
  const settled = outcome => outcome !== "failed";

  /** Check-ins in a row that ended still owing something, and the earliest the
   *  timers may check in again, by `now` — so a laptop that slept through the
   *  wait tries on its first beat awake. */
  let failedInARow = 0;
  let retryAt = 0;
  /** The earliest the timers may send anything at all — a check-in or the
   *  heartbeat — because the API asked for the wait (a Retry-After), whichever
   *  request it answered. Kept apart from the backoff, which is the check-ins'
   *  own: a check-in that owes nothing more clears that, and not this. */
  let askedWaitUntil = 0;

  /** A Retry-After, in seconds or as a date, moves the next try out to it. */
  function waitAsAsked(res) {
    try {
      const raw = String(res.headers?.get?.("retry-after") ?? "").trim();
      if (!raw) return;
      const at = now().getTime();
      const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - at;
      if (Number.isFinite(ms) && ms > 0) askedWaitUntil = Math.max(askedWaitUntil, at + Math.min(ms, RETRY_AFTER_MAX_MS));
    } catch {
      // A header that will not read: the backoff alone decides.
    }
  }

  /** Whether the API's own Retry-After has passed. Never throws. */
  function askedWaitOver() {
    try {
      return now().getTime() >= askedWaitUntil;
    } catch {
      return true;
    }
  }

  /** After a check-in: one that still owes something waits half a beat before
   *  the next try — so the first is the next beat, however long this one took
   *  to fail — then twice that each time, up to the six-hour check-in; one that
   *  owes nothing clears the wait. Never throws. */
  function afterCheckIn() {
    try {
      if (!checkInDue()) {
        failedInARow = 0;
        retryAt = 0;
        return;
      }
      failedInARow++;
      const wait = Math.min((PING_EVERY_MS / 2) * 2 ** (failedInARow - 1), CHECK_IN_EVERY_MS);
      retryAt = Math.max(retryAt, now().getTime() + wait);
    } catch {
      // A clock that cannot say: the next beat tries again.
    }
  }

  /** Whether the timers may check in now: the backoff, and any wait the API
   *  asked for, both over. Never throws. */
  function retryDue() {
    try {
      return now().getTime() >= retryAt && askedWaitOver();
    } catch {
      return true;
    }
  }

  /** Change the reporter's state, but only while it still belongs to `installId`:
   *  a switch-off that landed in between has the last word. */
  function remember(installId, change) {
    return prefs.update(prev =>
      prev.report.installId === installId ? { report: { ...prev.report, ...change } } : undefined,
    );
  }

  /** Check-ins under way, so a beat that lands during a slow one does not start
   *  a second beside it and send the same install twice. */
  let checkingIn = 0;

  /** Send whatever is due: a pending deletion, then install or update, then
   *  today's "active". Never throws: a floating rejection here would be an
   *  unhandled one, and Node's answer to those is to end the process. */
  async function checkIn() {
    checkingIn++;
    try {
      await sendWhatIsDue();
    } catch {
      // A settings file that cannot be written this minute; the next check-in tries again.
    } finally {
      checkingIn--;
      afterCheckIn();
    }
  }

  /** Whether a check-in has something to send: the conditions sendWhatIsDue
   *  acts on, read off the prefs and the clock alone — no network — so the
   *  heartbeat can ask on every beat. Never throws. */
  function checkInDue() {
    try {
      if (reportsVetoed(env)) return false;
      const p = prefs.current();
      const r = p.report;
      if (r.forget) return true;
      if (!reportsOn(p, env)) return false;
      if (!r.installId || r.lastVersion !== facts.version || r.lastActiveDay !== utcDay(now())) return true;
      if (r.installedAt && !r.activationSent && (r.firstSessionAt || usage.firstUse?.())) return true;
      return r.rating.score !== null && !r.rating.sent;
    } catch {
      return false;
    }
  }

  async function sendWhatIsDue() {
    // The machine's veto covers the deletion too: a deck launched to stay off
    // the network stays off it, and the deletion waits for a launch without it.
    if (reportsVetoed(env)) return;
    const p = prefs.current();
    const { forget } = p.report ?? EMPTY_REPORT;
    // Only a deletion that landed is done with: one refused stays owed, and is
    // asked again as a failed one is, rather than dropped.
    if (forget && (await call("DELETE", `/v1/app/installs/${encodeURIComponent(forget)}`)) === "sent") {
      await prefs.update(prev => (prev.report.forget === forget ? { report: { ...prev.report, forget: "" } } : undefined));
    }
    if (!reportsOn(prefs.current(), env)) return;

    // The id is made here, the first time there is something to send under it.
    if (!prefs.current().report.installId) {
      const fresh = isFirstRun();
      await prefs.update(prev =>
        prev.reports === false || prev.report.installId
          ? undefined
          // On a first run, when the id is made is when this install began: the
          // clock the first session is measured against. Kept here, never sent as
          // a time. A deck that ran here before — one upgraded from a version
          // with no reports, which had no id to keep — gets none, and is never
          // timed: its first session was long ago, and "now" would be a lie.
          : { report: { ...prev.report, installId: randomUUID(), installedAt: fresh ? now().toISOString() : "" } },
      );
    }
    const { installId, lastVersion, lastActiveDay } = prefs.current().report;
    if (!installId) return;
    const today = utcDay(now());
    // The CLI versions ride on install, update and "active", and those go out at a
    // boot more often than not: so they are asked for first, and on a new day
    // asked again.
    if (lastVersion !== facts.version || lastActiveDay !== today) await versionsReady();
    if (!lastVersion) {
      // The site page the command came from: one an earlier try of this install
      // could not send, else this run's. Kept until the install gets out, then
      // never again — only a new install has a page to come from.
      const ref = refSlug(prefs.current().report.ref) ?? refNow();
      const body = { installId, kind: "install", ...factsNow(), ...setupNow() };
      addIf(body, "ref", ref);
      // Refused by the API is as done as sent: the same body would be refused again.
      if (settled(await call("POST", "/v1/app/events", body))) {
        await remember(installId, { lastVersion: facts.version, ref: "" });
      } else if (ref) {
        await remember(installId, { ref });
      }
    } else if (lastVersion !== facts.version) {
      const body = { installId, kind: "update", fromVersion: lastVersion, ...factsNow(), ...setupNow() };
      // How it arrived: the deck's own update if it wrote that it started one
      // from this version, else what the channel says (depth-facts.mjs).
      addIf(body, "via", updateVia({
        marker: prefs.current().report.selfUpdate, lastVersion, channel: facts.channel, npx, now: now(),
      }));
      if (settled(await call("POST", "/v1/app/events", body))) {
        await remember(installId, { lastVersion: facts.version, selfUpdate: null });
      }
    }

    if (lastActiveDay !== today) {
      // Usage rides on the "active" event alone, and is read only here — the one
      // report it belongs to — so a checkIn that sends nothing new never asks the
      // deck for its counts.
      const used = coarseUsage(today);
      const held = await depthNow();
      if (settled(await call("POST", "/v1/app/events", { installId, kind: "active", ...factsNow(), ...setupNow(), ...used, ...held }))) {
        if (used.usageDay) usage.markSent(used.usageDay);
        await remember(installId, { lastActiveDay: today });
      }
    }
    await sendActivation();
    await sendRating();
    await saveUsage();
  }

  /**
   * The install's first session, said once: an "activated" event with how long
   * after the install it came, in a bucket, and which CLI it came from.
   *
   * Only for an install whose start this deck saw — `installedAt` is made with
   * the id, on a first run only, so an install from before this version, or one
   * whose id was made over an older deck's settings, has none and is never
   * measured: its first session was long ago, and "now" would be a lie. The time
   * is taken from the first use this run heard, so a session that arrived before
   * the first check-in had an id is still dated when it happened. A send that
   * cannot get through is tried again at the next check-in.
   */
  async function sendActivation() {
    const first = usage.firstUse?.();
    let r = prefs.current().report;
    if (!reportsOn(prefs.current(), env) || !r.installId || !r.installedAt || r.activationSent) return;
    if (!r.firstSessionAt) {
      if (!first) return;
      await remember(r.installId, { firstSessionAt: first.at, firstProvider: first.provider });
      r = prefs.current().report;
      if (!r.firstSessionAt) return;
    }
    const body = { installId: r.installId, kind: "activated", ...factsNow(), ...setupNow() };
    addIf(body, "firstSession", sinceInstallBucket(r.installedAt, r.firstSessionAt));
    addIf(body, "firstProvider", r.firstProvider === "codex" || r.firstProvider === "claude" ? r.firstProvider : undefined);
    if (settled(await call("POST", "/v1/app/events", body))) await remember(r.installId, { activationSent: true });
  }

  /** The deck starting an update of its own — the Upgrade press, the npx
   *  relaunch onto the latest, or the update it runs while nobody is looking
   *  (lifecycle.mjs) — written down so the "update" the next version sends can
   *  say so. Only the version it started from and when; never throws. */
  async function noteSelfUpdate() {
    try {
      const p = prefs.current();
      if (!reportsOn(p, env) || !p.report.installId) return;
      await remember(p.report.installId, { selfUpdate: { from: facts.version, at: now().toISOString() } });
    } catch {
      // Unsaid, the update is credited to its channel instead.
    }
  }

  /** The answer to the deck's one question, said once — tried again at the next
   *  check-in when it cannot get through. The score and how long the deck had
   *  been used, as a range; nothing else about the question ever leaves. */
  async function sendRating() {
    const p = prefs.current();
    const r = p.report;
    if (!reportsOn(p, env) || !r.installId || r.rating.score === null || r.rating.sent) return;
    const days = usage.daysUsed?.() ?? 0;
    const body = { installId: r.installId, kind: "rated", ...factsNow(), score: r.rating.score, daysUsed: daysUsedBucket(days) };
    if (settled(await call("POST", "/v1/app/events", body))) {
      await remember(r.installId, { rating: { ...prefs.current().report.rating, sent: true } });
    }
  }

  /** Should the page ask "How useful is ccdeck to you?" now? Only while reports
   *  are on and there is an install to send the answer under (rating.mjs says
   *  the rest). Never throws. */
  function ratingAsk() {
    try {
      const p = prefs.current();
      if (!reportsOn(p, env) || !p.report.installId) return false;
      return ratingDue(p.report.rating, usage.daysUsed?.() ?? 0, now(), uptime());
    } catch {
      return false;
    }
  }

  /** The question answered: kept, then sent. A second answer, from a second tab,
   *  changes nothing. Resolves to whether it was kept; never throws. */
  async function rate(score) {
    try {
      const picked = scoreOf(score);
      const p = prefs.current();
      if (picked === null || !reportsOn(p, env) || !p.report.installId || p.report.rating.score !== null) return false;
      await remember(p.report.installId, { rating: { ...p.report.rating, score: picked, sent: false } });
      await sendRating();
      return prefs.current().report.rating.score === picked;
    } catch {
      return false;
    }
  }

  /** "Not now": the question waits a month, and after the second time it stops.
   *  Resolves to whether it was kept; never throws. */
  async function rateLater() {
    try {
      const p = prefs.current();
      const r = p.report.rating;
      if (!reportsOn(p, env) || !p.report.installId || r.score !== null) return false;
      await remember(p.report.installId, { rating: { ...r, later: r.later + 1, laterAt: now().toISOString() } });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a report would go out right now: reports on, the machine not
   *  vetoing them, and an install id to send under. `ccdeck --uninstall` asks
   *  before it asks the person anything. Never throws. */
  async function willReport() {
    try {
      await Promise.resolve(ready).catch(() => {});
      const p = prefs.current();
      return reportsOn(p, env) && Boolean(p.report.installId);
    } catch {
      return false;
    }
  }

  /** The install leaving: `ccdeck --uninstall`, with the reason picked off
   *  UNINSTALL_REASONS if one was. The id stays: a deck run again later is the
   *  same install coming back. Resolves to whether it got through; never throws. */
  async function reportUninstall(reason) {
    try {
      if (!(await willReport())) return false;
      const body = { installId: prefs.current().report.installId, kind: "uninstall", ...factsNow() };
      addIf(body, "reason", UNINSTALL_REASONS.includes(reason) ? reason : undefined);
      return (await call("POST", "/v1/app/events", body)) === "sent";
    } catch {
      return false;
    }
  }

  /** The first session this run heard, sent the moment it lands rather than at
   *  the next check-in, hours later or on a next launch that may never come. */
  async function onFirstSession() {
    try {
      await sendActivation();
    } catch {
      // A settings file that cannot be written this minute; the next check-in tries again.
    }
  }

  /** The heartbeat. While reports are on and an id exists, tell the API this deck
   *  is still here — it moves the install's "last seen" and writes no event, so it
   *  carries the id and nothing else: no facts, no deviceId. Like every send it is
   *  dropped if it cannot get through, and it never throws. No id yet means the
   *  first check-in has not run, so there is nothing to be online under and
   *  nothing is sent; the check-in that makes the id is what puts this deck
   *  online, and the ping only keeps that fresh. Not while a Retry-After the
   *  API sent — on a ping or a check-in — is still running: it asked to be left
   *  alone that long, and the heartbeat is the request sent most often. */
  async function ping() {
    try {
      const p = prefs.current();
      if (!reportsOn(p, env) || !p.report.installId || !askedWaitOver()) return;
      await call("POST", "/v1/app/ping", { installId: p.report.installId });
    } catch {
      // The lightest of the niceties: a heartbeat that could not be sent is gone.
    }
  }

  /** The switch. On checks in, which makes an id if there is none; off drops the id and asks for a deletion. */
  async function setReports(on) {
    if (on) {
      await prefs.update(() => ({ reports: true }));
      await checkIn();
      return;
    }
    await prefs.update(prev => ({
      reports: false,
      report: { ...EMPTY_REPORT, forget: prev.report.installId || prev.report.forget },
    }));
    await checkIn();
  }

  /**
   * Report an error, scrubbed. At most ERRORS_PER_HOUR an hour, and the same
   * message is not repeated within SAME_ERROR_QUIET_MS: a handler that fails on
   * every poll would otherwise send the same line all day.
   */
  async function reportError(where, error) {
    const p = prefs.current();
    if (!reportsOn(p, env) || !p.report.installId) return false;
    const message = scrub(error?.message ?? error, home).slice(0, MESSAGE_MAX).trim();
    if (!message) return false;
    const at = now().getTime();
    while (errorsSent.length && at - errorsSent[0] > SAME_ERROR_QUIET_MS) errorsSent.shift();
    const key = `${where}\n${message}`;
    if (errorsSent.length >= ERRORS_PER_HOUR || at - (lastSentAt.get(key) ?? -Infinity) < SAME_ERROR_QUIET_MS) return false;
    errorsSent.push(at);
    lastSentAt.set(key, at);
    const stack = typeof error?.stack === "string" ? scrub(error.stack, home).slice(0, STACK_MAX) : undefined;
    // Less the runtime, and less the deviceId — an error is not one of the events
    // the fingerprint rides on, so the personal field never leaves on one.
    const { runtime: _runtime, deviceId: _deviceId, ...fields } = factsNow();
    return (await call("POST", "/v1/app/errors", { installId: p.report.installId, ...fields, where, message, stack })) === "sent";
  }

  /** One beat. Whatever a check-in still owes goes first: a boot check-in that
   *  could not get through (a login item started before the Wi-Fi), or a UTC day
   *  with no "active" yet. Left to the six-hour timer, that was hours of awake
   *  time — Node's timers stand still while the machine sleeps, so on a laptop it
   *  could be days, and a day the deck was used could end unsaid. Not before a
   *  check-in that could not get through has waited its turn (afterCheckIn), so
   *  an API that is down is not asked again every ten minutes. Then the ping. */
  async function beat() {
    if (!checkingIn && checkInDue() && retryDue()) await checkIn();
    await ping();
  }

  /** The heartbeat timer, rescheduled from itself so each beat carries fresh
   *  jitter — a fixed interval would let a fleet that started as one beat as one.
   *  Unref'd, so it never holds the process open. Each beat also saves the day's
   *  tally if it moved, so a deck that stops loses ten minutes of it at most. */
  function scheduleNextPing() {
    pingTimer = setTimeout(() => {
      samplePeak();
      void beat();
      void saveUsage();
      scheduleNextPing();
    }, PING_EVERY_MS + Math.floor(Math.random() * PING_JITTER_MS));
    pingTimer.unref?.();
  }

  /** Check in once the prefs are read, and every few hours after; and beat a
   *  heartbeat on its own, lighter timer, which also sends whatever a check-in
   *  still owes (beat). Both timers never hold the process open. The first
   *  check-in already puts a freshly launched deck online, so the first ping is
   *  a full interval out — nothing pings at boot. */
  function start() {
    // start() runs as the deck starts listening (index.mjs), so this is the
    // launch: process start to ready. A second start() keeps the first answer.
    if (launchMs == null) {
      try {
        const ms = launchedIn();
        launchMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
      } catch {
        launchMs = null;
      }
    }
    samplePeak();
    const prefsIn = Promise.resolve(ready).catch(() => {});
    // The CLIs are asked their versions as soon as the prefs say reports are on —
    // past boot, beside the wait for the setup — so the first check-in, which
    // waits for the answer, is held up by little or nothing.
    prefsIn.then(() => { if (reportsOn(prefs.current(), env)) void probeVersions(); }).catch(() => {});
    Promise.all([prefsIn, Promise.resolve(setupKnown()).catch(() => {})])
      .then(restoreUsage)
      .then(checkIn)
      .then(() => usage.onFirstUse?.(() => void onFirstSession()));
    if (!timer) {
      timer = setInterval(() => { if (retryDue()) void checkIn(); }, CHECK_IN_EVERY_MS);
      timer.unref?.();
    }
    if (!pingTimer) scheduleNextPing();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = null;
  }

  return {
    checkIn, ping, setReports, reportError, restoreUsage, saveUsage, sendActivation, willReport, reportUninstall,
    noteSelfUpdate, ratingAsk, rate, rateLater, sendRating, start, stop,
  };
}

// ── the deck's own providers ─────────────────────────────────────────────────
//
// Kept here rather than in the modules they read, so reports.mjs stays the one
// place that decides what leaves — and reached by lazy import, so the reporter's
// own module graph does not pull the CLI probe into a fast path like
// `--version` that imports it for nothing. The day's usage tally is imported
// directly: usage-day.mjs imports nothing.

// The CLI versions, detected in the background, off the boot path: the reporter
// runs this once the prefs say reports are on (never under the machine's veto),
// and again on each new UTC day (probeVersions). The last answer is kept until
// the next one lands, and a probe that comes back with less — a wedged shim, a
// timeout — does not take a version it knew away.
let cliVersionCache = {};
async function probeCliVersions() {
  const { detectCliVersions } = await import("./cli-versions.mjs");
  cliVersionCache = { ...cliVersionCache, ...(await detectCliVersions()) };
}

/** The deck's own reporter. */
export const reporter = createReporter({
  versions: () => cliVersionCache, probe: probeCliVersions, depth: deckDepth, npx: isNpxInstall(PKG_ROOT),
});
