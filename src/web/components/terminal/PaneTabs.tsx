// A Workspace pane's tabs, in its header (workspace-split.ts, StageShell.tsx).
//
// ONLY WITH TWO OR MORE. A pane holding one session draws the header it always
// drew: the session's name. Once it holds a second, the name's place is the
// strip: each tab the mark its session's row wears in the Sessions list (Done's
// tick for a turn that ended, as the list says it) and its name, the one on
// show filled, and a state word only where the header would say one ("waiting
// 6m"). The rest of the row, the context chip and the controls, are
// the tab on show's. No new row: the strip is the header.
//
// A TAB STRIP BY THE CONTRACT (tablist-keys.ts), WITH MANUAL ACTIVATION. One
// stop in the tab order; Left and Right walk the focus along the tabs, and the
// stop with it, Home and End are the ends, and the tab on show stays on show:
// showing a tab attaches its terminal, which costs a moment and a connection,
// so the strip does not attach every tab it passes. Space shows the tab under
// the keyboard and leaves the keyboard on the strip; Enter or a press shows it
// and puts the keyboard in its terminal. Delete closes the tab under the
// keyboard, a middle press the one under the pointer. Closing stops nothing:
// the session runs on, and stays in the list.
//
// ONE TERMINAL A PANE. Every tab shows the pane's one stage, which attaches
// the chosen tab's session in place (StageShell.tsx): a tab not on show holds
// no connection, and its session runs on in tmux.
//
// NARROW. The strip scrolls sideways (a wheel scrolls it too), and once it
// holds more than it shows, a chevron after it lists every tab in a menu, so no
// tab is out of reach at 641 wide.
//
// THE MENU CLOSES TABS TOO. Each row shows its tab, and the × after it closes
// that tab without showing it first, through the strip's own close (onClose):
// the same lifecycle as Delete on a tab or the header's ✕. Row and × are two
// items side by side, never one inside the other. Up and Down walk the rows,
// Right goes on to the row's ×, Left comes back, and a bare Delete on either
// closes the row's tab. The keyboard then lands on the next row (the one
// before, from the last), and the menu stays open, with its chevron, for the
// next close, even once the strip has room for every tab; shut then, the
// chevron goes and the keyboard it was handed lands on the strip.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type WheelEvent } from "react";
import { useT } from "../../i18n";
import { menuMove } from "../../menu-keys";
import { isBrowserChord } from "../../shortcuts";
import { tabStripManualMove, type TabStripKey } from "../../tablist-keys";
import AnchoredPopover from "../AnchoredPopover";
import { KitIcon } from "../kit-icons";
import type { StageStatus } from "./stage-model";
import { CloseGlyph, StageGlyph, type StageGlyphKind } from "./stage-icons";

/** One tab of the strip. */
export interface PaneTabItem {
  /** The tab's lasting key (workspace-split.ts tabKey). */
  key: string;
  /** Its element's id. */
  id: string;
  /** The session's name, as the rail and the board name it. */
  name: string;
  status: StageStatus;
  /** The mark its row wears in the Sessions list (SessionList.tsx
   *  rowGlyphOf), for a session the board knows; else the header's. */
  mark?: StageGlyphKind;
  /** On show in its pane. */
  on: boolean;
  /** The id of the pane's stage, the panel every tab of the pane shows. */
  panel?: string;
}

/** The strip, as a pane's header is handed it. */
export interface PaneTabsView {
  items: PaneTabItem[];
  /** A tab shown: by Space on the strip (`keys` false, the keyboard stays on
   *  the strip), or by a press or Enter (the keyboard goes into its
   *  terminal). */
  onSelect(key: string, how: { keys: boolean }): void;
  /** A tab closed: from the strip by Delete (`keys`), a middle press, or its
   *  row's × or Delete in the strip's menu (`keys` and `menu`: the menu keeps
   *  the keyboard, on its next row, and no terminal takes it). */
  onClose(key: string, how: { keys: boolean; menu?: boolean }): void;
}

/** A tab as the header draws it: its glyph, and the words StageHeader has
 *  for its state. */
export interface PaneTabWords {
  glyph: StageGlyphKind | null;
  /** "waiting 6m", or null for a normal state. */
  word: string | null;
  /** The whole sentence, for a screen reader and the tooltip. */
  sentence: string;
}

/** What a key on tab `at` of the strip, the one the keyboard is on, asks:
 *  Delete closes that tab, Space shows it, and the arrows, Home and End move
 *  the keyboard to another (tablist-keys.ts, manual activation); anything
 *  else, Enter among it, is not the strip's. */
export function stripKey(e: TabStripKey, at: number, items: readonly Pick<PaneTabItem, "key">[]): { kind: "close" | "focus" | "show"; key: string } | null {
  if (at < 0 || at >= items.length) return null;
  if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: "close", key: items[at]!.key };
  const move = tabStripManualMove(e, at, items.length);
  if (move.kind === "focus") return { kind: "focus", key: items[move.index]!.key };
  if (move.kind === "activate") return { kind: "show", key: items[move.index]!.key };
  return null;
}

/** The strip's one tab stop: the tab the keyboard moved to while it is on the
 *  strip, else the tab on show. */
export function stripStop(items: readonly Pick<PaneTabItem, "key" | "on">[], focused: string | null): string | null {
  if (focused && items.some(x => x.key === focused)) return focused;
  return items.find(x => x.on)?.key ?? items[0]?.key ?? null;
}

/** What a key asks on row `at` of the strip's menu, on the row itself or on
 *  its × (`on`): close that row's tab (a bare Delete on either), or move the
 *  keyboard to a row or to a row's ×. Up, Down, Home and End on a row are the
 *  menu's own (AnchoredPopover walks the rows); from a × they walk the rows
 *  as from its row. Enter and Space are the item's own press. */
export function menuRowKey(e: TabStripKey, at: number, count: number, on: "row" | "x"): { kind: "close" | "row" | "x"; index: number } | null {
  if (at < 0 || at >= count || isBrowserChord(e)) return null;
  if (e.key === "Delete") return { kind: "close", index: at };
  if (on === "row") return e.key === "ArrowRight" ? { kind: "x", index: at } : null;
  if (e.key === "ArrowLeft") return { kind: "row", index: at };
  const move = menuMove(e, at, count);
  return move.kind === "focus" ? { kind: "row", index: move.index } : null;
}

/** The row the keyboard lands on once tab `key` is closed from the menu: the
 *  next one, else the one before. None once one tab is left: the strip goes
 *  then, its menu with it, and the pane takes the keys, as after Delete on the
 *  strip (StageShell.tsx). */
export function menuLanding(items: readonly Pick<PaneTabItem, "key">[], key: string): string | null {
  const at = items.findIndex(x => x.key === key);
  if (at < 0 || items.length - 1 < 2) return null;
  return (items[at + 1] ?? items[at - 1])!.key;
}

export default function PaneTabs({ view, words, onRename }: {
  view: PaneTabsView;
  words(status: StageStatus): PaneTabWords;
  /** A double press on the tab on show names its session. */
  onRename?: () => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  // The tab the keyboard is on, while it is on the strip: the strip's one tab
  // stop. Back to the tab on show once the keyboard leaves the strip.
  const [focused, setFocused] = useState<string | null>(null);
  // The menu, open at its first row or its last; open, it keeps its chevron.
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const count = view.items.length;
  const onKey = view.items.find(x => x.on)?.key ?? null;
  const stop = stripStop(view.items, focused);
  // Whether the strip holds more than it shows: the menu is drawn only then.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setOver(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [count]);
  // The tab on show is scrolled into the strip's view, and again once the
  // menu's chevron takes its room at the strip's end.
  useEffect(() => {
    const el = onKey ? listRef.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]") : null;
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [onKey, over]);

  const tabOf = (target: EventTarget | null) => {
    const tab = (target as HTMLElement | null)?.closest?.("[role=tab]");
    return tab ? view.items.find(x => x.id === tab.id) ?? null : null;
  };
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = tabOf(e.target);
    if (!tab) return;
    const ask = stripKey(e, view.items.indexOf(tab), view.items);
    if (!ask) return;
    // The deck's own Delete (the selected card's) and arrows stay out of it,
    // and Space neither scrolls nor presses the tab (keyUp).
    e.preventDefault();
    e.stopPropagation();
    if (ask.kind === "close") view.onClose(ask.key, { keys: true });
    else if (ask.kind === "show") view.onSelect(ask.key, { keys: false });
    else {
      const to = view.items.find(x => x.key === ask.key);
      const el = to ? document.getElementById(to.id) : null;
      setFocused(ask.key);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  };
  // A button presses itself on Space's release: the tab was shown on the
  // press already (keyDown), and a second show would put the keys in the
  // terminal.
  const keyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " && tabOf(e.target)) e.preventDefault();
  };
  // Whichever way the keyboard came to a tab, that tab is the strip's stop;
  // once it leaves the strip, the stop is the tab on show again.
  const focusIn = (e: FocusEvent<HTMLDivElement>) => {
    const tab = tabOf(e.target);
    if (tab) setFocused(tab.key);
  };
  const focusOut = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
  };
  // A wheel turned over the strip scrolls it sideways: the header has nothing
  // to scroll up or down.
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
  };

  return (
    <>
      <div ref={listRef} className="ts-tabs" role="tablist" aria-label={t("board.stage.tabs.label")} onKeyDown={keyDown} onKeyUp={keyUp} onFocus={focusIn} onBlur={focusOut} onWheel={wheel}>
        {view.items.map(x => {
          const w = words(x.status);
          const glyph = x.mark ?? w.glyph;
          return (
            <button
              key={x.key}
              type="button"
              role="tab"
              id={x.id}
              className="wsp-tab ts-tab"
              aria-selected={x.on}
              aria-controls={x.panel}
              tabIndex={x.key === stop ? 0 : -1}
              data-on={x.on || undefined}
              title={w.word ? `${x.name} · ${w.sentence}` : x.name}
              onClick={() => view.onSelect(x.key, { keys: true })}
              // A middle press closes the tab, and is never the browser's
              // scroll-by-dragging that a middle press starts elsewhere.
              onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={e => {
                if (e.button !== 1) return;
                e.preventDefault();
                view.onClose(x.key, { keys: false });
              }}
              onDoubleClick={x.on ? onRename : undefined}
            >
              {glyph && <StageGlyph kind={glyph} />}
              <span className="wsp-tab-name">{x.name}</span>
              {w.word && <span className="ts-tab-word" data-state={x.status.state} aria-hidden="true">{w.word}</span>}
              {w.sentence && <span className="vis-hidden">{` · ${w.sentence}`}</span>}
            </button>
          );
        })}
      </div>
      {(over || menu) && (
        <TabsMenu view={view} words={words} menu={menu} setMenu={setMenu} over={over}
          toStrip={() => { const to = view.items.find(x => x.key === stop); if (to) document.getElementById(to.id)?.focus(); }} />
      )}
    </>
  );
}

/** Every tab of the pane in a menu, for a strip that holds more than it shows:
 *  each row shows its tab, the × after it closes it. */
export function TabsMenu({ view, words, menu, setMenu, over, toStrip }: {
  view: PaneTabsView;
  words(status: StageStatus): PaneTabWords;
  menu: "first" | "last" | null;
  setMenu(menu: "first" | "last" | null): void;
  /** The strip holds more than it shows: the chevron stays once the menu shuts. */
  over: boolean;
  /** The keyboard to the strip, for a chevron that goes as the menu shuts. */
  toStrip(): void;
}) {
  const t = useT();
  const id = `ts-tabs-${useId()}`;
  const menuId = `${id}-menu`;
  const open = menu !== null;
  const label = t("board.stage.tabs.all", { count: view.items.length });
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const xs = useRef(new Map<string, HTMLButtonElement>());
  // The row the keyboard goes to once a close is drawn: the × that was
  // pressed has gone with its row.
  const land = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = land.current;
    if (key == null) return;
    land.current = null;
    rows.current.get(key)?.focus();
  });
  const close = (key: string) => {
    land.current = menuLanding(view.items, key);
    view.onClose(key, { keys: true, menu: true });
  };
  const rowKey = (e: KeyboardEvent<HTMLButtonElement>, at: number, on: "row" | "x") => {
    const ask = menuRowKey(e, at, view.items.length, on);
    if (!ask) return;
    // The deck's own Delete (the selected card's) stays out of it.
    e.preventDefault();
    e.stopPropagation();
    const key = view.items[ask.index]!.key;
    if (ask.kind === "close") close(key);
    else (ask.kind === "x" ? xs : rows).current.get(key)?.focus();
  };
  // Escape and Tab hand the keyboard to the chevron. Once closes have left
  // the strip room for every tab, the chevron goes as the menu shuts, and the
  // keyboard goes on to the strip.
  const shut = () => {
    setMenu(null);
    if (!over && document.activeElement === document.getElementById(id)) toStrip();
  };
  return (
    <>
      <button
        type="button"
        id={id}
        className="glyph-btn ts-tabs-more"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <KitIcon name="chevron-down" />
      </button>
      {open && (
        <AnchoredPopover anchorId={id} id={menuId} className="ap-pop dock-more-pop" role="menu" labelledBy={id} start={menu} onClose={shut}>
          {view.items.map((x, i) => {
            const w = words(x.status);
            const glyph = x.mark ?? w.glyph;
            const closeName = t("board.stage.tabs.close", { name: x.name });
            return (
              <div key={x.key} role="none" className="ts-tabs-row">
                <button type="button" role="menuitemradio" aria-checked={x.on} aria-posinset={i + 1} aria-setsize={view.items.length}
                  className="ap-menu-item ts-tabs-item"
                  ref={el => { if (el) rows.current.set(x.key, el); else rows.current.delete(x.key); }}
                  onKeyDown={e => rowKey(e, i, "row")}
                  onClick={() => {
                    setMenu(null);
                    view.onSelect(x.key, { keys: true });
                  }}>
                  {glyph && <StageGlyph kind={glyph} />}
                  <span className="wsp-tab-name">{x.name}</span>
                  {w.word && <span className="ts-tab-word" data-state={x.status.state}>{w.word}</span>}
                </button>
                <button type="button" role="menuitem" tabIndex={-1} data-menu-aside="" aria-keyshortcuts="Delete"
                  className="glyph-btn ts-tabs-x" aria-label={closeName} title={closeName}
                  ref={el => { if (el) xs.current.set(x.key, el); else xs.current.delete(x.key); }}
                  onKeyDown={e => rowKey(e, i, "x")}
                  onClick={() => close(x.key)}>
                  <CloseGlyph />
                </button>
              </div>
            );
          })}
        </AnchoredPopover>
      )}
    </>
  );
}
