// The legend over the canvas that shows and hides tool calls by category.
//
// Moved out of App.tsx's markup unchanged. The filter's state, the categories
// present on the board and whether the bar is covered are
// use-category-filter-bar's; App.tsx decides when the bar shows (#783) and this
// file is only the legend.
//
// A legend, not a row of pills: a dot and a word per category, straight on the
// canvas with no box around them, so six of them read as a key to the board's
// colours rather than six controls all shouting "selected". Each one is still
// the same toggle it was. A hidden category's dot goes hollow and its word
// steps down a tier: the dot's shape carries the state, not only its colour.
// "Show all" turns up while anything is hidden. Under 600px wide the legend
// folds into one "Tools 4 of 6" button with the same toggles in a menu of
// checkboxes, so the row never runs off a phone.
import { useId, useState, type MutableRefObject } from "react";
import type { DetailCategory } from "../detail-category";
import { categoryLabel } from "../agent-copy";
import { useT } from "../i18n";
import { useMediaQuery } from "../use-media-query";
import AnchoredPopover from "./AnchoredPopover";
import Checkbox from "./Checkbox";
import { KitIcon } from "./kit-icons";

/** Where the legend folds into its one button. */
export const LEGEND_FOLD_QUERY = "(max-width: 599px)";

export default function CategoryFilterBar({ catBarRef, catBarOccluded, presentCats, hiddenCats, toggleCat }: {
  catBarRef: MutableRefObject<HTMLDivElement | null>;
  /** Whether something on the canvas covers the bar, which dims it. */
  catBarOccluded: boolean;
  /** The categories with a tool call on the board, in the bar's order. */
  presentCats: DetailCategory[];
  hiddenCats: ReadonlySet<DetailCategory>;
  toggleCat: (c: DetailCategory) => void;
}) {
  const t = useT();
  const folded = useMediaQuery(LEGEND_FOLD_QUERY);
  // Every muted category, the ones not on the board right now as well: a
  // filter kept for a category that left is still a filter (#783), and this
  // is the one press that takes all of them back. Through the same toggle a
  // single item uses, so the hook keeps the only way its set changes.
  const showAll = () => { for (const c of hiddenCats) toggleCat(c); };
  return (
    /* role="group", not role="toolbar". A toolbar is a promise about
       keyboard behaviour — one tab stop for the whole set, arrow keys
       between the members — and this bar implements none of it: every
       item is its own tab stop, which is the right shape for a handful
       of independent filters and the wrong shape to call a toolbar.
       Claiming the role told a screen reader to expect arrow keys that
       do nothing, which is a worse answer than not claiming it. group
       keeps the thing the role was actually being used for: the set is
       named, so the items are heard as one control and not seven. */
    <div
      ref={catBarRef}
      className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
      role="group"
      aria-label={t("board.cat.filter")}
    >
      {folded
        ? <ToolsMenu presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={toggleCat} showAll={showAll} />
        : <>
            {presentCats.map(c => {
              const off = hiddenCats.has(c);
              return (
                /* aria-pressed, because an item really is a toggle: it does
                   not reveal anything, it turns a filter on and off. Pressed
                   means the category is showing, which is the state the
                   item's own name and dot describe — the label is "edit",
                   not "hide edit", so pressed has to mean "edit is on". */
                <button
                  key={c}
                  type="button"
                  className={`cat-filter cat-${c}${off ? " off" : ""}`}
                  onClick={() => toggleCat(c)}
                  aria-pressed={!off}
                  title={t(off ? "board.cat.show" : "board.cat.hide", { cat: categoryLabel(c, t) })}
                >
                  <span className="cat-dot" aria-hidden="true" />
                  <span className="cat-name">{categoryLabel(c, t)}</span>
                </button>
              );
            })}
            {hiddenCats.size > 0 && (
              <>
                {presentCats.length > 0 && <span className="cat-filter-sep" aria-hidden="true" />}
                <button
                  type="button"
                  className="cat-filter-all"
                  onClick={e => {
                    // The button goes once nothing is hidden. Focus that was
                    // on it moves to the first item first, so a keyboard
                    // reader is not dropped to the page, where the next
                    // letter is a canvas shortcut.
                    if (document.activeElement === e.currentTarget) {
                      catBarRef.current?.querySelector<HTMLButtonElement>(".cat-filter")?.focus({ preventScroll: true });
                    }
                    showAll();
                  }}
                >
                  {t("board.cat.showAll")}
                </button>
              </>
            )}
          </>}
    </div>
  );
}

/** The folded legend: one button that says how many categories show, and the
 *  same toggles as checkboxes in a menu under it. A dialog-role popover, as the
 *  Radar's filters are, because its rows are checkboxes a reader ticks and
 *  leaves open, not commands that close it. */
function ToolsMenu({ presentCats, hiddenCats, toggleCat, showAll }: {
  presentCats: DetailCategory[];
  hiddenCats: ReadonlySet<DetailCategory>;
  toggleCat: (c: DetailCategory) => void;
  showAll: () => void;
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = `${id}-tools`;
  const menu = `${id}-tools-menu`;
  const total = presentCats.length;
  const shown = presentCats.filter(c => !hiddenCats.has(c)).length;
  return (
    <>
      <button
        id={trigger}
        type="button"
        className="cat-filter-tools"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menu : undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {t("board.cat.tools")}{" "}
        <span className="cat-tools-count">{t("board.cat.count", { shown, total })}</span>
        <KitIcon name="chevron-down" />
      </button>
      {open && (
        <AnchoredPopover anchorId={trigger} id={menu} className="ap-pop" role="dialog"
          labelledBy={trigger} align="start" onClose={() => setOpen(false)}>
          {presentCats.map(c => {
            const off = hiddenCats.has(c);
            return (
              <label key={c} className={`ap-menu-item cat-tools-item cat-${c}${off ? " off" : ""}`}>
                <Checkbox checked={!off} onChange={() => toggleCat(c)} />
                <span className="cat-dot" aria-hidden="true" />
                <span className="cat-name">{categoryLabel(c, t)}</span>
              </label>
            );
          })}
          {hiddenCats.size > 0 && (
            <>
              {total > 0 && <div className="ap-menu-sep" aria-hidden="true" />}
              <button
                type="button"
                className="ap-menu-item cat-tools-all"
                onClick={e => {
                  // As on the legend: the row goes once nothing is hidden, so
                  // focus on it moves to the first checkbox before it does.
                  if (document.activeElement === e.currentTarget) {
                    e.currentTarget.parentElement?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
                  }
                  showAll();
                }}
              >
                {t("board.cat.showAll")}
              </button>
            </>
          )}
        </AnchoredPopover>
      )}
    </>
  );
}
