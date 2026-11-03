// The Codex side of `ccdeck tui`: the deck's Codex accounts, drawn as the rows
// the Claude list draws, with the deck's Codex panel's words and rules
// (CodexProfilesSection.tsx, codex-accounts.ts, i18n/areas/codex/en.ts).
//
// Pure. The deck keeps the accounts (GET /api/codex-profiles), each one's
// quota (GET /api/codex-profile-quota?id=) and Codex's own Auto-switch (GET
// /api/codex-auto); bin/cli/tui.js reads them and hands them in. A Codex
// account has no slot, so a row's number is its place in the list — what 1-9
// select — and the account's id travels with the row for every action on it.
import { oneLine } from "./cli-lines.mjs";

/** A window's length as the deck's quota bars name it (codex-accounts.ts
 *  windowLabel): hours up to six, days past them. */
export function windowLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "limit";
  const hours = s / 3_600;
  return hours <= 6 ? `${Math.round(hours)}h` : `${Math.round(s / 86_400)}d`;
}

/**
 * A quota answer's windows as the two lanes a row has room for: the shorter
 * window in the 5-hour lane, the longer in the weekly one, each named by its
 * own length. A plan with one window (Plus reports the week alone) fills the
 * lane its length belongs to.
 */
export function codexLanes(quota) {
  if (!quota || quota.ok === false || !Array.isArray(quota.windows)) return [];
  const windows = quota.windows
    .filter(w => w && Number.isFinite(Number(w.usedPercent)))
    .sort((x, y) => (Number(x.seconds) || 0) - (Number(y.seconds) || 0));
  const lane = (w, id) => ({
    id, label: windowLabel(w.seconds), pct: Math.max(0, Math.min(100, Number(w.usedPercent))),
    resetAt: Number.isFinite(Number(w.resetAt)) ? Number(w.resetAt) : null,
  });
  if (!windows.length) return [];
  if (windows.length === 1) return [lane(windows[0], Number(windows[0].seconds) > 6 * 3_600 ? "seven_day" : "five_hour")];
  return [lane(windows[0], "five_hour"), lane(windows.at(-1), "seven_day")];
}

/** The accounts the deck serves, or none. */
export const codexProfiles = (state) => (Array.isArray(state.codex?.profiles) ? state.codex.profiles : []);

/** Whether the deck has a Codex side to show: it answered, with an account. */
export const hasCodex = (state) => codexProfiles(state).length > 0;

/** No login at all, by the source Codex reads it from (codex-accounts.ts signedOut). */
export function signedOut(p) {
  if (p.metadataUnavailable) return false;
  return p.authSource === "native" ? !p.signedIn : !p.signedInFilePresent;
}

const NOT_SIGNED_IN = {
  word: "not signed in", tone: "warn", blocks: true, fix: "Sign in",
  hint: "This account has no Codex login yet, so there is nothing to read and nothing to switch to.",
};

/** What reading an account's usage ran into, the deck's word for each. */
function quotaProblem(reason) {
  switch (reason) {
    case "no_token": return NOT_SIGNED_IN;
    case "expired":
    case "reauth_required":
      return {
        word: "login expired", tone: "warn", blocks: true, fix: "Sign in again",
        hint: "Codex no longer accepts this account's login. Signing in again replaces it; the account keeps its settings and history.",
      };
    case "api_key_mode":
      return { word: "uses an API key", tone: "muted", blocks: false, hint: "This account runs on an API key, which has no ChatGPT limits to read." };
    case "cli_unavailable":
      return { word: "Codex not found", tone: "warn", blocks: false, hint: "The deck cannot find the codex command on this machine, so it cannot read this account." };
    case "unsupported":
    case "unsupported_auth":
    case "quota_unavailable":
      return { word: "usage not available", tone: "muted", blocks: false, hint: "This version of Codex does not report usage for this account. Updating Codex may bring it back." };
    case "http_429":
      return { word: "rate limited", tone: "muted", blocks: false, hint: "OpenAI is throttling usage requests for this account. It clears on its own." };
    default:
      return { word: "temporary error", tone: "muted", blocks: false, hint: "A network or Codex hiccup while reading usage. The next read tries again." };
  }
}

/**
 * What is wrong with an account, first things first (codex-accounts.ts
 * codexIssue): `{ word, hint, tone, blocks, fix }`, or null. `blocks` is a
 * switch that cannot help; `fix` the sign-in that can.
 */
export function codexIssue(p, quota, profiles = []) {
  if (p.available === false) {
    return { word: "folder missing", tone: "warn", blocks: true, hint: "The deck cannot find this account's Codex folder, so it cannot read it or switch to it." };
  }
  if (signedOut(p)) return NOT_SIGNED_IN;
  if (p.metadataUnavailable) return quotaProblem(p.metadataReason ?? "unknown");
  if (p.sameAccountAs) {
    const other = profiles.find(o => o.id === p.sameAccountAs);
    return {
      word: other?.active ? "same as your default" : "same as another row", tone: "warn", blocks: false, fix: "Sign in again",
      hint: "Both rows are signed in to one ChatGPT account, so they share one quota and switching gains nothing.",
    };
  }
  // A login that moved while it was read is the moment after a sign-in: the
  // next reading has the answer.
  if (quota && quota.ok === false && quota.reason !== "profile_changed") return quotaProblem(quota.reason ?? "unknown");
  return null;
}

/** A reading is stale past this, as the deck's panel has it. */
export const CODEX_STALE_MS = 15 * 60_000;

/**
 * The accounts as rows: `{ num, id, email, alias, active, disabled, managed,
 * lanes, fetchedAt, stale, plan, issue, headroom, codex: true }`. The alias is
 * the name a person gave the account, the address its login's. A reading for
 * an earlier login of the account (`identityVersion`) is not its reading.
 */
export function codexRows(state, now = null) {
  const profiles = codexProfiles(state);
  const held = new Set(Array.isArray(state.codexAuto?.heldOut) ? state.codexAuto.heldOut : []);
  const quotas = state.codexQuota ?? {};
  return profiles.map((p, i) => {
    let quota = quotas[p.id] ?? null;
    if (quota?.identityVersion && p.identityVersion && quota.identityVersion !== p.identityVersion) quota = null;
    const good = quota?.ok === false ? quota.lastGood ?? null : quota;
    const lanes = codexLanes(good);
    const fetchedAt = typeof good?.fetchedAt === "number" ? good.fetchedAt : null;
    const alias = oneLine(p.managedLabel) || null;
    return {
      num: i + 1,
      id: p.id,
      email: oneLine(p.account) || (alias ? null : oneLine(p.label)) || null,
      alias,
      active: p.active === true,
      disabled: held.has(p.id),
      managed: p.managed === true,
      lanes,
      fetchedAt,
      stale: quota?.ok === false || good?.stale === true || (now != null && fetchedAt != null && now - fetchedAt > CODEX_STALE_MS),
      plan: typeof good?.plan === "string" ? good.plan : null,
      issue: codexIssue(p, quota, profiles),
      headroom: lanes.length ? 100 - Math.max(...lanes.map(l => l.pct)) : null,
      codex: true,
    };
  });
}

/**
 * The deck's Codex ⋯ menu for a row, by its rules: the switch where it can
 * help, the sign-in (in place, keeping the account), rename, rotation on every
 * account but the default unless it is already out, and remove on the
 * accounts the deck made.
 */
export function codexMenuItems(row) {
  const blocked = row.issue?.blocks === true;
  return [
    !row.active && !blocked ? { id: "switch", key: "enter", label: "Switch to this account" } : null,
    { id: "signin", key: "i", label: row.issue?.fix ?? (signedInWord(row) ? "Sign in again" : "Sign in") },
    { id: "rename", key: "n", label: "Rename…" },
    !row.active || row.disabled ? { id: "hold", key: "o", label: row.disabled ? "Put back in rotation" : "Hold out of rotation" } : null,
    row.managed ? { id: "remove", key: "x", label: "Remove…", danger: true } : null,
  ].filter(Boolean);
}
const signedInWord = (row) => row.issue?.word !== "not signed in";

/** A name the deck takes for a Codex account (codex-selection.mjs): up to 80
 *  characters, no slash, no control character. Empty takes the name away. */
export function codexNameTrouble(label) {
  const t = String(label ?? "").trim();
  if (!t) return null;
  if (/[\\/]/.test(t)) return "a name cannot hold a slash";
  if (/[\x00-\x1f\x7f]/.test(t) || t.length > 80) return "up to 80 characters, no slash";
  return null;
}

/** Why the deck refused a Codex change, in the panel's words. */
export const CODEX_REFUSED = Object.freeze({
  selection_conflict: "another change moved the accounts just then — try again",
  operation_conflict: "another change moved the accounts just then — try again",
  selection_busy: "the deck is busy with another account change — try again",
  unknown_profile: "the deck does not know that account any more",
  invalid_label: "a name cannot hold a slash, and has 80 characters at most",
  not_removable: "only accounts added in the deck can be removed here",
  profile_unavailable: "the deck cannot find this account's Codex folder",
});

/**
 * What a switch did to the Codex that is running, from the deck's `live`
 * answer: `{ tone, text }`, the panel's own sentences.
 */
export function codexLiveSaid(live, name) {
  const state = live?.state;
  if (state === "failed" || state === "unavailable" || state === "disconnected") {
    return { tone: "warn", text: `${name} is the default, but the open Codex app could not switch — check its account with /status` };
  }
  if (state === "external_change") {
    return { tone: "warn", text: "Codex account control is paused after a login change or lost connection — check /status in Codex" };
  }
  if (live?.continuation === "manual_required") {
    return { tone: "warn", text: `switched to ${name} — automatic continuation could not be confirmed; check the conversation` };
  }
  if (state === "waiting") return { tone: "info", text: `switching to ${name} once running tools and pending input are done` };
  if (live?.continuation === "waiting") return { tone: "ok", text: `switched to ${name} — waiting for subagents to resume` };
  if (state === "applied") return { tone: "ok", text: `switched to ${name} — connected Codex conversations use it now` };
  return { tone: "ok", text: `${name} is the default — new Codex sessions use it` };
}

// ── the sign-in ─────────────────────────────────────────────────────────────
//
// `codex login --device-auth`, run by the deck in the account's own folder:
// a link to open in any browser and a code to type there. Nothing comes back
// to type here, and it finishes by itself — which is why it works from a phone
// over SSH as well as at the desk.

/** The sign-in page's states: `{ id, name, adding, started, login }`, `login`
 *  the deck's GET /api/codex-profile-login-state answer. */
export const CODEX_LOGIN_LIVE = new Set(["starting", "waiting"]);
export const CODEX_LOGIN_FAILED = Object.freeze({
  codex_missing: "the deck cannot find the codex command on this machine",
  no_code: "codex did not print a sign-in code",
  login_failed: "codex did not finish the sign-in",
  code_expired: "the code expired before it was entered — enter starts a new one",
});

/** Whether the deck is still running the sign-in. */
export const codexSigninRunning = (si) => Boolean(si?.started) && (!si.login || CODEX_LOGIN_LIVE.has(si.login.state) || si.login.state === "idle");
