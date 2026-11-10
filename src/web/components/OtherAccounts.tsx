// THE FOLD'S HEAD, and the card that names what is behind it.
//
// Why the accounts column has a fold at all, and why it unfolds in place
// instead of leading to a view, is written in other-accounts.ts. This file is
// the two surfaces: the group's head, and a peek in Local network's shape.
//
// IT BORROWS THAT SECTION'S TIMINGS RATHER THAN CHOOSING ITS OWN. Two hover
// cards in one column that opened on different delays would be two behaviours
// a reader has to learn from the same panel, and nothing about accounts makes
// 160ms the wrong number. The constants are imported for that reason and not
// for reuse; if one of them ever needs to differ, the comment that says why
// belongs here.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { createPortal } from "react-dom";
import { type Peer, foldPeek, restLine } from "../other-accounts";
import { KitIcon } from "./kit-icons";
import AnchoredPopover from "./AnchoredPopover";
import { SLOT_ORDER, type OrderChoice } from "../other-accounts-order";
import { placeBeside } from "../popover-place";
import { PEEK_DELAY_MS, PEEK_GRACE_MS } from "./LanSyncSection";

/**
 * THE NAMES, BESIDE THE ROW, WITH NOTHING PRESSED.
 *
 * `2 ready` answers how many and refuses to say which, and which is the whole
 * question for somebody whose current window is nearly spent. The press that
 * answers it costs an unfold and a re-fold, for a list of at most a handful of
 * names.
 *
 * NOT ONE CONTROL IN IT, which is the rule LanPeek wrote and the one this card
 * is most tempted to break: the reader hovering it is choosing where to switch,
 * and `Switch` is right there in the sentence. It stays out. A card that shuts
 * 140ms after the pointer leaves is a way to lose a press, not to offer one,
 * and the press it would be offering restarts every session on this machine.
 * Unfold the row and the same switch is on the row it belongs to.
 *
 * PORTALLED and placed by placeBeside, for the reasons LanPeek gives: the panel
 * clips its own overflow, and a card dropped under this row would cover the
 * rows the pointer is moving through.
 */
function FoldPeek({ anchorId, id, peers, onHold, onLet }: {
  anchorId: string;
  id: string;
  peers: Peer[];
  /** The pointer is here: cancel whatever the row scheduled. */
  onHold: () => void;
  /** The pointer left the card: shut it, on the same grace as the row's. */
  onLet: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const { title, shown, rest } = foldPeek(peers, t);

  const place = useCallback(() => {
    const el = ref.current;
    const anchor = document.getElementById(anchorId);
    if (!el || !anchor) return;
    // Measured at its natural height, as SessionPeek's card is and for its reason.
    el.style.maxHeight = "";
    const p = placeBeside(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    el.dataset.side = p.side;
  }, [anchorId]);
  // Before paint, every render: the panel re-polls every fifteen seconds and a
  // number that grew a digit makes the card wider than it was placed at.
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    // Capture: the panel's own scroll does not bubble to window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [place]);

  return createPortal(
    <div ref={ref} id={id} className="ap-peek ap-fold-peek" role="tooltip"
      onPointerEnter={onHold} onPointerLeave={onLet}>
      <p className="ap-peek-title">{title}</p>
      <div className="ap-peek-list">
        {shown.map(p => (
          <span key={p.key} className="ap-peek-who ap-fold-who">
            <span className="ap-fold-name" title={p.name}>{p.name}</span>
            {/* The number is what makes this card a choice rather than a list.
                A name nothing has ever been collected for gets no number and no
                guess — see foldPeek on why it also sorts last. */}
            <span className="ap-fold-state" data-tone={p.ready ? "ok" : p.warn ? "warn" : "idle"}>
              {p.ready ? (p.headroom == null ? t("accounts.other.notReadYet") : t("accounts.other.free", { pct: Math.round(p.headroom) })) : p.why}
            </span>
          </span>
        ))}
      </div>
      {rest && <p className="ap-peek-rest">{rest}</p>}
    </div>,
    document.body,
  );
}

/**
 * THE HEAD OF THE GROUP OF EVERY ACCOUNT THAT IS NOT THE LIVE ONE.
 *
 * One line: the fold, total count, switchable count and, while expanded,
 * the order and expand-all controls. The names stay inside the list or peek.
 */
export default function OtherAccounts({
  peers, strained, armed, threshold, open, onToggle, order, choices, onOrder, allOpen, onToggleAll, held = false, idPrefix = "",
}: {
  peers: Peer[];
  /** Where auto-switch trips. This row says it because the control that sets
   *  it is behind this row now. */
  threshold: string | null;
  /** The live account is past the threshold auto-switch would act on, so where
   *  to go next is the question being asked rather than a number to hide. */
  strained: boolean;
  /** Something is switching automatically, so the reader is not the one
   *  picking — and a policy with nowhere to go is the one alarm this row
   *  carries. See restLine. */
  armed: boolean;
  open: boolean;
  onToggle: () => void;
  /** The order the list is in, as one of `choices` (#1579). */
  order: string;
  choices: OrderChoice[];
  onOrder: (order: string) => void;
  /** Every row behind the fold is open, so the next press shuts them all. */
  allOpen: boolean;
  onToggleAll: () => void;
  /** The list is holding the order the reader found it in — see holdOrder. */
  held?: boolean;
  /** Before each id, for the second column that draws this row (AccountRow's
   *  RowVoice says why). */
  idPrefix?: string;
}) {
  const t = useT();
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  // NOTHING TO PEEK AT WHILE THE LIST IS OPEN. The card would name, beside the
  // row, the accounts standing directly under it — and it would cover them.
  useEffect(() => { if (open) { window.clearTimeout(peekTimer.current); setPeek(false); } }, [open]);

  const openPeek = (delay: number) => {
    if (open) return;
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(true), delay);
  };
  // NOT AT ONCE — the card opens 4px from the row, and a pointer moving onto it
  // crosses those 4px of nothing. The grace is what makes the gap crossable;
  // see PEEK_GRACE_MS, where the whole of that argument is written.
  const shutPeek = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(false), PEEK_GRACE_MS);
  };
  // The pointer is on the card: whatever was pending, it is not wanted.
  const holdPeek = () => window.clearTimeout(peekTimer.current);
  // The press unfolds the list this card is about. No grace: the card would
  // stand over the rows it had just been naming.
  const dropPeek = () => { window.clearTimeout(peekTimer.current); setPeek(false); };

  // The one alarm the head carries — a policy with nowhere to go — is
  // restLine's verdict, in both states of the fold.
  const line = restLine(peers, { strained: strained && !open, armed, threshold }, t);
  // HOW MANY A SWITCH WOULD REACH: signed in and not held out, the same two
  // refusals a row withholds its own Switch for. A full window still counts —
  // each row says its own limits — and the tooltip says so.
  const ready = peers.filter(p => p.ready).length;
  const readyText = ready > 0
    ? t("accounts.other.canSwitch", { count: ready })
    : t("accounts.other.noneCanSwitch", { total: peers.length });
  return (
    <div className="ap-rest" data-open={open ? "" : undefined}>
      <div className="ap-rest-head">
        <button type="button" id={`ap-${idPrefix}rest-entry`} className="ap-nav ap-sum"
          aria-expanded={open}
          // THE WHOLE BOX, not the list inside it: the list's own id is the one
          // its rows' menus close against.
          aria-controls={open ? `ap-${idPrefix}rest-panel` : undefined}
          // Described by the card while the card is there, so a screen reader on
          // this row is read the same names a pointer is shown.
          aria-describedby={peek ? `ap-${idPrefix}rest-peek` : undefined}
          onClick={() => { dropPeek(); onToggle(); }}
          // A mouse only. Touch has no hover, and a pointerenter synthesised by a
          // tap would open a card the tap is already replacing with the list.
          onPointerEnter={e => { if (e.pointerType === "mouse") openPeek(PEEK_DELAY_MS); }}
          onPointerLeave={shutPeek}
          // A KEYBOARD'S FOCUS, NOT EVERY FOCUS — the rule Local network's way-in
          // row (LanEntryRow.tsx) learned from a card that opened on a
          // programmatic hand-back and then had nothing to close it.
          // `:focus-visible` is the browser's own answer to which of the two
          // happened.
          onFocus={e => { if (e.target.matches(":focus-visible")) openPeek(0); }}
          onBlur={shutPeek}>
          {/* A chevron and no other glyph: an icon in this column means a
              DESTINATION, and this row opens a list where it stands. The
              chevron turns down while the list is open. */}
          <KitIcon name="chevron-right" className="ap-nav-chev" />
          <span className="ap-nav-text">
            {/* The title never wraps; the count is every other account. */}
            <span className="ap-nav-name">{t("accounts.other.title")}</span>
            <span className="ap-sum-count">{peers.length}</span>
          </span>
        </button>
        <span className="ap-rest-ready" data-tone={ready > 0 ? "ok" : "idle"}
          role="img" aria-label={readyText} title={`${readyText}. ${t("accounts.other.countTip")}`}>
          <i className="ap-rest-dot" aria-hidden />
          <span className="ap-rest-ready-text" aria-hidden>{ready}</span>
        </span>
        {open && <SortMenu order={order} choices={choices} onOrder={onOrder} held={held} idPrefix={idPrefix} />}
        {/* A toggle, named once and pressed or not: a name that changed under
            the keyboard's focus is one most screen readers never announce. The
            tooltip says what the next press does. Drawn only while the list is
            open, because there is nothing to open while it is shut, and beside
            the toggle rather than inside it — a control inside a button is not
            a control. The glyph is arrows out of a line, and into it once
            every row is open. */}
        {open && (
          <button type="button" className="ap-rest-all" aria-label={t("accounts.other.expandAll")} aria-pressed={allOpen}
            aria-controls={`ap-${idPrefix}rest-list`} title={allOpen ? t("accounts.other.collapseAll") : t("accounts.other.expandAll")}
            onClick={onToggleAll}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.25"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={allOpen
                ? "M1 7h1M5 7h1M8 7h1M12 7h1M7 1v4M7 9v4M5 3.2 7 5l2-1.8M5 10.8 7 9l2 1.8"
                : "M1 7h1M5 7h1M8 7h1M12 7h1M7 1v4M7 9v4M5 3 7 1l2 2M5 11l2 2 2-2"} />
            </svg>
          </button>
        )}
      </div>
      {/* THE ONE SENTENCE IN THE ERROR INK: auto-switch is on and there is no
          account it could move to. Said open or shut, because neither the
          meters nor the toggle can show it. */}
      {line.tone === "bad" && (
        <p className="ap-rest-alarm">
          <KitIcon name="warning" className="ap-rest-alarm-glyph" />
          <span>{line.text}</span>
        </p>
      )}
      {peek && <FoldPeek anchorId={`ap-${idPrefix}rest-entry`} id={`ap-${idPrefix}rest-peek`} peers={peers}
        onHold={holdPeek} onLet={shutPeek} />}
    </div>
  );
}

/**
 * THE LIST'S ORDER (#1579), AS ONE MENU: slot, most room, and fullest or
 * emptiest first by each window — the direction is part of the choice, so
 * there is no second button to reverse it.
 *
 * A button that opens a menu over the column, so choosing an order moves
 * nothing but the rows and the group stays open. What it shows closed is the
 * order the list is in; under 240px the name leaves the button for its tooltip
 * and the icon and the chevron stay. It is drawn at --text once it is anything
 * but slot, so a sorted list says so, and with a dashed edge while the list is
 * holding the order the reader found — the deck's mark for "the last thing,
 * not the latest" — with the reason in its title.
 */
function SortMenu({ order, choices, onOrder, held, idPrefix }: {
  order: string;
  choices: OrderChoice[];
  onOrder: (order: string) => void;
  held: boolean;
  idPrefix: string;
}) {
  const t = useT();
  const [menu, setMenu] = useState<null | "first" | "last">(null);
  const id = `ap-${idPrefix}rest-sort`;
  const label = choices.find(c => c.id === order)?.label ?? t("accounts.order.slot");
  const choose = (next: string) => {
    onOrder(next);
    document.getElementById(id)?.focus();
    setMenu(null);
  };
  return (
    <>
      <button type="button" id={id} className="ap-rest-sort"
        aria-haspopup="menu" aria-expanded={menu != null}
        aria-controls={menu ? `${id}-menu` : undefined}
        // The whole order, for a name the width has cut or hidden; and while
        // the list is held, why it does not match what the numbers now say.
        title={held ? t("accounts.other.heldTip", { label }) : label}
        data-sorted={order === SLOT_ORDER ? undefined : ""}
        data-held={held ? "" : undefined}
        onClick={() => setMenu(m => (m ? null : "first"))}
        onKeyDown={e => {
          // Down opens at the first order and Up at the last, the way a native
          // menu button does. Enter and Space are the click.
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}>
        <svg className="ap-rest-sort-glyph" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3.5 2v8M1.75 8.25 3.5 10l1.75-1.75M6.5 2.5h1.5M6.5 5h3M6.5 7.5h4" />
        </svg>
        <span className="vis-hidden">{t("accounts.other.orderLabel")}: </span>
        <span className="ap-rest-sort-name">{label}</span>
        <KitIcon name="chevron-down" className="ap-rest-sort-chev" />
      </button>
      {menu && (
        <AnchoredPopover anchorId={id} boundaryId={idPrefix ? `ap-${idPrefix}scroll` : "ap-scroll"} id={`${id}-menu`}
          className="ap-pop ap-sort-pop" role="menu" labelledBy={id} start={menu} onClose={() => setMenu(null)}>
          {choices.map(c => (
            <button key={c.id} type="button" role="menuitemradio" aria-checked={c.id === order} className="ap-menu-item"
              onClick={() => choose(c.id)}>
              <span className="ap-menu-label">{c.label}</span>
              {c.id === order && <span className="ap-menu-check" aria-hidden>✓</span>}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </>
  );
}
