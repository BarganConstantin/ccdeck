// Quick open, drawn: a field near the top of the window and the list under it,
// in the manner of Raycast and VS Code (owner, 2026-10-24). What matches and in
// what order is quick-open.ts; what each row opens is quick-open-items.tsx.
//
// Nothing moves (V4's motion rules: Quick open never animates). It opens and
// closes at once. The highlight jumps with the arrows rather than gliding,
// because a list walked a hundred times a day should answer the key, not
// perform for it.
//
// A combobox over a listbox, the pattern screen readers know from every
// launcher: focus stays in the field and aria-activedescendant names the row,
// so typing and moving never fight. The dialog shell is the deck's own
// (use-modal-dismiss.ts): Escape and the scrim close it through the same stack
// every dialog uses, and focus goes back where it came from.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import {
  flatGroupRows, groupQuick, isQuickOpenChord, quickKeyAction, rankQuick, readRecent, rememberRecent,
  type QuickItem, type RankedItem,
} from "../quick-open";
import { useT } from "../i18n";
import { isApplePlatform, platformName } from "../platform";
import { SearchGlyph } from "./rail-glyphs";
import { KitStateGlyph } from "./kit-icons";

/** The groups that hold more than one kind of row, where the kind tag is
 *  drawn. Not the pinned row (Settings): its title and its chord say what it
 *  is, and a word more beside them is clutter; the tag stays in its spoken
 *  text. */
const MIXED_GROUPS: ReadonlySet<string> = new Set(["recent", "open"]);

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const marked = new Set(hits);
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i], hit });
  }
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="qo-hit">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

export default function QuickOpen({ items, onClose, onRun }: {
  items: readonly QuickItem[];
  /** The field was closed. */
  onClose: () => void;
  /** A row was chosen: the caller shuts the field and runs it in one go. */
  onRun: (item: QuickItem) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecent);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);
  // V4's motion rules: Quick open never animates. It opens and closes at once,
  // by key or by pointer, so there is no exit to wait for.
  const leave = finish;
  const dialogRef = useModalDismiss(leave, { focusRef: inputRef });
  const scrimPress = useScrimDismiss(leave);

  // The field names starting a session only where the menu can start one.
  const canStart = useMemo(() => items.some(item => item.section === "start"), [items]);
  const sections = useMemo(() => rankQuick(items, query, recent), [items, query, recent]);
  const groups = useMemo(() => groupQuick(sections, query.trim() !== "", t), [sections, query, t]);
  const rows = useMemo(() => flatGroupRows(groups), [groups]);
  const found = rows.findIndex(row => row.item.id === activeId);
  const active = rows.length ? (found >= 0 ? found : 0) : -1;
  const activeRow: RankedItem | undefined = rows[active];

  // The chord that opened it closes it, wherever focus has wandered inside.
  useEffect(() => {
    const apple = isApplePlatform(platformName());
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isQuickOpenChord(e, apple)) return;
      e.preventDefault();
      e.stopPropagation();
      leave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leave]);

  // The chosen row in view, and its section's caption with it when it is the
  // section's first row, so the list never shows a row without its name.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (active <= 0) { list.scrollTop = 0; return; }
    const row = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!row) return;
    if (row.dataset.first === "true") row.closest('[role="group"]')?.scrollIntoView({ block: "nearest" });
    row.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const run = (row: RankedItem | undefined) => {
    if (!row) return;
    rememberRecent(row.item.id);
    onRun(row.item);
  };
  const move = (to: number) => {
    const row = rows[to];
    if (row) setActiveId(row.item.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const action = quickKeyAction(e, groups, active);
    if (!action) return;
    if (action === "run") run(activeRow);
    else move(action.to);
  };

  // A row follows the pointer only when the pointer moves: a list scrolled by
  // the arrows slides under a still mouse, and that is not a choice.
  const onRowMove = (e: MouseEvent<HTMLDivElement>, id: string) => {
    const at = { x: e.clientX, y: e.clientY };
    const last = pointer.current;
    pointer.current = at;
    if (last && last.x === at.x && last.y === at.y) return;
    if (id !== activeRow?.item.id) setActiveId(id);
  };

  let index = -1;
  return (
    <div className="modal-backdrop qo-backdrop" {...scrimPress} role="presentation">
      <div
        ref={dialogRef}
        className="qo"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("board.quick.title")}
      >
        <div className="qo-field">
          <SearchGlyph />
          <input
            ref={inputRef}
            className="qo-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="qo-list"
            aria-autocomplete="list"
            aria-keyshortcuts="Tab Shift+Tab"
            aria-activedescendant={active >= 0 ? `qo-opt-${active}` : undefined}
            placeholder={t(canStart ? "board.quick.placeholderStart" : "board.quick.placeholder")}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveId(null); }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button type="button" className="qo-esc" onClick={leave} aria-label={t("board.quick.close")}>{t("board.quick.esc")}</button>
        </div>

        {/* Out of the Tab order: Chrome makes a scrolling box a Tab stop of its
            own, and focus belongs in the field, which walks the list. A press
            anywhere in it leaves focus there too, so the next key types. */}
        <div ref={listRef} className="qo-list" id="qo-list" role="listbox" aria-label={t("board.quick.results")} tabIndex={-1}
          onMouseDown={e => e.preventDefault()}>
          {/* The pinned row (Settings) has no caption: one row, named by its
              own title, set apart from the sessions above it by a rule. */}
          {groups.map(group => (
            <div key={group.group} role="group" className={group.title ? undefined : "qo-group-ruled"}
              aria-labelledby={group.title ? `qo-cap-${group.group}` : undefined}>
              {group.title && <div className="qo-caption" id={`qo-cap-${group.group}`} role="presentation">{group.title}</div>}
              {group.items.map((row, n) => {
                index++;
                const i = index;
                const { item } = row;
                return (
                  <div
                    key={item.id}
                    id={`qo-opt-${i}`}
                    className="qo-row"
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    data-first={n === 0 ? "true" : undefined}
                    title={item.hint}
                    onMouseMove={e => onRowMove(e, item.id)}
                    onClick={() => run(row)}
                  >
                    <span className="qo-icon" aria-hidden>
                      {item.tone ? <KitStateGlyph name={item.tone} className="qo-state" kind={item.tone} /> : item.glyph}
                    </span>
                    <span className="qo-text">
                      <span className="qo-title"><Highlighted text={item.title} hits={row.hits} /></span>
                      {item.subtitle && <span className="qo-sub">{item.subtitle}</span>}
                    </span>
                    {/* The kind of row (Panel, Dialog, Session) is its group's
                        name on screen and stays in the row's spoken text,
                        except where a group mixes kinds (Recent, Panels and
                        dialogs): there it is drawn, as a state (Shown,
                        Current) always is. */}
                    <span className={item.tagIsState || MIXED_GROUPS.has(group.group) ? "qo-tag state" : "qo-tag"}>{item.tag}</span>
                    {item.keyCap && <kbd className="qo-key">{item.keyCap}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="qo-empty">
              <p className="qo-empty-title">{t("board.quick.nothing", { query: query.trim() })}</p>
              <p className="qo-empty-note">{t("board.quick.try")}</p>
            </div>
          )}
        </div>

        {/* Tab's jump and what Enter does to the chosen row: the arrows go
            without saying, and the count is said to a screen reader below. */}
        <div className="qo-foot" aria-hidden>
          <span className="qo-foot-act qo-foot-tab"><kbd>{t("board.quick.tabKey")}</kbd> {t("board.quick.tabHint")}</span>
          {activeRow && <span className="qo-foot-act qo-foot-run"><kbd>↵</kbd> <span>{activeRow.item.verb}</span></span>}
        </div>
        <span className="qo-live" role="status">{query.trim() ? t("board.quick.results.count", { count: rows.length }) : ""}</span>
      </div>
    </div>
  );
}
