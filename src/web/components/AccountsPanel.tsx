// AccountsPanel — every managed Claude account, its usage, and one click to
// switch between them. Toggled via the topbar button or the A shortcut.
//
// The data comes from claude-swap's local store, which the server reads rather
// than fetching: Anthropic's usage endpoint has a per-account request budget
// shared across every tool on the machine, so a dashboard that polled it
// directly would rate-limit the user's actual account. That has a visible
// consequence here — numbers can be minutes old, and saying so is part of the
// display rather than a caveat to hide.
import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import AccountProjectsModal from "./AccountProjectsModal";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import AccountIssuePopover, { WarnGlyph } from "./AccountIssuePopover";
import type { FeedbackPrefill } from "../feedback";
import AccountRow from "./AccountRow";
import CodexProfilesSection from "./CodexProfilesSection";
import AccountsEmptyState from "./AccountsEmptyState";
import AccountsHeader from "./AccountsHeader";
import AccountsUsageReport from "./AccountsUsageReport";
import AutoSwitchPolicy from "./AutoSwitchPolicy";
import FilmLink from "./FilmLink";
import AddAccountDialog from "./AddAccountDialog";
import AccountMenuPopover from "./AccountMenuPopover";
import OtherAccounts from "./OtherAccounts";
import ShareAccountsDialog from "./ShareAccountsDialog";
import { isAutoArmed, pastThreshold, peersOf, reachable } from "../account-fold";
import { lanAccounts } from "../account-lan";
import { laneKey } from "../lane-open";
import {
  allOpen, holdOrder, isOpen, orderChoices, orderKey, sortAccounts, toggleAll, toggleOne, trimOpenness, validOrder,
  type Openness,
} from "../other-accounts-order";
import { loadOpenness, loadOrder, saveOpenness, saveOrder } from "../accounts-prefs";
import { focusDropped, rescueSelectors } from "../panel-press";
import { copyText } from "../copy-text";
import { accountIssue } from "../account-issue";
import LanSyncSection from "./LanSyncSection";
import { useRequestSlot } from "../use-request-slot";
import { useAccountMenu } from "../use-account-menu";
import { useAccountSwitching } from "../use-account-switching";
import { useThresholdDraft } from "../use-threshold-draft";
import { POLL_MS, useAccountRoster } from "../use-account-roster";
import { useRosterFocus } from "../use-roster-focus";
import { usePanelClock } from "../use-panel-clock";
import { type Account, type AccountsData } from "../claude-accounts";
import { useFeatureUse } from "../feature-use";

interface Props {
  onClose: () => void;
  /** Asked to close, still on screen for the length of its exit. The panel
   *  keeps working while it leaves — nothing here reads this but the class. */
  leaving?: boolean;
  /** Open the feedback dialog seeded for a caller (#1853). The issue popover
   *  uses it for its "Report this"; absent, the popover draws no such button. */
  onReport?: (prefill: FeedbackPrefill) => void;
  /** Every roster this panel's poll reads, handed up as it arrives — the
   *  re-sign-in prompt over the canvas watches the same reads rather than
   *  polling the store for itself (#1893). */
  onRoster?: (fresh: AccountsData) => void;
}

export default function AccountsPanel({ onClose, leaving, onReport, onRoster }: Props) {
  // Opened: one of the features the usage reports name (feature-use.ts).
  useFeatureUse("accounts-panel");
  const singleKeys = useSingleKeyShortcuts();
  // The one request the panel has out, and the attributes it puts on every
  // control that request makes inert — see use-request-slot.ts (#518).
  const { busy, claim, release, pressProps } = useRequestSlot();
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
  const [addOpen, setAddOpen] = useState(false);
  // The Usage report (#1707): every account's 5h and 7d added up, and the
  // order the panel listed them in when it was opened — its rows keep that
  // order through the polls, as the panel's own list does under a reader.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportOrder, setReportOrder] = useState<string[]>([]);
  // The panel-level share, which is a different job from the one on a row:
  // moving your own set between your own machines rather than sending one
  // account to somebody else. Its own dialog, so the row keeps its one-click
  // path and neither has to explain the other.
  const [shareSetOpen, setShareSetOpen] = useState(false);
  // The account whose "Projects" report is open, by slot number, or null. A
  // full modal rather than an inline popover: the report carries a chart, a
  // list and per-window totals that a menu-sized panel would crush. The name
  // it was opened under rides along, because a poll that could not read the
  // store answers with no roster at all and the report goes on being drawn
  // through it (#1412).
  const [projectsFor, setProjectsFor] = useState<{ num: number; name: string } | null>(null);
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
  //
  // KEPT BETWEEN RELOADS, AND AS A MODE (#1579). Comparing nine accounts meant
  // opening nine rows, and every one of them shut again when the panel closed.
  // "Expand all" is a mode rather than a list of whoever was there when it was
  // pressed, so it holds for an account signed in later, and each row's own
  // press still works after it — see other-accounts-order.ts. What is stored,
  // and where, is accounts-prefs.ts's.
  const [openness, setOpenness] = useState<Openness>(loadOpenness);
  // The order the accounts behind the fold are listed in (#1579): slot, how
  // full they are by one window, or how much room they have. Kept the same way.
  const [order, setOrder] = useState<string>(loadOrder);
  // The list's order at the moment the pointer or the keyboard came into it,
  // or null while nobody is there: a poll that moves the numbers does not move
  // the rows under a reader's hand. See holdOrder.
  const [held, setHeld] = useState<string[] | null>(null);
  /** Whether the accounts behind the fold are drawn. Shut on open, every time:
   *  the column's first screen is the live account, and a fold that remembered
   *  being open would give a reader who unfolded it once a panel that never
   *  folds again. It is kept across a switch on purpose — the account just left
   *  is in that list, and it moved there under the reader's own press. */
  const [restOpen, setRestOpen] = useState(false);

  // What the store holds and the auto-switch status beside it, whether a
  // reload the reader asked for is out, and the one line that says what went
  // wrong — read, polled and written in use-account-roster.ts.
  //
  // An account that was removed while its lanes were open would otherwise
  // keep its place in the set until the panel is unmounted, ready to reopen
  // itself on whoever signs that address back in. The roster is the only thing
  // that knows an account has gone, so the roster is where the set is trimmed.
  // Unchanged in and unchanged out when nobody left, which is every poll but
  // one.
  //
  // And handed up, through a ref: useAccountRoster builds its poll once around
  // this callback, so it has to stay the same function whatever App passes.
  const onRosterRef = useRef(onRoster);
  onRosterRef.current = onRoster;
  const trimLanes = useCallback((fresh: AccountsData) => {
    setOpenness(open => trimOpenness(open, fresh.accounts));
    onRosterRef.current?.(fresh);
  }, []);
  const { data, auto, reloading, failure, load, sayFailure, clearFailure } = useAccountRoster(trimLanes);
  // Focus through a roster the panel did not ask for: a switch made outside it
  // redraws the focused row in the other list — see use-roster-focus.ts.
  const rosterFocus = useRosterFocus(data);

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

  // The ⋯ popover, what it is holding and the requests pressed in it — see
  // use-account-menu.ts. The panel reads which menu is open and the note a swap
  // leaves on a row; the popover gets the whole of it.
  const accountMenu = useAccountMenu({ claim, release, load, clearFailure, rescueFocus });
  const { menu, menuFor, swapNote, showMenu, dropMenu, closeMenu, sayInMenu } = accountMenu;

  // Switching to an account, every auto-switch control's POST, and the
  // confirmation a switch that took leaves on its row — see
  // use-account-switching.ts.
  const { switched, post, doSwitch } = useAccountSwitching({
    data, claim, release, load, sayFailure, clearFailure, sayInMenu, rescueFocus,
  });

  // Where auto-switch trips, what the picker proposes instead, and the press
  // that stores it — see use-threshold-draft.ts.
  const {
    threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef,
    thresholdCustom, thresholdRefusal, thresholdFieldRef,
    proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold,
  } = useThresholdDraft({ auto, post, load });


  // Countdowns tick independently of the fetch so they stay honest between polls.
  // Asked for here, after the hooks above rather than beside the panel's other
  // state, because its interval is an effect: registered after the roster's
  // poll, as it always was, a tick and a poll due at the same moment still run
  // in that order. See use-panel-clock.ts.
  const nowSec = usePanelClock();

  // What the fold remembers is written back as it changes (#1579) — after the
  // clock, like every effect in this panel, so the roster's poll and the tick
  // keep the order they have always started in.
  useEffect(() => { saveOpenness(openness); }, [openness]);
  useEffect(() => { saveOrder(order); }, [order]);

  // WHAT LOCAL NETWORK KNOWS about each account's copies elsewhere, from the
  // status its own section already polls: a dead login no paired deck can
  // repair says so on its row, rather than waiting in silence for a copy
  // that will not come. See noCopyWorksNearby.
  const [noCopy, setNoCopy] = useState<ReadonlySet<string>>(() => new Set());
  const takeNoCopy = useCallback((keys: readonly string[]) => setNoCopy(new Set(keys)), []);
  const lanFor = (a: Account) => ({ noCopyWorksNearby: noCopy.has(lanAccounts([a])[0].key) });
  const activeAcct = data?.accounts?.find(a => a.active);
  const activeIssue = activeAcct ? accountIssue(activeAcct, nowSec, lanFor(activeAcct)) : null;

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
  const others = activeAcct ? roster.filter(a => !a.active) : [];
  // In the reader's order (#1579), and held where it was while they are in the
  // list. An order stored for a model no account has any more is slot order.
  const choices = orderChoices(others);
  const shownOrder = validOrder(order, others);
  const rest = holdOrder(sortAccounts(others, shownOrder, a => reachable(a, nowSec), nowSec), held);
  /**
   * HELD WHILE A READER IS IN IT (#1579). A sorted list whose rows jumped on a
   * poll would move the Switch the reader was reaching for, so the order is
   * taken when they come in and let go when nothing holds it any more, and the
   * fresh one lands then. Three things hold it, kept in a ref because they are
   * facts about the pointer and the page rather than things to draw:
   *
   *   - the pointer, over the list;
   *   - the KEYBOARD's focus in it, and not every focus: a row's door keeps
   *     focus after a mouse press, and a hold kept by that outlasted the
   *     pointer until something else was clicked;
   *   - a row's ⋯ menu or warning, open. Both are portalled outside the list
   *     and anchored to their row, so moving into one left the list — and a
   *     poll then moved the row, and the menu with it, while Remove was being
   *     armed.
   */
  const pointerIn = useRef(false);
  const keysIn = useRef(false);
  const popoverIn = useRef(false);
  const letGo = useCallback(() => {
    if (!pointerIn.current && !keysIn.current && !popoverIn.current) setHeld(null);
  }, []);
  const take = () => setHeld(h => h ?? rest.map(laneKey));
  const listHold = {
    onPointerEnter: () => { pointerIn.current = true; take(); },
    onPointerLeave: () => { pointerIn.current = false; letGo(); },
    onFocus: (e: FocusEvent<HTMLUListElement>) => {
      if ((e.target as Element).matches(":focus-visible")) { keysIn.current = true; take(); }
    },
    onBlur: (e: FocusEvent<HTMLUListElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { keysIn.current = false; letGo(); }
    },
  };
  const popoverHolds = (menuFor != null && others.some(a => a.num === menuFor))
    || (issueOpen != null && others.some(a => a.num === issueOpen.num));
  useEffect(() => {
    popoverIn.current = popoverHolds;
    if (!popoverHolds) letGo();
  }, [popoverHolds, letGo]);
  // Nothing holds a list that is not on screen. One that unmounts under the
  // pointer gets no pointerleave — the fold shut, or a roster between two
  // switches with nobody live — and would come back frozen on the old order.
  const listShown = restOpen && others.length > 0;
  useEffect(() => {
    if (listShown) return;
    pointerIn.current = keysIn.current = popoverIn.current = false;
    setHeld(null);
  }, [listShown]);
  // And the list's own controls leave with the last of the others. Focus on
  // one of them would drop to the page; the panel's rescue puts it back.
  const hadOthers = useRef(false);
  useEffect(() => {
    if (hadOthers.current && others.length === 0) rescueFocus(null);
    hadOthers.current = others.length > 0;
  }, [others.length, rescueFocus]);
  const head = rest.length ? roster.filter(a => a.active) : roster;
  // What the fold's row says about them — how many can be reached, whether
  // the live account is past the threshold, whether anything will switch
  // without a press — is read in account-fold.ts.
  const peers = peersOf(rest, nowSec, lanFor);
  const strained = pastThreshold(activeAcct, threshold, nowSec);
  const autoArmed = isAutoArmed(auto);
  /** The box a row scrolls inside, which is what a popover hanging off it
   *  closes against. Once the fold is open its list has a scroll of its own —
   *  it is the one thing in the column that gives, so Auto-switch under it
   *  cannot be pushed off — and a menu measured against the column instead
   *  would stay open over a row that had already scrolled out of view. */
  const rowBoundary = (num: number) =>
    restOpen && rest.some(a => a.num === num) ? "ap-rest-list" : "ap-scroll";

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
  // The account whose Projects report is open may have left the store —
  // removed while the menu was open, or from a terminal — and then the report
  // closes rather than stand over an account that is gone, handing focus to the
  // panel's reload, because the row it would go back to went with the account.
  //
  // Only a roster that was READ can say so. A poll that could not read the
  // store answers with no roster at all — what /api/claude-accounts says for
  // the moment claude-swap is rewriting it, during a switch for one — and the
  // report stays up through that, the rule the ⋯ menu, Local network and the
  // share dialog already keep (#1412). The cost is theirs too: removing the
  // last account also answers with no roster, so that report stays until it is
  // closed.
  //
  // Closed and not merely undrawn: a report that only hid while the account was
  // missing would come back by itself on the next poll that found it, over
  // whatever the reader had moved on to.
  useEffect(() => {
    if (projectsFor == null || !data?.accounts || data.accounts.some(a => a.num === projectsFor.num)) return;
    setProjectsFor(null);
    rescueFocus(null);
  }, [data, projectsFor, rescueFocus]);

  // The one close, drawn in whichever header is up: the accounts' own, or Local
  // network's while that view has the column.
  const closeBtn = (
    <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close accounts panel" title={withKey("Close", "A", singleKeys)}>
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
  const accountRow = (a: Account) => {
  // What the panel's state says about THIS row, each read once: whether the
  // reader has opened it, whether its ⋯ is the one open, the refusal a switch
  // on it left, whether a switch from the panel just landed on it, the note a
  // swap left on it and who that swap displaced, and whether its warning's
  // explanation is open.
  const opened = isOpen(openness, a);
  const menuOpen = menuFor === a.num;
  const refusal = failure?.row === a.num ? failure : null;
  const switchedHere = switched?.num === a.num;
  const swapped = swapNote?.at === a.num ? swapNote : null;
  const displaced = swapped ? roster.find(x => x.num === swapped.displaced) : undefined;
  const issueExpanded = issueOpen?.anchor === `ap-issue-${a.num}`;
    return (
      <AccountRow key={a.num} a={a} nowSec={nowSec} lan={lanFor(a)}
        opened={opened} onToggleLanes={() => setOpenness(o => toggleOne(o, a))}
        busy={busy} pressProps={pressProps} onSwitch={doSwitch}
        menuOpen={menuOpen} onOpenMenu={openMenu} onCloseMenu={closeMenu}
        refusal={refusal} onDismissRefusal={() => clearFailure()}
        switchedHere={switchedHere} swapped={swapped} displaced={displaced}
        issueExpanded={issueExpanded} onOpenIssue={openIssue}
        sortKey={a.active ? null : orderKey(shownOrder)} />
    );
  };

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
   * by the panel (use-threshold-draft.ts), so folding the list away does not
   * drop a pick nobody saved.
   */
  const policyBlock = data?.ok && auto?.ok ? (
    <AutoSwitchPolicy auto={auto} threshold={threshold} thresholdPick={thresholdPick}
      thresholdCtl={thresholdCtl} thresholdSaved={thresholdSaved}
      thresholdRef={thresholdRef} thresholdSaveRef={thresholdSaveRef}
      thresholdCustom={thresholdCustom} thresholdRefusal={thresholdRefusal} thresholdFieldRef={thresholdFieldRef}
      proposeThreshold={proposeThreshold} typeThreshold={typeThreshold}
      cancelThreshold={cancelThreshold} leaveThreshold={leaveThreshold} doThreshold={doThreshold}
      pressProps={pressProps} post={post} load={load} />
  ) : null;
  return (
    // Named for the topbar toggle's aria-controls — see UsagePanel, which also
    // carries the reason this is an <aside> and not the <div> it was: the
    // aria-label on a roleless <div> resolved to `generic` and the tree threw
    // the name away (#381). This panel is the left sidebar beside the canvas,
    // which is complementary content by any reading.
    <aside className={`accounts-panel${leaving ? " leaving" : ""}`} id="accounts-panel" aria-label="Agent accounts"
      onFocus={rosterFocus.onFocus} onBlur={rosterFocus.onBlur}>
      {view === "accounts" && (
        <AccountsHeader canShare={(data?.accounts?.length ?? 0) > 0}
          // Two or more: one account's report is the row above it again. And
          // kept while the report is open, so a poll that empties the roster
          // does not take away the control focus goes back to.
          canReport={(data?.accounts?.length ?? 0) > 1 || reportOpen}
          onAdd={() => setAddOpen(true)}
          onReport={() => { setReportOrder([...head, ...rest].map(laneKey)); setReportOpen(true); }}
          onShareSet={() => setShareSetOpen(true)} onReload={() => load(true)}
          pressProps={pressProps} reloading={reloading} closeButton={closeBtn} />
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
                {/* This was `disabled={reloading}`, #518's one pinned exclusion:
                    the only control in this branch, so no busy lock had anything
                    to protect it from. It still dropped focus to <body> the
                    moment it was pressed, as a control that disables itself
                    always does, and a roster that then arrived took the button
                    away with nowhere for focus to go (#1411). It takes the ↻'s
                    two attributes now and says `trying…` while it works; a
                    press that brings the roster in hands focus to that ↻, the
                    same act one row up — only if focus was dropped, the rule
                    every rescue in this panel keeps. */}
                <button type="button" className="ap-fix" {...pressProps("reload", reloading)}
                  onClick={() => load(true).then(() => rescueFocus(null))}>
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
                  order={shownOrder}
                  choices={choices}
                  onOrder={setOrder}
                  allOpen={allOpen(openness, rest)}
                  onToggleAll={() => setOpenness(o => toggleAll(o, rest))}
                  held={held != null}
                />
              )}
              {/* WHAT THE ROW OPENS, in one box, because that is what it claims
                  to control. The accounts and the policy over them are revealed
                  together and named together by `aria-controls`; the list inside
                  keeps its own id, because the list is the thing that scrolls
                  and a row's menu closes against it. */}
              {rest.length > 0 && restOpen && (
                <div className="ap-rest-panel" id="ap-rest-panel">
                  <ul className="ap-list ap-others" id="ap-rest-list" {...listHold}>
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
                  <button type="button" className="ap-failure-x" onClick={() => clearFailure()}
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
                    onProjects={() => { setProjectsFor({ num: a.num, name: a.alias ?? a.email ?? `account ${a.num}` }); closeMenu(a.num); }}
                    onRotation={() => post({ action: "account", account: a.num, enabled: a.disabled }, `rot-${a.num}`, "menu")
                      .then(out => { load(true); if (out?.ok) closeMenu(a.num); })} />
                );
              })()}
              {issueOpen && (() => {
                const a = data.accounts?.find(x => x.num === issueOpen.num);
                const issue = a ? accountIssue(a, nowSec, lanFor(a)) : null;
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
                    // The report carries the issue's own words and nothing that
                    // names the account: what is wrong, in the product's voice,
                    // never who it is wrong for (#1853). A warning is a bug to
                    // report; a quiet, self-clearing state is "something else".
                    onReport={onReport && (() => onReport({
                      initialKind: issue.tone === "warn" ? "bug" : "other",
                      initialBody: `Account issue: ${issue.text}. ${issue.hint}`,
                    }))}
                  />
                );
              })()}
            </>
          )}
          {/* Under the roster and the policy over it, in every state the
              column is in: the header has no room left beside its five acts. */}
          <CodexProfilesSection />
          <div className="film-foot"><FilmLink film="claudeAccounts" /></div>
        </div>
      )}

      {/* The switch that took, said out loud (#827). Always mounted, empty at
          rest, the way the topbar's blocked-session region is: a status that
          appears already holding its text is one a screen reader may never
          read. */}
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
          // Named by the identity every deck agrees on, never by slot — see
          // account-lan.ts.
          accounts={lanAccounts(data?.accounts ?? [])}
          onChanged={() => load(true)}
          onNoCopy={takeNoCopy}
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
        const a = data?.accounts?.find(x => x.num === projectsFor.num);
        // Gone from a roster that was read: nothing to draw, and the effect
        // that watches the roster closes the report. No roster at all is a
        // store that could not be read this once, and the report stays, under
        // the name it was opened with.
        if (data?.accounts && !a) return null;
        return (
          <AccountProjectsModal
            num={projectsFor.num}
            name={a ? (a.alias ?? a.email ?? `account ${a.num}`) : projectsFor.name}
            onClose={() => setProjectsFor(null)}
          />
        );
      })()}
      {/* The Usage report (#1707) — components/AccountsUsageReport.tsx. The
          panel's roster, handed in on every poll, in the order the panel had
          when it opened, and read on the panel's clock: an open report moves
          with the panel and starts no poll. A reload that failed is said
          there too, because the report stands over the line that says it. */}
      {reportOpen && (
        <AccountsUsageReport accounts={data?.accounts ?? null} order={reportOrder}
          failed={failure?.reload ? failure.text : null}
          nowSec={nowSec} onClose={() => setReportOpen(false)} />
      )}
    </aside>
  );
}
