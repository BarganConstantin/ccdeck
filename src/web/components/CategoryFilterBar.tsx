// The tool filter: the rows that show and hide tool calls by category, as the
// last group of the canvas bar's ⋯ menu (CanvasControls.tsx).
//
// The filter's state and the categories present on the board are
// use-category-filter-bar's; CanvasControls decides when the group shows
// (toolFilterShown, #783) and this file is only the rows.
//
// CHANGED ON PURPOSE (V4 top-10 #5): this was a "Tools" button floating over
// the canvas's top left — "Tools 1 of 2" while some kinds were hidden — with
// the same rows in a menu under it. A control floating over the cards, for a
// filter most readers never touch; the rows moved into ⋯ unchanged, and the dot
// on ⋯ says what the count said.
//
// Each kind's dot, its name and a checkbox. A hidden kind's dot goes hollow and
// its word steps down a tier, so the state is a tick and a shape, not only a
// colour. The desktop's always-on legend row ("● file ● shell") was a second
// header on the canvas that most readers never pressed; the filter stays one
// menu away and nothing more.
import type { DetailCategory } from "../detail-category";
import { categoryLabel } from "../agent-copy";
import { useT } from "../i18n";
import Checkbox from "./Checkbox";

/** Tool calls: a muted heading over one checkbox per kind of call on the
 *  board, and Show all while any kind is hidden. Each box is a real checkbox
 *  with the menuitemcheckbox role, so the menu's arrows walk it and Space ticks
 *  it; the rows leave the menu open, because they are ticked, not run. */
export default function CategoryFilterBar({ headId, presentCats, hiddenCats, toggleCat }: {
  /** The heading's id, which names the group. */
  headId: string;
  /** The categories with a tool call on the board, in the filter's order. */
  presentCats: readonly DetailCategory[];
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
    <div role="group" aria-labelledby={headId} className="cat-tools-group">
      <div id={headId} className="cat-tools-head">{t("board.detail.toolCalls")}</div>
      {presentCats.map(c => {
        const off = hiddenCats.has(c);
        return (
          <label key={c} className={`ap-menu-item cat-tools-item cat-${c}${off ? " off" : ""}`}>
            {/* Space ticks a checkbox by itself; a menu's Enter does too. */}
            <Checkbox role="menuitemcheckbox" checked={!off} onChange={() => toggleCat(c)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); toggleCat(c); } }} />
            <span className="cat-dot" aria-hidden="true" />
            <span className="cat-name">{categoryLabel(c, t)}</span>
          </label>
        );
      })}
      {/* Show all under a rule, as the old Tools menu drew it. */}
      {hiddenCats.size > 0 && <div role="separator" className="ap-menu-sep" />}
      {hiddenCats.size > 0 && (
        <button
          type="button"
          role="menuitem"
          className="ap-menu-item cat-tools-all"
          onClick={e => {
            // The row goes once nothing is hidden, so focus on it moves to the
            // first checkbox before it does.
            if (document.activeElement === e.currentTarget) {
              e.currentTarget.parentElement?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
            }
            showAll();
          }}
        >
          {t("board.cat.showAll")}
        </button>
      )}
    </div>
  );
}
