// THE TWO STRIPES: A DOOR STAYS ON THE SIDE WHERE ITS PANEL OPENS (V4's Figma).
//
// One stripe on each edge, 40 wide, so the eye never crosses the canvas to find
// what a door opened. The left one holds what opens on the left: Sessions,
// Accounts · the connected trackers, and at its foot a More (the capacity
// reports, Explore, Radio) and Settings. The right one holds what opens on the
// right: the Inspector, alone and first · Usage, Machine, and at its foot a
// More (the three activity records, Browser watch, Radar). The stripe keeps the
// doors used all day; a More, the ones used now and then. rail-items.tsx lists
// them; each run between two rules is a named group, and a More's menu keeps
// its runs a rule apart.
//
// A new profile's stripes say each door's word beside its glyph, 156 wide; a
// "Hide words" at the left stripe's foot folds both to 40 and icons, the names
// and shortcuts then in their tooltips (stripe-words.ts). Tooltips open towards
// the canvas: right from the left stripe, left from the right one. Phone
// controls and the topbar utilities keep their visible words.
// The topbar keeps the identity, the stream's state, the waiting queue, Search
// (UtilityRun) and, in its own corner cell, Feedback. Under 641px the stripes
// and Search become one dock along the bottom: the four panels one tap away and
// the rarer doors, Settings among them, behind a More; Feedback stays in the
// bar's corner, its one entry on every size.
//
// THESE ARE NOT TABS. A stripe button shows or hides a panel beside the canvas,
// several can be open at once, and the canvas never leaves the screen: "One
// canvas. No tabs." (PRODUCT.md) is the promise the shape keeps.
//
// Semantics: each stripe is its own APG toolbar (one Tab stop each, the arrows
// inside it, Home and End), vertical on the edges and horizontal in the dock.
// Its buttons keep the roles they had: a disclosure for the four panels
// (aria-expanded, and aria-controls while the region exists), aria-haspopup=
// "dialog" for the four that open a modal. Every key the deck answers is
// unchanged, and each button names its own in aria-keyshortcuts while the
// single-key shortcuts are on. A More is a menu button in the toolbar's arrow
// order like a door: Enter or Space opens its menu, Escape gives focus back to
// it, and a row hands focus to it before its dialog opens. On a stripe, Up and
// Down stay the toolbar's, so the arrows still walk past it to Settings; only
// the dock's More, in a horizontal toolbar, also opens on them.
import {
  useCallback, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type ReactNode, type RefObject,
} from "react";
import AnchoredPopover from "./AnchoredPopover";
import { Kbd } from "./Kbd";
import { useHint, type HintSide, type HintSpec } from "./use-hint";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { useT } from "../i18n";
import { setStripeWords, useStripeWords, useStripeWordsRoom } from "../stripe-words";
import { StripeWordsGlyph } from "./rail-glyphs";

/** The key a control answers: its keycap, its aria-keyshortcuts spelling, and
 *  whether it is one character — which the single-key switch silences — or a
 *  chord, which it never does. */
export interface RailKey {
  cap: string;
  aria: string;
  single: boolean;
}

export interface RailItem {
  id: string;
  /** The word on the control, and the dialog's or panel's own name. */
  label: string;
  /** The word under the glyph in the phone's dock, where a column is 60px wide. */
  short: string;
  /** The word beside the glyph on a stripe showing its words, where `short`
   *  alone would not say which door it is: "Reset calendar", not "Calendar".
   *  `short`, when unset. */
  stripeWord?: string;
  key?: RailKey;
  /** The hint's name, when it says more than the word: "Usage history". */
  hint?: string;
  /** The name in a More's menu, where a row has the room for it whole:
   *  "Usage history", "Send feedback". The word, when unset. */
  menu?: string;
  /** Lines the hint adds under the name. */
  detail?: string;
  ariaLabel: string;
  glyph: ReactNode;
  /** A panel discloses a region; a dialog opens a modal. */
  kind: "panel" | "dialog";
  open?: boolean;
  /** The region's id, while it is mounted. */
  controls?: string;
  onPress: () => void;
  buttonRef?: RefObject<HTMLButtonElement>;
  /** Unread findings, drawn in the chrome's resting grey: never amber.
   *  Feedback's unread replies, in its corner, are the accent's, as its dot. */
  badge?: number;
  /** Something unread with no number worth drawing — a ccdeck account's
   *  conversation with a reply: a small accent dot where the badge sits,
   *  never amber. Its count is in the item's name and `detail`. */
  dot?: boolean;
  /** The name of the run of doors this one stands in on a stripe, said once on
   *  the way into it (rail-items.tsx). */
  group?: string;
  /** The dialog this door opens is up. Drawn only on a stripe's More that
   *  holds the door, as that More's open look, so the reader sees where the
   *  dialog came from; never said, since the dialog says itself and a menu
   *  item has no open state. */
  up?: boolean;
  /** How the top bar draws this door where it is not a word button: a field
   *  holding `fieldText` and the chord (Search), or a bare 28x28 icon button
   *  (Feedback, V4's Figma). Looks only, on the same button with the same name
   *  and the same hint; the stripes and the dock ignore it. */
  barLook?: "field" | "icon";
  /** The sentence a field shows, and so its name (WCAG 2.5.3, label in name)
   *  and its hint's. */
  fieldText?: string;
}

/** The key a control may name right now: its own, unless it is a single
 *  character and the single-key shortcuts are off. */
export function liveKey(key: RailKey | undefined, singleKeys: boolean): RailKey | undefined {
  return key && (singleKeys || !key.single) ? key : undefined;
}

/** What the hint says for a control, or null when it would only repeat a word
 *  the control already shows and has no key to add. `word` is the word shown,
 *  where it is not the label: a stripe's shorter one. */
export function railHint(item: RailItem, singleKeys: boolean, wordShown: boolean, word: string = item.label): HintSpec | null {
  const keys = liveKey(item.key, singleKeys)?.cap;
  const label = item.hint ?? item.label;
  const addsSomething = keys != null || item.detail != null || label !== word || !wordShown;
  return addsSomething ? { label, keys, detail: item.detail } : null;
}

/** A stripe door's hint while its word shows: only what the word does not say,
 *  the longer name, the key and the help line, or null when that is nothing. */
export function stripeHint(item: RailItem, singleKeys: boolean, word: string): HintSpec | null {
  const spec = railHint(item, singleKeys, true, word);
  return spec && spec.label === word ? { ...spec, label: "" } : spec;
}

/** The word a stripe shows for a door while its words are on. */
export function stripeWordOf(item: RailItem): string {
  return item.stripeWord ?? item.short;
}

/** Each placement's classes, written out whole so every class the markup can
 *  carry is a literal the sheet sweeps can hold to a rule. */
const BUTTON_CLASS = { stripe: "rail-btn rail-btn-stripe", dock: "rail-btn rail-btn-dock", bar: "rail-btn rail-btn-bar" } as const;
const BAR_LOOK_CLASS = { field: "rail-btn rail-btn-bar rail-btn-field", icon: "rail-btn rail-btn-bar rail-btn-icon" } as const;
const RAIL_CLASS = { left: "edge-rail edge-rail-left", right: "edge-rail edge-rail-right" } as const;
/** A stripe's hint opens towards the canvas: the side facing it. */
const RAIL_HINT_SIDE = { left: "right", right: "left" } as const;

const NEXT_KEYS = { vertical: "ArrowDown", horizontal: "ArrowRight" } as const;
const PREV_KEYS = { vertical: "ArrowUp", horizontal: "ArrowLeft" } as const;

/** One Tab stop for the toolbar, the arrows inside it (APG toolbar pattern). */
function useRoving(count: number, orientation: "vertical" | "horizontal") {
  const [current, setCurrent] = useState(0);
  const active = Math.min(current, Math.max(0, count - 1));
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-rail-item]"));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === NEXT_KEYS[orientation]) to = (at + 1) % buttons.length;
    else if (e.key === PREV_KEYS[orientation]) to = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = buttons.length - 1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    setCurrent(to);
    buttons[to].focus();
  }, [orientation]);
  return { active, setCurrent, onKeyDown };
}

/** The control the keyboard was on when the window crossed 640px and the
 *  stripes and the dock traded places: the one that unmounts cannot hand focus
 *  over, so the one that mounts takes it, on the same control. */
let handover: string | null = null;
function useFocusHandover(ref: RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    if (handover && document.activeElement === document.body) {
      ref.current?.querySelector<HTMLElement>(`[data-rail-item="${handover}"]`)?.focus();
    }
    handover = null;
    const track = (e: FocusEvent) => {
      const id = (e.target as HTMLElement).dataset?.railItem;
      if (id) handover = id;
    };
    const untrack = (e: FocusEvent) => {
      if (!ref.current?.contains(e.relatedTarget as Node | null)) handover = null;
    };
    const el = ref.current;
    el?.addEventListener("focusin", track);
    el?.addEventListener("focusout", untrack);
    return () => {
      el?.removeEventListener("focusin", track);
      el?.removeEventListener("focusout", untrack);
    };
  }, [ref]);
}

/** A door's name while a stripe shows `word` beside it: its own name when that
 *  holds the word ("Browser watch, not watching"), the word when it does not
 *  ("Sessions" for "Session list"), so what the eye reads is what voice control
 *  can say (WCAG 2.5.3). */
export function stripeDoorName(ariaLabel: string, word: string): string {
  return ariaLabel.toLocaleLowerCase().includes(word.toLocaleLowerCase()) ? ariaLabel : word;
}

function RailButton({ item: given, index, tabbable, onFocusIndex, hint, variant, offlineDot = false, word = null }: {
  item: RailItem;
  index: number;
  tabbable: boolean;
  onFocusIndex: (i: number) => void;
  hint: ReturnType<typeof useHint>;
  variant: "stripe" | "dock" | "bar";
  /** The phone dock's red dot: the deck cannot reach the computer. */
  offlineDot?: boolean;
  /** A stripe's word beside the glyph, while its words are on. */
  word?: string | null;
}) {
  const stripeWord = variant === "stripe" ? word : null;
  const item = stripeWord != null ? { ...given, ariaLabel: stripeDoorName(given.ariaLabel, stripeWord) } : given;
  const singleKeys = useSingleKeyShortcuts();
  // V4's top bar draws Search as a field (its sentence and its chord): looks
  // only, on the same button with the same handler. A field is named by the
  // sentence it shows, and its hint says the same words.
  const look = variant === "bar" ? item.barLook : undefined;
  const fieldText = look === "field" ? item.fieldText ?? item.label : null;
  const hinted = fieldText != null ? { ...item, label: fieldText, hint: undefined } : item;
  // An icon-only bar button (Feedback) shows no word, so its hint is what says
  // the word: the tooltip keeps "Feedback".
  const iconOnly = look === "icon";
  const spec = stripeWord != null
    ? stripeHint(hinted, singleKeys, stripeWord)
    : railHint(hinted, singleKeys, variant !== "stripe" && !iconOnly);
  // V4's door tooltip on an icon stripe is one line, the name and its key; with
  // the word on the door it is what the word does not say, its key and its help
  // line. The help line stays for assistive tech as the door's description.
  const oneLine = variant === "stripe" && stripeWord == null && spec != null && spec.detail != null;
  const hintHandlers = hint.bind(oneLine ? { ...spec, detail: undefined } : spec);
  const disclosure = item.kind === "panel";
  return (
    <button
      ref={item.buttonRef}
      type="button"
      data-rail-item={item.id}
      className={look ? BAR_LOOK_CLASS[look] : BUTTON_CLASS[variant]}
      tabIndex={variant === "bar" ? undefined : tabbable ? 0 : -1}
      aria-label={fieldText ?? item.ariaLabel}
      aria-keyshortcuts={liveKey(item.key, singleKeys)?.aria}
      aria-description={variant === "stripe" ? spec?.detail : undefined}
      aria-expanded={disclosure ? item.open === true : undefined}
      aria-controls={disclosure && item.open ? item.controls : undefined}
      aria-haspopup={disclosure ? undefined : "dialog"}
      {...hintHandlers}
      onFocus={e => { onFocusIndex(index); hintHandlers.onFocus(e); }}
      onClick={() => item.onPress()}
    >
      {item.glyph}
      {fieldText != null ? <>
        <span className="rail-field-text">{fieldText}</span>
        {item.key && <Kbd>{item.key.cap}</Kbd>}
      </> : stripeWord != null ? <span className="rail-word">{stripeWord}</span>
        : variant !== "stripe" && !iconOnly && <span className="rail-word">{variant === "dock" ? item.short : item.label}</span>}
      {item.badge != null && item.badge > 0 && <span className="rail-badge" aria-hidden>{item.badge}</span>}
      {item.dot && !(item.badge != null && item.badge > 0) && <span className="rail-dot" aria-hidden />}
      {offlineDot && <span className="rail-offline-dot" aria-hidden />}
    </button>
  );
}

/** A stripe: on the window's left or right edge, under the topbar. Its doors
 *  are runs between rules at the top; its foot (no rule), if it has one, is
 *  pushed to the bottom: the More for the occasional doors first, then the
 *  utilities. Its hint opens towards the canvas: to its right on the left
 *  stripe, to its left on the right one. The left one's foot ends in the switch
 *  between words and icons, which both stripes follow. */
export function EdgeRail({ side, label, groups, more = [], foot = [] }: {
  side: "left" | "right";
  label: string;
  groups: RailItem[][];
  /** The occasional doors, behind the More at the head of the foot, in runs a
   *  rule apart. A More with nothing in it is not drawn. */
  more?: RailItem[][];
  foot?: RailItem[];
}) {
  const t = useT();
  const hint = useHint(RAIL_HINT_SIDE[side]);
  const words = useStripeWords();
  const room = useStripeWordsRoom();
  const items = groups.filter(g => g.length > 0);
  const runs = more.filter(g => g.length > 0);
  const moreHere = runs.length > 0;
  // Not drawn where the window has no room for words: there is nothing to switch.
  const switchHere = side === "left" && room;
  // The arrows' order: the doors, the More, the foot's doors, the switch.
  const moreIndex = items.flat().length;
  const footIndex = moreIndex + (moreHere ? 1 : 0);
  const switchIndex = footIndex + foot.length;
  const roving = useRoving(switchIndex + (switchHere ? 1 : 0), "vertical");
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandover(ref);
  const door = (item: RailItem, i: number) => (
    <RailButton key={item.id} item={item} index={i} tabbable={i === roving.active}
      onFocusIndex={roving.setCurrent} hint={hint} variant="stripe" word={words ? stripeWordOf(item) : null} />
  );
  let index = 0;
  // "Hide words" says itself while the words show; the » alone is named in its hint.
  const switchLabel = words ? t("board.rail.words.hide") : t("board.rail.words.show");
  const switchHint = hint.bind(words ? null : { label: switchLabel });
  // The foot is named by everything in it, the More and the switch too; a foot
  // of one control is that control, with no group around it.
  const footNames = [...(moreHere ? [t("board.rail.more")] : []), ...foot.map(item => item.label), ...(switchHere ? [switchLabel] : [])];
  const footName = footNames.length > 1 ? footNames.join(t("board.listSep")) : undefined;
  return (
    <div ref={ref} className={RAIL_CLASS[side]} role="toolbar" aria-label={label}
      aria-orientation="vertical" data-words={words || undefined} onKeyDown={roving.onKeyDown}>
      <div className="rail-doors">
      {items.map(group => {
        // A run of two or more is a named group, so a screen reader moving
        // down the stripe hears "Activity history" before the three doors in
        // it: the rule between runs, said. A door alone keeps its own name.
        const name = group.length > 1 ? group[0].group : undefined;
        return (
          <div className="rail-group" key={group[0].id} role={name ? "group" : undefined} aria-label={name}
            data-rail-group={group[0].id === "explore-integrations" ? "explore" : undefined}>
            {group.map(item => door(item, index++))}
          </div>
        );
      })}
      </div>
      {footNames.length > 0 && (
        <div className="rail-foot" role={footName ? "group" : undefined} aria-label={footName}>
          {moreHere && (
            <More place={side} items={runs.flat()} rules={runs.slice(1).map(run => run[0].id)}
              index={moreIndex} tabbable={moreIndex === roving.active} onFocusIndex={roving.setCurrent}
              hint={hint} word={words ? t("board.rail.more") : null} />
          )}
          {foot.map((item, i) => door(item, footIndex + i))}
          {switchHere && (
            <button type="button" data-rail-item={STRIPE_WORDS_ID} className={STRIPE_WORDS_CLASS}
              tabIndex={switchIndex === roving.active ? 0 : -1} aria-label={switchLabel}
              {...switchHint}
              onFocus={e => { roving.setCurrent(switchIndex); switchHint.onFocus(e); }}
              onClick={() => setStripeWords(!words)}>
              <StripeWordsGlyph shown={words} />
              {words && <span className="rail-word">{switchLabel}</span>}
            </button>
          )}
        </div>
      )}
      {hint.node}
    </div>
  );
}

/** The switch between words and icons, on the stripe's arrows like a door. */
const STRIPE_WORDS_ID = "stripe-words";
const STRIPE_WORDS_CLASS = "rail-btn rail-btn-stripe rail-words-btn";

/** The dock's More button: what a row of its menu that opens something hands on
 *  as its opener (rail-items.tsx commandPanelMore). */
export const DOCK_MORE_ID = "dock-more";

/** Where a More stands: the phone's dock, or the foot of either stripe. */
type MorePlace = "dock" | "left" | "right";
const MORE_ID: Record<MorePlace, string> = { dock: DOCK_MORE_ID, left: "rail-more-left", right: "rail-more-right" };
const MORE_MENU_ID: Record<MorePlace, string> = { dock: "dock-more-menu", left: "rail-more-left-menu", right: "rail-more-right-menu" };
/** The phone's menu grows out of the dock's corner (phone-sheet.css); a
 *  stripe's is the plain popover. */
const MORE_POP_CLASS = { dock: "ap-pop dock-more-pop", left: "ap-pop", right: "ap-pop" } as const;
/** A stripe's menu opens over the canvas, never past the window's edge: from
 *  the left stripe its left edge under More's, from the right one its right. */
const MORE_ALIGN = { dock: "end", left: "start", right: "end" } as const;
/** The dock's one rule: before Settings, last, set apart from the dialogs above
 *  it, so the one way into Settings on a phone is found at a glance rather than
 *  read for. */
const DOCK_RULES = ["settings"];

/** A More: the doors used now and then, in a menu like an account's ⋯ — the
 *  phone dock's, and the one at the foot of each stripe, with the same rows,
 *  count and dot. Each row hands focus back to More before its dialog opens, so
 *  the dialog gives it back there when it closes. In the dock, Up and Down on
 *  the button also open it at either end, the way a native menu button does;
 *  on a stripe those are the toolbar's (EdgeRails' header). */
function More({ items, rules = [], tabbable, onFocusIndex, index, place = "dock", hint, word = null }: {
  items: RailItem[];
  /** The rows a rule goes before: the first of each run after the first. */
  rules?: readonly string[];
  tabbable: boolean;
  onFocusIndex: (i: number) => void;
  index: number;
  place?: MorePlace;
  /** A stripe's hint; the dock's More has none. */
  hint?: ReturnType<typeof useHint>;
  /** A stripe's word beside the glyph, while its words are on. */
  word?: string | null;
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const stripe = place !== "dock";
  const variant = stripe ? "stripe" : "dock";
  const id = MORE_ID[place];
  const menuId = MORE_MENU_ID[place];
  const sep = t("board.listSep");
  const unread = items.reduce((n, item) => n + (item.badge ?? 0), 0);
  // A dot behind More shows on More while no count does.
  const dotted = unread === 0 && items.some(item => item.dot);
  // While a panel or dialog it holds the door of is up, a stripe's More wears
  // the open look, so the reader sees where that came from.
  const up = stripe && items.some(item => item.open === true || item.up === true);
  // A stripe's hint names the doors behind it, and More too while no word does.
  const hintHandlers = stripe
    ? hint?.bind({ label: word != null ? "" : t("board.rail.more"), detail: items.map(item => item.menu ?? item.label).join(sep) })
    : undefined;
  const shownWord = stripe ? word : t("board.rail.more");
  const pick = (item: RailItem) => () => {
    document.getElementById(id)?.focus();
    setMenu(null);
    item.onPress();
  };
  return (
    <>
      <button
        id={id}
        type="button"
        data-rail-item="more"
        // The doors in its menu, so a dialog whose opener is gone (Safari's
        // click, Quick open, a resize) gives focus back to the More on its own
        // side: `[data-more-holds~="radio"]` (RadioPanel.tsx, ToolAuditModal.tsx).
        data-more-holds={items.map(item => item.id).join(" ")}
        data-up={up || undefined}
        className={BUTTON_CLASS[variant]}
        tabIndex={tabbable ? 0 : -1}
        aria-label={t("board.rail.moreLabel", { items: items.map(i => i.ariaLabel).join(sep) })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        {...hintHandlers}
        onFocus={e => { onFocusIndex(index); hintHandlers?.onFocus(e); }}
        onKeyDown={e => {
          if (stripe || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <svg className="glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="2.8" cy="7" r="0.7" /><circle cx="7" cy="7" r="0.7" /><circle cx="11.2" cy="7" r="0.7" />
        </svg>
        {shownWord != null && <span className="rail-word">{shownWord}</span>}
        {unread > 0 && <span className="rail-badge" aria-hidden>{unread}</span>}
        {dotted && <span className="rail-dot" aria-hidden />}
      </button>
      {open && (
        <AnchoredPopover anchorId={id} id={menuId} className={MORE_POP_CLASS[place]} role="menu"
          labelledBy={id} start={menu} align={MORE_ALIGN[place]} onClose={() => setMenu(null)}>
          {/* Each run after the first set apart by the menus' own rule. A
              stripe's row ends in its key, quiet, as a native menu's does: seen,
              not said (the row's name stays its words; aria-keyshortcuts says
              the key). */}
          {items.flatMap((item, i) => {
            const key = liveKey(item.key, singleKeys);
            return [
              ...(i > 0 && rules.includes(item.id) ? [<div key={`${item.id}-rule`} role="separator" className="ap-menu-sep" />] : []),
              <button key={item.id} type="button" role="menuitem" className="ap-menu-item" data-rail-item={item.id}
                aria-keyshortcuts={key?.aria}
                onFocus={() => { handover = item.id; }} onClick={pick(item)}>
                {item.dot && item.detail ? `${item.menu ?? item.label} · ${item.detail}` : item.badge ? t("board.rail.unread", { label: item.menu ?? item.label, n: item.badge }) : item.menu ?? item.label}
                {stripe && key && <span className="rail-menu-key" aria-hidden><Kbd>{key.cap}</Kbd></span>}
              </button>,
            ];
          })}
        </AnchoredPopover>
      )}
    </>
  );
}

/** The phone's one dock: the four panels and Settings, and a More for the rest. */
export function EdgeDock({ items, more, offline = false }: { items: RailItem[]; more: RailItem[]; offline?: boolean }) {
  const t = useT();
  const hint = useHint("above");
  const roving = useRoving(items.length + 1, "horizontal");
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandover(ref);
  return (
    <div ref={ref} className="edge-dock" role="toolbar" aria-label={t("board.rail.tools")} onKeyDown={roving.onKeyDown}>
      {items.map((item, i) => (
        <RailButton key={item.id} item={item} index={i} tabbable={i === roving.active}
          onFocusIndex={roving.setCurrent} hint={hint} variant="dock" offlineDot={offline && item.id === "machine"} />
      ))}
      <More items={more} rules={DOCK_RULES} index={items.length} tabbable={roving.active === items.length} onFocusIndex={roving.setCurrent} />
      {hint.node}
    </div>
  );
}

/** The topbar's own buttons: Search in the end group, and Feedback alone in
 *  the corner cell. Fewer than three buttons are not a toolbar (the APG asks
 *  for three or more), so each stays in the Tab order. */
export function UtilityRun({ items, side = "below" }: { items: RailItem[]; side?: HintSide }) {
  const hint = useHint(side);
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandover(ref);
  return (
    <div ref={ref} className="utility-run">
      {items.map((item, i) => (
        <RailButton key={item.id} item={item} index={i} tabbable onFocusIndex={noop} hint={hint} variant="bar" />
      ))}
      {hint.node}
    </div>
  );
}

function noop() {}

/** Whether the window is a phone's: the dock instead of the stripes, at the
 *  sheet's one narrow breakpoint. Declared beside the rule for what a phone's
 *  load opens, which asks the same question before anything is drawn. */
export { PHONE_QUERY } from "../phone-load";
