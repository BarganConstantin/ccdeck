// One account's row in the accounts panel, and the bars it draws.
//
// Lifted out of AccountsPanel.tsx unchanged. The row was a render function
// inside the panel so that the live account above the fold and the others
// behind it would be one row rather than two drifting apart, and it still is
// one: the panel keeps a single `accountRow` that spells these props, and both
// lists map through it. What moved is everything the row draws — the door over
// a shut row, its head and its one verb, the answers a switch or a move leave
// on it, its trouble, the two numbers it rests on and the bars it opens to —
// some two hundred and thirty lines of closure that only ever read the panel.
//
// Nothing here holds state. Every value is the panel's, and what the panel's
// state says about this row arrives already answered — whether its ⋯ is the
// open one, the refusal a switch on it left, the note a swap left on it — so
// the row never reads another account's part of that state. The writes it
// makes are callbacks the panel spells.
import { WarnGlyph } from "./AccountIssuePopover";
import { KitIcon, KitStateGlyph } from "./kit-icons";
import AccountTelemetry from "./AccountTelemetry";
import AccountHint from "./AccountHint";
import { accountIssue, type AccountIssue } from "../account-issue";
import { agoLabel as ago, dueLabel as due } from "../accounts-time";
import { laneLabel } from "../lane-label";
import { useT } from "../i18n";
import { type Failure } from "../accounts-reload";
import { type SwapNote } from "../account-move";
import { type Account, type Lane } from "../claude-accounts";
import { lapsed, laneSplit } from "../lane-view";
import { resetCountdown } from "../relative-time";
import { type useRequestSlot } from "../use-request-slot";
import { laneName } from "../other-accounts-order";
import { resetSinceReading } from "../accounts-usage-report";
import { sharedLine } from "../account-lan";
import { switchedTelemetry, telemetryLine } from "../org-telemetry";

type RequestSlot = ReturnType<typeof useRequestSlot>;

/** How full a window is, in the inks its meter and figure use (V4's Figma):
 *  the text ink from 70%, the error ink from 90%, and the muted ink below that.
 *  Never the warning ink, which is for a problem and not for a quota. */
function fullness(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

/** The ink a meter fill is drawn in at this percentage. */
function meterInk(pct: number): string {
  return pct >= 90 ? "var(--err)" : pct >= 70 ? "var(--text)" : "var(--muted)";
}

export function LaneBar({ lane, nowSec, readAt, frozen, sortedBy }: {
  lane: Lane; nowSec: number; readAt: number | null; frozen?: boolean; sortedBy?: boolean;
}) {
  const t = useT();
  const capped = Math.min(100, Math.max(0, lane.pct));
  // A window whose reset has passed since it was read is over, and the number
  // is the old window's: a record too, however recent the collection.
  const rolled = lapsed(lane, nowSec);
  // A reading that cannot move is drawn as a record rather than a reading: one
  // ink, no warning colours, the fill at half strength. The row says how old.
  const record = frozen || rolled;
  const color  = record ? "var(--muted)" : meterInk(capped);
  // And a reset from a reading that old has most likely happened already.
  const reset  = lane.resetAt && !record ? resetCountdown(lane.resetAt, nowSec) : null;
  // RESET, FROZEN OR NOT, where the number was — as the shut row, the Usage
  // panel's bar and the capacity report say it. A row nothing has read for a
  // quarter of an hour is frozen, and it is the row most likely to have reset:
  // asked only of rows that were not frozen, the open row went on printing
  // 96% for a window the shut row above it and the report both called reset.
  // Not 0% either, which nobody has read. When it reset and what it read
  // before are on hover and said, in the report's words.
  const before = rolled ? resetSinceReading(lane, readAt, nowSec, t) : null;
  return (
    <div className="ap-lane" data-sort-key={sortedBy ? "" : undefined}>
      <span className="ap-lane-label" title={laneLabel(lane.label, t)}>{laneLabel(lane.label, t)}</span>
      <div className="ap-lane-track">
        {/* EMPTY ONCE IT HAS RESET, the way the Usage panel draws a window
            that has: the totals count it as unused, and a bar still 96% full
            beside the word "reset" said the opposite of the word. */}
        {!rolled && <div className="ap-lane-fill" style={{ width: `${capped === 0 ? 1.5 : capped}%`, background: color, opacity: capped === 0 || record ? 0.4 : 1 }} />}
      </div>
      {/* Whole, as the shut row and the Usage panel print it: claude-swap keeps
          the utilisation as it came, and 85.555555% beside a shut-row 86% is
          one window read two ways. */}
      {rolled
        ? <span className="ap-lane-pct" style={{ color }} data-reset="" title={before ?? undefined}>
            {before ? <><span aria-hidden>{t("accounts.row.resetWord")}</span><span className="vis-hidden">{before}</span></> : t("accounts.row.resetWord")}
          </span>
        : <span className="ap-lane-pct" style={{ color }}>{Math.round(capped)}%</span>}
      {/* When the window rolls over, at the end of its own bar rather than on a
          line under it: two resets under two bars made the live row five lines
          tall for two facts. The word is said to a screen reader and in the
          title; on screen a countdown beside a quota reads as one. */}
      <span className="ap-lane-reset" title={reset ? t("accounts.row.laneResetsIn", { label: laneLabel(lane.label, t), time: reset }) : undefined}>
        {reset && <><span className="vis-hidden">{t("accounts.row.resetsInSr")}</span>{reset}</>}
      </span>
    </div>
  );
}

/**
 * WHAT A ROW SAYS THAT BELONGS TO ITS PROVIDER. Codex's accounts are drawn by
 * this same row, so the two columns cannot drift apart, and these are the only
 * things that differ: who reads the numbers, and what a switch does to the
 * sessions already running. The prefix goes before every id the row gives out,
 * because both columns can be open at once and an anchor found by id would
 * otherwise be the other column's.
 */
export interface RowVoice {
  idPrefix: string;
  /** The live dot's title, and what a screen reader is told in its place. */
  liveTitle?: (num: number) => string;
  liveSpoken?: (num: number) => string;
  /** A shut row's age, on hover. */
  readBy?: string;
  /** The open row's age, on hover: who reads it and how often. */
  readPlan?: string;
  /** Over "never collected" on an open row. */
  neverRead?: string;
  /** Said on the row a switch landed on. */
  switched?: string;
  /** Said instead of "no usage recorded yet" while a first read is out. Claude's
   *  roster arrives with its numbers, so it never has this moment. */
  waiting?: string;
}

/** Claude's row says everything in the catalog (`accounts.row.*`); only what a
 *  provider sets here replaces it. */
export const CLAUDE_VOICE: RowVoice = { idPrefix: "" };

interface Props {
  a: Account;
  nowSec: number;
  /** Absent for Claude, whose words are the default. */
  voice?: RowVoice;
  /** What is wrong with this account, for a provider whose trouble is not
   *  claude-swap's. Null is nothing wrong; absent, the row works it out. */
  issueOverride?: AccountIssue | null;
  /** Whether a paired deck can restore this account and which decks share it. */
  lan?: {
    noCopyWorksNearby?: boolean; sharedTo?: readonly string[] | null; sharedInUse?: boolean;
  };
  /** The reader has opened this row's detail. */
  opened: boolean;
  /** Open this row's detail, or shut it. */
  onToggleLanes: () => void;
  busy: RequestSlot["busy"];
  pressProps: RequestSlot["pressProps"];
  onSwitch: (num: number, name: string) => void;
  /** This row's ⋯ is the one open. */
  menuOpen: boolean;
  onOpenMenu: (num: number, start?: "first" | "last") => void;
  onCloseMenu: (only?: number) => void;
  /** Why a switch pressed on this row did not work, if one did not. */
  refusal: Failure | null;
  onDismissRefusal: () => void;
  /** Open the sign-in dialog for this account — the remedy a refusal for an
   *  expired login offers (#2184). Absent, that refusal offers no button. */
  onSignIn?: (email: string | null) => void;
  /** A switch from the panel just landed on this account. */
  switchedHere: boolean;
  /** The swap a move into a taken slot made, when it landed on this row. */
  swapped: SwapNote | null;
  /** The account that swap sent to the other slot, for its name. */
  displaced: Account | undefined;
  /** This row's warning has its explanation open. */
  issueExpanded: boolean;
  onOpenIssue: (num: number, anchor: string) => void;
  /** What the list behind the fold is ordered by (#1579) — a window's name,
   *  "room", or null — so the row can mark the number it was placed by. */
  sortKey?: string | null;
  /** This is Auto-switch's home account: what the mark says about it
   *  (auto-choice.ts homeTitle), or null on every other row. */
  home?: string | null;
  /** Something is rotating accounts — the deck's loop or a terminal's — so the
   *  telemetry line points at "Hold out of rotation" in the ⋯ menu. */
  rotating?: boolean;
  /** The scroll area that can clip this row's telemetry indicator. */
  telemetryBoundaryId?: string;
  /** The plan the signed-in login is on ("Max 20x"), from the reading the deck
   *  already takes. It belongs to the live account only, so only that row
   *  draws it; absent, no row has a plan. */
  planLabel?: string | null;
}

export default function AccountRow({
  a, nowSec, voice = CLAUDE_VOICE, issueOverride, lan, opened, onToggleLanes, busy, pressProps, onSwitch, menuOpen, onOpenMenu, onCloseMenu,
  refusal, onDismissRefusal, onSignIn, switchedHere, swapped, displaced, issueExpanded, onOpenIssue, sortKey = null, home = null,
  rotating = false, telemetryBoundaryId, planLabel = null,
}: Props) {
  const t = useT();
  const ids = voice.idPrefix;
  // The windows that have not reset since they were read: the only ones whose
  // numbers say anything about this window (lane-view.ts's lapsed).
  const live = a.lanes.filter(l => !lapsed(l, nowSec));
  const { shown } = laneSplit(a.lanes);
  // A folded lane joins the shut row when it is fuller than every window still
  // running — not measured against one that has reset since.
  const { fuller } = laneSplit(live);
  // THE NUMBER THIS ROW WAS PLACED BY (#1579), marked in the shut line and on
  // the bars, so a sorted list says what it is sorted by at the numbers
  // themselves rather than only in the control that sorted it. Under "room"
  // it is the tightest window still running: the one the room is measured from.
  const keyLane = sortKey === "room"
    ? live.reduce<Lane | null>((x, l) => (x && x.pct >= l.pct ? x : l), null)
    : sortKey ? a.lanes.find(l => laneName(l) === sortKey) ?? null : null;
  const issue = issueOverride !== undefined ? issueOverride : accountIssue(a, nowSec, lan, t);
  // THE ACTIVE ROW IS OPEN, AND EVERY OTHER ROW IS SHUT UNTIL ASKED.
  // The live account is the one whose windows are being spent, so
  // its bars, resets and freshness are the reading this column is
  // opened for. Any other account only has to answer one question —
  // is it worth switching to — and two numbers answer it. The rest
  // is one press on the row away, and held by account (#542).
  // EVERY ROW IS ONE SHAPE (V4's Figma): the name, one figure, one line under
  // it and one meter. The live row used to be open by what it is, with a bar per
  // window; those bars are one press away on every row now, the live one too.
  const open = opened;
  const name = a.alias ?? a.email ?? t("accounts.accountNLower", { n: a.num });
  // The whole identity, for the door. The head clips both names with an
  // ellipsis and the door lies over them, so the door is where a pointer
  // lands and where the full string has to be (#1115).
  const identity = a.alias && a.email ? `${a.alias} · ${a.email}` : name;
  // Numbers that cannot move: nothing collected for a quarter of an
  // hour, or a login that no collection can get past. They stay on
  // screen as the last reading and are drawn as one.
  const frozen = a.stale || issue?.blocksSwitch === true;
  // The row leads with the windows; a folded model lane joins them
  // only when it is the fullest, so two calm numbers never sit over
  // a hidden hot one. See lane-view.ts.
  const quick = fuller ? [...shown, fuller] : shown;
  // THE ONE FIGURE AND THE ONE METER are the first window's; the others ride
  // in the line under the name (V4's Figma: "Resets in 2h 09m · 7-day 31%").
  const primary = quick[0] ?? null;
  const primaryRolled = primary ? lapsed(primary, nowSec) : false;
  const primaryPct = primary ? Math.min(100, Math.max(0, primary.pct)) : 0;
  const primaryReset = primary?.resetAt && !primaryRolled && !frozen ? resetCountdown(primary.resetAt, nowSec) : null;
  const age = a.fetchedAt ? ago(a.fetchedAt, nowSec, t) : null;
  // What the row no longer draws stays on the row: the whole identity, the slot
  // and every window with its reset, and when it was read, in the title of the
  // row's door and in what a screen reader is told.
  const detailTitle = [
    identity,
    a.active ? t("accounts.row.activeTitle", { n: a.num }) : t("accounts.row.slotTitle", { n: a.num }),
    ...a.lanes.map(l => {
      const left = !lapsed(l, nowSec) && l.resetAt ? resetCountdown(l.resetAt, nowSec) : null;
      const said = `${laneLabel(l.label, t)} ${lapsed(l, nowSec) ? t("accounts.row.resetWord") : `${Math.round(l.pct)}%`}`;
      return left ? `${said} · ${t("accounts.row.resetsIn", { time: left })}` : said;
    }),
    a.fetchedAt ? `${t("accounts.row.collected", { ago: ago(a.fetchedAt, nowSec, t) })}${issue?.blocksSwitch ? "" : due(a.nextAt, nowSec, t)}` : null,
  ].filter(Boolean).join("\n");
  // Every row says only the age; whose read it was waits in its tooltip.
  const ageTitle = a.sharedFrom
    ? t("accounts.row.readOn", { from: a.sharedFrom })
    : voice.readBy ?? t("accounts.row.lastRead");
  // What the account's organization sends, when the deck has seen it — said
  // before a switch, because Claude Code applies it without asking in its
  // non-interactive surfaces. See org-telemetry.ts.
  const telemetry = telemetryLine(a.telemetry, nowSec, { holdOut: rotating && !a.active && !a.disabled });
  const switchedNote = switchedTelemetry(a.telemetry);
  return (
    <li className={`ap-account${a.active ? " active" : ""}`}
      aria-current={a.active ? "true" : undefined}
      data-open={open ? "" : undefined}
      data-frozen={frozen ? "" : undefined}>
      {/* THE ROW IS THE DOOR, the way a machine's row is in Local
          network: a button laid over the whole row, under the row's
          own controls, so a press anywhere on it opens or shuts the
          detail and the keyboard's ring goes round the row. The live
          row has nothing folded, so it has no door.

          It carries the whole identity because it covers the clipped
          names: the title for a pointer, and — since a title reaches
          neither the keyboard nor a screen reader (WCAG 1.4.13) — the
          email in its description when the name it is called by is the
          alias. */}
        <button type="button" className="ap-row-open" id={`ap-${ids}row-${a.num}`}
          title={detailTitle}
          aria-expanded={open}
          aria-controls={open ? `ap-${ids}detail-${a.num}` : undefined}
          aria-describedby={[
            a.alias && a.email ? `ap-${ids}email-${a.num}` : null,
            home ? `ap-${ids}home-${a.num}` : null,
            lan?.sharedTo ? `ap-${ids}shared-${a.num}` : null,
            !open && !issue?.blocksSwitch ? `ap-${ids}quota-${a.num}` : null,
            telemetry ? `ap-${ids}telemetry-${a.num}` : null,
          ].filter(Boolean).join(" ") || undefined}
          onClick={() => onToggleLanes()}>
          <span className="vis-hidden">{t(open ? "accounts.row.hideDetails" : "accounts.row.showDetails", { name })}</span>
        </button>
      <div className="ap-account-head">
        {/* The live account is marked by a dot where the other rows
            carry their slot, in the accent, which in this deck means
            live. The slot is still its name for the CLI, so it rides
            in the title and in what a screen reader is told. */}
        {a.active
          ? <span className="ap-live" title={voice.liveTitle?.(a.num) ?? t("accounts.row.activeTitle", { n: a.num })}>
              <KitStateGlyph name="done" />
              <span className="vis-hidden">{voice.liveSpoken?.(a.num) ?? t("accounts.row.activeSr", { n: a.num })}</span>
            </span>
          : <span className="ap-num" title={t("accounts.row.slotTitle", { n: a.num })}>
              {a.disabled ? <KitIcon name="pause" /> : <KitStateGlyph name="idle" />}
              <span className="vis-hidden">{a.num}</span>
            </span>}
        {/* Both of these are clipped with an ellipsis so a long one
            cannot widen the panel, which means the row can be showing
            less than the whole string — so each one carries its own
            whole value in a title (#517). On a shut row the door lies
            over them and says the same in its own title; the email's
            id is what the door's description points at. */}
        <span className="ap-alias" title={identity}>{name}</span>
        {/* The address a name stands in for: said to a screen reader, and on
            the row's title; V4's row draws one name. */}
        {a.alias && a.email && <span className="ap-email vis-hidden" id={`ap-${ids}email-${a.num}`}>{a.email}</span>}
        {a.active && planLabel && <span className="ap-plan">{planLabel}</span>}
        {telemetry &&<AccountTelemetry num={a.num} name={name} telemetry={telemetry} boundaryId={telemetryBoundaryId} />}
        {/* HOME: the account Auto-switch comes back to. A mark, like the
            shared one beside it, and set from the ⋯ rather than by another
            control on every row; whether Auto-switch is passing it over
            right now, and why, is its title. */}
        {home && (
          <AccountHint detail={home}>
            <span className="ap-home" id={`ap-${ids}home-${a.num}`} title={home} role="img" aria-label={t("accounts.row.homeLabel")}>
              <span aria-hidden>{t("accounts.row.homeTag")}</span>
              <span className="vis-hidden">{home}</span>
            </span>
          </AccountHint>
        )}
        {/* SHARED, SAID ON THE ROW (#2170). Whether a login is offered to the
            paired decks was a tick in Local network's setup dialog and nowhere
            else, so somebody keeping a personal login to themselves opened
            that dialog every time to be sure. A mark rather than a word: it
            stands after the email, which takes the free width, so the marks
            line up down the column and a login without one reads as not
            offered at a glance. Who it is offered to is its title — raised
            over the door so the pointer gets it — and what a screen reader
            hears, on the row and in the door's description. */}
        {lan?.sharedTo && (
          <AccountHint detail={sharedLine(lan.sharedTo, lan.sharedInUse, t)}>
            <span className="ap-shared" id={`ap-${ids}shared-${a.num}`} title={sharedLine(lan.sharedTo, lan.sharedInUse, t)} role="img" aria-label={t("accounts.row.sharingLabel")}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" aria-hidden>
                <circle cx="10.5" cy="3.2" r="1.7" />
                <circle cx="3.5" cy="7" r="1.7" />
                <circle cx="10.5" cy="10.8" r="1.7" />
                <path d="M5.2 6.1 8.8 4.1M5.2 7.9l3.6 2" />
              </svg>
              <span className="vis-hidden">{sharedLine(lan.sharedTo, lan.sharedInUse, t)}</span>
            </span>
          </AccountHint>
        )}
        {/* A state, said in a word and not in a pill. It stands where
            `Switch` would, because a switch to a held-out account is
            refused and a control that can never act is worse than
            none (#519). Putting it back is in the ⋯. */}
        {a.disabled && <span className="ap-held ap-value">{t("accounts.heldOut")}</span>}
        {/* THE ONE FIGURE, at the right: the first window's fullness, in the
            muted, text or error ink by how full it is. A login that cannot
            be read shows none; the line on the row says why. */}
        {!a.disabled && primary && !issue?.blocksSwitch && (
          primaryRolled
            ? <span className="ap-value ap-q-pct" title={t("accounts.row.laneReset", { label: primary.label })}>{t("accounts.row.resetWord")}</span>
            : <span className="ap-value ap-q-pct" data-level={frozen ? undefined : fullness(primary.pct)}>{Math.round(primary.pct)}%</span>
        )}
        {/* The row's two acts take the value's place under the pointer and are
            always there on touch (accounts-panel.css). */}
        <span className="ap-acts">
        {/* The one verb a row carries, and quieter than the account it
            is about: a word on the control fill, no edge. Not offered
            where it cannot work — to a login that is dead or was never
            stored, a switch only makes the dead one live. */}
        {!a.active && !a.disabled && !issue?.blocksSwitch && (
          <button
            type="button"
            className="ap-switch"
            {...pressProps(`switch-${a.num}`)}
            onClick={() => onSwitch(a.num, name)}
            aria-label={t("accounts.row.switchTo", { name })}
            title={t("accounts.row.switchTo", { name: a.alias ?? a.email ?? name })}
          >{busy === `switch-${a.num}` ? "…" : t("accounts.row.switch")}</button>
        )}
        {/* THE WAY IN TO EVERYTHING ELSE. It opens a menu over the
            column rather than opening the row, so pressing it moves
            nothing on screen. aria-controls only while the menu
            exists: an IDREF that resolves to nothing is a dangling
            pointer. The name carries the account, because a column of
            identical "More actions" is a column of buttons a screen
            reader cannot tell apart. */}
        <button type="button" id={`ap-${ids}more-${a.num}`} className="ap-more"
          aria-label={t("accounts.row.moreFor", { who: a.email ?? a.alias ?? t("accounts.accountNLower", { n: a.num }) })}
          aria-haspopup="menu" aria-expanded={menuOpen}
          aria-controls={menuOpen ? `ap-${ids}menu-${a.num}` : undefined}
          title={t("accounts.row.more")}
          onClick={() => (menuOpen ? onCloseMenu() : onOpenMenu(a.num))}
          onKeyDown={e => {
            // Down opens at the first item and Up at the last, the way
            // a native menu button does. Enter and Space are the click.
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            onOpenMenu(a.num, e.key === "ArrowUp" ? "last" : "first");
          }}>
          <KitIcon name="more" />
        </button>
        </span>
      </div>

      {/* THE ANSWER TO A SWITCH, on the row it was about (#827). A
          switch that took says so on the row it took to, with the one
          thing nothing else on screen says: what happens to the
          sessions already running. */}
      {refusal && (
        <div className="ap-failure ap-row-failure" role="alert">
          <span className="ap-failure-text" title={refusal.raw || undefined}>{refusal.text}</span>
          {/* A switch the deck refused because this login has expired
              (#2184) has one remedy, and it is offered where the refusal
              is: the sign-in dialog, filled in with this account. */}
          {refusal.signIn && onSignIn && (
            <button type="button" className="ap-fix ap-failure-fix" onClick={() => onSignIn(a.email)}
              aria-label={t("accounts.reauth.againAs", { name: a.email ?? name })}
              title={t("accounts.row.reauthTip")}>
              {t("accounts.reauth.again")}
            </button>
          )}
          <button type="button" className="ap-failure-x" onClick={() => onDismissRefusal()}
            aria-label={t("accounts.row.dismissLabel")} title={t("accounts.row.dismiss")}>×</button>
        </div>
      )}
      {a.active && switchedHere && (
        <p className="ap-switched">{voice.switched ?? t("accounts.row.nowActive")}</p>
      )}
      {/* What the switch just turned on, said where the switch is answered: a
          switch somebody pressed raises no notification. */}
      {a.active && switchedHere && switchedNote && (
        <p className="ap-switched">{switchedNote}</p>
      )}
      {/* A move into a taken slot relocated a second account, and this
          is the only place that says so, for eight seconds. The
          sentence naming who went where is its title. */}
      {swapped && (() => {
        const who = displaced?.alias ?? displaced?.email ?? t("accounts.row.whoWasThere");
        return (
          <p className="ap-note ap-swap-note"
            title={t("accounts.row.swapTitle", { at: swapped.at, who, displaced: swapped.displaced })}>
            {t("accounts.row.swapped", { n: swapped.displaced })}
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
          <button type="button" id={`ap-${ids}issue-${a.num}`} className="ap-issue" data-tone={issue.tone}
            aria-haspopup="dialog"
            aria-expanded={issueExpanded}
            aria-controls={issueExpanded ? "ap-issue-pop" : undefined}
            onClick={() => onOpenIssue(a.num, `ap-${ids}issue-${a.num}`)}>
            {issue.tone === "warn" && <WarnGlyph />}
            <span className="ap-issue-text">{issue.text}</span>
          </button>
          {issue.fix && onSignIn && (
            <button type="button" className="ap-sign-in"
              aria-label={t("accounts.row.fixAs", { fix: issue.fix, name: a.email ?? name })} title={issue.hint}
              onClick={() => onSignIn(a.email)}>{t("accounts.row.signIn")}</button>
          )}
          {/* How old the last reading is. On an open row the freshness
              line under the bars says it, so it is said once. */}
          {!open && (age || !voice.waiting) && (
            <span className="ap-issue-age" title={ageTitle}>
              {age ?? t("accounts.row.ageNever")}
            </span>
          )}
        </div>
      )}

      {/* THE LINE UNDER THE NAME AND THE ONE METER (V4's Figma): when the first
          window resets and the other windows' fullness, then a 2px meter on the
          first window. No bars, no clock — unless the numbers are old, and then
          the age is the one thing that must be said beside them. A login that
          cannot be used shows none of it: the line below is the answer, and last
          week's quota under it would read as this week's. */}
      {!issue?.blocksSwitch && (
        <p className="ap-quota" id={`ap-${ids}quota-${a.num}`}>
          {primary
            ? <>
                {/* The figure in the head is the first window's, and the head is
                    not what this line is read from: the door is described by
                    this line, so the figure is said here too, with its window,
                    for a screen reader ("5h 31%"). */}
                <span className="vis-hidden">
                  {laneLabel(primary.label, t)}{" "}{primaryRolled ? t("accounts.row.resetWord") : `${Math.round(primary.pct)}%`}{". "}
                </span>
                {primaryReset && <span className="ap-q-reset">{t("accounts.row.resetsIn", { time: primaryReset })}</span>}
                {quick.slice(1).map(l => (
                  <span key={l.id} className="ap-q" data-sort-key={l.id === keyLane?.id ? "" : undefined}>
                    <span className="ap-q-label">{laneLabel(l.label, t)}</span>{" "}
                    {/* A window that has reset since it was read is said to
                        have, as its open bar says it: its number is the old
                        window's. */}
                    {lapsed(l, nowSec)
                      ? <span className="ap-q-pct" title={t("accounts.row.laneReset", { label: l.label })}>{t("accounts.row.resetWord")}</span>
                      : <span className="ap-q-pct" data-level={frozen ? undefined : fullness(l.pct)}>{Math.round(l.pct)}%</span>}
                  </span>
                ))}
              </>
            : <span className="ap-q-label">{voice.waiting ?? t("accounts.row.noUsageLower")}</span>}
          {a.stale && !issue && (
            <span className="ap-q-age" data-never={age ? undefined : ""} title={ageTitle}>
              {age ?? t("accounts.row.ageNever")}
            </span>
          )}
        </p>
      )}
      {primary && !issue?.blocksSwitch && !a.disabled && (
        <div className="ap-meter" aria-hidden>
          {!primaryRolled && <div className="ap-meter-fill" data-sort-key={primary.id === keyLane?.id ? "" : undefined}
            style={{ width: `${primaryPct === 0 ? 1.5 : primaryPct}%`, background: frozen ? "var(--muted)" : meterInk(primaryPct), opacity: primaryPct === 0 || frozen ? 0.4 : 1 }} />}
        </div>
      )}

      {/* OPEN: every window as a bar, when each one resets, and when
          claude-swap last read it and plans to read it again — the
          freshness that says whether these numbers are a decision's
          worth of evidence. */}
      {open && (
        <div className="ap-detail" id={`ap-${ids}detail-${a.num}`}>
          <div className="ap-lanes">
            {a.lanes.length
              ? a.lanes.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} readAt={a.fetchedAt} frozen={frozen} sortedBy={l.id === keyLane?.id} />)
              : <div className="ap-hint">{voice.waiting ?? t("accounts.row.noUsage")}</div>}
          </div>
          <div className="ap-meta">
            {/* The address a name stands in for, as text: the head draws one
                name, and a title is reachable by neither touch nor keyboard.
                The screen reader has it already, in the door's description. */}
            {a.alias && a.email && <span className="ap-meta-email" aria-hidden>{a.email}</span>}
            {a.fetchedAt
              ? <span
                  // ONE ATTENTION COLOUR PER ROW, ON THE CAUSE: an
                  // account with a problem is old because of it, so
                  // the age stays quiet and the problem takes the ink.
                  className={`ap-age${a.stale && !issue ? " ap-stale" : ""}`}
                  title={a.sharedFrom
                    ? t("accounts.row.readOnLong", { from: a.sharedFrom })
                    : voice.readPlan ?? t("accounts.row.lastReadLong")}
                >{t("accounts.row.collected", { ago: ago(a.fetchedAt, nowSec, t) })}{issue?.blocksSwitch ? "" : due(a.nextAt, nowSec, t)}</span>
              : !voice.waiting && <span className="ap-age ap-stale" title={voice.neverRead ?? t("accounts.row.notReadYet")}>{t("accounts.row.ageNever")}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
