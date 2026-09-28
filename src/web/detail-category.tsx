// The tool categories the detail panel and the canvas filter chips share, with the
// emoji, glyph and label each one wears — and CatGlyph, the component that draws
// the glyph.
//
// Moved out of App.tsx unchanged, because a second consumer arrived: the filter
// bar's hook needs the same order and the same buckets. The comment below already
// makes the case for one shared table (#417); this finishes it by giving the table
// a module of its own instead of a place inside the component.
import { categoryFor, type ToolCategory } from "./tool-taxonomy";

// Tool categories used both by the detail-panel strip and the canvas filter
// chips. These are the buckets ToolBursts tints its bubbles by, and they used
// to be a second copy of that table living here, "kept in sync manually —
// small enough that a shared module isn't worth it". It was not: when Codex
// renamed its shell tool to `exec` the copy here went on filing it under
// "other" while the canvas coloured it grey, and the two were only ever going
// to drift again (#417). Both now read the one table in tool-taxonomy.ts.
export type DetailCategory = ToolCategory;
export const DETAIL_CAT_EMOJI: Record<DetailCategory, string> = {
  file: "📁", shell: "⚡", web: "🌐", agent: "🤖",
  task: "📋", plan: "🧭", mcp: "🔌", other: "✨",
};
/** The canvas filter bar's glyph for a category: drawn, monochrome, on the
 *  topbar's icon spec (13px on a 14 viewBox, a 1.4 stroke, round caps). The
 *  emoji above stay for the detail rail's activity chips; on the bar they were
 *  eight colours of decoration beside a word that already names the category,
 *  on the one piece of chrome that sits over the canvas. The bubbles and the
 *  nodes carry each category's colour; the bar only has to say which is which. */
const CAT_GLYPH_PATHS: Record<DetailCategory, string> = {
  file: "M3.4 1.8h4.5l2.7 2.7v7.7H3.4z M7.9 1.8v2.7h2.7",
  shell: "M2.4 3.8 5.6 7l-3.2 3.2 M7.4 10.6h4.2",
  web: "M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 1 0 7 1.8z M1.8 7h10.4 M7 1.8c-1.5 1.4-2.3 3.1-2.3 5.2s.8 3.8 2.3 5.2c1.5-1.4 2.3-3.1 2.3-5.2S8.5 3.2 7 1.8z",
  agent: "M3.3 4.8h7.4a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-1.2 1.2H3.3a1.2 1.2 0 0 1-1.2-1.2V6a1.2 1.2 0 0 1 1.2-1.2z M7 4.8V2.4 M5.3 8.2h.01 M8.7 8.2h.01",
  task: "M2.2 4l1.2 1.2 2-2.2 M7.4 4.2h4.4 M2.2 9.4l1.2 1.2 2-2.2 M7.4 9.6h4.4",
  plan: "M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 1 0 7 1.8z M9 5 8 8 5 9l1-3z",
  mcp: "M5 1.8v2.6 M9 1.8v2.6 M3.6 4.4h6.8v2.2a3.4 3.4 0 0 1-6.8 0z M7 10v2.2",
  other: "M3.5 7h.01 M7 7h.01 M10.5 7h.01",
};
export function CatGlyph({ cat }: { cat: DetailCategory }) {
  return (
    <svg className="cat-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={CAT_GLYPH_PATHS[cat]} />
    </svg>
  );
}
/* An identity map on purpose — kept, not overlooked (#383).
 *
 * Every value below spells its own key, which is exactly what the eight
 * TOOL_CATEGORY rows deleted in the same sweep looked like. They are not the
 * same thing. Those rows sat behind a lookup whose default already returned
 * what they returned, so their presence could not change a rendered pixel;
 * this table is the only place a category's visible TEXT is decided — the
 * chip's `cat-name` span, plus the tooltips on the filter button and on the
 * activity strip. And being a `Record<DetailCategory, string>` it is how the
 * compiler asks for a label the day a ninth ToolCategory member arrives.
 *
 * Inlining `{c}` at those three call sites is what deleting it would mean, and
 * that promotes the union's member identifiers to user-facing prose: renaming
 * one would silently rewrite the UI, and the day `mcp` should read "MCP
 * servers" the map has to come back. One line changes here instead.
 *
 * Read with plain bracket access on purpose: unlike the tables #474 fixed, the
 * key is never an outside string — it is a DetailCategory that
 * `detailCategoryFor` produced, and none of the eight names an
 * Object.prototype member. */
export const DETAIL_CAT_LABEL: Record<DetailCategory, string> = {
  file: "file", shell: "shell", web: "web", agent: "agent",
  task: "task", plan: "plan", mcp: "mcp", other: "other",
};
/** The detail panel's name for the shared bucket lookup. Kept as a local alias
 *  purely so the call sites below read the way they always have. */
export const detailCategoryFor = categoryFor;
