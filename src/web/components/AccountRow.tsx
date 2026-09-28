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
import { accountIssue } from "../account-issue";
import { ago, due } from "../account-freshness";
import { type Failure } from "../accounts-reload";
import { type SwapNote } from "../account-move";
import { type Account, type Lane } from "../claude-accounts";
import { laneSplit } from "../lane-view";
import { resetCountdown } from "../relative-time";
import { type useRequestSlot } from "../use-request-slot";

type RequestSlot = ReturnType<typeof useRequestSlot>;

/** How full a window is, in the inks its bar uses: the warning past 70% and
 *  the error past 90%. Undefined below that — the shut row's numbers are
 *  neutral until they are a reason not to switch. */
function fullness(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
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

interface Props {
  a: Account;
  nowSec: number;
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
  /** A switch from the panel just landed on this account. */
  switchedHere: boolean;
  /** The swap a move into a taken slot made, when it landed on this row. */
  swapped: SwapNote | null;
  /** The account that swap sent to the other slot, for its name. */
  displaced: Account | undefined;
  /** This row's warning has its explanation open. */
  issueExpanded: boolean;
  onOpenIssue: (num: number, anchor: string) => void;
}

export default function AccountRow({
  a, nowSec, opened, onToggleLanes, busy, pressProps, onSwitch, menuOpen, onOpenMenu, onCloseMenu,
  refusal, onDismissRefusal, switchedHere, swapped, displaced, issueExpanded, onOpenIssue,
}: Props) {
  const { shown, fuller } = laneSplit(a.lanes);
  const issue = accountIssue(a, nowSec);
  // THE ACTIVE ROW IS OPEN, AND EVERY OTHER ROW IS SHUT UNTIL ASKED.
  // The live account is the one whose windows are being spent, so
  // its bars, resets and freshness are the reading this column is
  // opened for. Any other account only has to answer one question —
  // is it worth switching to — and two numbers answer it. The rest
  // is one press on the row away, and held by account (#542).
  const open = a.active || opened;
  const name = a.alias ?? a.email ?? `account ${a.num}`;
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
  const age = a.fetchedAt ? ago(a.fetchedAt, nowSec) : null;
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
      {!a.active && (
        <button type="button" className="ap-row-open" id={`ap-row-${a.num}`}
          title={identity}
          aria-expanded={open}
          aria-controls={open ? `ap-detail-${a.num}` : undefined}
          aria-describedby={[
            a.alias && a.email ? `ap-email-${a.num}` : null,
            !open && !issue?.blocksSwitch ? `ap-quota-${a.num}` : null,
          ].filter(Boolean).join(" ") || undefined}
          onClick={() => onToggleLanes()}>
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
            whole value in a title (#517). On a shut row the door lies
            over them and says the same in its own title; the email's
            id is what the door's description points at. */}
        {a.alias && <span className="ap-alias" title={a.alias}>{a.alias}</span>}
        <span className="ap-email" id={`ap-email-${a.num}`} title={a.email ?? undefined}>{a.email}</span>
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
            onClick={() => onSwitch(a.num, name)}
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
          aria-haspopup="menu" aria-expanded={menuOpen}
          aria-controls={menuOpen ? `ap-menu-${a.num}` : undefined}
          title="More actions"
          onClick={() => (menuOpen ? onCloseMenu() : onOpenMenu(a.num))}
          onKeyDown={e => {
            // Down opens at the first item and Up at the last, the way
            // a native menu button does. Enter and Space are the click.
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            onOpenMenu(a.num, e.key === "ArrowUp" ? "last" : "first");
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
      {refusal && (
        <div className="ap-failure ap-row-failure" role="alert">
          <span className="ap-failure-text" title={refusal.raw || undefined}>{refusal.text}</span>
          <button type="button" className="ap-failure-x" onClick={() => onDismissRefusal()}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}
      {a.active && switchedHere && (
        <p className="ap-switched">
          Now active. New sessions start on it; ones already running pick it up on
          their next message, up to about 30 seconds later on macOS.
        </p>
      )}
      {/* A move into a taken slot relocated a second account, and this
          is the only place that says so, for eight seconds. The
          sentence naming who went where is its title. */}
      {swapped && (() => {
        const who = displaced?.alias ?? displaced?.email ?? "the account that was there";
        return (
          <p className="ap-note ap-swap-note"
            title={`Slot ${swapped.at} was taken, so the two accounts traded places: `
                 + `${who} now holds slot ${swapped.displaced}.`}>
            swapped with slot {swapped.displaced}
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
            aria-expanded={issueExpanded}
            aria-controls={issueExpanded ? "ap-issue-pop" : undefined}
            onClick={() => onOpenIssue(a.num, `ap-issue-${a.num}`)}>
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
}
