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
