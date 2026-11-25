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
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type WheelEvent } from "react";
import { useT } from "../../i18n";
import { tabStripManualMove, type TabStripKey } from "../../tablist-keys";
import AnchoredPopover from "../AnchoredPopover";
import { KitIcon } from "../kit-icons";
import type { StageStatus } from "./stage-model";
import { StageGlyph, type StageGlyphKind } from "./stage-icons";

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
  /** A tab closed: from the strip by Delete (`keys`), or a middle press. */
  onClose(key: string, how: { keys: boolean }): void;
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
      {over && <TabsMenu view={view} words={words} />}
    </>
  );
}

/** Every tab of the pane in a menu, for a strip that holds more than it shows. */
function TabsMenu({ view, words }: { view: PaneTabsView; words(status: StageStatus): PaneTabWords }) {
  const t = useT();
  const id = `ts-tabs-${useId()}`;
  const menuId = `${id}-menu`;
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const label = t("board.stage.tabs.all", { count: view.items.length });
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
        <AnchoredPopover anchorId={id} id={menuId} className="ap-pop dock-more-pop" role="menu" labelledBy={id} start={menu} onClose={() => setMenu(null)}>
          {view.items.map(x => {
            const w = words(x.status);
            const glyph = x.mark ?? w.glyph;
            return (
              <button key={x.key} type="button" role="menuitemradio" aria-checked={x.on} className="ap-menu-item ts-tabs-item"
                onClick={() => {
                  setMenu(null);
                  view.onSelect(x.key, { keys: true });
                }}>
                {glyph && <StageGlyph kind={glyph} />}
                <span className="wsp-tab-name">{x.name}</span>
                {w.word && <span className="ts-tab-word" data-state={x.status.state}>{w.word}</span>}
              </button>
            );
          })}
        </AnchoredPopover>
      )}
    </>
  );
}
