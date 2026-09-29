// Claude Code's OAuth token, as quota.mjs borrows it: where it is kept, whether
// this machine has one at all, how a request made with it introduces itself,
// and the two limits every such request is under — the floor between two the
// deck pays for, and the 429 cooldown they all share.
//
// Source 2 of the chain lives here too — one GET of the usage endpoint, mapped
// by quota-shape.mjs — because it is nothing more than a request with this
// token. Whether to make it is quota.mjs's decision, taken against the
// self-poll floor; this module knows only how, and when a 429 says to stop.
import { claudeConfigDir } from "./claude-dir.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapOAuthUsage } from "./quota-shape.mjs";

export const USAGE_URL   = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

// Source 2's request, asking for the reset inventory as well as the windows.
const USAGE_WITH_RESETS_URL = `${USAGE_URL}?cedar_ember=1`;

/**
 * How these requests introduce themselves, in the format Claude Code uses for
 * its own.
 *
 * The endpoint decides whether to send the reset inventory by client surface:
 * a User-Agent it does not recognise as Claude Code's CLI gets `eligible:
 * false, ineligible_reason: "surface"` and no grants, and a CLI version it
 * considers too old gets `"cli_version"`. This deck used to send
 * `claude-code/2.1.0`: written to look like Claude Code, in a format the
 * endpoint does not take for it. The windows do not depend on any of this —
 * claude-swap reads the same ones as `claude-swap/1.0`.
 *
 * Pinned rather than read off the installed binary: the version lives in a
 * different place under every install method, and a pin that ages out fails
 * closed — the endpoint stops sending grants, the row disappears, and no number
 * on the panel is wrong. Raising it is the fix when that happens.
 */
const USER_AGENT  = "claude-cli/2.1.283 (external, cli)";

// Floor between two polls WE pay for. Twelve an hour against a budget of
// ~28-30 leaves claude-swap room to collect for every account, which is what
// the accounts panel is made of. Only reached when the store cannot answer.
export const SELF_POLL_MS = 5 * 60_000;

// 429 cooldown gate — after a rate-limit, skip the API until this passes.
let _rateLimitedUntil = 0;

/** When the cooldown ends, or 0 when there is none. For the budget rules,
 *  which take it as an argument so they stay pure. */
export function cooldownUntil() { return _rateLimitedUntil; }

/** Whether a 429 is still being waited out at `now`. */
export function coolingDown(now) { return now < _rateLimitedUntil; }

/** A 429 arrived: hold every request this token makes off for as long as its
 *  `retry-after` says, within the limits cooldownFromHeader keeps. One token,
 *  one budget, so both requests that can be refused back off the same way. */
export function startCooldown(res) {
  _rateLimitedUntil = Date.now() + cooldownFromHeader(res.headers.get("retry-after"), 5 * 60_000);
}

/** The cooldown, forgotten — for resetQuotaPollFloor. */
export function clearCooldown() { _rateLimitedUntil = 0; }

/**
 * Where Claude Code keeps the OAuth credentials this module borrows a token
 * from.
 *
 * It is `.credentials.json` inside the Claude config dir, and that dir moves:
 * CLAUDE_CONFIG_DIR replaces ~/.claude wholesale rather than overlaying it, so
 * on a machine where it is set there is no ~/.claude to read at all. Hardcoding
 * ~/.claude here did not fail loudly — it made readOAuthToken() return null
 * forever, which reads exactly like "this machine keeps its credentials in the
 * Keychain", and the quota chain quietly fell through to source 3 on every poll
 * it was allowed to make. See src/server/claude-dir.mjs, which owns the rule
 * and is the only place it is spelled.
 *
 * Resolved per call rather than frozen into a module-level constant, for the
 * same reason claudeConfigDir() is a function: a constant captured at import
 * time is a value nothing can observe or correct afterwards, and this module is
 * imported lazily by the /api/quota route rather than at a point in startup
 * anyone here controls.
 *
 * Exported for tests — it is the whole of the bug, and it is pure.
 */
export function credentialsPath() {
  return join(claudeConfigDir(), ".credentials.json");
}

export async function readOAuthToken() {
  try {
    const raw  = await readFile(credentialsPath(), "utf8");
    const auth = JSON.parse(raw)?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    // expiresAt is epoch milliseconds. If expired, the CLI fallback handles it.
    if (auth.expiresAt && Date.now() >= auth.expiresAt) return null;
    return auth.accessToken;
  } catch {
    return null;
  }
}

/**
 * A cooldown from a `retry-after`, kept inside limits the deck can live with.
 *
 * Unclamped, the header decided the poller's fate in both directions: `0` (or a
 * value the server rounds down to it) defeats the cooldown entirely and the
 * next tick asks again immediately, which is the loop a 429 exists to stop; a
 * large one — a day is a legal value — freezes the reader for the life of the
 * process, and nothing here re-reads it. Both are the remote side deciding how
 * this deck behaves, which a header is not entitled to do.
 *
 * The floor is the deck's own minimum backoff and the ceiling is an hour: long
 * enough to be a real retreat, short enough that a quota panel is not dead for
 * the rest of the day because one reply said so.
 */
export function cooldownFromHeader(raw, fallbackMs, minMs = 30_000, maxMs = 3600_000) {
  const seconds = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(seconds)) return fallbackMs;
  return Math.min(Math.max(seconds * 1000, minMs), maxMs);
}

/**
 * WHETHER THIS MACHINE HAS A SUBSCRIPTION TO REPORT ON AT ALL.
 *
 * Every source here needs a Claude.ai OAuth credential: the claude-swap store
 * holds one, `claudeAiOauth` in the credentials file is one, and
 * `claude --print /usage` prints windows only for a session signed in with one.
 * An API-key, Bedrock or Vertex install has none — and there is no quota to
 * read, because those are billed per token rather than in five-hour windows.
 *
 * That mattered because of what the CLI does on such a machine: it RUNS, prints
 * no quota lines, and the no-numbers branch of quota.mjs's _doFetch used to
 * read that as "genuine <1%" and publish `ok: true` with two zeroes. The panel
 * then drew empty bars, which is a measurement nobody took. Codex already
 * answers this properly, with `api_key_mode` as its own reason and its own
 * sentence.
 *
 * Cheap and synchronous: environment first, because a machine configured for
 * Bedrock or Vertex says so there, then the presence of the OAuth block in the
 * credentials file. `readOAuthToken` above answers a different question — it
 * also rejects an EXPIRED token, and an expired subscription is still a
 * subscription.
 */
export async function hasSubscriptionCredential(env = process.env) {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1") return false;
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    if (JSON.parse(raw)?.claudeAiOauth?.accessToken) return true;
  } catch { /* absent or unreadable, decided below */ }
  // A key in the environment and no OAuth block beside it is the API-key
  // install. Without either, this deck simply has not been signed in yet, and
  // "sign in" is the right thing to say — which is the `waiting` branch, not
  // this one.
  return !(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

/** The headers every request made with the Claude Code token sends. */
export function oauthHeaders(token) {
  return {
    "Authorization":  `Bearer ${token}`,
    "anthropic-beta": BETA_HEADER,
    "Accept":         "application/json",
    "Content-Type":   "application/json",
    "User-Agent":     USER_AGENT,
  };
}

export async function fetchOAuthUsage() {
  if (coolingDown(Date.now())) return null;
  const token = await readOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(USAGE_WITH_RESETS_URL, {
      headers: oauthHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      startCooldown(res);
      return null;
    }
    if (!res.ok) return null;

    return mapOAuthUsage(await res.json());
  } catch {
    return null;
  }
}
