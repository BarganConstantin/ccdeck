// A column header that sorts its table: the word, the direction it is
// pointing, and the press that changes it. The process list's since #739, and
// the account report's since its rows could be ordered — one header, so the
// two tables sort, sound and point the same way.

export type SortDir = "asc" | "desc";

export interface SortOf<K extends string> {
  key: K;
  dir: SortDir;
}

/** aria-sort's own vocabulary, which also decides the arrow and the active
 *  colour — the state is said once, in the place assistive technology reads.
 *  A table in an order of its own, not a column's, says `none` on every one. */
export function ariaSort<K extends string>(sort: SortOf<K> | null, key: K): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

export function SortHead<K extends string>({ col, label, note, sort, next, onSort, className }: {
  col: K;
  label: string;
  /** What this column means, where the meaning is not the label. It rides on
   *  the header's own tooltip, under the sort action, because a caveat about a
   *  column belongs to the column: it is findable from the thing it is about
   *  rather than from a footnote at the other end of the dialog. */
  note?: string;
  sort: SortOf<K> | null;
  /** What a press on this column makes of the sort, by the table's own rule. */
  next: (current: SortOf<K> | null, col: K) => SortOf<K>;
  onSort: (next: SortOf<K>) => void;
  /** The cell's own class, for a column that is laid out differently. */
  className?: string;
}) {
  const state = ariaSort(sort, col);
  return (
    <th scope="col" aria-sort={state} className={className}>
      <button
        type="button"
        className="sd-sort"
        title={note ? `Sort by ${label}\n\n${note}` : `Sort by ${label}`}
        onClick={() => onSort(next(sort, col))}
      >
        {label}
        {/* aria-sort has already said this to a screen reader, so the glyph is
            for the eye alone. Its slot is held open on every column, sorted or
            not, so that re-sorting moves the rows and never the headers. */}
        <span className="sd-sort-dir" aria-hidden>
          {state === "none" ? "" : state === "ascending" ? "↑" : "↓"}
        </span>
      </button>
    </th>
  );
}
