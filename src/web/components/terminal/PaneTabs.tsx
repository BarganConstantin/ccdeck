// A Workspace pane's tabs, in its header (workspace-split.ts, StageShell.tsx).
//
// ONLY WITH TWO OR MORE. A pane holding one session draws the header it always
// drew: the session's name. Once it holds a second, the name's place is the
// strip: each tab the session's state glyph (the rail row's) and its name, the
// one on show filled, and a state word only where the header would say one
// ("waiting 6m"). The rest of the row, the context chip and the controls, are
// the tab on show's. No new row: the strip is the header.
//
// A TAB STRIP BY THE CONTRACT (tablist-keys.ts). One stop in the tab order,
// Left and Right walk the tabs and show each as they go, Home and End are the
// ends; Enter or a press puts the keyboard in the tab's terminal. Delete closes
// the tab under the keyboard, a middle press the one under the pointer. Closing
// stops nothing: the session runs on, and stays in the list.
//
// ONE TERMINAL A PANE. Every tab shows the pane's one stage, which attaches
// the chosen tab's session in place (StageShell.tsx): a tab not on show holds
// no connection, and its session runs on in tmux.
//
// NARROW. The strip scrolls sideways (a wheel scrolls it too), and once it
// holds more than it shows, a chevron after it lists every tab in a menu, so no
// tab is out of reach at 641 wide.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { useT } from "../../i18n";
import { tabStripMove, type TabStripKey } from "../../tablist-keys";
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
  /** On show in its pane. */
  on: boolean;
  /** The id of the pane's stage, the panel every tab of the pane shows. */
  panel?: string;
}

/** The strip, as a pane's header is handed it. */
export interface PaneTabsView {
  items: PaneTabItem[];
  /** A tab chosen: by the keys along the strip (`keys` false, the keyboard
   *  stays on the strip), or by a press or Enter (the keyboard goes into its
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

/** What a key on tab `at` of the strip asks: Delete closes that tab, the
 *  arrows, Home and End choose another (tablist-keys.ts); anything else is
 *  not the strip's. */
export function stripKey(e: TabStripKey, at: number, items: readonly Pick<PaneTabItem, "key">[]): { kind: "close" | "select"; key: string } | null {
  if (at < 0 || at >= items.length) return null;
  if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: "close", key: items[at]!.key };
  const move = tabStripMove(e, at, items.length);
  return move.kind === "select" ? { kind: "select", key: items[move.index]!.key } : null;
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
  const count = view.items.length;
  const onKey = view.items.find(x => x.on)?.key ?? null;
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

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).closest?.("[role=tab]");
    if (!tab) return;
    const ask = stripKey(e, view.items.findIndex(x => x.id === tab.id), view.items);
    if (!ask) return;
    // The deck's own Delete (the selected card's) and arrows stay out of it.
    e.preventDefault();
    e.stopPropagation();
    if (ask.kind === "close") view.onClose(ask.key, { keys: true });
    else view.onSelect(ask.key, { keys: false });
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
      <div ref={listRef} className="ts-tabs" role="tablist" aria-label={t("board.stage.tabs.label")} onKeyDown={keyDown} onWheel={wheel}>
        {view.items.map(x => {
          const w = words(x.status);
          return (
            <button
              key={x.key}
              type="button"
              role="tab"
              id={x.id}
              className="wsp-tab ts-tab"
              aria-selected={x.on}
              aria-controls={x.panel}
              tabIndex={x.on ? 0 : -1}
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
              {w.glyph && <StageGlyph kind={w.glyph} />}
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
            return (
              <button key={x.key} type="button" role="menuitemradio" aria-checked={x.on} className="ap-menu-item ts-tabs-item"
                onClick={() => {
                  setMenu(null);
                  view.onSelect(x.key, { keys: true });
                }}>
                {w.glyph && <StageGlyph kind={w.glyph} />}
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
