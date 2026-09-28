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
import AccountProjectsModal from "./AccountProjectsModal";
import AccountIssuePopover, { WarnGlyph } from "./AccountIssuePopover";
import AccountRow from "./AccountRow";
import AccountsEmptyState from "./AccountsEmptyState";
import AutoSwitchPolicy from "./AutoSwitchPolicy";
import AddAccountDialog from "./AddAccountDialog";
import AccountMenuPopover from "./AccountMenuPopover";
import OtherAccounts from "./OtherAccounts";
import ShareAccountsDialog from "./ShareAccountsDialog";
import { type Peer } from "../other-accounts";
import { commandOutput, explainCommandFailure } from "../admin-failure";
import { type PickerCommit, thresholdCommit } from "../picker-commit";
import { knownLanes, laneKey, toggleLane } from "../lane-open";
import { focusDropped, rescueSelectors } from "../panel-press";
import { PRODUCT } from "../brand";
import { copyText } from "../copy-text";
import { activeSwitchNote } from "../active-switch-note";
import { accountIssue } from "../account-issue";
import {
  type Failure,
  RELOAD_SLOW,
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "../accounts-reload";
import LanSyncSection from "./LanSyncSection";
import { useRequestSlot } from "../use-request-slot";
import { useAccountMenu } from "../use-account-menu";
import { type Account, type AccountsData, type AutoStatus } from "../claude-accounts";

const POLL_MS = 15_000;
// How long the threshold's `save` stands as `saved`. The panel's other
// transient confirmation — `copied` on a share — uses the same 1.8s, and the
// word is the whole signal.
const SAVED_MS = 1_800;
// Past this, a reload is called dead rather than slow. Both routes can spawn
// cswap, and the server kills those at 20 seconds, so anything shorter would
// abort answers that were still coming.
const RELOAD_TIMEOUT_MS = 30_000;

interface Props {
  onClose: () => void;
  /** Asked to close, still on screen for the length of its exit. The panel
   *  keeps working while it leaves — nothing here reads this but the class. */
  leaving?: boolean;
}

export default function AccountsPanel({ onClose, leaving }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  // The one request the panel has out, and the attributes it puts on every
  // control that request makes inert — see use-request-slot.ts (#518).
  const { busy, claim, release, pressProps } = useRequestSlot();
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
  const [addOpen, setAddOpen] = useState(false);
  // The panel-level share, which is a different job from the one on a row:
  // moving your own set between your own machines rather than sending one
  // account to somebody else. Its own dialog, so the row keeps its one-click
  // path and neither has to explain the other.
  const [shareSetOpen, setShareSetOpen] = useState(false);
  // The account whose "Projects" report is open, by slot number, or null. A
  // full modal rather than an inline popover: the report carries a chart, a
  // list and per-window totals that a menu-sized panel would crush.
  const [projectsFor, setProjectsFor] = useState<number | null>(null);
  // The same split for the auto-switch threshold as the slot picker's in
  // use-account-menu.ts — the picker proposes, the button under it commits —
  // because it had the same defect with a setting write on the other end
  // (#516). Null follows whatever the store holds.
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

  // The ⋯ popover, what it is holding and the requests pressed in it — see
  // use-account-menu.ts. The panel reads which menu is open and the note a swap
  // leaves on a row; the popover gets the whole of it.
  const clearFailure = useCallback(() => setFailure(null), []);
  const accountMenu = useAccountMenu({ claim, release, load, clearFailure, rescueFocus });
  const { menu, menuFor, swapNote, showMenu, dropMenu, closeMenu, sayInMenu } = accountMenu;

  /** Every auto-switch control is one POST; they all reload afterwards. The
   *  refusal is said where the press was: at the foot of the column for the
   *  policy row, and inside the ⋯ menu for an account held out or put back. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string, where: "panel" | "menu" = "panel") => {
    if (!claim(tag)) return null;
    const say = where === "menu" ? sayInMenu : setFailure;
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
      // The status matters, not only the body: the deck's own gate refuses a
      // mutation before any command runs, and says so with no `reason` for the
      // map to find. See GATE_REASONS.
      if (!out?.ok) say({ text: explainCommandFailure(out, "command failed", res.status), raw: commandOutput(out) });
      return out;
    } catch {
      say({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release, sayInMenu]);

  useEffect(() => {
    load(true);
    timerRef.current = window.setInterval(() => load(false), POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [load]);

  // A switch from the panel can be superseded by auto-switch or by a command
  // outside the panel. Clear its confirmation when a fresh roster says that
  // account is no longer active, so it cannot reappear if it becomes active
  // again later. This runs on roster changes rather than on `switched` changes:
  // the previous roster may still describe the account before our POST lands.
  useEffect(() => {
    if (!data?.ok || !data.accounts) return;
    setSwitched(previous => activeSwitchNote(previous, data.accounts));
  }, [data]);

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
  // WHETHER ANYTHING IS GOING TO SWITCH WITHOUT A PRESS. The deck's own loop
  // and a `cswap auto` in a terminal are one fact to the fold's row: in both,
  // the reader is not the one picking, and in both a roster with nothing
  // reachable is a policy that will reach the threshold and do nothing. The
  // toggle can read `off` while the terminal loop runs — that is what
  // `external` is for — so the two are an OR and never the toggle alone.
  const autoArmed = auto?.ok === true && (auto.enabled || auto.external);
  /** The box a row scrolls inside, which is what a popover hanging off it
   *  closes against. Once the fold is open its list has a scroll of its own —
   *  it is the one thing in the column that gives, so Auto-switch under it
   *  cannot be pushed off — and a menu measured against the column instead
   *  would stay open over a row that had already scrolled out of view. */
  const rowBoundary = (num: number) =>
    restOpen && rest.some(a => a.num === num) ? "ap-rest-list" : "ap-scroll";

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

  /** Open an account's ⋯ on its menu, closing any other one first — and a
   *  warning's explanation, which never stands beside one. */
  const openMenu = (num: number, start: "first" | "last" = "first") => {
    showMenu(num, start);
    setIssueOpen(null);
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

  // A popover left standing as the panel slides out would float over the
  // canvas where the panel used to be; one whose account has left the store
  // has nothing to hang from.
  useEffect(() => { if (leaving) { dropMenu(); setIssueOpen(null); } }, [leaving, dropMenu]);
  useEffect(() => {
    if (menu && data?.accounts && !data.accounts.some(a => a.num === menu.num)) dropMenu();
    if (issueOpen && data?.accounts && !data.accounts.some(a => a.num === issueOpen.num)) setIssueOpen(null);
  }, [data, menu, issueOpen, dropMenu]);
  // The account whose Projects report is open may have vanished — removed
  // while the menu was open, or missing from a poll that found the store
  // unreadable — so the report closes rather than open empty. Closed and not
  // merely undrawn: a report that only hid while the account was missing would
  // come back by itself on the next poll that found it, over whatever the
  // reader had moved on to.
  useEffect(() => {
    if (projectsFor != null && !(data?.accounts ?? []).some(a => a.num === projectsFor)) setProjectsFor(null);
  }, [data, projectsFor]);

  /** The slot picker's rule (doSlot, in use-account-menu.ts) for the
   *  threshold: the picker proposes, `save` stores it. */
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
   * accounts go where is decided just above, at `head` and `rest`. What the row
   * draws is AccountRow's; this is the one place its props are spelled, so the
   * two lists cannot be handed different ones.
   */
  const accountRow = (a: Account) => (
    <AccountRow key={a.num} a={a} nowSec={nowSec}
      openLanes={openLanes} onToggleLanes={() => setOpenLanes(o => toggleLane(o, a))}
      busy={busy} pressProps={pressProps} doSwitch={doSwitch}
      menuFor={menuFor} openMenu={openMenu} closeMenu={closeMenu}
      failure={failure} onDismissFailure={() => setFailure(null)}
      switched={switched} swapNote={swapNote} roster={roster}
      issueOpen={issueOpen} openIssue={openIssue} />
  );

  /**
   * THE POLICY, AS ONE VALUE, because the column now draws it from two places.
   *
   * It lives INSIDE the fold — after the accounts it switches between, revealed
   * by the same press that reveals them — and the fold is not always there. A
   * store with one account has nothing to fold, and a policy nobody could reach
   * would be a setting the product had hidden rather than folded, so in that
   * case it stands on its own under the roster.
   *
   * WHAT PAYS FOR THE MOVE is the tail of the fold row's line: `auto 90%` or
   * `auto off`, said whether the fold is open or shut. A control behind a
   * disclosure is a control whose state has to be readable without opening it,
   * or the disclosure has hidden a fact rather than a form. See restLine.
   *
   * What the row says is AutoSwitchPolicy's; the draft it proposes is held
   * here, so folding the list away does not drop a pick nobody saved.
   */
  const policyBlock = data?.ok && auto?.ok ? (
    <AutoSwitchPolicy auto={auto} threshold={threshold} thresholdPick={thresholdPick}
      thresholdCtl={thresholdCtl} thresholdSaved={thresholdSaved}
      thresholdRef={thresholdRef} thresholdSaveRef={thresholdSaveRef}
      setThresholdDraft={setThresholdDraft} doThreshold={doThreshold}
      pressProps={pressProps} post={post} load={load} />
  ) : null;
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

      {/* THE ACCOUNTS SCROLL, AND ONE ROW BELOW IT. The column used to be one
          scroll of three sections, so with enough accounts Auto-switch and Local
          network went under the fold with no sign they were there, and both were
          pulled out to stand at the foot at every length.
          AUTO-SWITCH HAS SINCE GONE BACK IN, because the premise of that finding
          was a roster that was long for everybody. This column draws the live
          account and one row; it does not scroll until a reader opens the fold
          themselves. Local network did not go back: it is about other machines,
          so it has no accounts to stand under and stays the foot of the panel
          at every length. */}
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
            <AccountsEmptyState data={data} />
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
                  armed={autoArmed}
                  threshold={auto?.ok ? threshold : null}
                  open={restOpen}
                  onToggle={() => setRestOpen(o => !o)}
                />
              )}
              {/* WHAT THE ROW OPENS, in one box, because that is what it claims
                  to control. The accounts and the policy over them are revealed
                  together and named together by `aria-controls`; the list inside
                  keeps its own id, because the list is the thing that scrolls
                  and a row's menu closes against it. */}
              {rest.length > 0 && restOpen && (
                <div className="ap-rest-panel" id="ap-rest-panel">
                  <ul className="ap-list ap-others" id="ap-rest-list">
                  {rest.map(accountRow)}
                  </ul>
                  {policyBlock}
                </div>
              )}
              {/* Nothing to fold, so nothing to hide it behind: the policy
                  stands under the roster it is about. */}
              {rest.length === 0 && policyBlock}

              {/* Announced, and dismissible, because nothing else here clears it: the
                  next action does, and until then a stale refusal sits under a roster
                  that has since moved on. IT DID NOT FOLLOW THE POLICY BEHIND THE FOLD:
                  a refusal that could be put out of sight by collapsing a row is a
                  refusal the reader can lose, and the press that earned it was made
                  with the fold open, so this is still directly under where the control
                  was standing. Everything but a refused switch, which is said on the
                  row that was pressed (#827). */}
              {failure && failure.row == null && (
                <div className="ap-failure" role="alert">
                  <span className="ap-failure-text" title={failure.raw || undefined}>{failure.text}</span>
                  <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                    aria-label="Dismiss this message" title="Dismiss">×</button>
                </div>
              )}

              {menu && (() => {
                const a = data.accounts?.find(x => x.num === menu.num);
                if (!a) return null;
                return (
                  <AccountMenuPopover a={a} accountMenu={accountMenu}
                    slots={(data.accounts ?? []).map(x => x.num)}
                    boundaryId={rowBoundary(a.num)} nowSec={nowSec}
                    busy={busy} pressProps={pressProps}
                    rotating={!!(auto?.enabled || auto?.external)}
                    onProjects={() => { setProjectsFor(a.num); closeMenu(a.num); }}
                    onRotation={() => post({ action: "account", account: a.num, enabled: a.disabled }, `rot-${a.num}`, "menu")
                      .then(out => { load(true); if (out?.ok) closeMenu(a.num); })} />
                );
              })()}
              {issueOpen && (() => {
                const a = data.accounts?.find(x => x.num === issueOpen.num);
                const issue = a ? accountIssue(a, nowSec) : null;
                if (!a || !issue) return null;
                return (
                  <AccountIssuePopover
                    anchorId={issueOpen.anchor}
                    // The notice over the list does not live in the fold, so it
                    // closes against the column however the roster is drawn.
                    boundaryId={issueOpen.anchor === "ap-notice" ? "ap-scroll" : rowBoundary(a.num)}
                    issue={issue}
                    who={a.alias ?? a.email ?? `account ${a.num}`}
                    fetchedAt={a.fetchedAt}
                    nowSec={nowSec}
                    onClose={closeIssue}
                    onSignIn={() => setAddOpen(true)}
                  />
                );
              })()}
            </>
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
            // A valid stored copy can still be unavailable for LAN export
            // (locked Keychain, deferred refresh, or an unknown CLI verdict).
            // The active slot needs a verdict, as on the server: its export is
            // the live login — see cachedExportReadable.
            shareable: a.collector === "ok" || (a.collector == null && !a.active),
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
      {projectsFor != null && (() => {
        const a = (data?.accounts ?? []).find(x => x.num === projectsFor);
        // Gone from the roster: nothing to draw, and the effect that watches
        // the roster closes the report.
        if (!a) return null;
        return (
          <AccountProjectsModal
            num={a.num}
            name={a.alias ?? a.email ?? `account ${a.num}`}
            onClose={() => setProjectsFor(null)}
          />
        );
      })()}
    </aside>
  );
}
