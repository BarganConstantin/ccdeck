// THE CONTROLS LIVE WHERE THEIR PANELS OPEN.
//
// Each panel toggle used to sit in one row at the top right, whatever side its
// panel opened on: Session list and Accounts open a column on the far LEFT,
// from a button 1,100px away on the right. Here each side of the window owns
// its own controls, in a stripe one control-height wide on that edge:
//
//   left   Accounts, Session list          the left column, which they share
//   right  Usage, Machine · History, Browser watch
//                                          the two rail panels, then the two
//                                          records that open as dialogs
//
// Words, not bare glyphs (#836, and Feedback lost twice as a bare glyph, #1853),
// set along the stripe the way a title runs down a book's spine, so every
// desktop width keeps them for 30px of width a side. The topbar keeps the
// identity, the stream's state, the waiting queue, and the two utilities every
// product keeps in that corner (UtilityRun). Under 641px the stripes and the
// utilities become one dock along the bottom: the four panels and Settings one
// tap away, and the three rare dialogs — History, Browser watch, Feedback —
// behind a More, the three the phone's ⋯ folded before.
//
// THESE ARE NOT TABS. A stripe button shows or hides a panel beside the canvas,
// several can be open at once, and the canvas never leaves the screen: "One
// canvas. No tabs." (PRODUCT.md) is the promise the shape keeps.
//
// Semantics: each stripe is an APG toolbar (one Tab stop, the arrows inside it,
// Home and End), vertical on the edges and horizontal in the dock. Its buttons
// keep the roles they had on the bar: a disclosure for the four panels
// (aria-expanded, and aria-controls while the region exists), aria-haspopup=
// "dialog" for the four that open a modal. Every key the deck answers is
// unchanged, and each button names its own in aria-keyshortcuts while the
// single-key shortcuts are on.
import {
  useCallback, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type ReactNode, type RefObject,
} from "react";
import AnchoredPopover from "./AnchoredPopover";
import { useHint, type HintSide, type HintSpec } from "./use-hint";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";

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
  key?: RailKey;
  /** The hint's name, when it says more than the word: "Usage history". */
  hint?: string;
  /** The name in the dock's More menu, where a row has the room for it whole:
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
  /** Unread findings, drawn in the chrome's resting grey: never amber. */
  badge?: number;
}

/** The key a control may name right now: its own, unless it is a single
 *  character and the single-key shortcuts are off. */
export function liveKey(key: RailKey | undefined, singleKeys: boolean): RailKey | undefined {
  return key && (singleKeys || !key.single) ? key : undefined;
}

/** What the hint says for a control, or null when it would only repeat a word
 *  the control already shows and has no key to add. */
export function railHint(item: RailItem, singleKeys: boolean, wordShown: boolean): HintSpec | null {
  const keys = liveKey(item.key, singleKeys)?.cap;
  const label = item.hint ?? item.label;
  const addsSomething = keys != null || item.detail != null || label !== item.label || !wordShown;
  return addsSomething ? { label, keys, detail: item.detail } : null;
}

/** Each placement's classes, written out whole so every class the markup can
 *  carry is a literal the sheet sweeps can hold to a rule. */
const BUTTON_CLASS = { stripe: "rail-btn rail-btn-stripe", dock: "rail-btn rail-btn-dock", bar: "rail-btn rail-btn-bar" } as const;
const RAIL_CLASS = { left: "edge-rail edge-rail-left", right: "edge-rail edge-rail-right" } as const;

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

/** A word set down a stripe is as long as its letters' advances add up to —
 *  "Session list" came to 69.52px — and every button under it inherited the
 *  fraction, so their glyphs sat on half pixels and blurred at 1x. The word's
 *  box is rounded up to the next whole pixel, once: the fonts are the
 *  system's, already loaded, and the words never change. */
function useWholePixelLength(on: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    el.style.height = "";
    el.style.height = `${Math.ceil(el.getBoundingClientRect().height)}px`;
  }, [on]);
  return ref;
}

function RailButton({ item, index, tabbable, onFocusIndex, hint, variant }: {
  item: RailItem;
  index: number;
  tabbable: boolean;
  onFocusIndex: (i: number) => void;
  hint: ReturnType<typeof useHint>;
  variant: "stripe" | "dock" | "bar";
}) {
  const singleKeys = useSingleKeyShortcuts();
  const hintHandlers = hint.bind(railHint(item, singleKeys, true));
  const disclosure = item.kind === "panel";
  const wordRef = useWholePixelLength(variant === "stripe");
  return (
    <button
      ref={item.buttonRef}
      type="button"
      data-rail-item={item.id}
      className={BUTTON_CLASS[variant]}
      tabIndex={variant === "bar" ? undefined : tabbable ? 0 : -1}
      aria-label={item.ariaLabel}
      aria-keyshortcuts={liveKey(item.key, singleKeys)?.aria}
      aria-expanded={disclosure ? item.open === true : undefined}
      aria-controls={disclosure && item.open ? item.controls : undefined}
      aria-haspopup={disclosure ? undefined : "dialog"}
      {...hintHandlers}
      onFocus={e => { onFocusIndex(index); hintHandlers.onFocus(e); }}
      onClick={() => item.onPress()}
    >
      {item.glyph}
      <span className="rail-word" ref={wordRef}>{variant === "dock" ? item.short : item.label}</span>
      {item.badge != null && item.badge > 0 && <span className="rail-badge" aria-hidden>{item.badge}</span>}
    </button>
  );
}

/** A stripe on one edge of the window, under the topbar. Its hint opens
 *  towards the canvas, the side its panels open on. */
export function EdgeRail({ side, label, groups }: { side: "left" | "right"; label: string; groups: RailItem[][] }) {
  const hint = useHint(side === "left" ? "right" : "left");
  const items = groups.filter(g => g.length > 0);
  const roving = useRoving(items.flat().length, "vertical");
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandover(ref);
  let index = 0;
  return (
    <div ref={ref} className={RAIL_CLASS[side]} role="toolbar" aria-label={label}
      aria-orientation="vertical" onKeyDown={roving.onKeyDown}>
      {items.map((group, g) => (
        <div className="rail-group" key={g}>
          {group.map(item => {
            const i = index++;
            return (
              <RailButton key={item.id} item={item} index={i} tabbable={i === roving.active}
                onFocusIndex={roving.setCurrent} hint={hint} variant="stripe" />
            );
          })}
        </div>
      ))}
      {hint.node}
    </div>
  );
}

const DOCK_MORE_ID = "dock-more";
const DOCK_MENU_ID = "dock-more-menu";

/** The dock's More: the three rare dialogs, in a menu like an account's ⋯.
 *  Up and Down on the button open it at either end, the way a native menu
 *  button does; each item hands focus back to More before its dialog opens, so
 *  the dialog gives it back there when it closes. */
function DockMore({ items, tabbable, onFocusIndex, index }: {
  items: RailItem[];
  tabbable: boolean;
  onFocusIndex: (i: number) => void;
  index: number;
}) {
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const unread = items.reduce((n, item) => n + (item.badge ?? 0), 0);
  const pick = (item: RailItem) => () => {
    document.getElementById(DOCK_MORE_ID)?.focus();
    setMenu(null);
    item.onPress();
  };
  return (
    <>
      <button
        id={DOCK_MORE_ID}
        type="button"
        data-rail-item="more"
        className={BUTTON_CLASS.dock}
        tabIndex={tabbable ? 0 : -1}
        aria-label={`More: ${items.map(i => i.ariaLabel).join(", ")}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? DOCK_MENU_ID : undefined}
        onFocus={() => onFocusIndex(index)}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <svg className="glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="2.8" cy="7" r="0.7" /><circle cx="7" cy="7" r="0.7" /><circle cx="11.2" cy="7" r="0.7" />
        </svg>
        <span className="rail-word">More</span>
        {unread > 0 && <span className="rail-badge" aria-hidden>{unread}</span>}
      </button>
      {open && (
        <AnchoredPopover anchorId={DOCK_MORE_ID} id={DOCK_MENU_ID} className="ap-pop" role="menu"
          labelledBy={DOCK_MORE_ID} start={menu} onClose={() => setMenu(null)}>
          {items.map(item => (
            <button key={item.id} type="button" role="menuitem" className="ap-menu-item" data-rail-item={item.id}
              onFocus={() => { handover = item.id; }} onClick={pick(item)}>
              {item.badge ? `${item.menu ?? item.label} · ${item.badge} unread` : item.menu ?? item.label}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </>
  );
}

/** The phone's one dock: the four panels and Settings, and a More for the rest. */
export function EdgeDock({ items, more }: { items: RailItem[]; more: RailItem[] }) {
  const hint = useHint("above");
  const roving = useRoving(items.length + 1, "horizontal");
  const ref = useRef<HTMLDivElement>(null);
  useFocusHandover(ref);
  return (
    <div ref={ref} className="edge-dock" role="toolbar" aria-label="Panels and tools" onKeyDown={roving.onKeyDown}>
      {items.map((item, i) => (
        <RailButton key={item.id} item={item} index={i} tabbable={i === roving.active}
          onFocusIndex={roving.setCurrent} hint={hint} variant="dock" />
      ))}
      <DockMore items={more} index={items.length} tabbable={roving.active === items.length} onFocusIndex={roving.setCurrent} />
      {hint.node}
    </div>
  );
}

/** Settings and Feedback, the two the topbar keeps. Two buttons are not a
 *  toolbar (the APG asks for three or more), so both stay in the Tab order. */
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
 *  sheet's one narrow breakpoint. */
export const PHONE_QUERY = "(max-width: 640px)";
