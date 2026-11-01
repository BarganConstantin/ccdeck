// V4's Inspector (its Figma kit, Inspector / Header and the Agents and Context
// bodies): the detail panel as one --inspector-w column with a tablist over a
// scrolling body. This pins how it LOOKS at sheet level (tokens only, no hex),
// the tablist's roles and keys, the remembered tab, the tree of cards, and the
// two tabs the deck's data can fill. There is no Time tab: the client holds no
// per-turn waiting or thinking time (see components/Inspector.tsx).
import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inspector from "../components/Inspector";
import { agentTree, sessionCostLabel, sessionRoot, subagentCount } from "../inspector-tree";
import { ContextView, contextFill } from "../components/ContextModal";
import {
  INSPECTOR_TABS, INSPECTOR_TAB_KEY, loadInspectorTab, saveInspectorTab,
} from "../inspector-tab";
import { TimeBody } from "../components/InspectorTime";
import {
  TURN_POLL_MS, TURN_RETRY_MS, axisTicks, barBox, parseSessionTurn, readSessionTurn, spanTable, turnPieces, turnSpan, turnStartOf, waitingShare, withPromptWait,
  type SessionTurn,
} from "../inspector-time";
import { tabStripMove } from "../tablist-keys";
import { costChip } from "../card-cost";
import { fmtCost } from "../pricing";
import type { AgentNodeData, ToolCall, WaitingBlock } from "../types";
import { sheetParts, sheetText } from "./sheet-source";
import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet as a flat list of rules in source order, each with the @media
 *  prelude it sits in ("" at the top level). */
function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) { /* not read here */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? prelude.slice(6).trim() : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        const selectors = prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
        rules.push({ media, selectors, decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return rules;
}
const rules = parse(css);

function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const SPENT = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheCreateTokens: 0 };
const A = (id: string, over: Partial<AgentNodeData> = {}) => ({
  id, sessionId: "s", label: id, kind: id === "s" ? "root" : "subagent", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: NO_USAGE, prompts: [], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;
const mapOf = (...agents: AgentNodeData[]) => new Map(agents.map(a => [a.id, a]));

/** A root, two children (the first with a grandchild) and a stranger's session. */
const ROOT = A("s", { model: "claude-sonnet-4-5", usage: SPENT, childCount: 2 });
const TREE = mapOf(
  ROOT,
  A("c2", { parentId: "s", startedAt: 3000 }),
  A("g1", { parentId: "c1", startedAt: 4000 }),
  A("c1", { parentId: "s", startedAt: 2000 }),
  A("other", { sessionId: "t", kind: "root" }),
);

const stub = createElement("div", { id: "detail-stub" });
const html = (selected: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData> = TREE) =>
  renderToStaticMarkup(createElement(Inspector, { selected, agents, onSelectAgent: () => {}, onFold: () => {}, detail: stub }));

function stubStore(initial: Record<string, string> = {}, fails = false) {
  const data = { ...initial };
  vi.stubGlobal("window", {
    get localStorage() {
      if (fails) throw new Error("SecurityError");
      return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
    },
  });
  return data;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Inspector's column", () => {
  it("is --inspector-w wide in the grid, with no literal 360 left in the track", () => {
    expect(decl(".app", "grid-template-columns")).toBe("1fr var(--inspector-w)");
    expect(decl(".app:has(.left-column)", "grid-template-columns")).toBe("auto 1fr var(--inspector-w)");
  });
  it("is a --panel flex column with a --line edge on its left", () => {
    expect(decl(".detail", "background")).toBe("var(--panel)");
    expect(decl(".detail", "border-left")).toBe("1px solid var(--line)");
    expect(decl(".detail", "display")).toBe("flex");
    expect(decl(".detail", "flex-direction")).toBe("column");
  });
  it("keeps the phone's sheet as it was", () => {
    expect(decl(".detail", "width", "(max-width: 640px)")).toBe("min(var(--inspector-w), 100vw)");
    expect(decl(".detail", "position", "(max-width: 640px)")).toBe("fixed");
  });
});

describe("the header", () => {
  it("is --pane-head-h tall, 8 in and 6 out, a --line-soft rule under it, space-between", () => {
    expect(decl(".insp-h", "height")).toBe("var(--pane-head-h)");
    expect(decl(".insp-h", "padding")).toBe("0 6px 0 8px");
    expect(decl(".insp-h", "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(".insp-h", "justify-content")).toBe("space-between");
  });
  it("holds the tabs in a --bg-soft pill: 1px --line-soft, padding 2, gap 2, --r-panel", () => {
    expect(decl(".insp-tabs", "background")).toBe("var(--bg-soft)");
    expect(decl(".insp-tabs", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".insp-tabs", "padding")).toBe("2px");
    expect(decl(".insp-tabs", "gap")).toBe("2px");
    expect(decl(".insp-tabs", "border-radius")).toBe("var(--r-panel)");
  });
  it("draws a tab 20 tall, padding 0 8 0 6, gap 4, --r-ctl, a 14px glyph, the label 12/16 500 --muted", () => {
    expect(decl(".insp-tab", "height")).toBe("20px");
    expect(decl(".insp-tab", "padding")).toBe("0 8px 0 6px");
    expect(decl(".insp-tab", "gap")).toBe("4px");
    expect(decl(".insp-tab", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".insp-tab .glyph", "width")).toBe("14px");
    expect(decl(".insp-tab .glyph", "height")).toBe("14px");
    expect(decl(".insp-tab", "font-size")).toBe(INC(12));
    expect(decl(".insp-tab", "line-height")).toBe("16px");
    expect(decl(".insp-tab", "font-weight")).toBe("500");
    expect(decl(".insp-tab", "color")).toBe("var(--muted)");
    expect(decl(".insp-tab", "background")).toBe("transparent");
  });
  it("marks the chosen tab with a --panel fill, the smallest shadow token and a 600 --text label", () => {
    const sel = '.insp-tab[aria-selected="true"]';
    expect(decl(sel, "background")).toBe("var(--panel)");
    expect(decl(sel, "box-shadow")).toBe("var(--shadow-contact)");
    expect(decl(sel, "font-weight")).toBe("600");
    expect(decl(sel, "color")).toBe("var(--text)");
  });
  it("shows the chosen tab with an outline in forced colours", () => {
    expect(decl('.insp-tab[aria-selected="true"]', "outline", "(forced-colors: active)")).toBe("2px solid Highlight");
  });
  it("ends in Fold, a quiet 24x24 icon button of radius 6", () => {
    expect(decl(".detail .insp-fold", "width")).toBe("24px");
    expect(decl(".detail .insp-fold", "height")).toBe("24px");
    expect(decl(".detail .insp-fold", "border-radius")).toBe("6px");
    expect(decl(".detail .insp-fold", "background")).toBe("transparent");
  });
});

describe("the body and its head row", () => {
  it("is padded 8 12 12 with a gap of 8, and scrolls instead of clipping", () => {
    expect(decl(".insp-b", "padding")).toBe("8px 12px 12px");
    expect(decl(".insp-b", "gap")).toBe("8px");
    expect(decl(".insp-b", "overflow-y")).toBe("auto");
    expect(decl(".detail", "overflow")).toBe("hidden");
  });
  it("starts each tab with a baseline row of gap 6: the title 600 --text, the qualifier --muted, a spacer, a mono figure", () => {
    expect(decl(".insp-head", "align-items")).toBe("baseline");
    expect(decl(".insp-head", "gap")).toBe("6px");
    expect(decl(".insp-head", "font-size")).toBe(INC(13));
    expect(decl(".insp-head", "line-height")).toBe("20px");
    expect(decl(".insp-title", "font-weight")).toBe("600");
    expect(decl(".insp-title", "color")).toBe("var(--text)");
    expect(decl(".insp-qual", "color")).toBe("var(--muted)");
    expect(decl(".insp-spacer", "flex")).toBe("1");
    expect(decl(".insp-fig", "font-family")).toBe("var(--font-mono)");
    expect(decl(".insp-fig", "font-size")).toBe(INC(12));
    expect(decl(".insp-fig", "font-weight")).toBe("500");
    expect(decl(".insp-fig", "color")).toBe("var(--muted)");
  });
  it("sets the note 12/16 in --muted", () => {
    expect(decl(".insp-note", "font-size")).toBe(INC(12));
    expect(decl(".insp-note", "line-height")).toBe("16px");
    expect(decl(".insp-note", "color")).toBe("var(--muted)");
  });
});

describe("the tablist", () => {
  const out = html(ROOT);
  it("is a real tablist whose tabs are selected, controlling a tabpanel and in a roving tab order", () => {
    expect(out).toContain('role="tablist"');
    const tabs = [...out.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
    // CHANGED ON PURPOSE: three tabs now (Agents, Time, Context; V4's Figma), so the
    // Context tab is the third one and the Time tab sits between.
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[0]).toContain('aria-controls="insp-panel-agents"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('aria-controls="insp-panel-time"');
    expect(tabs[1]).toContain('tabindex="-1"');
    expect(tabs[2]).toContain('aria-selected="false"');
    expect(tabs[2]).toContain('aria-controls="insp-panel-context"');
    expect(tabs[2]).toContain('tabindex="-1"');
    expect(out).toMatch(/role="tabpanel"[^>]*id="insp-panel-agents"|id="insp-panel-agents"[^>]*role="tabpanel"/);
  });
  // CHANGED ON PURPOSE: the Time tab is back, redrawn on the session's real turn (V4's Figma).
  it("labels its tabs Agents, Time and Context, in Figma's order, each with a 14px glyph", () => {
    expect(INSPECTOR_TABS).toEqual(["agents", "time", "context"]);
    expect([...out.matchAll(/role="tab"[^>]*>.*?<span>([^<]+)<\/span><\/button>/g)].map(m => m[1])).toEqual(["Agents", "Time", "Context"]);
    expect([...out.matchAll(/role="tab"[^>]*><svg class="glyph"/g)]).toHaveLength(3);
  });
  it("hides the tabpanel that is not chosen", () => {
    expect(out).toMatch(/id="insp-panel-context"[^>]*hidden|hidden[^>]*id="insp-panel-context"/);
    expect(out).not.toMatch(/id="insp-panel-agents"[^>]*hidden=/);
  });
  it("moves with Left and Right (wrapping), Home and End, and ignores every other key", () => {
    // The decision is tablist-keys.ts's, the deck's one rule for a strip; the
    // Inspector asks it with its own three tabs.
    // CHANGED ON PURPOSE: three tabs, so Right from Agents is Time and the strip wraps after Context.
    const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    const to = (at: number, k: string) => tabStripMove(key(k), at, INSPECTOR_TABS.length);
    expect(to(0, "ArrowRight")).toEqual({ kind: "select", index: 1 });
    expect(to(2, "ArrowRight")).toEqual({ kind: "select", index: 0 });
    expect(to(0, "ArrowLeft")).toEqual({ kind: "select", index: 2 });
    expect(to(1, "Home")).toEqual({ kind: "select", index: 0 });
    expect(to(0, "End")).toEqual({ kind: "select", index: 2 });
    expect(to(0, "a")).toEqual({ kind: "pass" });
    expect(to(0, "ArrowDown")).toEqual({ kind: "pass" });
    expect(readFileSync(join(WEB_DIR, "components/Inspector.tsx"), "utf8")).toMatch(/tabStripMove\(e, INSPECTOR_TABS\.indexOf\(tab\)/);
  });
  it("keeps Fold's accessible name from the close it replaces", () => {
    expect(out).toContain('aria-label="Close detail panel"');
    expect(out).toContain('title="Close panel"');
  });
});

describe("the remembered tab", () => {
  it("is Agents when nothing is stored, or something this build does not know", () => {
    stubStore();
    expect(loadInspectorTab()).toBe("agents");
    // CHANGED ON PURPOSE: "time" is a tab now, so the unknown value this pins is another word.
    stubStore({ [INSPECTOR_TAB_KEY]: "treemap" });
    expect(loadInspectorTab()).toBe("agents");
    stubStore({ [INSPECTOR_TAB_KEY]: "time" });
    expect(loadInspectorTab()).toBe("time");
  });
  it("is kept under an agent-dag. key and read back", () => {
    expect(INSPECTOR_TAB_KEY.startsWith("agent-dag.")).toBe(true);
    const data = stubStore();
    saveInspectorTab("context");
    expect(data[INSPECTOR_TAB_KEY]).toBe("context");
    expect(loadInspectorTab()).toBe("context");
  });
  it("opens on the stored tab", () => {
    stubStore({ [INSPECTOR_TAB_KEY]: "context" });
    const out = html(ROOT);
    expect(out).toContain("Context window");
    expect(out).not.toContain("Who started whom");
  });
  it("costs nothing but the memory when the store throws", () => {
    stubStore({}, true);
    expect(loadInspectorTab()).toBe("agents");
    expect(() => saveInspectorTab("context")).not.toThrow();
    expect(html(ROOT)).toContain("Who started whom");
  });
});

describe("the column's width is written once", () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
  const LITERAL = /(?<![\d.-])(?:360|368|320)px/;
  it("no sheet but tokens.css and reading.css writes it as a literal in the rules that size the column, the sheet or --rail-r", () => {
    let checked = 0;
    for (const [path, text] of sheetParts()) {
      if (/\/(?:tokens|reading)\.css$/.test(path)) continue;
      for (const r of parse(strip(text))) {
        const sizesColumn = r.selectors.some(s => /^\.app\b/.test(s)) && "grid-template-columns" in r.decls;
        const sizesSheet = r.selectors.includes(".detail") && ("width" in r.decls || "min-width" in r.decls || "max-width" in r.decls);
        const setsRail = "--rail-r" in r.decls;
        if (!sizesColumn && !sizesSheet && !setsRail) continue;
        checked++;
        for (const p of ["grid-template-columns", "width", "min-width", "max-width", "--rail-r"]) {
          if (p in r.decls) expect(r.decls[p], `${path}: ${r.selectors.join(", ")} { ${p} }`).not.toMatch(LITERAL);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
  it("--rail-r and the narrow band read the token, plus the gap and the stripe for the rail", () => {
    expect(decl(".app", "--rail-r")).toBe("calc(var(--inspector-w) + 8px + var(--edge-w))");
    expect(decl(".app:has(.left-column)", "grid-template-columns", "(max-width: 647px)")).toBe("auto 1fr minmax(0, var(--inspector-w))");
  });
  it("is 360px at Default and 320px at Compact", () => {
    const tokens = strip(sheetParts().find(([p]) => /\/tokens\.css$/.test(p))![1]);
    const reading = strip(sheetParts().find(([p]) => /\/reading\.css$/.test(p))![1]);
    expect(tokens).toMatch(/:root\s*\{[^}]*--inspector-w:\s*360px/);
    expect(reading).toMatch(/data-density="compact"\][^{]*\{[^}]*--inspector-w:\s*320px/);
  });
});

describe("the Agents tab", () => {
  it("reads the tree: the root, then each child oldest first with its own children right after it", () => {
    const rows = agentTree(TREE, "s");
    expect(rows.map(r => [r.agent.id, r.depth])).toEqual([["s", 0], ["c1", 1], ["g1", 2], ["c2", 1]]);
  });
  it("leaves other sessions out, and hangs an agent whose parent is gone off the root", () => {
    expect(agentTree(TREE, "s").map(r => r.agent.id)).not.toContain("other");
    const orphan = mapOf(ROOT, A("lost", { parentId: "gone" }));
    expect(agentTree(orphan, "s").map(r => [r.agent.id, r.depth])).toEqual([["s", 0], ["lost", 1]]);
  });
  it("hangs a loop of two off the root, each agent once", () => {
    const rows = agentTree(mapOf(ROOT, A("x", { parentId: "y", startedAt: 2000 }), A("y", { parentId: "x", startedAt: 3000 })), "s");
    expect(rows.map(r => [r.agent.id, r.depth])).toEqual([["s", 0], ["x", 1], ["y", 1]]);
    expect(subagentCount(rows)).toBe("2 subagents");
  });
  it("hangs a loop of three off the root, each agent once", () => {
    const rows = agentTree(mapOf(ROOT, A("x", { parentId: "z", startedAt: 2000 }), A("y", { parentId: "x", startedAt: 3000 }), A("z", { parentId: "y", startedAt: 4000 })), "s");
    expect(rows.map(r => r.agent.id)).toEqual(["s", "x", "y", "z"]);
    expect(subagentCount(rows)).toBe("3 subagents");
  });
  it("hangs a loop off the root beside a real child, with what hangs below the loop", () => {
    const rows = agentTree(mapOf(
      ROOT, A("c1", { parentId: "s", startedAt: 2000 }), A("g1", { parentId: "c1", startedAt: 2500 }),
      A("x", { parentId: "y", startedAt: 3000 }), A("y", { parentId: "x", startedAt: 4000 }), A("below", { parentId: "x", startedAt: 5000 }),
    ), "s");
    const ids = rows.map(r => r.agent.id);
    expect(ids.slice().sort()).toEqual(["below", "c1", "g1", "s", "x", "y"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find(r => r.agent.id === "g1")!.depth).toBe(2);
    expect(subagentCount(rows)).toBe("5 subagents");
  });
  it("hangs a self-parent off the root", () => {
    const rows = agentTree(mapOf(ROOT, A("me", { parentId: "me" })), "s");
    expect(rows.map(r => [r.agent.id, r.depth])).toEqual([["s", 0], ["me", 1]]);
  });
  it("names the session's root once, for the tree and the tabs", () => {
    expect(sessionRoot(TREE, "s")).toBe(ROOT);
    expect(sessionRoot(TREE, "nope")).toBeUndefined();
  });
  it("counts every descendant, not only the root's children", () => {
    expect(readFileSync(join(WEB_DIR, "inspector-tree.ts"), "utf8")).toMatch(/at any depth/);
    expect(subagentCount(agentTree(TREE, "s"))).toBe("3 subagents");
  });
  it("draws each agent once even when parents loop", () => {
    const loop = mapOf(ROOT, A("x", { parentId: "y" }), A("y", { parentId: "x" }));
    const ids = agentTree(loop, "s").map(r => r.agent.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("marks which tree lines run on to a later sibling", () => {
    const rows = agentTree(TREE, "s");
    expect(rows.map(r => r.more)).toEqual([[], [true], [true, false], [false]]);
  });
  it("says how many subagents, in words", () => {
    expect(subagentCount(agentTree(mapOf(ROOT), "s"))).toBe("no subagents");
    expect(subagentCount(agentTree(mapOf(ROOT, A("c1", { parentId: "s" })), "s"))).toBe("1 subagent");
    expect(subagentCount(agentTree(TREE, "s"))).toBe("3 subagents");
  });
  it("heads the tab with the title, the count and the root's cost as its card prints it", () => {
    const out = html(ROOT);
    const chip = costChip(ROOT);
    expect(chip?.kind).toBe("spent");
    const shown = fmtCost((chip as { total: number }).total);
    expect(sessionCostLabel(ROOT)).toBe(shown);
    expect(out).toContain('<span class="insp-title">Agents</span>');
    expect(out).toContain('<span class="insp-qual">3 subagents</span>');
    expect(out).toContain(`<span class="insp-fig">${shown}</span>`);
  });
  it("prints no figure when the root's card prints no cost", () => {
    expect(html(A("s", { childCount: 0 }), mapOf(A("s")))).not.toContain("insp-fig");
  });
  it("draws one row per agent, with a gutter per level and the tree lines in the right columns", () => {
    const out = html(ROOT);
    const rows = [...out.matchAll(/<li class="insp-row" data-depth="(\d)">(.*?)<div class="insp-card"/g)];
    expect(rows.map(m => m[1])).toEqual(["0", "1", "2", "1"]);
    const lines = rows.map(m => [...m[2].matchAll(/<span class="insp-gut"(?: data-line="(\w+)")?/g)].map(g => g[1] ?? null));
    expect(lines).toEqual([[], ["tee"], ["through", "elbow"], ["elbow"]]);
  });
  it("draws the tree lines 1px in --line, a vertical from 8px above and a 10px stub", () => {
    expect(decl(".insp-gut", "width")).toBe("16px");
    expect(decl(".insp-gut[data-line]::before", "left")).toBe("6px");
    expect(decl(".insp-gut[data-line]::before", "top")).toBe("-8px");
    expect(decl(".insp-gut[data-line]::before", "width")).toBe("1px");
    expect(decl(".insp-gut[data-line]::before", "background")).toBe("var(--line)");
    expect(decl('.insp-gut[data-line="elbow"]::before', "bottom")).toBe("50%");
    expect(decl('.insp-gut[data-line="elbow"]::after', "width")).toBe("10px");
    expect(decl('.insp-gut[data-line="elbow"]::after', "height")).toBe("1px");
    expect(decl('.insp-gut[data-line="elbow"]::after', "background")).toBe("var(--line)");
    expect(decl(".insp-tree", "gap")).toBe("8px");
  });
  it("keeps the tree lines visible in forced colours, in the text colour", () => {
    for (const sel of [".insp-gut[data-line]::before", '.insp-gut[data-line="elbow"]::after', '.insp-gut[data-line="tee"]::after']) {
      expect(decl(sel, "forced-color-adjust", "(forced-colors: active)")).toBe("none");
      expect(decl(sel, "background", "(forced-colors: active)")).toBe("CanvasText");
    }
  });
  it("draws the agent card's own markup, not a copy of it", () => {
    const out = html(ROOT);
    expect([...out.matchAll(/<div class="agent-node /g)]).toHaveLength(4);
    expect(out).toContain('<span class="label"');
    expect(out).toContain('<div class="foot"');
    const source = readFileSync(join(WEB_DIR, "components/Inspector.tsx"), "utf8");
    expect(source).toMatch(/import \{ AgentCard \} from "\.\/AgentNode";/);
    expect(source).toMatch(/<AgentCard data=\{row\.agent\} \/>/);
    // The only rule written for it here sets its width to the row's.
    const own = rules.filter(r => r.selectors.some(s => /^\.insp-card \.agent-node/.test(s)));
    expect(own.flatMap(r => Object.keys(r.decls)).sort()).toEqual(["max-width", "min-width", "width"]);
  });
  it("draws the card without React Flow's handles, which only exist inside a flow", () => {
    expect(html(ROOT)).not.toContain("react-flow__handle");
  });
  it("gives each card one real button for the keyboard, named for the agent, and marks the selected one", () => {
    const out = html(A("c1", { parentId: "s" }));
    const picks = [...out.matchAll(/<button type="button" class="insp-pick"[^>]*>/g)].map(m => m[0]);
    expect(picks).toHaveLength(4);
    expect(picks.filter(p => p.includes('aria-current="true"'))).toHaveLength(1);
    for (const p of picks) expect(p).toMatch(/aria-label="[^"]+"/);
    // No invented tab stop: the stop is a button, not a div with a tabindex.
    expect(out).not.toMatch(/class="insp-card"[^>]*tabindex/);
    const source = readFileSync(join(WEB_DIR, "components/Inspector.tsx"), "utf8");
    expect(source).toMatch(/onClick=\{\(\) => onSelectAgent\(id\)\}/);
    expect(readFileSync(join(WEB_DIR, "App.tsx"), "utf8")).toMatch(/onSelectAgent=\{selectInspected\}/);
    expect(readFileSync(join(WEB_DIR, "App.tsx"), "utf8")).toMatch(/const selectInspected = useCallback\(\(id: string\) => selectAgent\(id, false, false\), \[selectAgent\]\)/);
  });
  it("puts the note under the tree and the detail panel's sections under the note", () => {
    const out = html(ROOT);
    const note = out.indexOf("Who started whom, read from the transcript. Each card shows its own model, cost and time.");
    expect(note).toBeGreaterThan(out.lastIndexOf('class="insp-row"'));
    expect(out.indexOf('id="detail-stub"')).toBeGreaterThan(note);
  });
});

describe("the Context tab", () => {
  const withContext = (extra: Partial<AgentNodeData>) => {
    stubStore({ [INSPECTOR_TAB_KEY]: "context" });
    return html(A("s", { model: "claude-opus-4-5", ...extra }), mapOf(A("s", { model: "claude-opus-4-5", ...extra })));
  };
  it("heads the tab with the window, the model and used / limit · percent", () => {
    const out = withContext({ context: { msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: 50_000, memoryFiles: [] }, contextWindow: 200_000 });
    expect(out).toContain('<span class="insp-title">Context window</span>');
    expect(out).toMatch(/<span class="insp-qual">[^<]*opus[^<]*<\/span>/i);
    // CHANGED ON PURPOSE: V4's Figma says whole k and a whole percent, as the Term header's chip says it.
    expect(out).toContain('<span class="insp-fig">50k / 200k · 25%</span>');
  });
  it("shows the context modal's body", () => {
    const out = withContext({});
    for (const word of ["ctx-window-row", "Cumulative usage", "Transcript composition", "CLAUDE.md files in scope"]) expect(out).toContain(word);
    const modal = readFileSync(join(WEB_DIR, "components/ContextModal.tsx"), "utf8");
    // CHANGED ON PURPOSE: the modal passes `meta`, to keep its percent and count line; the panel does not.
    expect(modal).toMatch(/<ContextView agent=\{agent\} meta \/>/);
    expect(modal).toMatch(/export function ContextView/);
    expect(readFileSync(join(WEB_DIR, "components/Inspector.tsx"), "utf8")).toMatch(/<ContextView agent=\{agent\} \/>/);
  });
  it("is about the selected agent, not the session's root: a subagent's own model and figures head it", () => {
    stubStore({ [INSPECTOR_TAB_KEY]: "context" });
    const ctx = (tokens: number) => ({ msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: tokens, memoryFiles: [] });
    const root = A("s", { model: "claude-opus-4-5", contextWindow: 200_000, context: ctx(150_000) });
    const child = A("c1", { parentId: "s", model: "claude-haiku-4-5", contextWindow: 100_000, context: ctx(10_000) });
    const out = html(child, mapOf(root, child));
    expect(out).toMatch(/<span class="insp-qual">[^<]*haiku[^<]*<\/span>/i);
    // CHANGED ON PURPOSE: V4's Figma form (was "10.0k / 100.0k · 10.0%").
    expect(out).toContain('<span class="insp-fig">10k / 100k · 10%</span>');
    expect(out).not.toMatch(/opus/i);
  });
  // CHANGED ON PURPOSE: the panel's meter has no percent line any more (V4's Figma); the
  // head's figure is the one place it is printed there. The modal keeps its line, from the same fill.
  // CHANGED ON PURPOSE: V4's Figma gives the Inspector's head a whole percent (the Term chip's
  // figure), so the head says that fill rounded, 100%, where the modal's line keeps its 99.6%.
  it("prints the head's percent once, the fill rounded, and the modal's meta line prints the same fill", () => {
    stubStore({ [INSPECTOR_TAB_KEY]: "context" });
    const a = A("s", { model: "claude-opus-4-5", contextWindow: 200_000, context: { msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: 199_200, memoryFiles: [] } });
    expect(contextFill(a).pct).toBeCloseTo(99.6, 5);
    const out = html(a, mapOf(a));
    expect(out).not.toContain("ctx-window-pct");
    expect(out).not.toContain("ctx-window-meta");
    expect(out).toContain('<span class="insp-fig">199k / 200k · 100%</span>');
    expect(out.match(/· 100%/g)).toHaveLength(1);
    const modal = renderToStaticMarkup(createElement(ContextView, { agent: a, meta: true }));
    expect(modal).toContain('<span class="ctx-window-pct">99.6%</span>');
  });
  it("sets the meter like Figma: the note directly under it, sentence-case rows, one column", () => {
    const out = withContext({ usage: SPENT });
    expect(out).toMatch(/ctx-window-bar[\s\S]*<p class="ctx-window-note">approximation — CC&#x27;s \/context isn&#x27;t hook-exposed<\/p>/);
    for (const label of ["Input tokens", "Output tokens", "Cache reads", "Cache writes", "Cumulative total", "Estimated cost",
      "User messages", "Assistant messages", "Tool uses", "Tool results", "System-reminders"]) expect(out).toContain(`<span class="ctx-row-label">${label}</span>`);
    expect(out).not.toMatch(/ctx-row-label">[a-z]/);
    expect(out).not.toContain("ctx-row accent");
    // The Codex note is the code's own, in the same place.
    const codex = A("s", { provider: "codex", model: "gpt-5" });
    expect(html(codex, mapOf(codex))).toContain('<p class="ctx-window-note">reported by the Codex CLI — as of its most recent request</p>');
  });
  it("draws the meter 6px, the track --ctl-fill and both parts radius 3, the captions 600 12/16 --text-secondary", () => {
    expect(decl(".ctx-window-bar", "height")).toBe("6px");
    expect(decl(".ctx-window-bar", "border-radius")).toBe("3px");
    expect(decl(".ctx-window-bar", "background")).toBe("var(--ctl-fill)");
    expect(decl(".ctx-window-fill", "border-radius")).toBe("3px");
    expect(decl(".ctx-window-fill", "background")).toBe("var(--accent)");
    expect(decl(".ctx-window-row", "gap")).toBe("6px");
    expect(decl(".ctx-view", "gap")).toBe("12px");
    expect(decl(".ctx-section-title", "height")).toBe("20px");
    expect(decl(".ctx-section-title", "font-size")).toBe(INC(12));
    expect(decl(".ctx-section-title", "font-weight")).toBe("600");
    expect(decl(".ctx-section-title", "color")).toBe("var(--text-secondary)");
    expect(decl(".ctx-section-title", "text-transform")).toBeUndefined();
    expect(decl(".ctx-section-title", "letter-spacing")).toBeUndefined();
    expect(decl(".ctx-row", "height")).toBe("20px");
    expect(decl(".ctx-row", "gap")).toBe("12px");
    expect(decl(".ctx-row", "border-bottom")).toBeUndefined();
    expect(decl(".ctx-row-label", "color")).toBe("var(--muted)");
    expect(decl(".ctx-row-val", "color")).toBe("var(--text)");
    expect(decl(".ctx-row-val", "font-weight")).toBe("400");
    expect(decl(".ctx-grid", "grid-template-columns")).toBeUndefined();
  });
  it("draws no treemap and no legend, and no number the deck does not have", () => {
    const out = withContext({});
    expect(out).not.toMatch(/cx-map|treemap|legend|Tool results \d|Files read|System tools|MCP tools|System prompt/i);
    const source = readFileSync(join(WEB_DIR, "components/Inspector.tsx"), "utf8");
    expect(source).not.toMatch(/cx-map|<svg[^>]*viewBox="0 0 296/);
    expect(out).not.toContain("left before Claude compacts");
    expect(out).not.toContain("the way /context counts it");
  });
});

// CHANGED ON PURPOSE: this block pinned "there is no Time tab, the client holds no turn start,
// waiting time or thinking time". The server holds the turn's lanes (GET /api/tool-audit?session=)
// and the client the calls, so the tab is built on those (V4's Figma). What it pinned that
// still holds is kept: no field is invented on the reducer, and no thinking row is drawn.
describe("the Time tab", () => {
  const reducer = ["reducer.ts", "types.ts", "graph-state.ts"].filter(f => existsSync(join(WEB_DIR, f)))
    .map(f => readFileSync(join(WEB_DIR, f), "utf8")).join("\n");
  const TURN: SessionTurn = { open: false, totalMs: 434_000, youMs: 402_000, claudeMs: 8_800, machineMs: 3_000 };
  const call = (id: string, name: string, startedAt: number, endedAt?: number, over: Partial<ToolCall> = {}): ToolCall =>
    ({ id, name, inputPreview: `${name} arg`, startedAt, endedAt, ...over }) as ToolCall;
  const withTime = (agent: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData> = mapOf(agent)) => {
    stubStore({ [INSPECTOR_TAB_KEY]: "time" });
    return html(agent, agents);
  };

  it("adds no field to the reducer for the turn's start, waiting or thinking", () => {
    expect(reducer).not.toMatch(/\b(waitedMs|turnStartedAt|thinkingMs|waitingMs|turnWaitMs)\b/);
  });
  it("opens on Time when it is the remembered tab, reading the turn first", () => {
    const out = withTime(A("s"));
    expect(out).toMatch(/id="insp-tab-time"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="insp-tab-time"/);
    expect(out).toContain("Reading this turn");
    expect(out).toMatch(/role="status"[^>]*>(?:<span class="loader")/);
    expect(out).not.toMatch(/spinner|insp-time-table/i);
  });
  it("says only that Time is recorded for Claude Code when the session is a Codex one", () => {
    const out = withTime(A("s", { provider: "codex" }));
    expect(out).toContain("Time is recorded for Claude Code sessions.");
    expect(out).not.toContain("Reading this turn");
    const source = readFileSync(join(WEB_DIR, "components/InspectorTime.tsx"), "utf8");
    expect(source.indexOf('=== "codex"')).toBeGreaterThan(-1);
    expect(source.indexOf('=== "codex"')).toBeLessThan(source.indexOf("<TimeTab"));
    // The fetch lives only in TimeTab's hook, which a Codex session never mounts.
    expect(source.slice(0, source.indexOf("export default function InspectorTime"))).toMatch(/readSessionTurn/);
  });
  it("asks every 5 s while the turn is open, and not again once it is closed", () => {
    expect(TURN_POLL_MS).toBe(5000);
    const source = readFileSync(join(WEB_DIR, "components/InspectorTime.tsx"), "utf8");
    // CHANGED ON PURPOSE: the poll is now `if (next?.open && working) later(TURN_POLL_MS)`: it also rests when the session is not working.
    expect(source).toMatch(/if \(next\?\.open && working\) later\(TURN_POLL_MS\)/);
    expect(source).toMatch(/return \(\) => \{ control\.abort\(\); clearTimeout\(timer\);/);
  });
  it("keeps asking after an answer that was not one, slower, and rests while the page is hidden", () => {
    expect(TURN_RETRY_MS).toBe(15000);
    const source = readFileSync(join(WEB_DIR, "components/InspectorTime.tsx"), "utf8");
    // A busy 409, an odd body and a failed fetch all schedule the slower retry and keep the last reading.
    expect(source.match(/later\(TURN_RETRY_MS\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/failedFor: session/);
    expect(source).toMatch(/document\.visibilityState === "hidden"/);
    expect(source).toMatch(/addEventListener\("visibilitychange"/);
    expect(source).toMatch(/removeEventListener\("visibilitychange"/);
    // No "Reading this turn" for ever: a plain sentence when there never was a reading.
    expect(source).toContain("This turn could not be read. Trying again.");
  });
  it("shows no other session's reading, and no table rebuilt by the clock", () => {
    const source = readFileSync(join(WEB_DIR, "components/InspectorTime.tsx"), "utf8");
    expect(source).toMatch(/state\.reading\?\.session === session/);
    expect(source).toMatch(/\[turn, agents, root\.sessionId, revision, readAt\]/);
    expect(source).not.toMatch(/turn\?\.open \? now : 0/);
  });
  it("treats a session that is not working as having no turn running", () => {
    const source = readFileSync(join(WEB_DIR, "components/InspectorTime.tsx"), "utf8");
    expect(source).toMatch(/root\.state === "active"/);
    expect(source).toMatch(/open: false/);
  });
  it("moves a permission prompt's wait from the machine to you, only while it is waiting", () => {
    const open: SessionTurn = { open: true, totalMs: 60_000, claudeMs: 10_000, machineMs: 50_000, youMs: 0 };
    const block = (kind: "permission" | "asked" | "idle", since: number) => ({ kind, since, message: "" }) as WaitingBlock;
    expect(withPromptWait(open, block("permission", 30_000), 60_000)).toEqual({ ...open, machineMs: 20_000, youMs: 30_000 });
    // Never more than the machine had, and nothing for another kind, a closed turn or no prompt.
    expect(withPromptWait(open, block("permission", 0), 90_000)).toEqual({ ...open, machineMs: 0, youMs: 50_000 });
    expect(withPromptWait(open, block("asked", 30_000), 60_000)).toBe(open);
    expect(withPromptWait(open, block("idle", 30_000), 60_000)).toBe(open);
    expect(withPromptWait(open, null, 60_000)).toBe(open);
    expect(withPromptWait({ ...open, open: false }, block("permission", 30_000), 60_000)).toEqual({ ...open, open: false });
  });
  it("reads the route with the session id encoded, and keeps its last answer for a busy or odd one", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return url.includes("busy") ? { ok: false, json: async () => ({ ok: false, reason: "busy" }) }
        : url.includes("none") ? { ok: true, json: async () => null }
        : url.includes("odd") ? { ok: true, json: async () => ({ open: "yes" }) }
        : { ok: true, json: async () => ({ open: true, totalMs: 5, claudeMs: 3, machineMs: 1, youMs: 1 }) };
    });
    const signal = new AbortController().signal;
    expect(await readSessionTurn("a b/c", signal)).toEqual({ open: true, totalMs: 5, claudeMs: 3, machineMs: 1, youMs: 1 });
    expect(seen).toEqual(["/api/tool-audit?session=a%20b%2Fc"]);
    expect(await readSessionTurn("none", signal)).toBeNull();
    expect(await readSessionTurn("busy", signal)).toBeUndefined();
    expect(await readSessionTurn("odd", signal)).toBeUndefined();
  });

  describe("the figures", () => {
    it("print a tenth below ten seconds, then the card's clock", () => {
      expect([300, 8800, 3000, 18000, 434000, 9960, 0].map(turnSpan)).toEqual(["0.3s", "8.8s", "3.0s", "18s", "7m 14s", "10s", "0.0s"]);
    });
    it("give the share of the turn that waited on you, and its bar one piece per lane", () => {
      expect(waitingShare(TURN)).toBe(93);
      expect(waitingShare({ ...TURN, totalMs: 0 })).toBe(0);
      expect(turnPieces(TURN)).toEqual([{ lane: "you", ms: 402_000 }, { lane: "claude", ms: 8_800 }, { lane: "machine", ms: 3_000 }]);
      expect(turnPieces({ ...TURN, youMs: 0 }).map(p => p.lane)).toEqual(["claude", "machine"]);
    });
    it("take the route's answer only when it is a turn", () => {
      expect(parseSessionTurn(null)).toBeNull();
      expect(parseSessionTurn(TURN)).toEqual(TURN);
      expect(parseSessionTurn({ ...TURN, totalMs: -1 })).toBeUndefined();
      expect(parseSessionTurn({ ok: false })).toBeUndefined();
      expect(parseSessionTurn(undefined)).toBeUndefined();
    });
  });

  describe("the span table", () => {
    const root = A("s", {
      prompts: [{ at: 500, text: "old" }, { at: 1000, text: "now" }] as never,
      tools: [call("r0", "Read", 600, 700), call("r1", "Read", 1100, 1400), call("t1", "Task", 2000, 20000), call("e1", "Edit", 21000, 21600), call("b1", "Bash", 22000)],
      waiting: { kind: "permission", message: "", since: 23000, tool: { name: "Bash", preview: "npm test" } },
    });
    const explore = A("x", { parentId: "s", label: "Explore", startedAt: 2100, tools: [call("g1", "Glob", 2200, 2400), call("g2", "Grep", 2500, 3200)] });
    const agents = mapOf(root, explore);
    const table = spanTable({ agents, sessionId: "s", start: turnStartOf(root)!, end: 24000, now: 24000 });
    it("starts at the last prompt, and drops the calls before it", () => {
      expect(turnStartOf(root)).toBe(1000);
      expect(table.rows.map(r => r.name)).toEqual(["Read", "Explore", "Glob", "Grep", "Edit", "Bash"]);
      expect(turnStartOf(A("s", { tools: [call("a", "Read", 700), call("b", "Read", 650)] }))).toBe(650);
    });
    it("nests the subagent's calls under the Task row that started it, and marks that row a group", () => {
      const rows = table.rows;
      expect(rows[1]).toMatchObject({ group: true, depth: 0, from: 2000, to: 20000, arg: "Task arg" });
      expect(rows[2]).toMatchObject({ depth: 1, group: false, under: [rows[1].key] });
      expect(rows[3]).toMatchObject({ depth: 1, under: [rows[1].key] });
      expect(rows[4].under).toEqual([]);
    });
    it("gives a subagent whose Task call is gone a row of its own", () => {
      const lone = A("s", { prompts: [{ at: 0, text: "" }] as never, tools: [] });
      const t = spanTable({ agents: mapOf(lone, explore), sessionId: "s", start: 0, end: 5000, now: 5000 });
      expect(t.rows.map(r => [r.name, r.group, r.depth])).toEqual([["Explore", true, 0], ["Glob", false, 1], ["Grep", false, 1]]);
    });
    it("names what a call ran on as the board does: the command, not its JSON", () => {
      const bash = { ...call("a", "Bash", 10), input: { command: "npm test -- rate-limit" }, inputPreview: '{"command":"npm test -- rate-limit"}' };
      const t = spanTable({ agents: mapOf(A("s", { prompts: [{ at: 0, text: "" }] as never, tools: [bash] })), sessionId: "s", start: 0, end: 100, now: 100 });
      expect(t.rows[0].arg).toBe("npm test -- rate-limit");
      // A call the skins do not know keeps its preview.
      expect(spanTable({ agents: mapOf(A("s", { prompts: [{ at: 0, text: "" }] as never, tools: [call("b", "Mystery", 10)] })), sessionId: "s", start: 0, end: 100, now: 100 }).rows[0].arg).toBe("Mystery arg");
    });
    it("puts the wait pill on the newest call still going that the prompt names, and on no other", () => {
      expect(table.rows.map(r => r.waitingSince)).toEqual([null, null, null, null, null, 23000]);
      const asked = spanTable({ agents: mapOf(A("s", { prompts: [{ at: 0, text: "" }] as never, tools: [call("a", "Bash", 10), call("b", "Read", 20)], waiting: { kind: "permission", message: "", since: 40 } })), sessionId: "s", start: 0, end: 100, now: 100 });
      expect(asked.rows.map(r => r.waitingSince)).toEqual([null, 40]);
      const idle = spanTable({ agents: mapOf(A("s", { prompts: [{ at: 0, text: "" }] as never, tools: [call("a", "Bash", 10)], waiting: { kind: "idle", message: "", since: 40 } })), sessionId: "s", start: 0, end: 100, now: 100 });
      expect(idle.rows[0].waitingSince).toBeNull();
    });
    it("lays the bars on the axis, with a 4-tick axis that starts at 0", () => {
      expect(axisTicks({ rows: [], start: 0, end: 36000 })).toEqual(["0", "12s", "24s", "36s"]);
      expect(barBox({ ...table.rows[0], from: 0, to: 9000 }, { rows: [], start: 0, end: 36000 }, 36000)).toEqual({ left: 0, width: 25 });
      expect(barBox({ ...table.rows[0], from: 18000, to: null }, { rows: [], start: 0, end: 36000 }, 27000)).toEqual({ left: 50, width: 25 });
    });
  });

  describe("the body", () => {
    const root = A("s", { tools: [call("r1", "Read", 1100, 1400), call("t1", "Task", 2000, 20000), call("b1", "Bash", 22000)], prompts: [{ at: 1000, text: "" }] as never,
      waiting: { kind: "permission", message: "", since: 22000 } as never });
    const agents = mapOf(root, A("x", { parentId: "s", label: "Explore", startedAt: 2100, tools: [call("g1", "Glob", 2200, 2400)] }));
    const table = spanTable({ agents, sessionId: "s", start: 1000, end: 40000, now: 40000 });
    const body = (turn: SessionTurn, t = table) => renderToStaticMarkup(createElement(TimeBody, { turn, table: t, now: 40000 }));
    it("heads the tab 'Where the time went' and the turn, with nothing at the right and no cost", () => {
      const out = body({ ...TURN, open: true });
      expect(out).toContain('<span class="insp-title">Where the time went</span><span class="insp-qual">this turn</span>');
      expect(out).not.toContain("insp-fig");
      expect(out).not.toMatch(/\$|¢|cost|Thinking/i);
      expect(body(TURN)).toContain('<span class="insp-qual">last turn</span>');
    });
    it("prints the four figures, the share line, the bar and the note", () => {
      const out = body(TURN);
      expect([...out.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map(m => [m[1], m[2]])).toEqual([
        ["Last turn", "7m 14s"], ["Waiting on you", "6m 42s"], ["Claude", "8.8s"], ["This machine", "3.0s"]]);
      expect(out).toContain("<b>93%</b> of last turn was waiting on you");
      expect(body({ ...TURN, open: true })).toContain("of this turn was waiting on you");
      expect(body({ ...TURN, open: true })).toContain("<dt>This turn</dt>");
      expect(out).toMatch(/<i data-lane="you" style="flex-grow:402000"><\/i><i data-lane="claude"[^>]*><\/i><i data-lane="machine"/);
      expect(out).toContain("Waiting on you is part of the turn. It never counts as Claude or machine time.");
      expect(out).not.toMatch(/legend/i);
    });
    it("draws the axis row, a row per call with its name, argument and duration, a fold on the group and the wait pill", () => {
      const out = body(TURN);
      expect(out).toContain("<span role=\"columnheader\">Span</span>");
      expect(out).toMatch(/<span class="insp-time-ticks"[^>]*><span>0<\/span><span>[^<]+<\/span><span>[^<]+<\/span><span>[^<]+<\/span>/);
      // CHANGED ON PURPOSE: the argument ends in an ellipsis on a narrow panel, so it carries itself as a title.
      expect(out).toContain('<span class="insp-time-op">Read</span><span class="insp-time-arg" title="Read arg">Read arg</span><span class="insp-time-took">0.3s</span>');
      expect(out).toMatch(/aria-expanded="true" aria-label="Hide the calls of Explore"/);
      expect(out).toContain('<span class="insp-time-op">Glob</span>');
      expect(out).toMatch(/<span class="insp-time-wait"[^>]*>waiting on you · 18s<\/span>/);
      // A call still waiting draws the pill in place of its bar, and shows no duration.
      expect(out.match(/insp-time-span/g)).toHaveLength(3);
    });
    it("draws the group's bar in --accent and every other bar in --text, from CSS", () => {
      expect(decl(".insp-time-span", "background")).toBe("var(--text)");
      expect(decl(".insp-time-span[data-group]", "background")).toBe("var(--accent)");
      expect(decl(".insp-time-span", "height")).toBe("10px");
      expect(decl(".insp-time-span", "min-width")).toBe("2px");
      expect(decl(".insp-time-wait", "color")).toBe("var(--warn)");
      expect(decl(".insp-time-wait", "background")).toBe("var(--panel)");
      expect(decl(".insp-time-wait", "border-radius")).toBe("3px");
    });
    it("sets the stats 2 x 2 with a 6 and 12 gap, the bar 6px radius 3, the rows 24 and the axis 20", () => {
      expect(decl(".insp-time-stats", "grid-template-columns")).toBe("minmax(0, 1fr) minmax(0, 1fr)");
      expect(decl(".insp-time-stats", "gap")).toBe("6px 12px");
      expect(decl(".insp-time-stat dd", "font-weight")).toBe("500");
      expect(decl(".insp-time-stat dd", "font-size")).toBe(INC(14));
      expect(decl(".insp-time-stat dd", "line-height")).toBe("20px");
      expect(decl('.insp-time-stat[data-tone="warn"] dd', "color")).toBe("var(--warn)");
      expect(decl(".insp-time-bar", "height")).toBe("6px");
      expect(decl(".insp-time-bar", "border-radius")).toBe("3px");
      expect(decl(".insp-time-row", "height")).toBe("24px");
      expect(decl(".insp-time-axis", "height")).toBe("20px");
      expect(decl(".insp-time-axis", "border-bottom")).toBe("1px solid var(--line-soft)");
      expect(decl(".insp-time-share b", "color")).toBe("var(--warn)");
      expect(decl(".insp-time-share", "color")).toBe("var(--text-secondary)");
    });
    it("uses the ring's lane colours for the bar, and animates nothing in the tab", () => {
      expect(decl('.insp-time-bar i[data-lane="claude"]', "background")).toBe("var(--usage-purple)");
      expect(decl('.insp-time-bar i[data-lane="machine"]', "background")).toBe("var(--usage-lime)");
      expect(decl('.insp-time-bar i[data-lane="you"]', "background")).toBe("var(--usage-cyan)");
      const own = rules.filter(r => r.selectors.some(s => /^\.insp-time/.test(s)));
      expect(own.length).toBeGreaterThan(15);
      for (const r of own) for (const p of Object.keys(r.decls)) expect(p, r.selectors.join(", ")).not.toMatch(/^(transition|animation)/);
    });
  });
});

describe("what the Inspector loads", () => {
  const rel = (p: string) => relative(WEB_DIR, p).replaceAll("\\", "/");
  function staticImports(source: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
      if (m[2] || (m[1] === "export" && !m[3])) continue;
      out.push(m[4]);
    }
    return out;
  }
  function graph(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [join(WEB_DIR, entry)];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!/\.tsx?$/.test(file)) continue;
      for (const spec of staticImports(withoutComments(readFileSync(file, "utf8")))) {
        if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(file), spec);
        const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile());
        if (hit) queue.push(hit);
      }
    }
    return [...seen].map(rel);
  }
  it("imports no module that is only loaded with the terminal stage", () => {
    const lazyOnly = [
      /^components\/terminal\//, /^components\/BoardNavigator\.tsx$/, /^navigator-flip\.ts$/, /^board-navigator\.ts$/,
      /^stage-morph\.ts$/, /^use-terminal-session\.ts$/, /^terminal-protocol\.ts$/, /^xterm-sheet\.ts$/,
    ];
    const reached = graph("components/Inspector.tsx");
    expect(reached).toContain("components/AgentNode.tsx");
    expect(reached.filter(p => lazyOnly.some(re => re.test(p)))).toEqual([]);
  });
});

describe("the Context tab's headings", () => {
  it("are left out of the panel's caption rule, which would zero their margin", () => {
    const caption = rules.find(r => r.selectors.includes(".detail > h2") && r.decls.margin === "0");
    expect(caption?.selectors).toContain(".detail h3:not(.ctx-section-title)");
    expect(caption?.selectors).not.toContain(".detail h3");
    // CHANGED ON PURPOSE: the captions are 20px rows with no margin now (V4's Figma); the
    // 12px between sections is the body's gap, so the rule that must not zero it has nothing to protect.
    expect(decl(".ctx-section-title", "margin")).toBe("0");
  });
  it("no other `.detail … h3` rule reaches them", () => {
    for (const r of rules) {
      for (const s of r.selectors) {
        if (/\.detail\b[^,]*\bh3\b/.test(s) && !s.includes(":not(.ctx-section-title)")) {
          // Scoped to a section of the agent's own detail, which ContextView sits in none of.
          expect(s, s).toMatch(/\.detail-section|\.jr-detail-section/);
        }
      }
    }
  });
});

describe("tokens only", () => {
  it("the Inspector's own rules name no hex or rgba colour", () => {
    const own = rules.filter(r => r.selectors.some(s => /^\.(?:insp-|detail \.insp-)/.test(s)));
    expect(own.length).toBeGreaterThan(20);
    for (const r of own) {
      for (const [p, v] of Object.entries(r.decls)) {
        expect(v, `${r.selectors.join(", ")} { ${p} }`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      }
    }
  });
  it("its components and tree name no literal colour or design-file path", () => {
    for (const f of ["components/Inspector.tsx", "components/InspectorTime.tsx", "inspector-time.ts", "inspector-tree.ts", "inspector-tab.ts"]) {
      const text = readFileSync(join(WEB_DIR, f), "utf8");
      expect(text, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i);
      expect(text, f).not.toContain("docs/design" + "-v4");
    }
  });
});

