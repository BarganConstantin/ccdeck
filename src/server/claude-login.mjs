// Who Claude Code is signed in as right now, and which claude-swap slot that is.
//
// The roster used to call the slot in sequence.json's `activeAccountNumber` the
// active account. claude-swap writes that number only when one of its own
// commands switches or adds, so a `/login` in Claude Code — or `claude auth
// login`, or anything else that signs in without cswap — left it naming the
// previous account for good. The panel showed A while `cswap list` and Claude
// Code's /status both said B; ↻ re-read the same stale number; and Switch on B
// did nothing, because cswap saw it was already on B and wrote nothing.
//
// `cswap list` never trusts that number. It reads the live identity out of
// Claude Code's global config and matches it to a slot (switcher.py
// _get_current_account and _find_account_slot). This module is that rule, so
// the deck and `cswap list` cannot answer "who is active" two ways.
//
// A file read, never a spawn and never the keychain: it runs on every roster
// read. And only when the file has changed: .claude.json can be large, so an
// unchanged one costs a stat, as org-telemetry.mjs keeps it. Only when there is
// no live identity to read — no config file, one that will not parse, or one
// with nobody signed in — does the stored number stand in, which is what the
// roster did before.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { claudePlanToken } from "./depth-facts.mjs";

async function exists(path, statFile) {
  try { await statFile(path); return true; } catch { return false; }
}

/**
 * The global config file Claude Code keeps its signed-in account in, chosen
 * the way claude-swap's paths.py get_global_config_path chooses it: the legacy
 * `<config dir>/.config.json` while Claude Code would still use it, otherwise
 * `($CLAUDE_CONFIG_DIR || home)/.claude.json`.
 */
export async function claudeGlobalConfigPath({
  env = process.env, home = homedir(), platform = process.platform, statFile = stat,
} = {}) {
  const { join } = platform === "win32" ? win32 : posix;
  const configDir = claudeConfigDir(env, home, platform);
  const global = join(env.CLAUDE_CONFIG_DIR?.trim() ? configDir : home, ".claude.json");
  const legacy = join(configDir, ".config.json");
  try {
    const st = await statFile(legacy);
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) !== 0 && !(await exists(global, statFile))))) return legacy;
  } catch { /* no legacy file: the global one */ }
  return global;
}

// The last answer, and the file it was read from: path, mtime and size.
let _last = null;

/**
 * The plan of a signed-in account, as claudePlanToken names it ("max-20x",
 * "pro"…), or null when `oauthAccount` does not say one it knows.
 *
 * Claude Code keeps the plan in two places: `subscriptionType` and
 * `rateLimitTier` beside the token in .credentials.json, and
 * `organizationType` ("claude_max") and `organizationRateLimitTier`
 * ("default_claude_max_20x") here. This is the one every platform has: on
 * macOS the token, and the two fields beside it, are in the Keychain.
 */
export function planOfAccount(oauth) {
  const type = typeof oauth?.organizationType === "string" ? oauth.organizationType.trim().replace(/^claude_/i, "") : "";
  return claudePlanToken({ subscriptionType: type, rateLimitTier: oauth?.organizationRateLimitTier }) ?? null;
}

/**
 * Who Claude Code is signed in as — `{ email, orgUuid }` from the config's
 * `oauthAccount`, and `plan` when planOfAccount can say it — or null when that
 * cannot be read. `orgUuid` is "" for a login with no organization, as
 * claude-swap normalises it.
 */
export async function readLiveLogin({
  env = process.env, home = homedir(), platform = process.platform, statFile = stat, read = readFile,
} = {}) {
  try {
    const path = await claudeGlobalConfigPath({ env, home, platform, statFile });
    const st = await statFile(path);
    if (_last?.path === path && _last.mtimeMs === st.mtimeMs && _last.size === st.size) return _last.login;
    const oauth = JSON.parse(String(await read(path, "utf8")).replace(/^﻿/, ""))?.oauthAccount;
    const email = typeof oauth?.emailAddress === "string" ? oauth.emailAddress : "";
    const plan = planOfAccount(oauth);
    const login = email
      ? { email, orgUuid: typeof oauth.organizationUuid === "string" ? oauth.organizationUuid : "", ...(plan && { plan }) }
      : null;
    _last = { path, mtimeMs: st.mtimeMs, size: st.size, login };
    return login;
  } catch {
    return null;
  }
}

/**
 * The slot holding that login, matched on (email, organizationUuid) exactly as
 * claude-swap's _find_account_slot matches it — the email as written, a slot
 * with no organization key as "" (one whose key is null matches nothing, as
 * there) — or null when no slot holds it.
 */
export function slotOfLogin(seq, login) {
  if (!login) return null;
  for (const [num, acct] of Object.entries(seq?.accounts ?? {})) {
    const org = acct && Object.hasOwn(acct, "organizationUuid") ? acct.organizationUuid : "";
    if (acct?.email === login.email && org === login.orgUuid) return num;
  }
  return null;
}

/**
 * Which slot is active, and on whose word:
 *
 *   - `{ num, unlisted: null, source: "login" }`: Claude Code is signed in as
 *     slot `num`, whatever sequence.json last recorded;
 *   - `{ num: null, unlisted: email, source: "login" }`: it is signed in as an
 *     account claude-swap does not hold, so no row is active and the panel can
 *     say whose login it is;
 *   - `{ num, unlisted: null, source: "store" }`: no live identity could be
 *     read, so sequence.json's number stands, as it always did.
 */
export function activeFrom(seq, login) {
  if (!login) {
    const stored = seq?.activeAccountNumber;
    return { num: stored != null ? String(stored) : null, unlisted: null, source: "store" };
  }
  const num = slotOfLogin(seq, login);
  return { num, unlisted: num == null ? login.email : null, source: "login" };
}
