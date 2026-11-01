// The chips over the canvas that show and hide tool calls by category.
//
// Moved out of App.tsx's markup unchanged. The filter's state, the categories
// present on the board and whether the bar is covered are
// use-category-filter-bar's; App.tsx decides when the bar shows (#783) and this
// file is only the chips.
import type { MutableRefObject } from "react";
import { CatGlyph, type DetailCategory } from "../detail-category";
import { categoryLabel } from "../agent-copy";
import { useT } from "../i18n";

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
  return (
    /* role="group", not role="toolbar". A toolbar is a promise about
       keyboard behaviour — one tab stop for the whole set, arrow keys
       between the members — and this bar implements none of it: every
       chip is its own tab stop, which is the right shape for a handful
       of independent filters and the wrong shape to call a toolbar.
       Claiming the role told a screen reader to expect arrow keys that
       do nothing, which is a worse answer than not claiming it. group
       keeps the thing the role was actually being used for: the set is
       named, so the chips are heard as one control and not seven. */
    <div
      ref={catBarRef}
      className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
      role="group"
      aria-label={t("board.cat.filter")}
    >
      {presentCats.map(c => {
        const off = hiddenCats.has(c);
        return (
          /* aria-pressed, because a chip really is a toggle: it does not
             reveal anything, it turns a filter on and off. Pressed means
             the category is showing, which is the state the chip's own
             name and emoji describe — the label is "edit", not "hide
             edit", so pressed has to mean "edit is on". */
          <button
            key={c}
            type="button"
            className={`cat-filter${off ? " off" : ""}`}
            onClick={() => toggleCat(c)}
            aria-pressed={!off}
            title={t(off ? "board.cat.show" : "board.cat.hide", { cat: categoryLabel(c, t) })}
          >
            <CatGlyph cat={c} />
            <span className="cat-name">{categoryLabel(c, t)}</span>
          </button>
        );
      })}
    </div>
  );
}
