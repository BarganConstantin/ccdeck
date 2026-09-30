// Anonymous reports, on unless the person switched them off (#1853).
//
// WHAT GOES OUT, to api.ccdeck.dev, while `prefs.reports` is true and the
// machine has not vetoed it (reportsVetoed):
//
//   - an "install" event the first time,
//   - an "update" event, with the version it came from, when the version moves,
//   - an "active" event at most once a UTC day, which is how many people use
//     ccdeck gets counted without counting anything else about them,
//   - errors: a request handler that threw on this server, or an error the page
//     caught, with home folders, email addresses and key-shaped strings
//     scrubbed out before they leave.
//
// Each carries the install id, the version, the OS and CPU architecture, the
// channel (the desktop app or npm) and the runtime. Nothing about a session, a
// project, a prompt, a path or a person: the install id is random, made at the
// first check-in, and tied to nothing on the machine.
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

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { inApp } from "./app-host.mjs";
import { reportsVetoed } from "./deck-prefs.mjs";
import { heldPrefs, prefsRead } from "./prefs-state.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";

export const REPORTS_API = "https://api.ccdeck.dev";
const TIMEOUT_MS = 6000;
/** How often a long-running deck checks whether a new day wants its "active". */
const CHECK_IN_EVERY_MS = 6 * 60 * 60 * 1000;
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

/** What every report says about the install, and nothing else. */
export function installFacts({
  version = RUNNING_VERSION,
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
  env = process.env,
} = {}) {
  return {
    version: String(version),
    os: platform,
    arch,
    channel: inApp(env) ? "desktop" : "npm",
    runtime: versions.electron ? `electron-${versions.electron}` : `node-${versions.node}`,
  };
}

/**
 * Take out of an error what could say who someone is. The API scrubs again;
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
      /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{48,})/g,
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
 */
export function createReporter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  prefs = heldPrefs,
  env = process.env,
  facts = installFacts({ env }),
  home = homedir(),
  ready = prefsRead,
} = {}) {
  const errorsSent = [];
  const lastSentAt = new Map();
  let timer = null;

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
      if (await call("POST", "/v1/app/events", { installId, kind: "install", ...facts })) {
        await remember(installId, { lastVersion: facts.version });
      }
    } else if (lastVersion !== facts.version) {
      if (await call("POST", "/v1/app/events", { installId, kind: "update", fromVersion: lastVersion, ...facts })) {
        await remember(installId, { lastVersion: facts.version });
      }
    }

    const today = now().toISOString().slice(0, 10);
    if (lastActiveDay !== today && (await call("POST", "/v1/app/events", { installId, kind: "active", ...facts }))) {
      await remember(installId, { lastActiveDay: today });
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
    const { runtime: _runtime, ...fields } = facts;
    return call("POST", "/v1/app/errors", { installId: p.report.installId, ...fields, where, message, stack });
  }

  /** Check in once the prefs are read, and every few hours after, on a timer
   *  that never holds the process open. */
  function start() {
    Promise.resolve(ready).catch(() => {}).then(checkIn);
    if (!timer) {
      timer = setInterval(() => void checkIn(), CHECK_IN_EVERY_MS);
      timer.unref?.();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { checkIn, setReports, reportError, start, stop };
}

/** The deck's own reporter. */
export const reporter = createReporter();
