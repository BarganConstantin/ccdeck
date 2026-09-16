// AccountsPanel — every managed Claude account, its usage, and one click to
// switch between them. Toggled via the topbar button or the A shortcut.
//
// The data comes from claude-swap's local store, which the server reads rather
// than fetching: Anthropic's usage endpoint has a per-account request budget
// shared across every tool on the machine, so a dashboard that polled it
// directly would rate-limit the user's actual account. That has a visible
// consequence here — numbers can be minutes old, and saying so is part of the
// display rather than a caveat to hide.
import { useCallback, useEffect, useRef, useState } from "react";
import AddAccountDialog from "./AddAccountDialog";
import AnchoredPopover from "./AnchoredPopover";
import OtherAccounts from "./OtherAccounts";
import ShareAccountsDialog from "./ShareAccountsDialog";
import { type Peer } from "../other-accounts";
import { commandOutput, explainCommandFailure, explainFailure } from "../admin-failure";
import { type SwapNote, manageAfterMove, slotChoices } from "../account-move";
import { type PickerCommit, slotCommit, slotShowing, thresholdCommit } from "../picker-commit";
import { laneSplit } from "../lane-view";
import { knownLanes, laneKey, toggleLane } from "../lane-open";
import { focusDropped, pressAccepted, pressState, rescueSelectors } from "../panel-press";
import { ALIAS_MAX_LENGTH, aliasSave } from "../alias-save";
import { PRODUCT } from "../brand";
import {
  type Failure,
  RELOAD_SLOW,
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "../accounts-reload";
import { resetCountdown, shortAgoSec } from "../relative-time";
import { shareExpiry } from "../share-bundle";
import LanSyncSection, { CONFIRM_GAP_MS } from "./LanSyncSection";

interface Lane {
  id: string;
  label: string;
  pct: number;
  resetAt: number | null;   // unix seconds
}

interface Account {
  num: number;
  email: string | null;
  alias: string | null;
  org: string | null;
  active: boolean;
  disabled: boolean;
  lanes: Lane[];
  headroom: number | null;
  fetchedAt: number | null;  // unix ms
  nextAt: number | null;     // unix ms — claude-swap's next planned read
  stale: boolean;
  error: string | null;
  staleCopy?: boolean;
  /** How the deck's own re-capture of a `staleCopy` row is going. */
  repair?: Repair | null;
  stopped?: boolean;
  collector?: string | null;
  /** The other half of an account's identity. A slot number is not one:
   *  claude-swap assigns them max+1 per store, so the account that is 4 here
   *  is 2 on another machine. LAN sync matches on this pair. */
  orgUuid?: string | null;
  /** Whether claude-swap's STORED COPY works on this machine — which is not
   *  the same question as whether the user is signed in (#721). The copy is
   *  what a share carries and what a peer's copy heals, so both kinds of
   *  trouble read as not alive. */
  alive?: boolean;
}

interface AccountsData {
  ok: boolean;
  accounts?: Account[];
  activeNum?: number | null;
  reason?: string;
  hint?: string;
  fetchedAt?: number;
}

interface AutoTick {
  at: number;
  event: string;
  reason?: string | null;
  detail?: string | null;
  to?: number | null;
}

interface AutoStatus {
  ok: boolean;
  enabled: boolean;
  external: boolean;          // the user runs their own `cswap auto` loop
  lastTick: AutoTick | null;
  settings: Record<string, { value: string | null; isDefault: boolean }>;
}

/** What an account's ⋯ is showing. Rename and Move are forms; Share is its
 *  answer — the text to copy. */
interface AccountMenu {
  num: number;
  view: "menu" | "rename" | "move" | "share";
  /** Which end of the menu focus lands on when it opens. */
  start?: "first" | "last";
}

const POLL_MS = 15_000;
// How long the "a second account moved too" line stands on the moved row. Long
// enough to read a sentence the user did not ask for, short enough that it does
// not keep reporting a move from ten minutes ago. Same shape as the panel's
// other transient states — `copied` at 1.8s, an armed remove at 4s.
const SWAP_NOTE_MS = 8_000;
// How long the threshold's `save` stands as `saved`. The panel's other
// transient confirmation — `copied` on a share — uses the same 1.8s, and the
// word is the whole signal.
const SAVED_MS = 1_800;
// Past this, a reload is called dead rather than slow. Both routes can spawn
// cswap, and the server kills those at 20 seconds, so anything shorter would
// abort answers that were still coming.
const RELOAD_TIMEOUT_MS = 30_000;
const THRESHOLDS = [70, 80, 85, 90, 95];

// This panel used to carry its own `countdown` and its own `ago`. The usage
// panel had the same countdown under another name and relative-time.ts had the
// same `ago` under `shortAgo` — and that module's header names THIS panel as
// one of the surfaces it exists to keep in one dialect (#374). Both now come
// from there; the wrapper below is what makes the second one exact rather than
// approximate.

/** The panel's ages, from a millisecond stamp and its second-resolution clock.
 *
 *  `shortAgo` takes a millisecond delta, and `shortAgo(nowSec * 1000 - at)`
 *  would NOT be what this panel computed: flooring a stamp that has a
 *  sub-second part after the subtraction lands a second lower than flooring it
 *  before, which walks every threshold by a second. Subtracting in seconds and
 *  handing the result to the seconds-form helper is character for character the
 *  arithmetic the private copy did. */
function ago(ms: number, nowSec: number): string {
  return shortAgoSec(nowSec - Math.floor(ms / 1000));
}

/**
 * " · next in 4m" — when claude-swap plans to read this account again.
 *
 * The age alone reads as neglect. The two together read as a cadence, which is
 * what it is: claude-swap sets the interval per account and every surface
 * inherits it, so a number that has not moved in ten minutes is on schedule
 * rather than stuck. Nothing is shown once the read is due, because at that
 * point the answer is "any moment now" and a countdown to zero that lingers is
 * worse than no countdown.
 */
function due(nextAt: number | null, nowSec: number): string {
  if (!nextAt) return "";
  const s = Math.floor(nextAt / 1000) - nowSec;
  if (s <= 0)  return " · due";
  if (s < 60)  return ` · next in ${s}s`;
  return ` · next in ${Math.round(s / 60)}m`;
}

/** A verb from picker-commit.ts as a button in the popover says it. Those words
 *  are lowercase because the row's pills are; the popover's buttons are in
 *  sentence case, like every dialog button in the deck. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How the server's re-capture of a `staleCopy` row is going (autoRecapture). */
type Repair = { state: "running" } | { state: "failed"; reason: string | null; retryAt: number };

/**
 * What a `staleCopy` row says (#721): the login works, claude-swap's stored copy
 * of it does not, and the deck re-captures the copy on its own.
 *
 * `resuming…` while that runs, `numbers paused` once an attempt has not taken,
 * with when the next one is. No state at all is a deck that is not repairing —
 * so it says only what is true without promising anything. Exported for its
 * test.
 */
export function staleCopyText(repair: Repair | null, nowSec: number): { text: string; hint: string } {
  const why = "The deck can still see this account — its live usage is being read — but claude-swap's "
    + "own stored copy of the login was rejected, so these numbers stopped updating.";
  if (repair?.state === "running") {
    return { text: "resuming…", hint: `${why} The deck is re-capturing it from the login you already have. No sign-in, no switch.` };
  }
  if (repair?.state === "failed") {
    const mins = Math.max(1, Math.ceil((repair.retryAt / 1000 - nowSec) / 60));
    const what = repair.reason
      ? `Re-capturing it from the login you already have did not work (${repair.reason}).`
      : "The deck re-captured it from the login you already have, and claude-swap still cannot read it.";
    return { text: "numbers paused", hint: `${why} ${what} It tries again in ${mins}m. No sign-in, no switch.` };
  }
  return { text: "numbers paused", hint: why };
}

/** Plain-language version of claude-swap's error codes. */
/**
 * claude-swap's failure codes, said in the product's voice.
 *
 * These come straight out of its store, and the panel used to print whatever it
 * found — which is how a user ended up looking at `invalid_grant` on their
 * ACTIVE account with nothing to do about it. Two of these are permanent and
 * only the user can clear them: the stored refresh token is dead, and every
 * poll will keep failing until someone signs in again. Those get `fixable`, and
 * the row grows a button.
 */
export function errorText(code: string): { text: string; hint: string; fixable: boolean } {
  switch (code) {
    case "invalid_grant":
    case "no_refresh_token":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fixable: true,
      };
    case "http-401":
      return { text: "re-login needed", hint: "Anthropic refused this account's token.", fixable: true };
    case "http-429":
      return { text: "rate limited", hint: "Anthropic is throttling requests for this account. It clears on its own.", fixable: false };
    case "transient":
      return { text: "temporary error", hint: "A network or server hiccup while reading usage. The next collection retries.", fixable: false };
    case "timeout":
      return { text: "timed out", hint: "Reading this account's usage took too long. The next collection retries.", fixable: false };
    case "network":
      return { text: "unreachable", hint: "Could not reach Anthropic to read this account's usage.", fixable: false };
    default:
      // Still shown, because a code we have not met is better than silence —
      // but labelled as one, so it does not read as a sentence.
      return { text: code, hint: `claude-swap reported "${code}" for this account.`, fixable: false };
  }
}

/**
 * claude-swap's verdict for a slot, said in the product's voice.
 *
 * THREE STATES, THREE DIFFERENT THINGS TO DO, and until this existed the panel
 * collapsed all of them into one silence. Measured at one instant on the same
 * account: `usage.json` said `consecutiveFailures: 0, lastError: null` while
 * `cswap list` said `no_credentials`. The counter cannot tell them apart, and
 * for two of the three it reads zero.
 *
 * The third one is the reason this is worth a sentence rather than a word:
 * `keychain_unavailable` is not about the account at all. Measured on this
 * machine — the same command, the same instant, two sessions:
 *
 *   from a background session  ->  keychain_unavailable, keychain_unavailable
 *   from the GUI session       ->  no_credentials,       relogin_required
 *
 * A deck started where it cannot reach the keychain reports every account as
 * broken and none of them are. Saying which of the two happened is the
 * difference between a person re-adding an account they already have and a
 * person starting the deck differently.
 */
export function collectorText(code: string | null): { text: string; hint: string; fix?: string } | null {
  switch (code) {
    case "no_credentials":
      return {
        text: "no stored login",
        hint: "claude-swap holds no credentials for this account, so there is nothing to read its usage with "
            + "and nothing to switch to. A paired deck that has them sends them on its own; signing in as "
            + "this account puts them there by hand.",
        // NOT "again". There is nothing there to replace — this is the first
        // login claude-swap will hold for this slot.
        fix: "sign in",
      };
    case "relogin_required":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fix: "sign in again",
      };
    case "keychain_unavailable":
      return {
        text: "keychain unreadable",
        hint: "This is about the deck, not the account: claude-swap could not open your keychain, so it cannot "
            + "read any account's stored login. A deck started from a background session cannot reach the "
            + "keychain at all — start it from a terminal, or let it start at login, and this clears.",
        // NO `fix`, and this is the case that makes the field worth having
        // rather than always offering a button: nothing is wrong with the
        // account, and a sign-in here would have somebody replace a working
        // login to repair a deck that was started in the wrong place.
      };
    case "token_expired":
      return { text: "token expired", hint: "The access token ran out and the refresh was deferred. The next collection retries." };
    case "foreign_credential":
      return { text: "wrong credential", hint: "The live credential belongs to a different account. Switching to this one repairs it." };
    case null:
    case undefined:
      return null;
    default:
      return { text: code, hint: `claude-swap reported "${code}" for this account.` };
  }
}

/**
 * What is wrong with an account, decided once, for the row, the notice over the
 * list and the popover that explains it.
 *
 * The three fields the server sends — `error`, `stopped` with claude-swap's
 * verdict, `staleCopy` — never arrive together (authTrouble returns one kind),
 * and each already has its sentence in this file. What this adds is the two
 * decisions the row makes about them: whether the problem is the reader's to
 * act on (`warn`, the amber mark) or something that clears or repairs on its own
 * (`quiet`), and whether a switch to the account can work at all. A login that
 * is dead or was never stored cannot be switched to — the switch would only put
 * the dead one live — so the row does not offer it.
 */
export interface AccountIssue {
  /** The row's words, in sentence case. */
  text: string;
  /** The whole explanation — claude-swap's verdict in the product's voice. */
  hint: string;
  /** The one press that repairs it, when there is one. */
  fix: string | null;
  tone: "warn" | "quiet";
  blocksSwitch: boolean;
}

export function accountIssue(
  a: Pick<Account, "error" | "stopped" | "collector" | "staleCopy" | "repair">,
  nowSec: number,
): AccountIssue | null {
  if (a.staleCopy) {
    // Signed in, and the deck is re-capturing the copy by itself (#721): news,
    // not a task.
    const s = staleCopyText(a.repair ?? null, nowSec);
    return { text: sentence(s.text), hint: s.hint, fix: null, tone: "quiet", blocksSwitch: false };
  }
  if (a.stopped) {
    const v = collectorText(a.collector ?? null);
    if (!v) {
      return {
        text: "Not collecting",
        hint: "claude-swap has collected nothing for this account in over half a day and has not said why. "
            + "A paired deck holding a working copy of this account will replace it on its own. "
            + "To do it by hand, sign in as this account from + Add.",
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    }
    const dead = a.collector === "no_credentials" || a.collector === "relogin_required";
    return {
      text: sentence(v.text),
      hint: v.hint,
      fix: v.fix ? sentence(v.fix) : null,
      // An unreadable keychain is not the account's fault, and it is still the
      // reader's to fix: the deck has to be started from somewhere that can
      // reach it.
      tone: dead || a.collector === "keychain_unavailable" ? "warn" : "quiet",
      blocksSwitch: dead,
    };
  }
  if (a.error) {
    const e = errorText(a.error);
    return { text: sentence(e.text), hint: e.hint, fix: e.fixable ? "Sign in again" : null, tone: e.fixable ? "warn" : "quiet", blocksSwitch: e.fixable };
  }
  return null;
}

/** The panel's one warning mark, drawn at the header icons' spec — a triangle
 *  and a stroke, in whatever ink the words beside it are in. */
function WarnGlyph() {
  return (
    <svg className="ap-warn-glyph" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 1.9 12.9 12H1.1Z" />
      <path d="M7 5.6v2.9" />
      <path d="M7 10.3v.05" />
    </svg>
  );
}

/** How full a window is, in the inks its bar uses: the warning past 70% and
 *  the error past 90%. Undefined below that — the shut row's numbers are
 *  neutral until they are a reason not to switch. */
function fullness(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

/** The threshold picker's options: the five, plus whatever the store holds if
 *  it is none of them — `cswap config set` takes any number, and a picker that
 *  cannot show the stored value shows its first option instead, which is a
 *  setting the loop is not using. */
export function thresholdChoices(stored: string): number[] {
  const n = Number(stored);
  const all = Number.isFinite(n) && n > 0 && !THRESHOLDS.includes(n) ? [...THRESHOLDS, n] : THRESHOLDS;
  return [...all].sort((a, b) => a - b);
}

function LaneBar({ lane, nowSec, frozen }: { lane: Lane; nowSec: number; frozen?: boolean }) {
  const capped = Math.min(100, Math.max(0, lane.pct));
  // A reading that cannot move is drawn as a record rather than a reading: one
  // ink, no warning colours, the fill at half strength. The row says how old.
  const color  = frozen ? "var(--muted)" : capped >= 90 ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  // And a reset from a reading that old has most likely happened already.
  const reset  = lane.resetAt && !frozen ? resetCountdown(lane.resetAt, nowSec) : null;
  return (
    <div className="ap-lane">
      <span className="ap-lane-label" title={lane.label}>{lane.label}</span>
      <div className="ap-lane-track">
        <div className="ap-lane-fill" style={{ width: `${capped === 0 ? 1.5 : capped}%`, background: color, opacity: capped === 0 || frozen ? 0.4 : 1 }} />
      </div>
      <span className="ap-lane-pct" style={{ color }}>{capped}%</span>
      {/* When the window rolls over, at the end of its own bar rather than on a
          line under it: two resets under two bars made the live row five lines
          tall for two facts. The word is said to a screen reader and in the
          title; on screen a countdown beside a quota reads as one. */}
      <span className="ap-lane-reset" title={reset ? `${lane.label} resets in ${reset}` : undefined}>
        {reset && <><span className="vis-hidden">resets in </span>{reset}</>}
      </span>
    </div>
  );
}

/**
 * Copy text, and say whether it worked.
 *
 * navigator.clipboard is undefined outside a secure context and can sit
 * unresolved while the browser decides on permission — which leaves a Copy
 * button silently dead. Race it, then fall back to the old selection trick.
 * Same shape as the version banner's copy, for the same reason.
 */
async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    ok = await Promise.race([
      navigator.clipboard?.writeText(text).then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(r => window.setTimeout(() => r(false), 500)),
    ]);
  } catch { ok = false; }
  if (ok) return true;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand("copy");
    ta.remove();
  } catch { ok = false; }
  return ok;
}

interface Props {
  onClose: () => void;
  /** Asked to close, still on screen for the length of its exit. The panel
   *  keeps working while it leaves — nothing here reads this but the class. */
  leaving?: boolean;
}

export default function AccountsPanel({ onClose, leaving }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  // The tag of the one request the panel has out, or null. A switch is one of
  // them now rather than a flag of its own: #518 needs every control to answer
  // the same question — "is somebody else working" — and two flags cannot.
  const [busy, setBusy] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The account a switch from this panel just landed on (#827), said on its
   *  own row until the next switch or until it stops being the active one. The
   *  `active` chip moving rows used to be the only answer, and a screen reader
   *  heard nothing at all. */
  const [switched, setSwitched] = useState<{ num: number; name: string } | null>(null);
  /** Which of the column's two views is up: the accounts, or Local network's
   *  own. Local network used to be the last section of one long scroll, with a
   *  line under the header to jump down to it (#844); it is a view now, opened
   *  from a row at the foot and left by Back, and the column keeps its width. */
  const [view, setView] = useState<"accounts" | "lan">("accounts");
  /** Once Local network has been shown it stays mounted, whatever a poll says.
   *  /api/claude-accounts answers `no_accounts` for the moment claude-swap is
   *  rewriting its store, and a section that unmounted on that would throw a
   *  reader out of its view and close whatever dialog it had open. */
  const [lanReady, setLanReady] = useState(false);
  /** Whose warning has its explanation open, and which control it hangs from —
   *  the row's own warning, or the notice over the list for the live account.
   *  One at a time, and never alongside a ⋯ menu. */
  const [issueOpen, setIssueOpen] = useState<{ num: number; anchor: string } | null>(null);
  const issueRef = useRef(issueOpen);
  issueRef.current = issueOpen;
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const timerRef = useRef<number | null>(null);
  // Which account's ⋯ is open, and what it is showing: the menu, or the one
  // small form an item turned it into. One at a time — opening a second
  // account's menu closes the first. It lies over the column rather than
  // opening the row, so nothing held here decides any row's height.
  const [menu, setMenu] = useState<AccountMenu | null>(null);
  const menuFor = menu?.num ?? null;
  // The same fact for a handler that returns after a render. A rename that
  // lands after the reader has opened another account's menu must close its
  // own popover, not theirs.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  // Why the last press in the popover did not work, said in the popover under
  // the control that was pressed. A popover that closed on a refusal would
  // look exactly like one that closed on success, so it stays open instead,
  // holding the draft, and this is the line that says why.
  const [menuError, setMenuError] = useState<Failure | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  // Removal is irreversible, and there is no confirmation dialog anywhere in
  // this deck. The button becomes its own confirmation and gives up after a
  // few seconds, so a stray click can never be the second one.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  // When Remove was armed, so a double-click cannot be its own confirmation —
  // the rule the LAN section's unpair already keeps (CONFIRM_GAP_MS). It
  // matters more in the menu than it did on the row: an open menu lies over
  // the next account's ⋯, and Remove, last in the list, is what a press aimed
  // at that ⋯ lands on.
  const removeArmedAt = useRef(0);
  const [share, setShare] = useState<{ num: number; blob: string; expiresAt: number } | null>(null);
  // The panel-level share, which is a different job from the one on a row:
  // moving your own set between your own machines rather than sending one
  // account to somebody else. Its own dialog, so the row keeps its one-click
  // path and neither has to explain the other.
  const [shareSetOpen, setShareSetOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // A move into an occupied slot relocates an account the user never picked.
  // Nothing else on screen says so — both accounts simply appear where they
  // were not — so the moved row says it, in its own freshness line.
  const [swapNote, setSwapNote] = useState<SwapNote | null>(null);
  // What the slot picker is SHOWING, which is no longer what the store holds.
  // A select fires `change` on any keystroke that matches an option, so a
  // single `s` used to move an account and, into a taken slot, a second one
  // with it (#516). The picker proposes now and the button under it commits.
  // Null is the account's own slot, which is where the picker opens; only one
  // popover is ever open, so one draft covers the panel.
  const [slotDraft, setSlotDraft] = useState<number | null>(null);
  // The same two for the auto-switch threshold, which had the same defect with
  // a setting write on the other end. Null follows whatever the store holds.
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  // `save` only exists while there is a pick to store, so it leaves the panel
  // under the reader's focus: the press that stored the pick is the press that
  // unmounts it. The picker is where focus goes when that happens.
  const thresholdRef = useRef<HTMLSelectElement>(null);
  const thresholdSaveRef = useRef<HTMLButtonElement>(null);
  // Which of the other accounts the reader has opened. The live one is open by
  // what it is — its windows are the ones being spent — and every other row
  // rests shut on the two numbers it is chosen by. More than one may be open:
  // comparing two accounts is exactly what this panel is for.
  //
  // Held by ACCOUNT and not by slot, which is the whole of #542: a swap trades
  // two slot numbers and this set, unlike the manage block, never went through
  // manageAfterMove — so the disclosure stayed on the number and expanded a row
  // belonging to somebody else. laneKey names the account instead; see
  // lane-open.ts, which also says why a fifth ManageState field would not have
  // been enough.
  const [openLanes, setOpenLanes] = useState<string[]>([]);
  /** Whether the accounts behind the fold are drawn. Shut on open, every time:
   *  the column's first screen is the live account, and a fold that remembered
   *  being open would give a reader who unfolded it once a panel that never
   *  folds again. It is kept across a switch on purpose — the account just left
   *  is in that list, and it moved there under the reader's own press. */
  const [restOpen, setRestOpen] = useState(false);

  // The same fact as `busy`, where a handler can read it without waiting for a
  // render. #518 leaves the working control enabled, so a second press reaches
  // the handler and the handler is what has to refuse it.
  const busyRef = useRef<string | null>(null);
  /** Take the panel's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => { busyRef.current = null; setBusy(null); }, []);

  /**
   * The two attributes #518 puts on every control that a request makes inert.
   *
   * Spread rather than written out per button, because the whole of that fix is
   * that there is ONE answer: inert while somebody else is working, busy and
   * still focusable while it is your own request. A control that spelled either
   * half by hand would be the second answer the issue asks against.
   */
  const pressProps = (tag: string, working = false) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy || working };
  };

  /**
   * Focus the nearest control that outlived the press.
   *
   * Only when focus was actually dropped — a user who tabbed somewhere else
   * while the request was out is left where they put themselves. After the
   * frame, because the control being rescued from is unmounted by a React
   * commit and rAF is the first moment the document is certain to be the one
   * the reader is looking at.
   */
  const rescueFocus = useCallback((row: number | null) => {
    window.requestAnimationFrame(() => {
      if (!focusDropped(document.activeElement?.tagName ?? null)) return;
      for (const sel of rescueSelectors(row)) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) { el.focus(); return; }
      }
    });
  }, []);

  // A reload the user asked for, and the same one on a timer. Only the forced
  // half touches `reloading`: a poll blinking the ↻ every 15 seconds would read
  // as the panel doing something to itself.
  const load = useCallback(async (force = false) => {
    if (force) setReloading(true);
    // A deck that accepts the connection and then wedges never rejects these
    // fetches. Unbounded, the first load would sit on "Checking…" behind a ↻
    // disabled forever — the dead button this busy state exists to rule out,
    // made permanent.
    const ctl = new AbortController();
    const bell = window.setTimeout(() => ctl.abort(), RELOAD_TIMEOUT_MS);
    try {
      const [accts, autoRes] = await Promise.all([
        fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`, { signal: ctl.signal }),
        fetch("/api/cswap-auto", { signal: ctl.signal }),
      ]);
      if (accts.ok) {
        const fresh: AccountsData = await accts.json();
        setData(fresh);
        // An account that was removed while its lanes were open would otherwise
        // keep its place in the set until the panel is unmounted, ready to
        // reopen itself on whoever signs that address back in. The roster is
        // the only thing that knows an account has gone, so the roster is where
        // the set is trimmed. Unchanged in and unchanged out when nobody left,
        // which is every poll but one.
        setOpenLanes(open => knownLanes(open, fresh.accounts));
      }
      if (autoRes.ok)  setAuto(await autoRes.json());
      const verdict = explainReload([await answered(accts), await answered(autoRes)]);
      setFailure(prev => nextFailure(prev, verdict));
    } catch {
      // Our own abort is a deck that answered the connection and then took
      // too long, not one that is gone (#829) — see RELOAD_SLOW.
      setFailure(prev => nextFailure(prev, ctl.signal.aborted ? RELOAD_SLOW : RELOAD_UNREACHABLE));
    } finally {
      window.clearTimeout(bell);
      if (force) setReloading(false);
    }
  }, []);

  /** Every auto-switch control is one POST; they all reload afterwards. The
   *  refusal is said where the press was: at the foot of the column for the
   *  policy row, and inside the ⋯ menu for an account held out or put back. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string, where: "panel" | "menu" = "panel") => {
    if (!claim(tag)) return null;
    const say = where === "menu" ? setMenuError : setFailure;
    say(null);
    try {
      const res = await fetch("/api/cswap-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // This route's `detail` is cswap's stderr verbatim, not a sentence
      // anybody wrote — same as the switch below, and unlike the admin route.
      if (!out?.ok) say({ text: explainCommandFailure(out, "command failed"), raw: commandOutput(out) });
      return out;
    } catch {
      say({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release]);

  /** Every store-changing action is one POST to the same route — and every one
   *  of them is pressed inside an account's ⋯ popover, so its refusal is said
   *  there, under the control that was pressed, rather than at the foot of a
   *  panel the popover is lying over. */
  const admin = useCallback(async (body: Record<string, unknown>, tag: string) => {
    if (!claim(tag)) return null;
    setFailure(null);
    setMenuError(null);
    try {
      const res = await fetch("/api/claude-accounts/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // The admin route composes its `detail` with failureText(), so here the
      // server's own words are the message and explainFailure ranks them first.
      if (!out?.ok) setMenuError({ text: explainFailure(out, "command failed") });
      return out;
    } catch {
      setMenuError({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release]);

  useEffect(() => {
    load(true);
    timerRef.current = window.setInterval(() => load(false), POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [load]);

  // Countdowns tick independently of the fetch so they stay honest between polls.
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Where auto-switch trips, as the store holds it. The live percentage it
  // races is the active row's own, one glance up the column — the policy row
  // no longer prints a second copy of it.
  const threshold = auto?.settings["autoswitch.threshold"]?.value ?? "90";
  // The percentage the picker is showing, which is a proposal until it is
  // saved.
  const thresholdPick = thresholdDraft ?? threshold;
  const thresholdCtl = thresholdCommit(thresholdPick, threshold);
  const activeAcct = data?.accounts?.find(a => a.active);
  const activeIssue = activeAcct ? accountIssue(activeAcct, nowSec) : null;

  // ── the fold ──
  // WHO THE COLUMN DRAWS AT ONCE, and who stands behind one row. The live
  // account is the reading the panel is opened for and never folds; the others
  // answer one question, which their row and its peek answer without being
  // unfolded. other-accounts.ts has the whole argument.
  //
  // AND NOTHING FOLDS WHILE NOTHING IS LIVE. A store between two switches, or
  // one whose active account was just removed, has no row to stand above the
  // fold — so the roster is drawn as it always was, which is also what every
  // reader of a one-account store sees.
  const roster = data?.accounts ?? [];
  const rest = activeAcct ? roster.filter(a => !a.active) : [];
  const head = rest.length ? roster.filter(a => a.active) : roster;
  const peers: Peer[] = rest.map(a => {
    const issue = accountIssue(a, nowSec);
    return {
      key: laneKey(a),
      name: a.alias ?? a.email ?? `account ${a.num}`,
      // The same pair of refusals the row's own `Switch` is withheld for, so
      // the count and the button can never disagree about who can be reached.
      ready: !a.disabled && !issue?.blocksSwitch,
      why: a.disabled ? "held out" : issue?.blocksSwitch ? issue.text : null,
      warn: issue?.tone === "warn",
      headroom: a.headroom,
    };
  });
  // Where auto-switch would already be acting. Past it, "where do I go next" is
  // the question the reader has, and the row answers it before it is unfolded.
  // Derived from the same `headroom` the peers carry rather than from a second
  // walk over the lanes, so the two numbers cannot disagree.
  const trip = Number(threshold);
  const strained = activeAcct?.headroom != null && Number.isFinite(trip)
    && 100 - activeAcct.headroom >= trip;

  const doSwitch = async (num: number, name: string) => {
    if (!claim(`switch-${num}`)) return;
    setFailure(null);
    setSwitched(null);
    try {
      const res = await fetch("/api/claude-accounts/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: num }),
      });
      const body = await res.json().catch(() => null);
      // Both answers land on the row that was pressed (#827): the refusal is
      // tagged with it, and a switch that took names the account it took to.
      if (!body?.ok) setFailure({ text: explainCommandFailure(body, "the switch failed"), raw: commandOutput(body), row: num });
      else setSwitched({ num, name });
      await load(true);
    } catch {
      setFailure({ text: "server unreachable", row: num });
    } finally {
      release();
      // A switch that landed replaces this button with the `active` marker,
      // which is a span and cannot hold focus. One that failed leaves the
      // button standing, still focused, and this is a no-op — the rescue only
      // fires when focus was actually dropped. See panel-press.ts.
      rescueFocus(num);
    }
  };

  /** Forget the popover and everything it was holding: an armed remove, a
   *  share, a refusal. All three belonged to the account they were made on. */
  const dropMenu = useCallback(() => {
    setMenu(null);
    setMenuError(null);
    setConfirmRemove(null);
    setShare(null);
    setShareCopied(false);
  }, []);

  /** Open an account's ⋯ on its menu, closing any other one first. */
  const openMenu = (num: number, start: "first" | "last" = "first") => {
    dropMenu();
    setIssueOpen(null);
    setSlotDraft(null);
    setMenu({ num, view: "menu", start });
  };

  /** Open a warning's explanation, or shut it when it is the one open. The
   *  anchor's own press is the toggle — the popover lets a press on its anchor
   *  through, the way the ⋯ does. */
  const openIssue = (num: number, anchor: string) => {
    dropMenu();
    setIssueOpen(o => (o?.anchor === anchor ? null : { num, anchor }));
  };
  /** Shut it. From one of its own buttons focus goes back to the warning it
   *  hangs from; Escape does that itself, and a press outside leaves focus
   *  where the press put it. */
  const closeIssue = useCallback((refocus = false) => {
    const open = issueRef.current;
    if (refocus && open) document.getElementById(open.anchor)?.focus();
    setIssueOpen(null);
  }, []);

  /** Give Local network the column. Nothing hangs over it on the way: a menu
   *  or a warning left open would point at a row that is no longer drawn. */
  const openLan = () => {
    dropMenu();
    setIssueOpen(null);
    setView("lan");
  };
  // Where focus goes when the view changes: Back, at the top of Local network,
  // on the way in, and the row that opened it on the way out — so the next Tab
  // carries on from where the reader was rather than from the top of the page.
  // After the frame, because the control being moved to mounts in this commit.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    window.requestAnimationFrame(() => {
      document.getElementById(view === "lan" ? "ap-lan-back" : "ap-lan-entry")?.focus();
    });
  }, [view]);
  useEffect(() => { if (data?.ok) setLanReady(true); }, [data?.ok]);

  /**
   * Close the popover and hand focus back to the ⋯ it came from.
   *
   * Only when focus was inside it, which is about to go, or has already
   * fallen to <body> — a reader who moved on while a request was out is left
   * where they put themselves, the rule panel-press.ts writes for every rescue
   * in this panel. `only` is for a request that finished late: it closes its
   * own account's popover and never one opened since.
   */
  const closeMenu = useCallback((only?: number) => {
    const open = menuRef.current;
    if (!open || (only != null && open.num !== only)) return;
    const pop = document.getElementById(`ap-menu-${open.num}`);
    if (pop?.contains(document.activeElement) || focusDropped(document.activeElement?.tagName ?? null)) {
      document.getElementById(`ap-more-${open.num}`)?.focus();
    }
    dropMenu();
  }, [dropMenu]);

  // A popover left standing as the panel slides out would float over the
  // canvas where the panel used to be; one whose account has left the store
  // has nothing to hang from.
  useEffect(() => { if (leaving) { dropMenu(); setIssueOpen(null); } }, [leaving, dropMenu]);
  useEffect(() => {
    if (menu && data?.accounts && !data.accounts.some(a => a.num === menu.num)) dropMenu();
    if (issueOpen && data?.accounts && !data.accounts.some(a => a.num === issueOpen.num)) setIssueOpen(null);
  }, [data, menu, issueOpen, dropMenu]);

  /**
   * Make a share for this account and turn the popover into it. Also what
   * `Make a new share` does once the one on screen has expired.
   */
  const makeShare = async (num: number) => {
    setShareCopied(false);
    const out = await admin({ action: "share", account: num }, `share-${num}`);
    // Closed while the request was out: the share is not shown to anybody.
    if (!out?.ok || menuRef.current?.num !== num) return;
    setShare({ num, blob: out.blob, expiresAt: out.expiresAt });
    setMenu({ num, view: "share" });
  };

  /**
   * Store the alias in the field, then close.
   *
   * A draft that already matches the store is not a failure and not a no-op
   * the user should have to detect — it is an alias that is saved — so it
   * closes without a round trip, and a draft that differs closes once the
   * store has it. The row is the confirmation: it is showing the name. A
   * refusal leaves the form open on the draft, with the reason under it.
   */
  const doAlias = async (num: number, stored: string | null) => {
    const { commit, alias } = aliasSave(aliasDraft, stored);
    if (commit) {
      const out = await admin({ action: "alias", account: num, alias }, `alias-${num}`);
      await load(true);
      if (!out?.ok) return;
    }
    closeMenu(num);
  };

  /**
   * Send an account to another slot, then close the popover and follow the
   * account with focus.
   *
   * The reload alone is not enough: `cswap move` into an occupied slot is a
   * swap, so the slot numbers this panel keys everything by change hands
   * underneath it. manageAfterMove decides what survives that; a refused move
   * returns null and nothing here is touched, leaving the form open and armed
   * exactly as the user left it, with the refusal under it to say why.
   */
  const doMove = async (from: number, to: number) => {
    const out = await admin({ action: "move", account: from, slot: to }, `move-${from}`);
    const next = manageAfterMove(
      { menuFor: menuRef.current?.num ?? null, confirmRemove, shareFor: share?.num ?? null, swapNote },
      from,
      out,
    );
    // The roster first, then the popover, and never the other way round: the
    // two disagree about who holds a slot for exactly as long as one has moved
    // on and the other has not, and that disagreement IS the bug — a form
    // aimed at a row belonging to somebody else.
    await load(true);
    if (next) {
      // The account is where the picker said, so the form has nothing left to
      // do. It closes rather than chase the row down the column; the row
      // answers instead, by being in its new place and, after a swap, by
      // saying so.
      if (menuRef.current?.num === from) dropMenu();
      setConfirmRemove(next.confirmRemove);
      if (next.shareFor == null) { setShare(null); setShareCopied(false); }
      setSwapNote(next.swapNote);
      const note = next.swapNote;
      if (note) window.setTimeout(() => setSwapNote(n => (n === note ? null : n)), SWAP_NOTE_MS);
      // A refused move keeps the draft: the form stays open on the pick the
      // user made, ready to be pressed again under the refusal.
      setSlotDraft(null);
      // The popover that held focus is gone, and the account now sits on a
      // different row. Focus lands on that row's ⋯ — the account's, wherever
      // the move put it.
      rescueFocus(next.menuFor);
    }
    return out;
  };

  /**
   * Act on the slot showing in the picker, because the user said so.
   *
   * This is the whole of #516. A `<select>` changes value on a keystroke and
   * fires `change` for it, so the picker cannot be the thing that acts — one
   * `s` matched `slot 3 · swap` by type-ahead and traded two accounts with no
   * confirmation and no undo. The press is the decision now, and slotCommit
   * decides what the press means from the choice alone.
   *
   * Both endings close the form, which is what `Save` does for a name: a pick
   * that is already where the account lives has nothing to send and is not a
   * failure — the account IS there — and a pick that moved it closes once the
   * move has landed.
   */
  const doSlot = async (from: number, to: number, commit: PickerCommit) => {
    if (!commit.sends) { closeMenu(from); return; }
    await doMove(from, to);
  };

  /** The same rule for the threshold: the picker proposes, `save` stores it. */
  const doThreshold = async (pick: string, commit: PickerCommit) => {
    if (commit.sends) {
      const out = await post({ action: "setting", key: "autoswitch.threshold", value: pick }, "threshold");
      await load(true);
      if (!out?.ok) return;
      setThresholdDraft(null);
    }
    setThresholdSaved(true);
    window.setTimeout(() => {
      // `saved` is the last thing the control says before it goes. A focused
      // button that unmounts drops focus on <body>, so hand it to the picker
      // first — only if it is still there, never out from under a reader who
      // has moved on.
      if (document.activeElement === thresholdSaveRef.current) thresholdRef.current?.focus();
      setThresholdSaved(false);
    }, SAVED_MS);
  };

  // The one close, drawn in whichever header is up: the accounts' own, or Local
  // network's while that view has the column.
  const closeBtn = (
    <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close accounts panel" title="Close (A)">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
        strokeWidth="1.3" strokeLinecap="round" aria-hidden>
        {/* A diagonal cross reads about a seventh larger than an
            orthogonal one at the same box, so it is drawn a seventh
            smaller than the plus at the other end of this row. Optical,
            not arithmetic. */}
        <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
      </svg>
    </button>
  );

  /**
   * ONE ACCOUNT'S ROW, drawn the same whether it is standing alone above the
   * fold or in the list behind it.
   *
   * IT IS A FUNCTION AND NOT A MAP BODY because the column renders it from two
   * places now — the live account, and the others once their row is unfolded —
   * and a row that were written twice would be two rows drifting apart. Which
   * accounts go where is decided just above, at `head` and `rest`.
   */
  const accountRow = (a: Account) => {
      const { shown, fuller } = laneSplit(a.lanes);
      const issue = accountIssue(a, nowSec);
      // THE ACTIVE ROW IS OPEN, AND EVERY OTHER ROW IS SHUT UNTIL ASKED.
      // The live account is the one whose windows are being spent, so
      // its bars, resets and freshness are the reading this column is
      // opened for. Any other account only has to answer one question —
      // is it worth switching to — and two numbers answer it. The rest
      // is one press on the row away, and held by account (#542).
      const open = a.active || openLanes.includes(laneKey(a));
      const name = a.alias ?? a.email ?? `account ${a.num}`;
      // Numbers that cannot move: nothing collected for a quarter of an
      // hour, or a login that no collection can get past. They stay on
      // screen as the last reading and are drawn as one.
      const frozen = a.stale || issue?.blocksSwitch === true;
      // The row leads with the windows; a folded model lane joins them
      // only when it is the fullest, so two calm numbers never sit over
      // a hidden hot one. See lane-view.ts.
      const quick = fuller ? [...shown, fuller] : shown;
      const age = a.fetchedAt ? ago(a.fetchedAt, nowSec) : null;
      return (
      <li key={a.num} className={`ap-account${a.active ? " active" : ""}`}
        aria-current={a.active ? "true" : undefined}
        data-open={open ? "" : undefined}
        data-frozen={frozen ? "" : undefined}>
        {/* THE ROW IS THE DOOR, the way a machine's row is in Local
            network: a button laid over the whole row, under the row's
            own controls, so a press anywhere on it opens or shuts the
            detail and the keyboard's ring goes round the row. The live
            row has nothing folded, so it has no door. */}
        {!a.active && (
          <button type="button" className="ap-row-open" id={`ap-row-${a.num}`}
            aria-expanded={open}
            aria-controls={open ? `ap-detail-${a.num}` : undefined}
            aria-describedby={!open && !issue?.blocksSwitch ? `ap-quota-${a.num}` : undefined}
            onClick={() => setOpenLanes(o => toggleLane(o, a))}>
            <span className="vis-hidden">{name}, {open ? "hide details" : "details"}</span>
          </button>
        )}
        <div className="ap-account-head">
          {/* The live account is marked by a dot where the other rows
              carry their slot, in the accent, which in this deck means
              live. The slot is still its name for the CLI, so it rides
              in the title and in what a screen reader is told. */}
          {a.active
            ? <span className="ap-live" title={`Active account · slot ${a.num}`}>
                <span className="vis-hidden">Active account, slot {a.num}:</span>
              </span>
            : <span className="ap-num">{a.num}</span>}
          {/* Both of these are clipped with an ellipsis so a long one
              cannot widen the panel, which means the row can be showing
              less than the whole string — so each one carries its own
              whole value in a title (#517). */}
          {a.alias && <span className="ap-alias" title={a.alias}>{a.alias}</span>}
          <span className="ap-email" title={a.email ?? undefined}>{a.email}</span>
          {/* A state, said in a word and not in a pill. It stands where
              `Switch` would, because a switch to a held-out account is
              refused and a control that can never act is worse than
              none (#519). Putting it back is in the ⋯. */}
          {a.disabled && <span className="ap-held">held out</span>}
          {/* The one verb a row carries, and quieter than the account it
              is about: a word on the control fill, no edge. Not offered
              where it cannot work — to a login that is dead or was never
              stored, a switch only makes the dead one live. */}
          {!a.active && !a.disabled && !issue?.blocksSwitch && (
            <button
              type="button"
              className="ap-switch"
              {...pressProps(`switch-${a.num}`)}
              onClick={() => doSwitch(a.num, name)}
              aria-label={`Switch to ${name}`}
              title={`Switch to ${a.alias ?? a.email}`}
            >{busy === `switch-${a.num}` ? "…" : "Switch"}</button>
          )}
          {/* THE WAY IN TO EVERYTHING ELSE. It opens a menu over the
              column rather than opening the row, so pressing it moves
              nothing on screen. aria-controls only while the menu
              exists: an IDREF that resolves to nothing is a dangling
              pointer. The name carries the account, because a column of
              identical "More actions" is a column of buttons a screen
              reader cannot tell apart. */}
          <button type="button" id={`ap-more-${a.num}`} className="ap-more"
            aria-label={`More actions for ${a.email ?? a.alias ?? `account ${a.num}`}`}
            aria-haspopup="menu" aria-expanded={menuFor === a.num}
            aria-controls={menuFor === a.num ? `ap-menu-${a.num}` : undefined}
            title="More actions"
            onClick={() => (menuFor === a.num ? closeMenu() : openMenu(a.num))}
            onKeyDown={e => {
              // Down opens at the first item and Up at the last, the way
              // a native menu button does. Enter and Space are the click.
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              openMenu(a.num, e.key === "ArrowUp" ? "last" : "first");
            }}>
            {/* AUTHORED, NOT TYPED, like the header's four: three dots on
                the same 14px grid the header draws at. */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
              <circle cx="2.8" cy="7" r="1.15" />
              <circle cx="7" cy="7" r="1.15" />
              <circle cx="11.2" cy="7" r="1.15" />
            </svg>
          </button>
        </div>

        {/* THE ANSWER TO A SWITCH, on the row it was about (#827). A
            switch that took says so on the row it took to, with the one
            thing nothing else on screen says: what happens to the
            sessions already running. */}
        {failure?.row === a.num && (
          <div className="ap-failure ap-row-failure" role="alert">
            <span className="ap-failure-text" title={failure.raw || undefined}>{failure.text}</span>
            <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
              aria-label="Dismiss this message" title="Dismiss">×</button>
          </div>
        )}
        {a.active && switched?.num === a.num && (
          <p className="ap-switched">
            Now active. New sessions start on it; ones already running pick it up on
            their next message, up to about 30 seconds later on macOS.
          </p>
        )}
        {/* A move into a taken slot relocated a second account, and this
            is the only place that says so, for eight seconds. The
            sentence naming who went where is its title. */}
        {swapNote?.at === a.num && (() => {
          const other = roster.find(x => x.num === swapNote.displaced);
          const who = other?.alias ?? other?.email ?? "the account that was there";
          return (
            <p className="ap-note ap-swap-note"
              title={`Slot ${swapNote.at} was taken, so the two accounts traded places: `
                   + `${who} now holds slot ${swapNote.displaced}.`}>
              swapped with slot {swapNote.displaced}
            </p>
          );
        })()}

        {/* WHAT IS WRONG, ON THE ROW, SHUT OR OPEN. A problem is never
            folded away with the detail and never moved into the ⋯: it
            is the one line on the row somebody has to be able to find.
            It is a word and a mark rather than a banner, and the why
            and the fix are one press away (#856) — a popover over the
            column, so opening it moves no row. */}
        {issue && (
          <div className="ap-issue-line">
            <button type="button" id={`ap-issue-${a.num}`} className="ap-issue" data-tone={issue.tone}
              aria-haspopup="dialog"
              aria-expanded={issueOpen?.anchor === `ap-issue-${a.num}`}
              aria-controls={issueOpen?.anchor === `ap-issue-${a.num}` ? "ap-issue-pop" : undefined}
              onClick={() => openIssue(a.num, `ap-issue-${a.num}`)}>
              {issue.tone === "warn" && <WarnGlyph />}
              <span className="ap-issue-text">{issue.text}</span>
            </button>
            {/* How old the last reading is. On an open row the freshness
                line under the bars says it, so it is said once. */}
            {!open && (
              <span className="ap-issue-age" title="When claude-swap last read this account's usage">
                {age ?? "never collected"}
              </span>
            )}
          </div>
        )}

        {/* SHUT: THE TWO NUMBERS AN ACCOUNT IS CHOSEN BY. No bars, no
            resets, no clock — unless the numbers are old, and then the
            age is the one thing that must be said beside them. A login
            that cannot be used shows no numbers at all here: the line
            above is the answer, and last week's quota under it would
            read as this week's. */}
        {!open && !issue?.blocksSwitch && (
          <p className="ap-quota" id={`ap-quota-${a.num}`}>
            {quick.length
              ? quick.map(l => (
                  <span key={l.id} className="ap-q">
                    <span className="ap-q-label">{l.label}</span>{" "}
                    <span className="ap-q-pct" data-level={frozen ? undefined : fullness(l.pct)}>{Math.round(l.pct)}%</span>
                  </span>
                ))
              : <span className="ap-q-label">no usage recorded yet</span>}
            {a.stale && !issue && (
              <span className="ap-q-age" data-never={age ? undefined : ""} title="When claude-swap last read this account's usage">
                {age ?? "never collected"}
              </span>
            )}
          </p>
        )}

        {/* OPEN: every window as a bar, when each one resets, and when
            claude-swap last read it and plans to read it again — the
            freshness that says whether these numbers are a decision's
            worth of evidence. */}
        {open && (
          <div className="ap-detail" id={`ap-detail-${a.num}`}>
            <div className="ap-lanes">
              {a.lanes.length
                ? a.lanes.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} frozen={frozen} />)
                : <div className="ap-hint">No usage recorded yet.</div>}
            </div>
            <div className="ap-meta">
              {a.fetchedAt
                ? <span
                    // ONE ATTENTION COLOUR PER ROW, ON THE CAUSE: an
                    // account with a problem is old because of it, so
                    // the age stays quiet and the problem takes the ink.
                    className={`ap-age${a.stale && !issue ? " ap-stale" : ""}`}
                    title={"When claude-swap last read this account's usage, and when it plans to read it again. "
                         + "It sets that interval itself — 3 minutes at the fastest, wider while an account is "
                         + "recovering from a rate limit — and every surface, including `cswap watch`, follows "
                         + "the same plan."}
                  >collected {ago(a.fetchedAt, nowSec)}{issue?.blocksSwitch ? "" : due(a.nextAt, nowSec)}</span>
                : <span className="ap-age ap-stale" title="claude-swap has not read this account yet">never collected</span>}
            </div>
          </div>
        )}
      </li>
      );
  };

  return (
    // Named for the topbar toggle's aria-controls — see UsagePanel, which also
    // carries the reason this is an <aside> and not the <div> it was: the
    // aria-label on a roleless <div> resolved to `generic` and the tree threw
    // the name away (#381). This panel is the left sidebar beside the canvas,
    // which is complementary content by any reading.
    <aside className={`accounts-panel${leaving ? " leaving" : ""}`} id="accounts-panel" aria-label="Claude accounts">
      {view === "accounts" && (
        <div className="ap-header">
          {/* h2, under the topbar's h1 — the level every panel title sits at.

              CLAUDE ACCOUNTS, BECAUSE THAT IS WHAT IS IN IT. `Accounts` was
              written when Claude was the only thing this deck watched. The deck
              has drawn Codex sessions on the same canvas for months, and a Codex
              login is NOT in this list and cannot be — claude-swap manages Claude
              credentials, and nothing here reads or switches a Codex one. So a
              panel titled `Accounts` beside a canvas holding both promises a
              place to manage the other one and then never mentions it.

              Sentence case, like `Local network` below and every other caption in
              this sheet, and now identical to the landmark name this panel has
              carried since #381 — a region whose heading and whose accessible
              name are the same string is one thing to a screen reader rather than
              two. */}
          <h2>Claude accounts</h2>
          <div className="ap-header-right">
            {/* The `+` is one glyph, so `title` was its whole accessible name.
                A last-resort name source that a touch user never sees and that
                some readers are configured to ignore is not a name; this is the
                second and last of the two the #381 sweep found. The tooltip stays
                as the longer hover sentence. */}
            <button type="button" className="glyph-btn ap-add" onClick={() => setAddOpen(true)}
              aria-label="Add an account"
              title="Sign in to another Claude account, or paste one shared from another deck">
              {/* AUTHORED, NOT TYPED. These four were `+`, `↗`, `↻` and `×` —
                  four Unicode codepoints out of four different blocks, all set at
                  16px and measuring 8.3, 9.1, 10.9 and 7.4 of ink, with the
                  reload 78% taller than the close beside it. A row of one-size
                  buttons cannot be one size while the glyphs in them come from
                  four typefaces. Drawn at the app's own small-icon spec, which is
                  what the topbar's five already are. */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" aria-hidden>
                <path d="M7 2.2v9.6M2.2 7h9.6" />
              </svg>
            </button>
            {/* #518: this used to be `disabled={reloading}`, which disabled the
                control the press came from and dropped focus to the document
                body on every reload. It is inert while somebody ELSE is working and busy while
                its own request is out — the same two attributes every control in
                the panel takes from pressProps — and the glyph goes on saying
                which of the two it is.
                `reloading` is a second flag rather than the panel request slot
                because a reload is fired by the poll and by every other action
                too, and a reload that took the slot would disable the control
                that had just fired it — which is the defect, one step further
                along. */}
            {/* A panel-level act and not a row one, so it is up here beside the
                other two. It is drawn only when there is something to share:
                a header offering to send accounts from a deck that holds none
                is a control whose only outcome is an error.

                It has no class of its own any more. The one it had existed to
                nudge a text arrow inside the 24px box, and an icon is centred by
                `.glyph-btn` itself — a class that styles nothing is a hook nobody
                is holding. */}
            {(data?.accounts?.length ?? 0) > 0 && (
              <button type="button" className="glyph-btn" onClick={() => setShareSetOpen(true)}
                aria-label="Share accounts with another deck"
                title={`Copy several accounts to another ${PRODUCT} in one paste. The text carries a live login for each one — treat it as those passwords.`}>
                {/* Out and away: the same arrowhead the reload beside it is built
                    from, so the two read as one hand rather than two. */}
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                  strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3.3 10.7L10.7 3.3" />
                  <path d="M5.5 3.3h5.2v5.2" />
                </svg>
              </button>
            )}
            <button type="button" className="glyph-btn ap-refresh" onClick={() => load(true)}
              {...pressProps("reload", reloading)} aria-label="Reload accounts"
              title="Reload from claude-swap">
              {/* IT TURNS WHILE IT WORKS, where it used to swap the arrow for an
                  ellipsis. Both say which of the two states the control is in,
                  which is what #518 asked of it; a rotation says it without the
                  button's ink changing shape. The LAN section's check turns the
                  same way while it works, with its own glyph since #838. */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
                <path d="M11.9 2.6v3.7h-3.6" />
              </svg>
            </button>
            {closeBtn}
          </div>
        </div>
      )}

      {/* THE ACCOUNTS SCROLL, AND NOTHING ELSE DOES. The column used to be one
          scroll of three sections, so with enough accounts Auto-switch and Local
          network went under the fold with no sign they were there. The roster
          takes whatever height is left; the policy row and the way into Local
          network stand at the foot of the column at every length. */}
      {view === "accounts" && (
        <div className="ap-scroll" id="ap-scroll">
          {/* Nothing has arrived yet. "Checking…" is only true while a request is
              still out: the panel's failure box lives inside the branch below,
              which needs a roster to render, so a first load that failed used to
              leave this word standing with nothing behind it. */}
          {data == null ? (
            failure ? (
              <div className="ap-empty" role="alert">
                <span title={failure.raw || undefined}>{failure.text}</span>
                <span className="ap-hint">
                  No accounts have arrived, so there is nothing to show yet. The panel keeps
                  trying every {POLL_MS / 1000} seconds.
                </span>
                <button type="button" className="ap-fix" disabled={reloading} onClick={() => load(true)}>
                  {reloading ? "trying…" : "try again"}
                </button>
              </div>
            ) : (
              <div className="ap-empty">Checking…</div>
            )
          ) : !data.ok ? (
            <div className="ap-empty">
              {data.reason === "no_cswap" ? (
                <>
                  <span>claude-swap isn't installed.</span>
                  <span className="ap-hint">
                    This panel reads the account store claude-swap keeps — without it there is
                    nothing to show. It is a separate tool, published on PyPI, so it does not
                    come with this package.
                  </span>
                  {data.hint && <code className="ap-cmd">{data.hint}</code>}
                  <span className="ap-hint">Then add an account with the <strong>+</strong> button above.</span>
                </>
              ) : data.reason === "no_accounts" ? (
                <>
                  <span>No accounts added yet.</span>
                  <span className="ap-hint">
                    claude-swap is installed but has nothing in its store. Use the <strong>+</strong> above
                    to sign one in, or to paste one shared from another deck.
                  </span>
                </>
              ) : (
                <>
                  <span>Couldn't read the account store.</span>
                  <span className="ap-hint">
                    claude-swap is installed, but its store could not be read
                    {data.reason ? ` (${data.reason})` : ""}.
                  </span>
                </>
              )}
            </div>
          ) : (
            <>
              {/* THE LIVE ACCOUNT'S TROUBLE, ONCE, ABOVE THE LIST. Every session
                  this deck starts runs on that login, so a dead one is not one
                  row's news — it is the column's. Only the active account earns
                  this line: a problem on an account nobody is using stays on its
                  own row, where it is visible and where it is about. */}
              {activeAcct && activeIssue?.tone === "warn" && (
                <div className="ap-notice">
                  <button type="button" id="ap-notice" className="ap-issue" data-tone="warn"
                    aria-haspopup="dialog"
                    aria-expanded={issueOpen?.anchor === "ap-notice"}
                    aria-controls={issueOpen?.anchor === "ap-notice" ? "ap-issue-pop" : undefined}
                    onClick={() => openIssue(activeAcct.num, "ap-notice")}>
                    <WarnGlyph />
                    <span className="ap-issue-text">Current account needs attention</span>
                  </button>
                  {activeIssue.fix && (
                    <button type="button" className="ap-notice-fix" onClick={() => setAddOpen(true)}
                      title="Open the sign-in dialog. Signing in as this account replaces its stored login in place.">
                      Sign in
                    </button>
                  )}
                </div>
              )}

              {/* A LIST, because it is one. The roster was a run of sibling divs, so
                  a reader on a screen reader had no way to learn how many accounts
                  exist or where one ends without walking every control on it — and
                  heading navigation jumps from the panel's h2 straight past all of
                  them to Auto-switch. ShareAccountsDialog has used ul/li since the
                  day it was written; this is the same shape. */}
              <ul className="ap-list">
              {head.map(accountRow)}
              </ul>

              {/* THE FOLD. Every account that is not the live one, behind one
                  row — see other-accounts.ts for why the column opens this way
                  and why the row unfolds in place instead of leading anywhere.
                  Drawn only when there IS a live account to stand above it: a
                  store with nothing active has no reason to hide the rest, and
                  the whole roster is already above it. */}
              {rest.length > 0 && (
                <OtherAccounts
                  peers={peers}
                  strained={strained}
                  open={restOpen}
                  onToggle={() => setRestOpen(o => !o)}
                />
              )}
              {rest.length > 0 && restOpen && (
                <ul className="ap-list ap-others" id="ap-rest-list">
                {rest.map(accountRow)}
                </ul>
              )}

              {menu && (() => {
                const a = data.accounts?.find(x => x.num === menu.num);
                if (!a) return null;
                const titleId = `ap-pop-title-${a.num}`;
                // Under the control that was pressed, in every view. The popover
                // stays open on a refusal, holding what the user had done.
                const refusal = menuError && (
                  <p className="ap-pop-error" role="alert" title={menuError.raw || undefined}>{menuError.text}</p>
                );
                return (
                  <AnchoredPopover
                    anchorId={`ap-more-${a.num}`}
                    // The column the ⋯ scrolls in. Scrolled out of it, the
                    // popover closes rather than float over a row nobody can see.
                    boundaryId="ap-scroll"
                    id={`ap-menu-${a.num}`}
                    className="ap-pop"
                    role={menu.view === "menu" ? "menu" : "dialog"}
                    labelledBy={menu.view === "menu" ? `ap-more-${a.num}` : titleId}
                    start={menu.start}
                    onClose={dropMenu}
                  >
                    {menu.view === "menu" && (
                      <>
                        {/* Four words, where the block drew three forms and five
                            controls before anything was chosen. Each item that
                            needs more than a press turns this same surface into
                            the one form it needs. The arrows walk the items, and
                            Tab leaves the menu instead of stepping through it. */}
                        <button type="button" role="menuitem" className="ap-menu-item"
                          onClick={() => {
                            setAliasDraft(a.alias ?? "");
                            setMenuError(null);
                            setMenu({ num: a.num, view: "rename" });
                          }}>Rename</button>
                        <button type="button" role="menuitem" className="ap-menu-item"
                          onClick={() => {
                            setSlotDraft(null);
                            setMenuError(null);
                            setMenu({ num: a.num, view: "move" });
                          }}>Move to slot…</button>
                        <button type="button" role="menuitem" className="ap-menu-item"
                          {...pressProps(`share-${a.num}`)}
                          /* It leads with what the reader is about to put on their
                             clipboard, and describes the ten minutes as what they
                             are: how long the OTHER deck will still take it. The
                             share is plain text with the account's token inside and
                             an expiry nothing signs. */
                          title={`Copy this account to another ${PRODUCT}. Anyone who has the text can use the account — treat it as the password. The other deck stops accepting it after 10 minutes; that does not make an escaped copy safe.`}
                          onClick={() => makeShare(a.num)}
                        >{busy === `share-${a.num}` ? "Sharing…" : "Share"}</button>
                        {/* Holding an account out only matters while something is
                            rotating, so it is offered with it. Putting one BACK is
                            offered whenever an account is out (#519): the row says
                            `held out`, and this is the one way to undo it. A menu
                            item rather than a word on every row — it is a
                            preference flipped a few times a year. */}
                        {(((auto?.enabled || auto?.external) && !a.active) || a.disabled) && (
                          <button type="button" role="menuitem" className="ap-menu-item"
                            {...pressProps(`rot-${a.num}`)}
                            title={a.disabled
                              ? "Return this account to auto-rotation"
                              : "Hold this account out of auto-rotation"}
                            onClick={() => post({ action: "account", account: a.num, enabled: a.disabled }, `rot-${a.num}`, "menu")
                              .then(out => { load(true); if (out?.ok) closeMenu(a.num); })}
                          >{a.disabled ? "Put back in rotation" : "Hold out of rotation"}</button>
                        )}
                        <div role="separator" className="ap-menu-sep" />
                        {/* Two presses, and the second one expires. There is no
                            confirmation dialog anywhere in this deck and removing an
                            account cannot be undone, so the item is its own
                            confirmation: the first press arms it and leaves the
                            menu open, the four seconds it stays armed drain along
                            its foot, and only a press inside them removes. It arms
                            to the word unpair arms to in the LAN section (#839);
                            the name spells out what is being confirmed for a reader
                            who cannot see the row it replaced. */}
                        <button
                          type="button"
                          role="menuitem"
                          className={`ap-menu-item danger${confirmRemove === a.num ? " armed" : ""}`}
                          {...pressProps(`rm-${a.num}`)}
                          aria-label={confirmRemove === a.num ? "Confirm remove" : undefined}
                          title={confirmRemove === a.num
                            ? "This deletes the stored credentials for this account"
                            : "Remove this account from claude-swap"}
                          onClick={() => {
                            if (confirmRemove !== a.num) {
                              setConfirmRemove(a.num);
                              removeArmedAt.current = Date.now();
                              window.setTimeout(() => setConfirmRemove(c => (c === a.num ? null : c)), 4000);
                              return;
                            }
                            // A double-click is one decision, not two: its second
                            // press lands before anybody could have read `Confirm`.
                            if (Date.now() - removeArmedAt.current < CONFIRM_GAP_MS) return;
                            setConfirmRemove(null);
                            admin({ action: "remove", account: a.num }, `rm-${a.num}`).then(out => {
                              load(true);
                              // Refused: the menu stays open and says why.
                              if (!out?.ok) return;
                              if (menuRef.current?.num === a.num) dropMenu();
                              // The row this lived on is going, so there is no
                              // local anchor left and focus falls to the panel
                              // reload — see rescueSelectors in panel-press.ts.
                              rescueFocus(null);
                            });
                          }}
                        >{busy === `rm-${a.num}` ? "Removing…" : confirmRemove === a.num ? "Confirm" : "Remove"}</button>
                        {refusal}
                      </>
                    )}

                    {menu.view === "rename" && (
                      /* A form, so Enter is Save the way it is in every field —
                         and never in the middle of an IME composition, which a
                         keydown listener for Enter gets wrong. The title is the
                         field's label: one line that says what the form is for and
                         names the field, where the block had a hidden label and a
                         placeholder doing the naming. */
                      <form className="ap-pop-form" onSubmit={e => { e.preventDefault(); doAlias(a.num, a.alias); }}>
                        <label className="ap-pop-title" id={titleId} htmlFor={`ap-alias-${a.num}`}>Rename account</label>
                        <input
                          id={`ap-alias-${a.num}`}
                          className="ap-manage-input"
                          type="text"
                          value={aliasDraft}
                          onChange={e => setAliasDraft(e.target.value)}
                          /* The store's own bound, stated where the typing happens
                             rather than discovered from a `bad_value` after a
                             round trip. See ALIAS_MAX_LENGTH. */
                          maxLength={ALIAS_MAX_LENGTH}
                          /* An example, not a narration of the empty state: "no
                             alias" reads as a field whose value is those two words. */
                          placeholder="e.g. work"
                          spellCheck={false}
                          autoComplete="off"
                          /* The keyboard lands in the field, with the name that is
                             there selected, so typing replaces it and an arrow key
                             edits it instead. */
                          autoFocus
                          onFocus={e => e.currentTarget.select()}
                        />
                        {refusal}
                        <div className="ap-pop-actions">
                          <button type="button" className="btn" onClick={() => closeMenu()}>Cancel</button>
                          <button type="submit" className="btn primary" {...pressProps(`alias-${a.num}`)}
                            title="A short name to show instead of the email">
                            {busy === `alias-${a.num}` ? "…" : "Save"}
                          </button>
                        </div>
                      </form>
                    )}

                    {/* The picker and the press that acts on it (#516). A
                        `<select>` fires `change` for a keystroke as readily as for
                        a pick, so one letter once matched an option by type-ahead
                        and moved an account — and into a taken slot, a second one
                        nobody pointed at. Nothing is sent until the button is
                        pressed, and the button says which of the two it will do:
                        `Swap` for exactly the options marked `· swap`. */}
                    {menu.view === "move" && (() => {
                      const choices = slotChoices((data.accounts ?? []).map(x => x.num), a.num);
                      const picked = slotShowing(choices, slotDraft, a.num);
                      const commit = slotCommit(choices, picked, a.num);
                      return (
                        // Not a form: with no text field in it there is nothing for
                        // Enter to submit from, and the one way to send is the
                        // press on the button — which is the point of #516.
                        <div className="ap-pop-form">
                          <label className="ap-pop-title" id={titleId} htmlFor={`ap-slot-${a.num}`}>Move to slot</label>
                          <span className="ap-field">
                            <select
                              id={`ap-slot-${a.num}`}
                              value={String(picked)}
                              {...pressProps(`move-${a.num}`)}
                              onChange={e => setSlotDraft(Number(e.target.value))}
                              autoFocus
                            >
                              {/* The consequence rides on the option that carries
                                  it, and the one harmless move is visible as the
                                  exception — see slotChoices. */}
                              {choices.map(c => <option key={c.slot} value={c.slot}>{c.label}</option>)}
                            </select>
                          </span>
                          {refusal}
                          <div className="ap-pop-actions">
                            <button type="button" className="btn" onClick={() => closeMenu()}>Cancel</button>
                            <button type="button" className="btn primary" {...pressProps(`move-${a.num}`)}
                              title={commit.title}
                              onClick={() => doSlot(a.num, picked, commit)}
                            >{busy === `move-${a.num}` ? "…" : sentence(commit.label)}</button>
                          </div>
                        </div>
                      );
                    })()}

                    {menu.view === "share" && share?.num === a.num && (() => {
                      const exp = shareExpiry(share.expiresAt, nowSec);
                      const dead = exp.tone === "gone";
                      return (
                        <div className={`ap-pop-form ap-share${dead ? " expired" : ""}`}>
                          <p className="ap-pop-title" id={titleId}>Share account</p>
                          <code className="ap-share-blob">{share.blob}</code>
                          {/* The warning belongs to what the text IS, and the
                              countdown is not what keeps anyone out — so the warning
                              carries the colour, and the full explanation is one
                              hover away rather than a paragraph in a popover. */}
                          <p className="ap-pop-note"
                            title={"This text is the account's password. It is base64 of plain JSON — the expiry inside it is not signed, so anyone holding a copy can change it, "
                                 + "and the login itself is in there in the clear either way. The countdown only says how long another deck's import dialog will still accept it. "
                                 + "If a copy escapes, sign the account out and back in."}>
                            <span className="ap-share-warn">This is the password</span>
                            {" · "}
                            <span className={`ap-share-expiry ${exp.tone}`}>{exp.text}</span>
                          </p>
                          {refusal}
                          <div className="ap-pop-actions">
                            <button type="button" className="btn" onClick={() => closeMenu()}>Done</button>
                            {/* Past the expiry the import dialog on the other deck
                                refuses this text, so offering to copy it is offering
                                a dead end — see shareExpiry. */}
                            <button type="button" className="btn primary" {...pressProps(`share-${a.num}`)} autoFocus
                              onClick={async () => {
                                if (dead) { await makeShare(a.num); return; }
                                if (await copyText(share.blob)) {
                                  setShareCopied(true);
                                  window.setTimeout(() => setShareCopied(false), 1800);
                                }
                              }}>
                              {dead ? "Make a new share" : shareCopied ? "Copied" : "Copy"}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </AnchoredPopover>
                );
              })()}
              {/* WHY, AND WHAT FIXES IT — for whichever warning was pressed. The
                  sentences are claude-swap's verdicts in the product's voice, the
                  same ones that lived in a title and then in a line that pushed
                  the row open; the press is the sign-in the row used to carry as
                  a second pill. Portalled like the ⋯ menu, so it moves nothing. */}
              {issueOpen && (() => {
                const a = data.accounts?.find(x => x.num === issueOpen.num);
                const issue = a ? accountIssue(a, nowSec) : null;
                if (!a || !issue) return null;
                return (
                  <AnchoredPopover
                    anchorId={issueOpen.anchor}
                    boundaryId="ap-scroll"
                    id="ap-issue-pop"
                    className="ap-pop ap-issue-pop"
                    role="dialog"
                    labelledBy="ap-issue-title"
                    onClose={() => closeIssue()}
                  >
                    <div className="ap-pop-form">
                      <p className="ap-pop-title ap-issue-title" id="ap-issue-title" data-tone={issue.tone}>
                        {issue.tone === "warn" && <WarnGlyph />}
                        {issue.text}
                      </p>
                      <p className="ap-pop-note ap-issue-hint">{issue.hint}</p>
                      <p className="ap-pop-note ap-issue-when">
                        <span className="ap-issue-who">{a.alias ?? a.email ?? `account ${a.num}`}</span>
                        {" · "}
                        {a.fetchedAt ? `last collected ${ago(a.fetchedAt, nowSec)}` : "never collected"}
                      </p>
                      <div className="ap-pop-actions">
                        <button type="button" className="btn" onClick={() => closeIssue(true)}>Done</button>
                        {issue.fix && (
                          <button type="button" className="btn primary" onClick={() => { closeIssue(true); setAddOpen(true); }}
                            title="Open the sign-in dialog. Signing in as this account puts its login back in this slot — it keeps its slot, its alias and its history.">
                            {issue.fix}
                          </button>
                        )}
                      </div>
                    </div>
                  </AnchoredPopover>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Announced, and dismissible, because nothing else here clears it: the
          next action does, and until then a stale refusal sits under a roster
          that has since moved on. Between the roster and its foot, so a refused
          auto-switch press is said beside the control that made it. Everything
          but a refused switch, which is said on the row that was pressed (#827). */}
      {view === "accounts" && data != null && failure && failure.row == null && (
        <div className="ap-failure" role="alert">
          <span className="ap-failure-text" title={failure.raw || undefined}>{failure.text}</span>
          <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}

      {/* ── auto-switch ──
          ONE POLICY, ONE ROW: its name, where it trips, and whether it is armed.
          The live percentage it used to print beside the threshold is the active
          row's own number, one glance up, and the clock of its last check under
          a rule was diagnostics — the switch being on is the state, and a
          terminal loop taking over is the one thing still said under it. */}
      {view === "accounts" && data?.ok && auto?.ok && (
        <div className="ap-foot">
          <div className="ap-policy">
            {/* A real h3, under the panel header's h2: a reader walking headings
                should find the policy. It says what the switch's name says
                (#546), so what is heard and what a voice-control user has to
                pronounce are the words on the screen. */}
            <h3 className="ap-auto-title">Auto-switch</h3>
            {/* The picker proposes and `save` stores (#516): a select fires
                `change` on a keystroke, and one letter used to write a setting.
                A value set from the terminal that is not one of the five is kept
                as an option of its own, so the picker never shows a number the
                store does not hold. */}
            <span className="ap-field" title="Switch once the active account passes this much of its limit">
              <select
                ref={thresholdRef}
                aria-label="Switch threshold"
                value={thresholdPick}
                {...pressProps("threshold")}
                onChange={e => setThresholdDraft(e.target.value)}
              >
                {thresholdChoices(threshold).map(t => <option key={t} value={t}>{t}%</option>)}
              </select>
            </span>
            {/* ONLY WHILE THERE IS SOMETHING TO SAVE, after the picker so that
                arriving moves nothing the reader just pressed. `saved` only
                while the pick is the stored one. */}
            {(thresholdCtl.sends || thresholdSaved) && (
              <button ref={thresholdSaveRef} type="button" className="ap-manage-btn" {...pressProps("threshold")}
                title={thresholdCtl.title}
                onClick={() => doThreshold(thresholdPick, thresholdCtl)}
              >{thresholdSaved && !thresholdCtl.sends ? thresholdCtl.done : thresholdCtl.label}</button>
            )}
            {/* Always a control, never a read-out: a terminal loop's state is
                said beside it, not instead of it. Named in aria-label because
                the contents cannot carry it (#546). */}
            <button
              type="button"
              className="switch ap-auto-state"
              role="switch"
              aria-checked={auto.enabled}
              aria-label="Auto-switch"
              {...pressProps("enable")}
              onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
              title={auto.enabled
                ? "Stop switching accounts automatically"
                : "Switch accounts automatically when the active one nears its limit"}
            >
              <span className="switch-knob" />
            </button>
          </div>

          {/* Which engine is actually switching right now. The deck stands down
              while a terminal loop runs, and says so. */}
          {auto.external && (
            <p className="ap-auto-note">
              <i className="ap-pulse" aria-hidden /> A <code>cswap auto</code> loop in your terminal is
              doing the switching. The deck stands down while it runs
              {auto.enabled ? " — this toggle takes over when you stop it." : "."}
            </p>
          )}
        </div>
      )}

      {/* The switch that took, said out loud (#827). Always mounted, empty at
          rest, the way App's blocked-session region is: a status that appears
          already holding its text is one a screen reader may never read. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {switched ? `Now active: ${switched.name}` : ""}
      </div>

      {/* LOCAL NETWORK: A WAY IN AT THE FOOT, AND A VIEW OF ITS OWN. It is not
          about this machine's accounts but about other machines, so it no
          longer draws its machine list under them. The section stays mounted in
          both views — it polls, and its dialogs outlive a press on Back — and
          once it has been shown it is not taken away by a poll that came back
          empty while claude-swap rewrote its store. */}
      {lanReady && (
        <LanSyncSection
          accounts={(data?.accounts ?? []).map(a => ({
            // The same key the server builds, from the same two fields: an
            // account is (email, organizationUuid) and never a slot number,
            // because slots are assigned max+1 per store and diverge between
            // two machines that grew in a different order.
            key: `${String(a.email ?? "").trim().toLowerCase()}@@${a.orgUuid ?? ""}`,
            email: a.email ?? "",
            alive: a.alive === true,
          }))}
          onChanged={() => load(true)}
          view={view === "lan"}
          onOpen={openLan}
          onBack={() => setView("accounts")}
          closeButton={closeBtn}
        />
      )}

      {addOpen && (
        <AddAccountDialog
          onClose={() => setAddOpen(false)}
          onChanged={() => load(true)}
        />
      )}

      {/* Gated on the open flag ALONE, the way the add dialog is. Adding
          `data?.accounts?.length` to the condition made a poll that came back
          empty — /api/claude-accounts answers 200 with `no_accounts` when
          sequence.json cannot be read, which is every moment cswap spends
          rewriting it — unmount a dialog holding a bundle the user had not
          copied yet, and then silently reopen it on a fresh picker. The roster
          being empty is a state for the dialog to show, not a reason to
          destroy it. */}
      {shareSetOpen && (
        <ShareAccountsDialog
          accounts={(data?.accounts ?? []).map(a => ({ num: a.num, email: a.email, alias: a.alias, org: a.org }))}
          onClose={() => setShareSetOpen(false)}
          copyText={copyText}
        />
      )}
    </aside>
  );
}
