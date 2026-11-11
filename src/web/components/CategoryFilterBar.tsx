// The tool filter over the canvas: one "Tools" button that shows and hides
// tool calls by category.
//
// The filter's state, the categories present on the board and whether the bar
// is covered are use-category-filter-bar's; App.tsx decides when the bar shows
// (#783) and this file is only the control.
//
// One compact button at every width, as the phone always had it: "Tools" while
// every category shows, "Tools 1 of 2" while some are hidden, and the toggles
// in a menu under it — each category's dot, its name and a checkbox. A hidden
// category's dot goes hollow and its word steps down a tier, so the state is a
// tick and a shape, not only a colour. The desktop's always-on legend row
// ("● file ● shell") was a second header on the canvas that most readers never
// pressed; the button keeps the filters one press away and nothing more.
import { useId, useState, type MutableRefObject } from "react";
import type { DetailCategory } from "../detail-category";
import { categoryLabel } from "../agent-copy";
import { useT } from "../i18n";
import AnchoredPopover from "./AnchoredPopover";
import Checkbox from "./Checkbox";
import { KitIcon } from "./kit-icons";

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
  // Every muted category, the ones not on the board right now as well: a
  // filter kept for a category that left is still a filter (#783), and this
  // is the one press that takes all of them back. Through the same toggle a
  // single item uses, so the hook keeps the only way its set changes.
  const showAll = () => { for (const c of hiddenCats) toggleCat(c); };
  return (
    /* role="group", named, so the button is heard as the board's tool
       filter and not a stray "Tools". */
    <div
      ref={catBarRef}
      className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
      role="group"
      aria-label={t("board.cat.filter")}
    >
      <ToolsMenu presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={toggleCat} showAll={showAll} />
    </div>
  );
}

/** The button that says whether anything is hidden, and the toggles as
 *  checkboxes in a menu under it. A dialog-role popover, as the Radar's
 *  filters are, because its rows are checkboxes a reader ticks and leaves
 *  open, not commands that close it. */
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
        {t("board.cat.tools")}
        {/* The count only while it says something: "2 of 2" was a number to
            read that meant nothing is hidden. */}
        {shown < total && <>{" "}<span className="cat-tools-count">{t("board.cat.count", { shown, total })}</span></>}
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
                  // The row goes once nothing is hidden, so focus on it moves
                  // to the first checkbox before it does.
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
