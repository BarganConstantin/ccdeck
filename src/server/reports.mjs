// Anonymous reports, on unless the person switched them off (#1853).
//
// WHAT GOES OUT, to api.ccdeck.dev, while `prefs.reports` is true and the
// machine has not vetoed it (reportsVetoed):
//
//   - an "install" event the first time,
//   - an "update" event, with the version it came from, when the version moves,
//   - an "active" event at most once a UTC day, which is how many people use
//     ccdeck gets counted without counting anything else about them, and which
//     alone also carries coarse counts of how much: how many sessions,
//     subagents and projects — numbers, never their names,
//   - errors: a request handler that threw on this server, or an error the page
//     caught, with home folders, email addresses and key-shaped strings
//     scrubbed out before they leave,
//   - a "ping" heartbeat, every ten minutes or so while the deck runs, which
//     moves the install's "last seen" so the admin can show who is online now.
//     It writes no event and carries the install id alone — no facts, no
//     fingerprint.
//
// Each event carries the install id, the version, the OS and CPU architecture,
// the channel (the desktop app, npm, or a source checkout) and the runtime, plus
// a coarse sketch of the environment: the logical CPU count, the RAM in MB, the
// locale, the shell and terminal names, and the Claude Code and Codex CLI
// versions. Every one of those is a small fixed token or a number, safe by
// construction — no path, no hostname, no user name, no project name, no prompt,
// no free text ever reaches any field, so there is nothing in them to scrub. A
// field that cannot be told is left out rather than guessed. The install id is
// random, made at the first check-in, and tied to nothing on the machine.
//
// The one field that IS derived from the machine is `deviceId`, sent ONLY when
// AGENTS_DECK_FINGERPRINT=1 (off by default, so nothing is even transmitted until
// consent turns it on). It is a stable
// per-machine fingerprint on install/update/active (never on ping or errors). It
// is personal data, so it leaves only as a one-way hash of stable machine traits,
// never those traits in the clear (see deviceIdToken), and the API keeps it only
// while a server-side consent flag is on — off today — so sending it is harmless
// now and becomes meaningful once consent is live.
//
// NOBODY IS ASKED, AND NOTHING IS HIDDEN. The owner chose on-by-default
// (2026-09-30): the README says what is sent, Appearance holds the switch, and
// AGENTS_DECK_NO_REPORTS=1 keeps it off from the first start.
//
// SWITCHING IT OFF DELETES WHAT WAS SENT. The id is forgotten here and the API
// is asked to drop every event and error it holds for it; if that request
// cannot get through, the id waits in `report.forget` and the ask is repeated
// on the next start, so switching off while offline still ends in a deletion.
//
// NOTHING HERE THROWS OR WAITS FOR ANYBODY. A report that cannot be sent is
// dropped: it is a nicety for the people who make ccdeck, and no part of the
// deck depends on it.

import { createHash, randomUUID } from "node:crypto";
import { arch as osArch, cpus as osCpus, homedir, hostname, platform as osPlatform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inApp } from "./app-host.mjs";
import { reportsVetoed } from "./deck-prefs.mjs";
import { isGitCheckout } from "./install-layout.mjs";
import { heldPrefs, prefsRead } from "./prefs-state.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";

export const REPORTS_API = "https://api.ccdeck.dev";
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMEOUT_MS = 6000;
/** How often a long-running deck checks whether a new day wants its "active". */
const CHECK_IN_EVERY_MS = 6 * 60 * 60 * 1000;
/** The heartbeat's beat: a lighter timer than the check-in that only moves the
 *  install's "last seen", so the admin can count who is online now. Ten minutes,
 *  plus up to `PING_JITTER_MS` of random spread, so a fleet started together does
 *  not all beat on the same tick. */
const PING_EVERY_MS = 10 * 60 * 1000;
const PING_JITTER_MS = 2 * 60 * 1000;
/** Errors per hour this deck may send, and how long one error is not repeated. */
const ERRORS_PER_HOUR = 20;
const SAME_ERROR_QUIET_MS = 60 * 60 * 1000;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;

const EMPTY_REPORT = Object.freeze({ installId: "", lastVersion: "", lastActiveDay: "", forget: "" });

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
 * details cannot be read back out of what leaves. It is precisely because it is
 * identifying that the API stores it only while a server-side consent flag is on
 * (off today) and drops it otherwise — so the reporter may always send it, and it
 * stays harmless until consent is live. The token is hex, so it matches the API's
 * `^[0-9A-Za-z.+_-]+$` shape and its 16 characters sit well under the 64 cap.
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
 *  on Windows there is no `SHELL` (unless a Git-Bash-style one set it), so the
 *  hints are PowerShell's `PSModulePath` and cmd's `ComSpec`. */
export function shellToken(env = process.env, platform = process.platform) {
  const sh = env?.SHELL;
  if (sh) return token(baseName(sh), TOKEN_CAPS.shell);
  if (platform === "win32") {
    if (env?.PSModulePath) return "pwsh";
    const comSpec = env?.ComSpec ?? env?.COMSPEC;
    return comSpec ? token(baseName(comSpec), TOKEN_CAPS.shell) : "cmd";
  }
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
  deviceId = env.AGENTS_DECK_FINGERPRINT === "1" ? deviceIdToken() : undefined,
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
 * @param {() => ({ sessions?: number, subagents?: number, projects?: number } | Promise<...>)} [deps.usage]
 *   the coarse counts the "active" report carries, read only when an "active" is
 *   about to be sent. Default: none.
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
  usage = () => ({}),
} = {}) {
  const errorsSent = [];
  const lastSentAt = new Map();
  let timer = null;
  let pingTimer = null;

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

  /** The full facts an event carries: the fixed install facts, plus whatever CLI
   *  versions are known this moment. */
  function factsNow() {
    return { ...facts, ...versionFacts() };
  }

  /** The coarse usage the "active" report carries: only whole counts of zero or
   *  more survive, and a provider that throws or is slow costs the report
   *  nothing. */
  async function coarseUsage() {
    try {
      const raw = (await usage()) ?? {};
      const out = {};
      addIf(out, "sessions", count(raw.sessions));
      addIf(out, "subagents", count(raw.subagents));
      addIf(out, "projects", count(raw.projects));
      return out;
    } catch {
      return {};
    }
  }

  async function call(method, path, body) {
    try {
      const res = await fetchImpl(REPORTS_API + path, {
        method,
        headers: { "content-type": "application/json", "user-agent": `ccdeck/${facts.version}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Change the reporter's state, but only while it still belongs to `installId`:
   *  a switch-off that landed in between has the last word. */
  function remember(installId, change) {
    return prefs.update(prev =>
      prev.report.installId === installId ? { report: { ...prev.report, ...change } } : undefined,
    );
  }

  /** Send whatever is due: a pending deletion, then install or update, then
   *  today's "active". Never throws: a floating rejection here would be an
   *  unhandled one, and Node's answer to those is to end the process. */
  async function checkIn() {
    try {
      await sendWhatIsDue();
    } catch {
      // A settings file that cannot be written this minute; the next check-in tries again.
    }
  }

  async function sendWhatIsDue() {
    // The machine's veto covers the deletion too: a deck launched to stay off
    // the network stays off it, and the deletion waits for a launch without it.
    if (reportsVetoed(env)) return;
    const p = prefs.current();
    const { forget } = p.report ?? EMPTY_REPORT;
    if (forget && (await call("DELETE", `/v1/app/installs/${encodeURIComponent(forget)}`))) {
      await prefs.update(prev => (prev.report.forget === forget ? { report: { ...prev.report, forget: "" } } : undefined));
    }
    if (!reportsOn(prefs.current(), env)) return;

    // The id is made here, the first time there is something to send under it.
    if (!prefs.current().report.installId) {
      await prefs.update(prev =>
        prev.reports === false || prev.report.installId ? undefined : { report: { ...prev.report, installId: randomUUID() } },
      );
    }
    const { installId, lastVersion, lastActiveDay } = prefs.current().report;
    if (!installId) return;
    if (!lastVersion) {
      if (await call("POST", "/v1/app/events", { installId, kind: "install", ...factsNow() })) {
        await remember(installId, { lastVersion: facts.version });
      }
    } else if (lastVersion !== facts.version) {
      if (await call("POST", "/v1/app/events", { installId, kind: "update", fromVersion: lastVersion, ...factsNow() })) {
        await remember(installId, { lastVersion: facts.version });
      }
    }

    const today = now().toISOString().slice(0, 10);
    if (lastActiveDay !== today) {
      // Usage rides on the "active" event alone, and is read only here — the one
      // report it belongs to — so a checkIn that sends nothing new never asks the
      // deck for its counts.
      const used = await coarseUsage();
      if (await call("POST", "/v1/app/events", { installId, kind: "active", ...factsNow(), ...used })) {
        await remember(installId, { lastActiveDay: today });
      }
    }
  }

  /** The heartbeat. While reports are on and an id exists, tell the API this deck
   *  is still here — it moves the install's "last seen" and writes no event, so it
   *  carries the id and nothing else: no facts, no deviceId. Like every send it is
   *  dropped if it cannot get through, and it never throws. No id yet means the
   *  first check-in has not run, so there is nothing to be online under and
   *  nothing is sent; the check-in that makes the id is what puts this deck
   *  online, and the ping only keeps that fresh. */
  async function ping() {
    try {
      const p = prefs.current();
      if (!reportsOn(p, env) || !p.report.installId) return;
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
    return call("POST", "/v1/app/errors", { installId: p.report.installId, ...fields, where, message, stack });
  }

  /** The heartbeat timer, rescheduled from itself so each beat carries fresh
   *  jitter — a fixed interval would let a fleet that started as one beat as one.
   *  Unref'd, so it never holds the process open. */
  function scheduleNextPing() {
    pingTimer = setTimeout(() => {
      void ping();
      scheduleNextPing();
    }, PING_EVERY_MS + Math.floor(Math.random() * PING_JITTER_MS));
    pingTimer.unref?.();
  }

  /** Check in once the prefs are read, and every few hours after; and beat a
   *  heartbeat on its own, lighter timer. Both timers never hold the process
   *  open. The first check-in already puts a freshly launched deck online, so the
   *  first ping is a full interval out — nothing pings at boot. */
  function start() {
    Promise.resolve(ready).catch(() => {}).then(checkIn);
    if (!timer) {
      timer = setInterval(() => void checkIn(), CHECK_IN_EVERY_MS);
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

  return { checkIn, ping, setReports, reportError, start, stop };
}

// ── the deck's own providers ─────────────────────────────────────────────────
//
// Kept here rather than in the modules they read, so reports.mjs stays the one
// place that decides what leaves — and reached by lazy import, so the reporter's
// own module graph does not pull the session tracker, the enrichment cache or
// the CLI probe into a fast path like `--version` that imports it for nothing.

/** The coarse counts the "active" report carries, read from the state the deck
 *  already keeps — the LRU of tracked sessions and the per-session subagent
 *  signatures. Never new tracking, and never anything but a number: no session
 *  id, name or path. `projects` is left out for now — its only source is the
 *  disk-backed, per-account rollup (account-projects.mjs), which has no cheap
 *  synchronous count — so the field is simply not sent. */
async function deckUsage() {
  const out = {};
  try {
    const { trackedSessionCount } = await import("./session-tracking.mjs");
    out.sessions = trackedSessionCount();
  } catch { /* count unavailable: omitted */ }
  try {
    const { trackedSubagentCount } = await import("./session-enrichment.mjs");
    out.subagents = trackedSubagentCount();
  } catch { /* count unavailable: omitted */ }
  return out;
}

// The CLI versions, detected once in the background, off the boot path. The
// first send starts the probe (past boot, and not while the machine has vetoed
// reports) and reads back an empty answer; the version rides along on the
// reports that follow, once the probe has filled this cache.
let cliVersionCache = {};
let cliProbeStarted = false;
function deckCliVersions() {
  if (!cliProbeStarted && !reportsVetoed(process.env)) {
    cliProbeStarted = true;
    import("./cli-versions.mjs")
      .then(m => m.detectCliVersions())
      .then(v => { cliVersionCache = { ...cliVersionCache, ...v }; })
      .catch(() => { /* a probe that could not run leaves the versions unsent */ });
  }
  return cliVersionCache;
}

/** The deck's own reporter. */
export const reporter = createReporter({ versions: deckCliVersions, usage: deckUsage });
