// Connecting this deck to a ccdeck account: the device authorization grant,
// in the shape RFC 8628 gives it (design 1.5).
//
//   1. POST /v1/device/authorize with the name the person chose → a user code
//      for the browser, and a device code that stays in this process.
//   2. The page opens the approval page; the person signs in and approves.
//   3. This polls POST /v1/device/token every `interval` seconds until the API
//      says approved, denied or expired.
//
// NOT A LOOPBACK REDIRECT, and the reasons are this deck's: a redirect back to
// 127.0.0.1 is a cross-site navigation that has to act, which is exactly what
// request-gates.mjs refuses; the port moves; and the browser that approves is
// often on another machine. The browser only ever sees the short user code.
//
// THE ANSWERS, and what each does here:
//   200                      approved: the token goes to `onApproved`, once
//   authorization_pending    poll again after `interval`
//   slow_down                poll again, with the longer interval it names
//   access_denied            stop: "Cancelled in the browser"
//   expired_token            stop: offer Connect again
//   invalid_grant            stop
//   401 / 404                the API has accounts off: "not open yet"
//   429                      wait as asked, then poll again
//   5xx, no answer           poll again at `interval` — which is also what
//                            recovers a LOST 200: the API mints a fresh token
//                            for a second success poll inside 120 s and kills
//                            the first, so the deck never needs the one it
//                            did not receive.
import { hostname } from "node:os";

/** The longest name a device may have (design 3.2). */
export const DEVICE_NAME_MAX = 48;

/** The name a deck offers before anybody has typed one: what LAN sync calls
 *  this machine when the user has not said (lan-engine.mjs defaultName) —
 *  repeated rather than imported, so the account never loads the LAN engine. */
export function defaultDeviceName(host = hostname()) {
  return cleanDeviceName(String(host ?? "").replace(/\.local$/i, ""), "this machine");
}

/**
 * A device name as the API will take it: C0 and C1 controls replaced, Unicode
 * format characters (bidi overrides, zero-width marks) removed, whitespace
 * collapsed, at most DEVICE_NAME_MAX characters. The rule lan-sync.mjs
 * cleanName applies to a deck's LAN name, at the account's own length.
 */
export function cleanDeviceName(raw, fallback = "") {
  if (typeof raw !== "string") return fallback;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped ? [...stripped].slice(0, DEVICE_NAME_MAX).join("").trim() : fallback;
}

/** A field the API's token pattern takes (design 3.2: os, arch, channel, version). */
const TOKEN_PATTERN = /^[0-9A-Za-z.+_-]+$/;
export function deckToken(value, max) {
  const s = String(value ?? "");
  return s && s.length <= max && TOKEN_PATTERN.test(s) ? s : "unknown";
}

/** Whether a URL the API handed back may be opened: https, or http on this
 *  machine's loopback when the API itself is a development one there. */
export function openableUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The authorize answer, checked: everything the flow needs, or null. */
export function parseAuthorize(body, at = Date.now()) {
  if (!body || typeof body !== "object") return null;
  const { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval } = body;
  if (typeof deviceCode !== "string" || !/^ccdc_[A-Za-z0-9_-]{16,128}$/.test(deviceCode)) return null;
  if (typeof userCode !== "string" || !/^[A-Z]{4}-[A-Z]{4}$/.test(userCode)) return null;
  if (!openableUrl(verificationUri) || !openableUrl(verificationUriComplete)) return null;
  if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 3600) return null;
  const every = Number.isInteger(interval) && interval > 0 && interval <= 60 ? interval : 5;
  return {
    deviceCode, userCode, verificationUri, verificationUriComplete,
    expiresAt: at + expiresIn * 1000,
    interval: every,
  };
}

/** The token answer, checked: the fields the deck keeps, or null. */
export function parseTokenResponse(body) {
  if (!body || typeof body !== "object") return null;
  const { accessToken, deviceId, name, account, settings, status } = body;
  if (typeof accessToken !== "string" || !/^ccdd_[A-Za-z0-9_-]{20,128}$/.test(accessToken)) return null;
  if (typeof deviceId !== "string" || !deviceId) return null;
  if (!account || typeof account.id !== "string" || typeof account.email !== "string") return null;
  return {
    accessToken,
    deviceId,
    name: typeof name === "string" ? name : "",
    account: { id: account.id, email: account.email },
    settings: settings && typeof settings === "object"
      ? {
        mode: settings.mode === "shared" ? "shared" : "independent",
        profileId: typeof settings.profileId === "string" ? settings.profileId : null,
        revision: Number.isInteger(settings.revision) && settings.revision >= 0 ? settings.revision : 0,
      }
      : { mode: "independent", profileId: null, revision: 0 },
    everySec: Number.isInteger(status?.everySec) && status.everySec > 0 ? status.everySec : 15,
  };
}

/**
 * The flow. One connect at a time: starting again cancels the one before, and
 * a poll that lands after a cancel is dropped by its generation.
 *
 * `onApproved(token)` is handed parseTokenResponse's answer, once; it stores
 * the token and starts everything else, and may throw (a store that failed),
 * which ends the flow with `connect-failed`. `onChange()` is told whenever
 * `state()` would answer something new.
 */
export function createConnectFlow({
  client,
  facts,
  onApproved,
  onChange = () => {},
  now = Date.now,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = t => clearTimeout(t),
}) {
  let generation = 0;
  let pending = null;   // { deviceCode, userCode, verificationUri, verificationUriComplete, expiresAt, interval }
  let timer = null;
  let problem = null;

  const state = () => ({
    connecting: pending != null,
    connect: pending ? {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    } : null,
    problem,
  });

  function stop(why = null) {
    generation++;
    if (timer) clearTimer(timer);
    timer = null;
    pending = null;
    problem = why;
    onChange();
  }

  function schedule(gen, ms) {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; void poll(gen); }, ms);
  }

  async function poll(gen) {
    if (gen !== generation || !pending) return;
    if (now() >= pending.expiresAt) return stop("connect-expired");
    const res = await client.post("/v1/device/token", { deviceCode: pending.deviceCode });
    if (gen !== generation || !pending) return;
    if (res.ok) {
      const token = parseTokenResponse(res.body);
      if (!token) return schedule(gen, pending.interval * 1000);
      // Stop polling BEFORE handing the token on: an approval is delivered
      // once, and a second success poll would mint a new token and kill this.
      generation++;
      pending = null;
      try {
        await onApproved(token);
        problem = null;
      } catch {
        problem = "connect-failed";
      }
      return onChange();
    }
    if (res.network || res.status >= 500) return schedule(gen, pending.interval * 1000);
    if (res.status === 429) return schedule(gen, res.retryAfterMs ?? pending.interval * 1000);
    if (res.status === 401 || res.status === 404) return stop("api-disabled");
    const interval = Number.isInteger(res.body?.interval) && res.body.interval > 0 ? res.body.interval : null;
    switch (res.error) {
      case "authorization_pending":
        if (interval) pending.interval = interval;
        return schedule(gen, pending.interval * 1000);
      case "slow_down":
        pending.interval = interval ?? pending.interval + 5;
        return schedule(gen, pending.interval * 1000);
      case "access_denied": return stop("connect-denied");
      case "expired_token": return stop("connect-expired");
      default: return stop("connect-failed");
    }
  }

  /** Ask the API for a code. Resolves when the code is in hand (or refused);
   *  the approval arrives later, through `onApproved`. */
  async function start(name) {
    stop(null);
    const gen = generation;
    const res = await client.post("/v1/device/authorize", {
      name, os: facts.os, arch: facts.arch, version: facts.version, channel: facts.channel,
    });
    if (gen !== generation) return state();
    if (!res.ok) {
      problem = res.network ? "offline"
        : res.status === 401 || res.status === 404 ? "api-disabled"
        : res.status === 429 ? "rate-limited"
        : "connect-failed";
      onChange();
      return state();
    }
    const code = parseAuthorize(res.body, now());
    if (!code) {
      problem = "connect-failed";
      onChange();
      return state();
    }
    pending = code;
    problem = null;
    schedule(gen, code.interval * 1000);
    onChange();
    return state();
  }

  return {
    start,
    cancel: () => stop(null),
    state,
    /** For the suite: poll now rather than after the interval. */
    pollNow: () => poll(generation),
  };
}
