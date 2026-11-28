// Claude Code's own breakdown of a session's context window, from its newest
// `/context` (src/server/context-snapshot.mjs reads it off the transcript), as
// the Context tab lays it out: one bar, one row per category, the deferred
// rows apart, and the lists behind them.
//
// Pure, so the suite can pin the arithmetic without a DOM: what the reducer
// keeps, which rows the bar draws and in what order, and what "Since then"
// adds on top of the snapshot.
import type { AgentNodeData, ContextSnapshot } from "./types";

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A snapshot the tab can draw: a window, a used count and a category list.
 *  Anything else off the wire says nothing, as a malformed field does on every
 *  other enrichment. */
export function isContextSnapshot(v: unknown): v is ContextSnapshot {
  return isObject(v)
    && typeof v.used === "number" && Number.isFinite(v.used) && v.used >= 0
    && typeof v.max === "number" && Number.isFinite(v.max) && v.max > 0
    && Array.isArray(v.categories);
}

/** When the snapshot was taken, in ms; an undated one sorts first. */
export function snapshotTime(s: { at?: unknown } | null | undefined): number {
  const at = typeof s?.at === "string" ? Date.parse(s.at) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * What a session keeps after a ContextObserved: `next` is the payload's
 * `snapshot` field. Absent (undefined) says nothing and keeps `prev`; null is
 * the server saying a /clear or /compact dropped it; a snapshot replaces `prev`
 * unless it is older than it. A value that is not a snapshot says nothing.
 */
export function mergeSnapshot(prev: ContextSnapshot | null | undefined, next: unknown): ContextSnapshot | undefined {
  const kept = prev ?? undefined;
  if (next === undefined) return kept;
  if (next === null) return undefined;
  if (!isContextSnapshot(next)) return kept;
  if (kept && snapshotTime(next) < snapshotTime(kept)) return kept;
  return next;
}

/** Which colour a row is drawn in. Three categories carry a hue of their own,
 *  as the reference does; the rest share one quiet one. */
export type SnapTone = "messages" | "memory" | "tools" | "other" | "since" | "buffer" | "free" | "deferred";

export interface SnapRow {
  /** Stable key: the category's slug, or since / buffer / free. */
  id: string;
  /** Claude Code's own name for it, shown when no translation is known; empty
   *  for the two rows the deck names itself (since, free). */
  name: string;
  tokens: number;
  /** Share of the window, or null for a deferred row: it is not in the window. */
  pct: number | null;
  tone: SnapTone;
}

export interface SnapLayout {
  /** The snapshot's used count plus what the session added since. */
  used: number;
  max: number;
  pct: number;
  /** Tokens the session added after /context ran, 0 when none. */
  since: number;
  /** The rows the bar draws, in its order, then free space (the bar's track). */
  rows: SnapRow[];
  /** The deferred categories, listed apart with no share. */
  deferred: SnapRow[];
}

/** "MCP tools (deferred)" → "mcp-tools-deferred": the key a category's
 *  translation is found under. */
export function categorySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The catalog key for each category name Claude Code writes. A name not here
 *  is shown as Claude Code wrote it. */
export const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  "messages": "insights.context.cat.messages",
  "memory-files": "insights.context.cat.memory",
  "system-tools": "insights.context.cat.systemTools",
  "system-tools-deferred": "insights.context.cat.systemToolsDeferred",
  "system-prompt": "insights.context.cat.systemPrompt",
  "skills": "insights.context.cat.skills",
  "custom-agents": "insights.context.cat.agents",
  "mcp-tools": "insights.context.cat.mcpTools",
  "mcp-tools-deferred": "insights.context.cat.mcpToolsDeferred",
  "mcp-server-instructions": "insights.context.cat.mcpInstructions",
  "free-space": "insights.context.cat.free",
  "autocompact-buffer": "insights.context.cat.autocompact",
  "compact-buffer": "insights.context.cat.compact",
};

const TONES: Readonly<Record<string, SnapTone>> = {
  "messages": "messages",
  "memory-files": "memory",
  "system-tools": "tools",
};

/** How little "Since then" has to be to be left out. /context prints its
 *  counts rounded ("113.6k"), so a session that has not moved can read a few
 *  dozen tokens past its own snapshot; a real turn adds far more than this. */
export const SINCE_FLOOR = 1000;

/** What the session holds by the snapshot's count: /context's own figure, plus
 *  what the transcript says the session added since, once that is past
 *  SINCE_FLOOR. The Context tab's bar and the window figure everywhere else
 *  (contextFill) both read it, so they print one number. */
export function snapshotUsed(snap: ContextSnapshot, currentUsed: number): number {
  const grown = Number.isFinite(currentUsed) ? currentUsed - snap.used : 0;
  return snap.used + (grown >= SINCE_FLOOR ? grown : 0);
}

/** The session's /context snapshot, when it has one: only Claude Code has
 *  /context, so another provider's session never shows one. */
export function liveSnapshot(agent: Pick<AgentNodeData, "provider" | "context">): ContextSnapshot | null {
  if ((agent.provider ?? "claude") !== "claude") return null;
  return agent.context?.snapshot ?? null;
}

/** A token count as /context prints it: "850", "3.1k", "86k", "1M", "1.2M".
 *  A decimal only under ten thousand and past a million, and never a trailing
 *  ".0", so "600k" and "10k" read as the window figure above them does. */
export function snapTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const one = (x: number): string => String(Math.round(x * 10) / 10);
  if (v < 1000) return String(v);
  if (v < 9_950) return `${one(v / 1000)}k`;
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  return `${one(v / 1_000_000)}M`;
}

const share = (tokens: number, max: number): number => Math.round((tokens / max) * 1000) / 10;

/**
 * The tab's rows for a snapshot, given the session's current used tokens (the
 * estimate the tab already shows). The bar runs from the biggest category to
 * the smallest, then what was added since, then the compact buffer; free space
 * is what is left, and the deferred rows are kept apart: they are not loaded.
 */
export function snapshotLayout(snap: ContextSnapshot, currentUsed: number): SnapLayout {
  const max = snap.max;
  const used = snapshotUsed(snap, currentUsed);
  const since = used - snap.used;
  const categories = Array.isArray(snap.categories) ? snap.categories : [];
  const row = (c: ContextSnapshot["categories"][number]): SnapRow => {
    const id = categorySlug(c.name);
    return {
      id, name: c.name, tokens: c.tokens,
      pct: c.deferred ? null : (typeof c.pct === "number" ? c.pct : share(c.tokens, max)),
      tone: c.deferred ? "deferred" : (TONES[id] ?? "other"),
    };
  };
  const rows = categories.filter(c => !c.deferred && c.tokens > 0)
    .map(row)
    .sort((a, b) => b.tokens - a.tokens);
  if (since > 0) rows.push({ id: "since", name: "", tokens: since, pct: share(since, max), tone: "since" });
  if (snap.buffer && snap.buffer.tokens > 0) {
    rows.push({ id: "buffer", name: snap.buffer.name, tokens: snap.buffer.tokens, pct: share(snap.buffer.tokens, max), tone: "buffer" });
  }
  const free = Math.max(0, (snap.free ?? 0) - since);
  if (free > 0) rows.push({ id: "free", name: "", tokens: free, pct: share(free, max), tone: "free" });
  const deferred = categories.filter(c => c.deferred && c.tokens > 0).map(row).sort((a, b) => b.tokens - a.tokens);
  return { used, max, pct: Math.min(100, (used / max) * 100), since, rows, deferred };
}

/** One MCP server in the tools list: the tools of it that are loaded, and how
 *  many more are deferred (with what they would cost if all were loaded). */
export interface McpGroup {
  server: string;
  tools: Array<{ name: string; tokens: number }>;
  /** Tokens of the loaded tools. */
  tokens: number;
  deferred: number;
  deferredTokens: number;
}

/** The MCP tools grouped by server, the heaviest server first. */
export function mcpGroups(snap: ContextSnapshot): McpGroup[] {
  const by = new Map<string, McpGroup>();
  const group = (server: string): McpGroup => {
    let g = by.get(server);
    if (!g) { g = { server, tools: [], tokens: 0, deferred: 0, deferredTokens: 0 }; by.set(server, g); }
    return g;
  };
  for (const t of snap.mcpTools ?? []) {
    const g = group(t.server);
    g.tools.push({ name: t.name, tokens: t.tokens });
    g.tokens += t.tokens;
  }
  for (const s of snap.mcpServers ?? []) {
    const g = group(s.server);
    g.deferred += s.tools;
    g.deferredTokens += s.tokens;
  }
  for (const g of by.values()) g.tools.sort((a, b) => b.tokens - a.tokens);
  return [...by.values()].sort((a, b) => (b.tokens - a.tokens) || (b.deferredTokens - a.deferredTokens));
}

/** How many MCP tools the snapshot names, loaded and deferred, counting the
 *  ones its bounded list folded into "and N more". */
export function mcpToolCount(snap: ContextSnapshot): number {
  const deferred = (snap.mcpServers ?? []).reduce((n, s) => n + s.tools, 0);
  return (snap.mcpTools ?? []).length + (snap.more?.mcpTools?.count ?? 0) + deferred;
}

/** How many rows a list has, counting the ones folded into "and N more". */
export function listCount(rows: readonly unknown[] | undefined, more: { count: number } | undefined): number {
  return (rows?.length ?? 0) + (more?.count ?? 0);
}
