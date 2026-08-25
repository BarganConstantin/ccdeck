// Fetches Codex/ChatGPT quota from the same endpoint the Codex CLI uses.
// Auth (including token refresh) lives in codex-auth.mjs.
//
// The response is deliberately parsed defensively: OpenAI ships new plan
// types, new limit families and new numeric encodings without warning, and a
// menu-bar-style readout is worth more when it degrades to "some lanes" than
// when one unrecognised field blanks the whole panel. So every section is
// optional, unknown values pass through verbatim, and a `partial` flag tells
// the UI when something was dropped instead of silently showing less.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_HOME } from "./codex-dir.mjs";
import { getCodexAuth, forceCodexRefresh, isCredentialHost } from "./codex-auth.mjs";
import { PRODUCT } from "./brand.mjs";
import { resetLabel } from "./reset-label.mjs";

// Resolved by codex-dir.mjs rather than here. This file used to spell it
// `process.env.CODEX_HOME ?? join(homedir(), ".codex")`, which keeps an empty
// CODEX_HOME instead of falling back — and then read a CWD-relative
// "config.toml" for the base URL every credential below is sent to (#375).
const CONFIG_PATH = join(CODEX_HOME, "config.toml");
const DEFAULT_BASE = "https://chatgpt.com/backend-api";

let _cache   = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

// The last base URL we refused, so the refusal is said once rather than once a
// minute for as long as the config stays that way.
let _warnedBase = null;

// ── base URL ───────────────────────────────────────────────────────────────
// `chatgpt_base_url` in config.toml can point at a proxy, and the path style
// follows from its shape exactly as in the CLI: a /backend-api base speaks
// /wham/*, anything else speaks /api/codex/*.
//
// Whatever it says, the request below carries `Authorization: Bearer
// <accessToken>` — a live ChatGPT session — so the value is not just a routing
// preference, it is the answer to "who gets the credential". It was taken
// verbatim: a line regex, quotes stripped, straight into fetch(), which meant
// anything able to write that TOML (or to set $CODEX_HOME and point it at its
// own) could redirect the token to a host of its choosing, over plaintext http
// if it liked. isCredentialHost is where the two rules live.
async function readBaseUrl() {
  let raw = null;
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    for (const line of text.split("\n")) {
      const m = line.replace(/#.*$/, "").match(/^\s*chatgpt_base_url\s*=\s*(.+?)\s*$/);
      if (m) { raw = m[1].replace(/^["']|["']$/g, "").trim(); break; }
    }
  } catch { /* no config.toml — use the default */ }

  let base = (raw || DEFAULT_BASE).replace(/\/+$/, "");
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)/.test(base) && !base.includes("/backend-api")) {
    base += "/backend-api";
  }
  return base;
}

function usagePath(base)        { return base.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage"; }
function resetCreditsPath(base) { return base.includes("/backend-api") ? "/wham/rate-limit-reset-credits" : "/api/codex/rate-limit-reset-credits"; }

// ── lenient field readers ──────────────────────────────────────────────────
// Team and enterprise payloads send numbers as strings ("limit": "1000"), and
// reset timestamps answer to three different spellings depending on which
// sub-object you are in.
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function resetAt(o) {
  return num(o?.resets_at) ?? num(o?.resetsAt) ?? num(o?.reset_at) ?? null;
}

/** "Jun 18, 4:09pm" — matches the Claude quota formatting so both read alike.
 *
 *  It did not, and the sentence above is why #374 called this one out: this
 *  copy passed the same options to `toLocaleString` and then stripped the comma
 *  and lower-cased the whole string, so it printed "jun 18 4:09pm" where the
 *  Claude lane one row up printed "Jun 18, 4:09pm". Swept over 2,794 instants
 *  the two disagreed on every one. Both read from reset-label.mjs now, and the
 *  claim above is true for the first time. */
const fmtReset = resetLabel;

// ── window classification ──────────────────────────────────────────────────
// Slot position is NOT the lane. Free plans return a weekly window in the
// primary slot, and a 30-day lane can arrive in either slot — labelling by
// slot is how a weekly cap ends up displayed as a 5-hour one. Duration is the
// only trustworthy signal.
const HOUR = 3600;
function laneFor(windowSec) {
  if (windowSec == null || windowSec <= 0) return { key: "unknown", label: "Rate limit", rank: 9 };
  if (windowSec <= 6 * HOUR)       return { key: "session", label: `${Math.round(windowSec / HOUR)}-hour window`, rank: 0 };
  if (windowSec <= 8 * 24 * HOUR)  return { key: "weekly",  label: "7-day window",  rank: 1 };
  return { key: "monthly", label: "30-day window", rank: 2 };
}

/** One rate-limit lane, or null when the window carries no usable reading. */
function toWindow(w, idFallback) {
  const pct = num(w?.used_percent ?? w?.usedPercent);
  if (pct == null) return null;
  const windowSec = num(w?.limit_window_seconds ?? w?.limitWindowSeconds);
  const lane      = laneFor(windowSec);
  const reset     = resetAt(w);
  return {
    id:         idFallback ? `${idFallback}-${lane.key}` : lane.key,
    key:        lane.key,
    label:      lane.label,
    rank:       lane.rank,
    pct,                                   // never clamped — over-quota is real information
    windowSec:  windowSec ?? null,
    resetAt:    reset,
    reset:      fmtReset(reset),
  };
}

/** Both slots of a rate_limit object, ordered by lane rather than by slot. */
function windowsFrom(rl, idPrefix) {
  return [toWindow(rl?.primary_window, idPrefix), toWindow(rl?.secondary_window, idPrefix)]
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

// ── spend control / monthly credit limit ───────────────────────────────────
// Three places can carry it, in this precedence. Whichever answers first wins.
function creditLimitFrom(data) {
  const src = data?.individual_limit
           ?? data?.rate_limit?.individual_limit
           ?? data?.spend_control?.individual_limit;
  const limit = num(src?.limit);
  if (!limit || limit <= 0) return null;

  const remainingPct = num(src?.remaining_percent ?? src?.remainingPercent);
  const used = num(src?.used) ?? (remainingPct != null ? limit * Math.max(0, Math.min(100, 100 - remainingPct)) / 100 : 0);
  const pct  = remainingPct != null ? Math.max(0, Math.min(100, 100 - remainingPct)) : (used / limit) * 100;
  const reset = resetAt(src);

  return {
    limit,
    used,
    usedPct:   pct,
    remaining: num(src?.remaining) ?? Math.max(0, limit - used),
    source:    src?.source ?? null,
    resetAt:   reset,
    reset:     fmtReset(reset),
  };
}

// ── plan labels ────────────────────────────────────────────────────────────
// OpenAI's marketing names, since "pro" alone tells the user nothing about
// which of the two Pro tiers they are on.
const PLAN_LABELS = { pro: "Pro 20x", prolite: "Pro 5x", pro_lite: "Pro 5x", "pro-lite": "Pro 5x" };
function planLabel(plan) {
  if (!plan || typeof plan !== "string") return null;
  const k = plan.toLowerCase().replace(/\s+/g, "_");
  if (PLAN_LABELS[k]) return PLAN_LABELS[k];
  if (k === "k12" || k === "cbp") return k.toUpperCase();
  return k.split(/[_-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

// ── extra limit families (Codex Spark and friends) ────────────────────────
// `additional_rate_limits` is an ARRAY of {limit_name, metered_feature,
// rate_limit}, not a map. Decoded element-wise so one malformed entry costs
// only itself.
function extraLimits(data) {
  const arr = data?.additional_rate_limits;
  if (!Array.isArray(arr)) return { extras: [], damaged: arr != null };

  const extras = [];
  let damaged = false;
  for (const entry of arr) {
    try {
      const slug = String(entry?.metered_feature ?? entry?.limit_name ?? "extra")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const title = entry?.limit_name ?? entry?.metered_feature ?? "Codex extra limit";
      for (const w of windowsFrom(entry?.rate_limit, slug)) {
        extras.push({ ...w, label: `${title} · ${w.label}`, family: slug });
      }
    } catch { damaged = true; }
  }
  return { extras, damaged };
}

// ── fetch ──────────────────────────────────────────────────────────────────
function authHeaders(auth, { accountIdHeader = "ChatGPT-Account-Id", extra = {} } = {}) {
  const h = {
    "Authorization": `Bearer ${auth.accessToken}`,
    "Accept":        "application/json",
    "User-Agent":    "codex-cli",
    ...extra,
  };
  if (auth.accountId) h[accountIdHeader] = auth.accountId;
  if (auth.isFedramp) h["X-OpenAI-Fedramp"] = "true";
  return h;
}

/**
 * Reset credits ("one free rate limit reset" grants). Best-effort and short-
 * timeout: it is a nice-to-have next to the gauges, never a reason to fail
 * the quota read. Read-only — we never redeem.
 */
async function fetchResetCredits(base, auth) {
  try {
    const res = await fetch(base + resetCreditsPath(base), {
      // This endpoint alone wants the uppercase-ID spelling and the beta
      // headers; sending the wham/usage set here returns nothing useful.
      headers: authHeaders(auth, {
        accountIdHeader: "ChatGPT-Account-ID",
        extra: { "OpenAI-Beta": "codex-1", "originator": "Codex Desktop" },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const count = num(body?.available_count);
    if (count == null || count < 0) return null;
    const next = (body?.credits ?? [])
      .filter(c => c?.status === "available" && c?.expires_at)
      .map(c => Date.parse(c.expires_at))
      .filter(t => !isNaN(t))
      .sort((a, b) => a - b)[0] ?? null;
    return { availableCount: count, nextExpiryAt: next };
  } catch { return null; }
}

async function requestUsage(base, auth) {
  return fetch(base + usagePath(base), {
    headers: authHeaders(auth),
    // Quota is per-account state; a cached response is how one account's
    // gauges end up shown for another.
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
}

// One outstanding fetch at a time. Several browser tabs mounting at once
// otherwise each force their own round trip — and each one is another chance
// to race over the single-use refresh token.
let _inflight = null;

// ── what a forced read may cost ────────────────────────────────────────────
// The floor between two reads WE pay for, and it is the same number and the
// same rule quota.mjs gives the Claude half — see FORCE_POLL_MS and maySelfPoll
// there. The two routes are four lines apart in the router and had no business
// disagreeing about what `?refresh=1` costs.
//
// `force` used to mean "skip the cache", and the cache was the ONLY thing
// between a caller and chatgpt.com. `_inflight` deduplicates callers that
// overlap and nothing else, so a caller that waits for one fetch to settle and
// then asks again got a fresh round trip every time — two authenticated HTTPS
// GETs carrying the user's live ChatGPT session, as fast as the round trip
// allows, from any page the user happens to have open (#580). Reads on this
// server are deliberately open (isTrustedRead), so "any page" is the real
// threat model rather than a hypothetical one.
//
// The sharper half is the credential rather than the traffic. On a 401
// doFetchCodexQuota spends the SINGLE-USE refresh token via forceCodexRefresh,
// and `staleAccessToken` only stops that happening twice for the same rejected
// token — every turn re-reads auth.json and sees the token the previous turn
// rotated to, so a backend that keeps answering 401 rotated a fresh credential
// once per request, racing the Codex CLI for each one. codex-auth.mjs's own
// EXPIRY_SKEW_MS comment says what losing that race costs the user: a
// `refresh_token_reused` that reads as "your login is broken", recoverable only
// with `codex login`.
const FORCE_POLL_MS = 60_000;

// Set from a 429 or a rejected refresh: a backend that is refusing us must not
// be asked once per request, whoever is asking. Same shape as quota.mjs's
// _rateLimitedUntil, which is likewise never beaten by force.
let _rateLimitedUntil = 0;
const COOLDOWN_MS = 5 * 60_000;

// Stamped when a fetch STARTS rather than when it lands: what the floor is
// rationing is the round trip, and one that is still in flight has already been
// paid for.
let _lastFetchAt = 0;

/**
 * Whether we may spend a request of the user's ChatGPT session right now.
 *
 * Exported for tests, for the same reason quota.mjs exports maySelfPoll: this
 * is the rule, it is pure, and it is worth pinning down away from the fetch it
 * guards.
 */
export function mayFetchQuota({ now, lastFetchAt, rateLimitedUntil }) {
  if (now < rateLimitedUntil) return false;
  return now - lastFetchAt >= FORCE_POLL_MS;
}

/**
 * The answer to a read the floor refused.
 *
 * A reading, not an error — a user who clicks ↻ twice in a second must get the
 * numbers they already have rather than a red hint, which is exactly what
 * quota.mjs does with `{ ...held, stale: true }`. The timestamp stays the one
 * the data was fetched at, so the panel's age label keeps telling the truth
 * instead of vouching for a reading it did not take.
 */
function heldReading(now) {
  if (_cache) return { ..._cache, stale: true };
  // Only reachable before the first fetch has ever landed — `finish` caches
  // every outcome, failures included — and spelled the way the Claude side
  // spells the same two states.
  return { ok: false, reason: now < _rateLimitedUntil ? "rate_limited" : "waiting", fetchedAt: now };
}

export function fetchCodexQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return Promise.resolve(_cache);
  // Joining a run already in flight costs nothing, so it is offered before the
  // floor: what refresh asks for is a reading newer than the cache, and a fetch
  // that has not landed yet is one.
  if (_inflight) return _inflight;
  if (!mayFetchQuota({ now, lastFetchAt: _lastFetchAt, rateLimitedUntil: _rateLimitedUntil })) {
    return Promise.resolve(heldReading(now));
  }
  _lastFetchAt = now;
  _inflight = doFetchCodexQuota().finally(() => { _inflight = null; });
  return _inflight;
}

async function doFetchCodexQuota() {
  const started = Date.now();
  // Stamped at completion, not at entry: the two calls below can take up to
  // 17s between them, and a cache entry that is already stale on arrival
  // shortens the effective TTL for no reason.
  const finish = (r) => { _cache = r; _cacheAt = Date.now(); return r; };
  const fail   = (reason) => finish({ ok: false, reason, fetchedAt: started });
  // A refusal we were told about, rather than one we inferred: back off further
  // than the ordinary floor before asking again. `retry-after` is honoured when
  // the backend sends one, because it knows better than the constant does.
  const cooldown = (res) => {
    const after = parseInt(res?.headers?.get?.("retry-after") ?? "", 10);
    _rateLimitedUntil = Date.now() + (Number.isFinite(after) ? after * 1000 : COOLDOWN_MS);
  };

  let auth, base, res;
  try {
    auth = await getCodexAuth();
    if (!auth.ok) return fail(auth.reason);

    // An API key in auth.json is a platform credential, not a ChatGPT session —
    // sending it here only produces a confusing 401.
    if (auth.apiKeyMode) return fail("api_key_mode");

    base = await readBaseUrl();
    // Refused before the first byte goes out, and reported rather than
    // swallowed: a panel that says "Codex quota is off because the configured
    // base URL is not an OpenAI one" is a bug report the user can act on, where
    // a silently empty gauge is a mystery. Logged once per distinct value so a
    // 60-second poll does not turn a misconfiguration into a log flood.
    if (!isCredentialHost(base)) {
      if (_warnedBase !== base) {
        _warnedBase = base;
        console.error(
          `${PRODUCT} codex-quota: not sending the ChatGPT token to ${base} — ` +
          `chatgpt_base_url must be an https OpenAI host`,
        );
      }
      return fail("untrusted_base_url");
    }
    res  = await requestUsage(base, auth);

    // The JWT's own `exp` is not the last word: OpenAI revokes server-side, so
    // a token that looks valid locally can still come back expired. One forced
    // refresh + retry turns that from "bar goes dark" into a hiccup.
    //
    // 401 only. A 403 from chatgpt.com is usually a bot check or a blocked
    // egress IP rather than a bad token, and rotating a single-use credential
    // once a minute against a network-layer block is how a working login gets
    // destroyed.
    if (res.status === 401) {
      const refreshed = await forceCodexRefresh(auth.accessToken);
      if (!refreshed.ok) {
        // The credential is gone and only `codex login` brings it back, so
        // rotating another single-use token at the next request would burn the
        // one the CLI is still holding. Wait.
        if (refreshed.reason === "refresh_rejected") cooldown(null);
        return fail(refreshed.reason);
      }
      auth = refreshed;
      res  = await requestUsage(base, auth);
    }

    if (!res.ok) {
      // A second 401 means the token we just rotated to was rejected as well —
      // the case that turned into one rotation per request. 429 is the backend
      // saying the same thing in the ordinary way.
      if (res.status === 401 || res.status === 429) cooldown(res);
      return fail(res.status === 401 ? "refresh_rejected" : `http_${res.status}`);
    }
  } catch (err) {
    console.error(`${PRODUCT} codex-quota: fetch failed:`, err?.message ?? err);
    return fail("fetch_error");
  }

  let data;
  try { data = await res.json(); }
  catch { return fail("decode_error"); }

  const rl              = data?.rate_limit;
  const windows         = windowsFrom(rl);
  const { extras, damaged } = extraLimits(data);
  const creditsRaw      = data?.credits;
  const balance         = num(creditsRaw?.balance);

  const result = {
    ok:           true,
    limitReached: rl?.limit_reached ?? false,
    allowed:      rl?.allowed ?? true,

    // Lanes, already ordered session → weekly → monthly and labelled by the
    // window duration the API actually reported.
    windows,
    extraWindows: extras,

    plan:      data?.plan_type ?? auth.planType ?? null,
    planLabel: planLabel(data?.plan_type ?? auth.planType),
    email:     data?.email ?? auth.email ?? null,

    creditsBalance:   balance != null && balance > 0 ? String(creditsRaw.balance) : null,
    creditsUnlimited: creditsRaw?.unlimited === true,
    overageReached:   creditsRaw?.overage_limit_reached === true,
    creditLimit:      creditLimitFrom(data),

    spendControlReached: data?.spend_control?.reached === true,
    reachedType:         data?.rate_limit_reached_type?.type ?? data?.rate_limit_reached_type ?? null,
    promo:               data?.promo?.message ?? null,

    // True when something in the payload did not decode — the UI says "partial"
    // rather than pretending the missing lanes do not exist.
    partial:   damaged || windows.length === 0,
    refreshed: auth.refreshed === true,
    fetchedAt: started,
  };

  result.resetCredits = await fetchResetCredits(base, auth);

  return finish(result);
}
