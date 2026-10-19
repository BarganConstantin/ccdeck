// Whether this deck has a ccdeck account at all — the switch, the two vetoes
// and the API it would talk to.
//
// HIDDEN, AND OFF. The account (Settings › Account, the status frames, the
// settings sync) is built and not released: nothing about it is public until
// its owner says so. Off has to mean ABSENT, the way the terminal panel's flag
// means it on its branch: every /api/account* route answers the 404 an /api
// path with no route answers, /api/prefs says `accountOn: false`, none of the
// account modules is imported and no request goes to the API. This file is the
// one piece that is always loaded, because it is what decides — and it imports
// nothing but the product's name, does nothing as it loads and touches no file,
// so loading it costs a deck with the account off nothing.
//
// TWO WAYS ON, TWO WAYS OFF, AND OFF WINS. The launch variable turns it on for
// one run; `account: true` in prefs.json turns it on for good — deck-owned and
// hand-edited, never written by a page (not in PAGE_FIELDS while hidden). The
// vetoes are whoever launched the deck saying no for this machine, which a
// stored switch must not overrule: AGENTS_DECK_NO_ACCOUNT, and
// AGENTS_DECK_NO_INSTALL, which the README promises "turns off everything but
// the quota reads". AGENTS_DECK_NO_REPORTS is NOT a veto: reports are on by
// default and nobody asked for them; an account is something somebody connects
// on purpose, and the two identities are never linked (account-client.mjs).
//
// THE VARIABLES ARE UNDOCUMENTED ON PURPOSE. CCDECK_ACCOUNT and
// CCDECK_ACCOUNT_API stay out of the README and out of the login item while the
// feature is hidden; readme-order.test.ts names them as a decision, so
// documenting them later is a decision too. The veto is carried by the login
// item (login-service.mjs SETTING_VARS), because a veto is always safe to pass
// on — and stays out of the README's table for the same reason the switch does.
import { PRODUCT } from "./brand.mjs";

/** Set to "1" to switch the account on for this run, whatever prefs.json says. */
export const ACCOUNT_ENV = "CCDECK_ACCOUNT";

/** Set to "1" to keep this deck away from any account, whatever else says so. */
export const NO_ACCOUNT_ENV = "AGENTS_DECK_NO_ACCOUNT";

/** Where the API is, for development: a local ccdeck-api on loopback. */
export const ACCOUNT_API_ENV = "CCDECK_ACCOUNT_API";

/** The API the account talks to. The same host the usage reports go to
 *  (reports.mjs REPORTS_API), a different channel on it: nothing the reports
 *  send rides here, and nothing sent here rides there. */
export const ACCOUNT_API_DEFAULT = "https://api.ccdeck.dev";

/** Did the machine rule the account out? Asked before anything else, every
 *  time: a vetoed deck reads no token and sends nothing. */
export function accountVetoed(env = process.env) {
  return env[NO_ACCOUNT_ENV] === "1" || env.AGENTS_DECK_NO_INSTALL === "1";
}

/** Is the account feature on, right now? The launch variable or the stored
 *  switch, unless the machine vetoed it. Asked on every request rather than
 *  once at boot, so the routes and the boot can never disagree about whether
 *  the feature exists. Only "1" and only a real `true` count: a truthy string
 *  in a hand-edited file is not an answer anybody gave. */
export function accountOn(prefs, env = process.env) {
  if (accountVetoed(env)) return false;
  return env[ACCOUNT_ENV] === "1" || prefs?.account === true;
}

/** Did anybody ask for the account — the variable or the stored switch —
 *  whether or not a veto then said no? What Settings needs to tell "off on this
 *  machine" from "not a thing here". */
export function accountRequested(prefs, env = process.env) {
  return env[ACCOUNT_ENV] === "1" || prefs?.account === true;
}

/** Hosts a development API may sit on: this machine, by any spelling of it. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The API base the account talks to, as an origin with no trailing slash.
 *
 * An override is accepted only as `https://…`, or as plain http on this
 * machine's own loopback — a ccdeck-api run with `dotnet run`. Anything else
 * (a LAN address over http, a URL with a path or credentials in it, garbage)
 * is not a development API: it is ignored, said once, and the default is used.
 * A device token must never travel over plain http to another machine.
 */
export function accountApiBase(env = process.env, warn = warnOnce) {
  const raw = typeof env[ACCOUNT_API_ENV] === "string" ? env[ACCOUNT_API_ENV].trim() : "";
  if (!raw) return ACCOUNT_API_DEFAULT;
  const base = acceptedApiBase(raw);
  if (base) return base;
  warn(`${ACCOUNT_API_ENV} is not an https:// URL or a loopback http:// URL; using ${ACCOUNT_API_DEFAULT}`);
  return ACCOUNT_API_DEFAULT;
}

/** `raw` as an origin, or null when it is not one the account may use. */
export function acceptedApiBase(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.origin;
  return null;
}

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.error(`${PRODUCT}: ${message}`);
}
