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
import { t as translateNow, type TFunction } from "./i18n";

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

export function codexVoice(t: TFunction = translateNow): RowVoice {
  return {
    idPrefix: "codex-",
    liveTitle: () => t("codex.row.liveTitle"),
    liveSpoken: () => t("codex.row.liveSpoken"),
    readBy: t("codex.row.readBy"),
    readPlan: t("codex.row.readPlan"),
    neverRead: t("codex.row.neverRead"),
    switched: t("codex.row.switched"),
  };
}

/** A window's name the way the Claude column says it, and the lane id that makes
 *  Claude's order choices (5h · fullest, 7d · emptiest) work on it. */
function laneOf(window: NonNullable<ProfileQuota["windows"]>[number], index: number, t: TFunction): Lane {
  const { seconds, usedPercent: pct, resetAt } = window;
  if (!seconds || seconds <= 0) return { id: `w${index}`, label: t("codex.lane.limit"), pct, resetAt };
  if (seconds <= 6 * 3600) {
    const hours = Math.round(seconds / 3600);
    return { id: hours === 5 ? "five_hour" : `w${index}`, label: `${hours}h`, pct, resetAt };
  }
  const days = Math.round(seconds / 86400);
  return { id: days === 7 ? "seven_day" : `w${index}`, label: `${days}d`, pct, resetAt };
}

export function lanesOf(quota: ProfileQuota | null | undefined, t: TFunction = translateNow): Lane[] {
  return (quota?.windows ?? []).map((window, index) => laneOf(window, index, t));
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

function notSignedIn(t: TFunction): AccountIssue {
  return {
    text: t("codex.issue.notSignedIn"),
    hint: t("codex.issue.notSignedIn.hint"),
    fix: t("codex.issue.signIn"),
    tone: "warn",
    blocksSwitch: true,
  };
}

function quotaProblem(reason: string, t: TFunction): AccountIssue {
  switch (reason) {
    case "no_token":
      return notSignedIn(t);
    case "expired":
    case "reauth_required":
      return {
        text: t("codex.issue.expired"),
        hint: t("codex.issue.expired.hint"),
        fix: t("codex.issue.signInAgain"),
        tone: "warn",
        blocksSwitch: true,
      };
    case "api_key_mode":
      return {
        text: t("codex.issue.apiKey"),
        hint: t("codex.issue.apiKey.hint"),
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    case "cli_unavailable":
      return {
        text: t("codex.issue.cliMissing"),
        hint: t("codex.issue.cliMissing.hint"),
        fix: null,
        tone: "warn",
        blocksSwitch: false,
      };
    case "unsupported":
    case "unsupported_auth":
    case "quota_unavailable":
      return {
        text: t("codex.issue.noUsage"),
        hint: t("codex.issue.noUsage.hint"),
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    case "http_429":
      return {
        text: t("codex.issue.rateLimited"),
        hint: t("codex.issue.rateLimited.hint"),
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    default:
      return {
        text: t("codex.issue.temporary"),
        hint: t("codex.issue.temporary.hint"),
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
export function codexIssue(
  profile: CodexProfile, reading: ProfileQuota | null, roster: readonly CodexProfile[], t: TFunction = translateNow,
): AccountIssue | null {
  if (profile.available === false) {
    return {
      text: t("codex.issue.folderMissing"),
      hint: t("codex.issue.folderMissing.hint"),
      fix: null,
      tone: "warn",
      blocksSwitch: true,
    };
  }
  if (signedOut(profile)) return notSignedIn(t);
  if (profile.metadataUnavailable) return quotaProblem(profile.metadataReason ?? "unknown", t);
  if (profile.sameAccountAs) {
    const other = roster.find(p => p.id === profile.sameAccountAs);
    return {
      text: other?.active ? t("codex.issue.sameAsDefault") : t("codex.issue.sameAsOther"),
      hint: t("codex.issue.same.hint"),
      fix: t("codex.issue.signIn"),
      tone: "warn",
      blocksSwitch: false,
    };
  }
  // A login that moved while it was being read is the moment after a sign-in,
  // not a state: the panel reads it again and has nothing to say meanwhile.
  if (reading && !reading.ok && reading.reason !== "profile_changed") return quotaProblem(reading.reason ?? "unknown", t);
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
  t: TFunction = translateNow,
): Account {
  const shown = shownReading(reading);
  const lanes = lanesOf(shown, t);
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
export function codexPeers(rows: readonly { account: Account; issue: AccountIssue | null }[], nowSec: number, t: TFunction = translateNow): Peer[] {
  return rows.map(({ account: a, issue }) => ({
    key: laneKey(a),
    name: a.alias ?? a.email ?? t("codex.peer.account", { n: a.num }),
    ready: !a.disabled && !issue?.blocksSwitch,
    why: a.disabled ? t("codex.peer.heldOut") : issue?.blocksSwitch ? issue.text : null,
    warn: issue?.tone === "warn",
    headroom: headroomAt(a, nowSec),
  }));
}
