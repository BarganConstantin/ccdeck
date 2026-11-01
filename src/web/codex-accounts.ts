// Codex's accounts as the accounts panel draws them.
//
// Codex's column uses Claude's own row, fold and warning (AccountRow.tsx,
// OtherAccounts.tsx, AccountIssuePopover.tsx), so what a person learns in one
// column holds in the other. This file is the translation: a Codex profile and
// its reading become the Account those components read, and what can go wrong
// with one is said in the product's voice. Nothing here touches React.
import { type AccountIssue } from "./account-issue";
import { type Account, type Lane } from "./claude-accounts";
import { laneKey } from "./lane-open";
import { headroomAt } from "./lane-view";
import { type Peer } from "./other-accounts";
import { type RowVoice } from "./components/AccountRow";

export interface CodexProfile {
  id: string;
  label: string;
  identityVersion: string;
  active: boolean;
  signedInFilePresent: boolean;
  signedIn?: boolean;
  authSource?: string;
  metadataUnavailable?: boolean;
  metadataReason?: string | null;
  available?: boolean;
  /** An account this deck made, which is the only kind it removes. */
  managed?: boolean;
  /** The name somebody gave it. */
  managedLabel?: string;
  /** Who it is signed in as, or null. */
  account?: string | null;
  /** Another row signed in to this same ChatGPT account. */
  sameAccountAs?: string;
}

export interface ProfileQuota {
  ok: boolean;
  identityVersion?: string;
  reason?: string;
  stale?: boolean;
  partial?: boolean;
  lastGood?: ProfileQuota;
  fetchedAt?: number;
  plan?: string | null;
  windows?: { usedPercent: number; seconds: number | null; resetAt: number | null }[];
}

/** How often the panel reads the default account, and the others. The server
 *  keeps one usage request a minute per account, so neither costs a second one. */
export const DEFAULT_READ_MS = 60_000;
export const OTHER_READ_MS = 5 * 60_000;
/** Nothing read for this long is a record rather than a reading, as on Claude's. */
const STALE_MS = 15 * 60_000;

export const CODEX_VOICE: RowVoice = {
  idPrefix: "codex-",
  liveTitle: () => "Default account for new sessions",
  liveSpoken: () => "Default account:",
  readBy: "When the deck last read this account's usage",
  readPlan: "When the deck last read this account's usage, and when it plans to read it again: "
    + "each minute for the default account and every five for the others, while this panel is open. "
    + "These are the limits Codex reports for the account, so a plan with one window shows one bar.",
  neverRead: "The deck has not read this account yet",
  switched: "Now active. New sessions from the deck start on it, and the terminal's codex too once "
    + "terminal selection is on (in ⋯). Running ones keep their account.",
};

/** A window's name the way the Claude column says it, and the lane id that makes
 *  Claude's order choices (5h · fullest, 7d · emptiest) work on it. */
function laneOf(window: NonNullable<ProfileQuota["windows"]>[number], index: number): Lane {
  const { seconds, usedPercent: pct, resetAt } = window;
  if (!seconds || seconds <= 0) return { id: `w${index}`, label: "limit", pct, resetAt };
  if (seconds <= 6 * 3600) {
    const hours = Math.round(seconds / 3600);
    return { id: hours === 5 ? "five_hour" : `w${index}`, label: `${hours}h`, pct, resetAt };
  }
  const days = Math.round(seconds / 86400);
  return { id: days === 7 ? "seven_day" : `w${index}`, label: `${days}d`, pct, resetAt };
}

export function lanesOf(quota: ProfileQuota | null | undefined): Lane[] {
  return (quota?.windows ?? []).map(laneOf);
}

/** What a reading says about one profile, or null before there is one. A reading
 *  taken for a login that has since changed is never shown as this profile's. */
export function readingFor(profile: CodexProfile, quota: ProfileQuota | null | undefined): ProfileQuota | null {
  if (!quota) return null;
  const version = quota.identityVersion ?? quota.lastGood?.identityVersion;
  return (quota.ok || quota.stale) && version !== profile.identityVersion ? { ok: false, reason: "profile_changed" } : quota;
}

/** Trouble that says nothing about the account and clears on the next read. */
const passing = (reason: string | undefined) => !reason || reason === "fetch_error" || reason === "timeout"
  || reason === "rpc_error" || reason === "protocol_error" || reason === "native_busy" || reason === "output_limit"
  || reason === "decode_error" || /^http_5\d\d$/.test(reason);

/**
 * The reading to hold after a read. A read that failed in passing keeps the
 * numbers on screen, drawn as the last reading, the way the server does for a
 * reading it holds itself: a poll that timed out once should not empty a row.
 */
export function nextReading(previous: ProfileQuota | null | undefined, value: ProfileQuota): ProfileQuota {
  if (value.ok || value.stale || !passing(value.reason)) return value;
  const good = previous?.ok ? previous : previous?.lastGood;
  return good ? { ...value, stale: true, lastGood: good } : value;
}

const NOT_SIGNED_IN: AccountIssue = {
  text: "Not signed in",
  hint: "This account has no Codex login yet, so there is nothing to read and nothing to switch to.",
  fix: "Sign in",
  tone: "warn",
  blocksSwitch: true,
};

function quotaProblem(reason: string): AccountIssue {
  switch (reason) {
    case "no_token":
      return NOT_SIGNED_IN;
    case "expired":
    case "reauth_required":
      return {
        text: "Login expired",
        hint: "Codex no longer accepts this account's login. Signing in again replaces it; the account keeps its settings and history.",
        fix: "Sign in again",
        tone: "warn",
        blocksSwitch: true,
      };
    case "api_key_mode":
      return {
        text: "Uses an API key",
        hint: "This account runs on an API key, which has no ChatGPT limits to read.",
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    case "cli_unavailable":
      return {
        text: "Codex not found",
        hint: "The deck cannot find the codex command on this machine, so it cannot read this account. Install Codex, or start the deck where codex is on the PATH.",
        fix: null,
        tone: "warn",
        blocksSwitch: false,
      };
    case "unsupported":
    case "unsupported_auth":
    case "quota_unavailable":
      return {
        text: "Usage not available",
        hint: "This version of Codex does not report usage for this account. Updating Codex may bring it back.",
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    case "http_429":
      return {
        text: "Rate limited",
        hint: "OpenAI is throttling usage requests for this account. It clears on its own.",
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    default:
      return {
        text: "Temporary error",
        hint: "A network or Codex hiccup while reading usage. The next read tries again.",
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
  }
}

/** Whether Codex itself has said nobody is signed in here. */
export function signedOut(profile: CodexProfile): boolean {
  if (profile.metadataUnavailable) return false;
  return profile.authSource === "native" ? !profile.signedIn : !profile.signedInFilePresent;
}

/** What is wrong with an account, for the row, the notice and the popover. */
export function codexIssue(profile: CodexProfile, reading: ProfileQuota | null, roster: readonly CodexProfile[]): AccountIssue | null {
  if (profile.available === false) {
    return {
      text: "Folder missing",
      hint: "The deck cannot find this account's Codex folder, so it cannot read it or switch to it.",
      fix: null,
      tone: "warn",
      blocksSwitch: true,
    };
  }
  if (signedOut(profile)) return NOT_SIGNED_IN;
  if (profile.metadataUnavailable) return quotaProblem(profile.metadataReason ?? "unknown");
  if (profile.sameAccountAs) {
    const other = roster.find(p => p.id === profile.sameAccountAs);
    return {
      text: other?.active ? "Same as your default" : "Same as another row",
      hint: "Both rows are signed in to one ChatGPT account, so they share one quota and switching gains nothing. "
        + "The sign-in page uses the account your browser is signed in to: sign out of ChatGPT there first, then sign in here with a different one, or remove this row.",
      fix: "Sign in",
      tone: "warn",
      blocksSwitch: false,
    };
  }
  // A login that moved while it was being read is the moment after a sign-in,
  // not a state: the panel reads it again and has nothing to say meanwhile.
  if (reading && !reading.ok && reading.reason !== "profile_changed") return quotaProblem(reading.reason ?? "unknown");
  return null;
}

/** The reading a row draws its numbers from. */
export function shownReading(reading: ProfileQuota | null): ProfileQuota | null {
  return reading?.ok ? reading : reading?.stale ? reading.lastGood ?? null : null;
}

/** One profile as the row reads an account. `num` is its place in the roster:
 *  Codex has no slots, and the row only uses it to tell its rows apart. */
export function codexAccount(
  profile: CodexProfile,
  num: number,
  reading: ProfileQuota | null,
  { nowMs, heldOut = [] }: { nowMs: number; heldOut?: readonly string[] },
): Account {
  const shown = shownReading(reading);
  const lanes = lanesOf(shown);
  const fetchedAt = shown?.fetchedAt ?? null;
  return {
    num,
    alias: profile.managedLabel ?? null,
    email: profile.account ?? (profile.managedLabel ? null : profile.label),
    org: null,
    // The profile's id stands where Claude's organisation does, so two rows on
    // one address are still two rows to the open-row memory (lane-open.ts).
    orgUuid: profile.id,
    active: profile.active,
    disabled: heldOut.includes(profile.id),
    lanes,
    headroom: lanes.length ? Math.max(0, 100 - Math.max(...lanes.map(l => l.pct))) : null,
    fetchedAt,
    nextAt: fetchedAt == null ? null : fetchedAt + (profile.active ? DEFAULT_READ_MS : OTHER_READ_MS),
    stale: fetchedAt == null ? false : nowMs - fetchedAt > STALE_MS || (!!reading && !reading.ok),
    error: null,
  };
}

/** The accounts behind the fold, as its row counts them. Whether a switch would
 *  work is the same rule the row's own Switch is withheld by. */
export function codexPeers(rows: readonly { account: Account; issue: AccountIssue | null }[], nowSec: number): Peer[] {
  return rows.map(({ account: a, issue }) => ({
    key: laneKey(a),
    name: a.alias ?? a.email ?? `account ${a.num}`,
    ready: !a.disabled && !issue?.blocksSwitch,
    why: a.disabled ? "held out" : issue?.blocksSwitch ? issue.text : null,
    warn: issue?.tone === "warn",
    headroom: headroomAt(a, nowSec),
  }));
}
