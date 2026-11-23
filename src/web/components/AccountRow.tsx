// One account's row in the accounts panel, and the lines it opens to.
//
// Lifted out of AccountsPanel.tsx unchanged. The row was a render function
// inside the panel so that the live account above the fold and the others
// behind it would be one row rather than two drifting apart, and it still is
// one: the panel keeps a single `accountRow` that spells these props, and both
// lists map through it. What moved is everything the row draws — the door over
// a shut row, its head and its one verb, the answers a switch or a move leave
// on it, its trouble, the two numbers it rests on and the lines it opens to —
// some two hundred and thirty lines of closure that only ever read the panel.
//
// Nothing here holds state. Every value is the panel's, and what the panel's
// state says about this row arrives already answered — whether its ⋯ is the
// open one, the refusal a switch on it left, the note a swap left on it — so
// the row never reads another account's part of that state. The writes it
// makes are callbacks the panel spells.
//
// Every account, the live one and every other, draws the name and then one bar
// per window it reports — 5h, 7d, a model's own such as Fable — with how full
// it is and when it resets, in columns, so accounts compare at a glance
// (#2644). A problem has its own line under the name. Pressing the row opens
// when the reading was taken and what the organization sends.
import { WarnGlyph } from "./AccountIssuePopover";
import { KitIcon, KitStateGlyph, type KitIconName } from "./kit-icons";
import { type LevelTone } from "./LevelMark";
import { quotaFill, quotaLevel } from "./QuotaBar";
import AccountTelemetry from "./AccountTelemetry";
import AccountHint from "./AccountHint";
import { accountIssue, sentence, type AccountIssue } from "../account-issue";
import { agoLabel as ago, dueLabel as due, resetPhrase } from "../accounts-time";
import { laneLabel, windowName } from "../lane-label";
import { useT } from "../i18n";
import { type Failure } from "../accounts-reload";
import { type SwapNote } from "../account-move";
import { type Account, type Lane } from "../claude-accounts";
import { lapsed } from "../lane-view";
import { resetCountdown } from "../relative-time";
import { type useRequestSlot } from "../use-request-slot";
import { resetSinceReading } from "../accounts-usage-report";
import { sharedLine } from "../account-lan";
import { telemetryLine } from "../org-telemetry";

type RequestSlot = ReturnType<typeof useRequestSlot>;

/** How full a window is, in the inks its figure and bar use: the Usage
 *  panel's level (quotaLevel), the warning from 70% and the error from 90%.
 *  Below that a figure keeps its line's own ink — a quota is not a problem
 *  until it is nearly spent. */
const fullness = (pct: number): LevelTone | undefined => quotaLevel(pct) ?? undefined;

/** A quota figure painted --warn or --err for its level never says so in
 *  colour alone (WCAG 1.4.1). A lane's figure stands in a column beside its
 *  bar, so it wears the mark alone and gives the word to a screen reader and
 *  to the hover — "high" beside every hot figure would push the bars apart.
 *  Below its level the figure is drawn as it always was. */
function QuotaPct({ className, pct, level }: {
  className: string; pct: number; level: LevelTone | undefined;
}) {
  const t = useT();
  const n = `${Math.round(pct)}%`;
  if (!level) return <span className={className}>{n}</span>;
  const word = t("common.level.high");
  return (
    <span className={className} data-level={level} title={word}>
      <KitIcon name="warning" className="level-mark-glyph" />{n}<span className="vis-hidden"> {word}</span>
    </span>
  );
}

/** An address as the row draws it: the part before the @ in the text ink and
 *  the domain after it quieter, so the name a person reads first is the part
 *  that tells two accounts at one company apart. Anything else is one name. */
function splitAddress(name: string): { local: string; domain: string | null } {
  const at = name.lastIndexOf("@");
  return at > 0 && at < name.length - 1 ? { local: name.slice(0, at), domain: name.slice(at) } : { local: name, domain: null };
}

/** What a lane's reset column can print at its widest in the language on show,
 *  one per line: a minute short of a day ("23h 59m"), a day short of a week
 *  ("6d 23h") and the word for a window nobody has spent from ("not started").
 *  Every reset cell is held to the widest of them (accounts-panel.css), so the
 *  columns of two accounts line up whatever their own resets say — "3 Std. 11
 *  Min." over "6 Tg. 6 Std.", or an account whose window has not started under
 *  one whose window has. */
export function resetFloor(nowSec: number, idle: string): string {
  const day = resetCountdown(nowSec + 23 * 3600 + 59 * 60, nowSec) ?? "";
  const week = resetCountdown(nowSec + 6 * 86400 + 23 * 3600, nowSec) ?? "";
  return [day, week, idle].join("\n");
}

/**
 * ONE WINDOW, AS A BAR (#2644): the window's short name, a bar, how full it is
 * and how long until it resets ("7d  ▬▬▬▬▬───  79%  2d 17h").
 *
 * A user said the 3.x overview, a bar per window on every account, was clearer
 * than the lines that replaced it, which read as text: comparing accounts
 * meant reading each one. So every row draws its windows this way, shut or
 * open, the live account and the others alike, and every account reads the
 * same.
 *
 * THE FOUR ARE COLUMNS. An account's lanes are one grid (accounts-panel.css),
 * so its figures and resets stand one under another; the name and the figure
 * columns have a fixed width and the reset column a floor, so the bars of one
 * account line up with the next one's too. The window's whole name ("Weekly")
 * is the label's title; the countdown says "resets in" to a screen reader and,
 * with the window's name, in its title.
 *
 * WHAT THE BAR SAYS IS WHAT THE FIGURE SAYS. The fill is the figure's level
 * (quotaLevel) in its ink; a record — an old reading, or a login that cannot
 * be read — is drawn in the quiet ink with no level, a window that has reset
 * since it was read is an empty track beside "reset", and a window at 0% keeps
 * a faint sliver, so none of them can pass for another. A window the account
 * does not report has no lane at all.
 */
export function LaneBar({ lane, nowSec, readAt, frozen }: {
  lane: Lane; nowSec: number; readAt: number | null; frozen?: boolean;
}) {
  const t = useT();
  const capped = Math.min(100, Math.max(0, lane.pct));
  // A window whose reset has passed since it was read is over, and the number
  // is the old window's: a record too, however recent the collection.
  const rolled = lapsed(lane, nowSec);
  // A reading that cannot move is drawn as a record rather than a reading: one
  // ink, no warning colours. The row says how old.
  const record = frozen || rolled;
  const level = record ? undefined : fullness(capped);
  // A reset still ahead is when the window ends, which no later reading moves,
  // so it is counted down on an old reading too: the shut row used to say it
  // to a screen reader there, and the comparison needs it on every account. A
  // reset that has passed is the "reset" in the figure's place instead.
  const countdown = lane.resetAt && !rolled ? resetCountdown(lane.resetAt, nowSec) : null;
  // RESET, FROZEN OR NOT, where the number was — as the shut row, the Usage
  // panel's bar and the capacity report say it. A row nothing has read for a
  // quarter of an hour is frozen, and it is the row most likely to have reset:
  // asked only of rows that were not frozen, the open row went on printing
  // 96% for a window the shut row above it and the report both called reset.
  // Not 0% either, which nobody has read. When it reset and what it read
  // before are on hover and said, in the report's words.
  const before = rolled ? resetSinceReading(lane, readAt, nowSec, t) : null;
  // A window nobody has spent from yet has no reset to count down to.
  const idle = !record && capped === 0 && !lane.resetAt;
  return (
    <div className="ap-lane">
      <span className="ap-lane-label" title={windowName(lane, t)}>{laneLabel(lane.label, t)}</span>
      {/* EMPTY ONCE IT HAS RESET, as the Usage panel draws a window that has:
          a bar still 96% full beside the word "reset" would say the opposite
          of the word. A window at 0% keeps a faint sliver, so an empty track
          is never mistaken for one nobody has spent from. */}
      <span className="ap-lane-track" aria-hidden>
        {!rolled && <span className="ap-lane-fill"
          style={{ width: `${capped === 0 ? 1.5 : capped}%`, background: record ? "var(--muted)" : quotaFill(level ?? null), opacity: capped === 0 ? 0.4 : 1 }} />}
      </span>
      {/* Whole, as the Usage panel prints it: claude-swap keeps the utilisation
          as it came, and 85.555555% beside another surface's 86% is one window
          read two ways. A high figure wears the warning mark, with the word on
          hover and for a screen reader. */}
      {rolled
        ? <span className="ap-lane-pct" data-reset="" title={before ?? undefined}>
            {before ? <><span aria-hidden>{t("accounts.row.resetWord")}</span><span className="vis-hidden">{before}</span></> : t("accounts.row.resetWord")}
          </span>
        : <QuotaPct className="ap-lane-pct" pct={capped} level={level} />}
      {/* Always drawn, empty when there is nothing to count down to, so every
          lane fills the same four columns, and never narrower than the widest
          thing the column prints in the language (accounts-panel.css), so the
          column is one width on every account. */}
      <span className="ap-lane-reset" data-widest={resetFloor(nowSec, t("accounts.row.notStarted"))}
        title={countdown ? t("accounts.row.laneResetsIn", { label: laneLabel(lane.label, t), time: countdown }) : undefined}>
        {countdown
          ? <><span className="vis-hidden">{t("accounts.row.resetsInSr")}</span>{countdown}</>
          : idle ? t("accounts.row.notStarted") : null}
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
  /** A grey word among the live row's marks ("default"), for a provider whose
   *  live account is a default rather than the one in use. */
  liveTag?: string;
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
  /** Said instead of "no usage recorded yet" on a row nothing has read, for a
   *  provider that reads its accounts on demand ("Quota not checked yet"). */
  noReading?: string;
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
  /** This is Auto-switch's home account: what the mark says about it
   *  (auto-choice.ts homeTitle), or null on every other row. */
  home?: string | null;
  /** Something is rotating accounts — the deck's loop or a terminal's — so the
   *  telemetry line points at "Hold out of rotation" in the ⋯ menu. */
  rotating?: boolean;
  /** The scroll area that can clip this row's telemetry indicator. */
  telemetryBoundaryId?: string;
  /** The plan the account is on ("Max 20x", "Plus"), from a reading the deck
   *  already takes: Claude's for its live login, Codex's for every account it
   *  has read. Absent, the row has no plan to say and draws none. */
  planLabel?: string | null;
}

/** The state an account is in, said on a line of its own under the name. */
interface RowState {
  /** Which ink the line is in: the error ink, the waiting ink or the quiet one. */
  tone: "err" | "wait" | "quiet";
  glyph: KitIconName;
}

/** The glyph and the ink of what is wrong: a login only a sign-in brings back
 *  in the error ink with the warning mark, a rate limit with a clock in the
 *  waiting ink, anything else that is the reader's to fix with the warning mark
 *  in the waiting ink, and what clears or repairs on its own quietly. */
function issueState(issue: AccountIssue): RowState {
  if (issue.blocksSwitch) return { tone: "err", glyph: "warning" };
  if (issue.kind === "rate") return { tone: "wait", glyph: "time" };
  if (issue.tone === "warn") return { tone: "wait", glyph: "warning" };
  return { tone: "quiet", glyph: "info" };
}

export default function AccountRow({
  a, nowSec, voice = CLAUDE_VOICE, issueOverride, lan, opened, onToggleLanes, busy, pressProps, onSwitch, menuOpen, onOpenMenu, onCloseMenu,
  refusal, onDismissRefusal, onSignIn, switchedHere, swapped, displaced, issueExpanded, onOpenIssue, home = null,
  rotating = false, telemetryBoundaryId, planLabel = null,
}: Props) {
  const t = useT();
  const ids = voice.idPrefix;
  // The windows that have not reset since they were read: the only ones whose
  // numbers say anything about this window (lane-view.ts's lapsed).
  const live = a.lanes.filter(l => !lapsed(l, nowSec));
  const issue = issueOverride !== undefined ? issueOverride : accountIssue(a, nowSec, lan, t);
  // EVERY ROW IS ONE SHAPE: the name, a bar for every window it reports with
  // its figure and its reset, and a state line only for a state. When it was
  // read and what its organization sends are one press on the row away, the
  // live row's too, and held by account (#542).
  const open = opened;
  const name = a.alias ?? a.email ?? t("accounts.accountNLower", { n: a.num });
  // The whole identity, for the door. The head clips the name with an
  // ellipsis and the door lies over it, so the door is where a pointer lands
  // and where the full string has to be (#1115).
  const identity = a.alias && a.email ? `${a.alias} · ${a.email}` : name;
  // An address shows its domain quieter than its name; an alias is one name.
  const { local, domain } = a.alias ? { local: name, domain: null } : splitAddress(name);
  // Numbers that cannot move: nothing collected for a quarter of an
  // hour, or a login that no collection can get past. They stay on
  // screen as the last reading and are drawn as one.
  const frozen = a.stale || issue?.blocksSwitch === true;
  // A login that cannot be used has no numbers worth showing: last week's
  // quota beside "Login expired" would read as this week's. Its bars wait in
  // the open row, drawn as the record they are.
  const blocked = issue?.blocksSwitch === true;
  const age = a.fetchedAt ? ago(a.fetchedAt, nowSec, t) : null;
  // Every row says only the age; whose read it was waits in its tooltip.
  const ageTitle = a.sharedFrom
    ? t("accounts.row.readOn", { from: a.sharedFrom })
    : voice.readBy ?? t("accounts.row.lastRead");
  // What the account's organization sends, when the deck has seen it — said
  // before a switch, because Claude Code applies it without asking in its
  // non-interactive surfaces. See org-telemetry.ts.
  const telemetry = telemetryLine(a.telemetry, nowSec, { holdOut: rotating && !a.active && !a.disabled });
  // THE WEEKLY LIMIT, said as a state: a 7-day window spent to the end is the
  // one full window that does not come back within the day, so it gets the
  // line a state gets, with when it resets — not only a red figure.
  const week = live.find(l => l.id === "seven_day");
  const weekFull = !issue && !frozen && !!week && week.pct >= 100;
  const weekReset = weekFull && week?.resetAt ? resetPhrase(week.resetAt, nowSec, t) : null;
  // The state on the second line: what is wrong first, then a
  // weekly limit, then a reading that has gone old.
  const state: RowState | null = issue ? issueState(issue)
    : weekFull ? { tone: "err", glyph: "calendar" }
    : a.stale ? { tone: "quiet", glyph: "info" }
    : null;
  // THE BARS: every window the account reports, on every row a login can be
  // read for, and on a blocked one only once it is opened. An account with no
  // reading at all says so where its bars would be, unless its state line
  // already says it ("Never collected", "Last read 2h ago").
  const bars = a.lanes.length > 0 && (!blocked || open);
  const noReading = a.lanes.length === 0 && !blocked && !(a.stale && !issue);
  // THE PLAN LINE: what only it says — the plan, and that auto-switch skips a
  // held-out account — under the name, while no state line is there.
  const planLine = !state && (!!planLabel || a.disabled);
  const lanesId = `ap-${ids}lanes-${a.num}`;
  const quotaId = `ap-${ids}quota-${a.num}`;
  return (
    <li className={`ap-account${a.active ? " active" : ""}`}
      aria-current={a.active ? "true" : undefined}
      data-open={open ? "" : undefined}
      data-frozen={frozen ? "" : undefined}
      data-state={state ? "" : undefined}>
      {/* THE ROW IS THE DOOR, the way a machine's row is in Local
          network: a button laid over the whole row, under the row's
          own controls, so a press anywhere on it opens or shuts the
          detail and the keyboard's ring goes round the row.

          It carries the whole identity because it covers the clipped
          names: the title for a pointer, and — since a title reaches
          neither the keyboard nor a screen reader (WCAG 1.4.13) — the
          email in its description when the name it is called by is the
          alias. */}
        <button type="button" className="ap-row-open" id={`ap-${ids}row-${a.num}`}
          title={identity}
          aria-expanded={open}
          aria-controls={open ? `ap-${ids}detail-${a.num}` : undefined}
          aria-describedby={[
            a.alias && a.email ? `ap-${ids}email-${a.num}` : null,
            home ? `ap-${ids}home-${a.num}` : null,
            lan?.sharedTo ? `ap-${ids}shared-${a.num}` : null,
            planLine ? quotaId : null,
            bars ? lanesId : null,
            telemetry ? `ap-${ids}telemetry-${a.num}` : null,
          ].filter(Boolean).join(" ") || undefined}
          onClick={() => onToggleLanes()}>
          <span className="vis-hidden">{t(open ? "accounts.row.hideDetails" : "accounts.row.showDetails", { name })}</span>
        </button>
      <div className="ap-account-head">
        {/* The live account is marked by a tick where the other rows
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
        {/* Clipped with an ellipsis so a long one cannot widen the panel —
            the domain first, then the name before it — which means the row
            can be showing less than the whole string, so it carries its own
            whole value in a title (#517). On a shut row the door lies over it
            and says the same in its own title; the email's id is what the
            door's description points at. */}
        <span className="ap-alias" title={identity}>
          <span className="ap-alias-local">{local}</span>
          {domain && <span className="ap-alias-domain">{domain}</span>}
        </span>
        {/* The address a name stands in for: said to a screen reader, and on
            the row's title; the row draws one name. */}
        {a.alias && a.email && <span className="ap-email vis-hidden" id={`ap-${ids}email-${a.num}`}>{a.email}</span>}
        {/* THE MARKS: one grey 12px set after the name — home, telemetry,
            shared, and a provider's word for its live account — each said in
            its tooltip and to a screen reader. None of them is a colour: a
            mark is a fact about the account, not an alarm. */}
        {(home || telemetry || lan?.sharedTo || (a.active && voice.liveTag)) && (
          <span className="ap-marks">
            {/* HOME: the account Auto-switch comes back to, set from the ⋯
                rather than by another control on every row; whether
                Auto-switch is passing it over right now, and why, is its
                title. */}
            {home && (
              <AccountHint detail={home}>
                <span className="ap-home" id={`ap-${ids}home-${a.num}`} title={home} role="img" aria-label={t("accounts.row.homeLabel")}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                    strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7.5 10.5v-4a.5.5 0 0 0-.5-.5H5a.5.5 0 0 0-.5.5v4" />
                    <path d="M1.5 5a1 1 0 0 1 .35-.76l3.5-3a1 1 0 0 1 1.3 0l3.5 3a1 1 0 0 1 .35.76v4.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1Z" />
                  </svg>
                  <span className="vis-hidden">{home}</span>
                </span>
              </AccountHint>
            )}
            {/* Telemetry: grey like the other marks. What goes out, and to
                where, is its tooltip and its popover, and the open row says it
                on a line of its own. */}
            {telemetry && <AccountTelemetry num={a.num} name={name} telemetry={telemetry} boundaryId={telemetryBoundaryId} />}
            {/* SHARED, SAID ON THE ROW (#2170). Whether a login is offered to the
                paired decks was a tick in Local network's setup dialog and nowhere
                else, so somebody keeping a personal login to themselves opened
                that dialog every time to be sure. A mark rather than a word, so a
                login without one reads as not offered at a glance. Who it is
                offered to is its title — raised over the door so the pointer gets
                it — and what a screen reader hears, on the row and in the door's
                description. */}
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
            {a.active && voice.liveTag && <span className="ap-tag">{voice.liveTag}</span>}
          </span>
        )}
        {/* A state, said in a word and not in a pill. It stands where
            `Switch` would, because a switch to a held-out account is
            refused and a control that can never act is worse than
            none (#519). Putting it back is in the ⋯. */}
        {a.disabled && <span className="ap-held ap-value">{t("accounts.heldOut")}</span>}
        {/* NO FIGURE ON THIS LINE (#2644): every window is a bar under the
            name, with its figure, so a figure here said the first one twice.
            The row's two acts stand at the right end under the pointer and the
            keyboard, and are always there on touch (accounts-panel.css). */}
        <span className="ap-acts">
        {/* The one verb a row carries. Not offered where it cannot work — to
            a login that is dead or was never stored, a switch only makes the
            dead one live. */}
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
      {/* A switch that took is said by the row itself — its tick, and the
          telemetry mark beside the name for what the account sends — so the
          row adds words only for a switch still under way or one that needs
          a hand, which only a provider's voice knows (Codex's live switch). */}
      {a.active && switchedHere && voice.switched && (
        <p className="ap-switched">{voice.switched}</p>
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

      {/* THE STATE LINE: what is wrong, a weekly limit, or an old reading, on a
          line of its own under the name, in the state's ink with its own glyph.
          A problem is never folded away with the detail and never moved into
          the ⋯: it is the one line on the row somebody has to be able to find.
          The words of a problem are a button — the why and the fix are one
          press away (#856), a popover over the column, so opening it moves no
          row — and Sign in stands on the line when it is the fix. */}
      {issue && state && (
        <div className="ap-issue-line" data-tone={state.tone}>
          <button type="button" id={`ap-${ids}issue-${a.num}`} className="ap-issue" data-tone={issue.tone}
            aria-haspopup="dialog"
            aria-expanded={issueExpanded}
            aria-controls={issueExpanded ? "ap-issue-pop" : undefined}
            onClick={() => onOpenIssue(a.num, `ap-${ids}issue-${a.num}`)}>
            {state.glyph === "warning" ? <WarnGlyph /> : <KitIcon name={state.glyph} className="ap-state-glyph" />}
            <span className="ap-issue-text">{issue.text}</span>
          </button>
          {issue.fix && onSignIn && (
            <button type="button" className="ap-sign-in"
              aria-label={t("accounts.row.fixAs", { fix: issue.fix, name: a.email ?? name })} title={issue.hint}
              onClick={() => onSignIn(a.email)}>{t("accounts.row.signIn")}</button>
          )}
        </div>
      )}
      {!issue && weekFull && state && (
        <p className="ap-issue-line" data-tone={state.tone}>
          <KitIcon name="calendar" className="ap-state-glyph" />
          <span className="ap-issue-text">
            {weekReset ? t("accounts.row.weeklyLimitAt", { reset: weekReset }) : t("accounts.row.weeklyLimit")}
          </span>
        </p>
      )}
      {/* AN OLD READING: nothing collected for a quarter of an hour. The
          bars and figures go quiet and this line says how old they are, with
          whose read it was in its tooltip. */}
      {!issue && !weekFull && a.stale && state && (
        <p className="ap-issue-line" data-tone={state.tone}>
          <KitIcon name="info" className="ap-state-glyph" />
          <span className="ap-issue-text ap-q-age" data-never={age ? undefined : ""} title={ageTitle}>
            {age ? t("accounts.row.lastReadAgo", { ago: age }) : sentence(t("accounts.row.ageNever"))}
          </span>
        </p>
      )}

      {/* THE PLAN LINE: the plan, and that auto-switch skips a held-out
          account — what the bars do not say. Every window's figure and reset
          are the bars', so nothing here says them a second time. */}
      {planLine && (
        <p className="ap-quota" id={quotaId}>
          {planLabel && <span className="ap-q-plan">{planLabel}</span>}
          {a.disabled && <span className="ap-q-reset">{t("accounts.row.skipped")}</span>}
        </p>
      )}

      {/* THE BARS (#2644), one per window, under the name on every row, shut
          or open: the comparison this column is opened for, read without a
          press. An account nobody has read says so here instead, quietly,
          and never as a 0% it never measured. */}
      {bars && (
        <div className="ap-lanes" id={lanesId}>
          {a.lanes.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} readAt={a.fetchedAt} frozen={frozen} />)}
        </div>
      )}
      {noReading && (
        <p className="ap-quota">
          <span className="ap-q-reset">{voice.waiting ?? voice.noReading ?? t("accounts.row.noUsageLower")}</span>
        </p>
      )}

      {/* OPEN: when it was read and when it will be read again, and what its
          organization sends — the freshness that says whether the bars are a
          decision's worth of evidence — one key and one value to a line. */}
      {open && (
        <div className="ap-detail" id={`ap-${ids}detail-${a.num}`}>
          {a.lanes.length === 0 && !noReading && <div className="ap-hint">{voice.waiting ?? t("accounts.row.noUsage")}</div>}
          <div className="ap-meta">
            {/* The address a name stands in for, as text: the head draws one
                name, and a title is reachable by neither touch nor keyboard.
                The screen reader has it already, in the door's description. */}
            {a.alias && a.email && <span className="ap-meta-email" aria-hidden>{a.email}</span>}
            {/* ONE ATTENTION COLOUR PER ROW, ON THE CAUSE: an old reading is
                said by its own state line, quietly, and a problem takes the
                ink on its line, so the age here is plain. */}
            {a.stale && !issue && !weekFull ? null : a.fetchedAt
              ? <span className="ap-meta-line">
                  <span className="ap-meta-key">{t("accounts.row.readKey")}</span>
                  <span className="ap-age"
                    title={a.sharedFrom
                      ? t("accounts.row.readOnLong", { from: a.sharedFrom })
                      : voice.readPlan ?? t("accounts.row.lastReadLong")}
                  >{ago(a.fetchedAt, nowSec, t)}{issue?.blocksSwitch ? "" : due(a.nextAt, nowSec, t)}</span>
                </span>
              : !voice.waiting && (
                <span className="ap-meta-line">
                  <span className="ap-meta-key">{t("accounts.row.readKey")}</span>
                  <span className="ap-age" title={voice.neverRead ?? t("accounts.row.notReadYet")}>{t("accounts.row.ageNever")}</span>
                </span>
              )}
            {telemetry && (
              <span className="ap-meta-line">
                <span className="ap-meta-key">{t("accounts.row.telemetryKey")}</span>
                <span className="ap-meta-value" title={telemetry.detail}>{telemetry.words}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
