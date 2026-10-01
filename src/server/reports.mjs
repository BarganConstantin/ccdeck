// Usage reports, on unless the person switched them off (#1853). They are NOT
// anonymous: with reports on, every one carries a stable, hashed device id — an
// identifier for this machine — and the server records the IP the report arrives
// from. What never leaves is the person's sessions, prompts, files, project
// names and paths.
//
// WHAT GOES OUT, to api.ccdeck.dev, while `prefs.reports` is true and the
// machine has not vetoed it (reportsVetoed):
//
//   - an "install" event the first time,
//   - an "update" event, with the version it came from, when the version moves,
//   - an "active" event at most once a UTC day, which is how many people use
//     ccdeck gets counted without counting anything else about them, and which
//     alone also carries coarse counts of how much: how many sessions,
//     subagents and projects the deck heard from on the last day it was used,
//     and that day's date — numbers, never their names (see usage-day.mjs) —
//     and which of the deck's features were used that day, as fixed names
//     ("usage-history", "account-switch") and nothing about what was done
//     with them (feature-use.mjs),
//   - an "uninstall" event when somebody runs `ccdeck --uninstall`, with the
//     reason they picked from a short list if they picked one (bin/cli/leaving.js),
//   - an "activated" event, once, when a new install's first session arrives:
//     how long after the install it came, as a bucket ("5m", "1h", "1d", "7d",
//     "later"), and whether it was a Claude or a Codex session (activation.mjs),
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
import { FEATURES, usageDay, utcDay } from "./usage-day.mjs";
import { setupFacts, sinceInstallBucket, whenSetupKnown } from "./activation.mjs";

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

/** Why somebody uninstalled, when they said: the answers `ccdeck --uninstall`
 *  offers (bin/cli/leaving.js), and nothing else ever leaves as a reason. */
export const UNINSTALL_REASONS = Object.freeze(["not-useful", "too-noisy", "broken", "other-tool", "privacy", "other"]);

const EMPTY_REPORT = Object.freeze({
  installId: "", lastVersion: "", lastActiveDay: "", forget: "", usage: null,
  installedAt: "", firstSessionAt: "", firstProvider: "", activationSent: false,
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
 * @param {ReturnType<typeof import("./usage-day.mjs").createUsageDay>} [deps.usage]
 *   the day's tally: the "active" report carries the last finished day's totals,
 *   read only when an "active" is about to be sent, and the tally is saved into
 *   the prefs so a restart does not lose the day. Default: the deck's own.
 * @param {() => { claudeHooks?: string, codexWatch?: string }} [deps.setup] what the
 *   boot set up, folded into install, update and active (activation.mjs).
 * @param {() => Promise<unknown>} [deps.setupKnown] what start() waits for besides the
 *   prefs, so the first install event carries the setup. Bounded.
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
  usage = usageDay,
  setup = setupFacts,
  setupKnown = () => whenSetupKnown(),
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
      return out;
    } catch {
      return {};
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
        prev.reports === false || prev.report.installId
          ? undefined
          // When the id is made is when this install began: the clock the first
          // session is measured against. Kept here, never sent as a time.
          : { report: { ...prev.report, installId: randomUUID(), installedAt: now().toISOString() } },
      );
    }
    const { installId, lastVersion, lastActiveDay } = prefs.current().report;
    if (!installId) return;
    if (!lastVersion) {
      if (await call("POST", "/v1/app/events", { installId, kind: "install", ...factsNow(), ...setupNow() })) {
        await remember(installId, { lastVersion: facts.version });
      }
    } else if (lastVersion !== facts.version) {
      if (await call("POST", "/v1/app/events", { installId, kind: "update", fromVersion: lastVersion, ...factsNow(), ...setupNow() })) {
        await remember(installId, { lastVersion: facts.version });
      }
    }

    const today = utcDay(now());
    if (lastActiveDay !== today) {
      // Usage rides on the "active" event alone, and is read only here — the one
      // report it belongs to — so a checkIn that sends nothing new never asks the
      // deck for its counts.
      const used = coarseUsage(today);
      if (await call("POST", "/v1/app/events", { installId, kind: "active", ...factsNow(), ...setupNow(), ...used })) {
        if (used.usageDay) usage.markSent(used.usageDay);
        await remember(installId, { lastActiveDay: today });
      }
    }
    await sendActivation();
    await saveUsage();
  }

  /**
   * The install's first session, said once: an "activated" event with how long
   * after the install it came, in a bucket, and which CLI it came from.
   *
   * Only for an install whose start this deck saw — `installedAt` is made with
   * the id, so an install from before this version has none and is never
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
    if (await call("POST", "/v1/app/events", body)) await remember(r.installId, { activationSent: true });
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
      return await call("POST", "/v1/app/events", body);
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
   *  Unref'd, so it never holds the process open. Each beat also saves the day's
   *  tally if it moved, so a deck that stops loses ten minutes of it at most. */
  function scheduleNextPing() {
    pingTimer = setTimeout(() => {
      void ping();
      void saveUsage();
      scheduleNextPing();
    }, PING_EVERY_MS + Math.floor(Math.random() * PING_JITTER_MS));
    pingTimer.unref?.();
  }

  /** Check in once the prefs are read, and every few hours after; and beat a
   *  heartbeat on its own, lighter timer. Both timers never hold the process
   *  open. The first check-in already puts a freshly launched deck online, so the
   *  first ping is a full interval out — nothing pings at boot. */
  function start() {
    Promise.all([Promise.resolve(ready).catch(() => {}), Promise.resolve(setupKnown()).catch(() => {})])
      .then(restoreUsage)
      .then(checkIn)
      .then(() => usage.onFirstUse?.(() => void onFirstSession()));
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

  return { checkIn, ping, setReports, reportError, restoreUsage, saveUsage, sendActivation, willReport, reportUninstall, start, stop };
}

// ── the deck's own providers ─────────────────────────────────────────────────
//
// Kept here rather than in the modules they read, so reports.mjs stays the one
// place that decides what leaves — and reached by lazy import, so the reporter's
// own module graph does not pull the CLI probe into a fast path like
// `--version` that imports it for nothing. The day's usage tally is imported
// directly: usage-day.mjs imports nothing.

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
export const reporter = createReporter({ versions: deckCliVersions });
