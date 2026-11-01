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
import { agentTree, sessionCostLabel, subagentCount } from "../inspector-tree";
import {
  INSPECTOR_TABS, INSPECTOR_TAB_KEY, loadInspectorTab, saveInspectorTab,
} from "../inspector-tab";
import { tabStripMove } from "../tablist-keys";
import { costChip } from "../card-cost";
import { fmtCost } from "../pricing";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";
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
    expect(decl(".detail", "width", "(max-width: 640px)")).toBe("min(360px, 100vw)");
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
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[0]).toContain('aria-controls="insp-panel-agents"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('aria-controls="insp-panel-context"');
    expect(tabs[1]).toContain('tabindex="-1"');
    expect(out).toMatch(/role="tabpanel"[^>]*id="insp-panel-agents"|id="insp-panel-agents"[^>]*role="tabpanel"/);
  });
  it("labels its tabs Agents and Context, and has no Time tab", () => {
    expect(INSPECTOR_TABS).toEqual(["agents", "context"]);
    expect([...out.matchAll(/role="tab"[^>]*>.*?<span>([^<]+)<\/span><\/button>/g)].map(m => m[1])).toEqual(["Agents", "Context"]);
    expect(out).not.toMatch(/>Time</);
  });
  it("hides the tabpanel that is not chosen", () => {
    expect(out).toMatch(/id="insp-panel-context"[^>]*hidden|hidden[^>]*id="insp-panel-context"/);
    expect(out).not.toMatch(/id="insp-panel-agents"[^>]*hidden=/);
  });
  it("moves with Left and Right (wrapping), Home and End, and ignores every other key", () => {
    // The decision is tablist-keys.ts's, the deck's one rule for a strip; the
    // Inspector asks it with its own two tabs.
    const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    const to = (at: number, k: string) => tabStripMove(key(k), at, INSPECTOR_TABS.length);
    expect(to(0, "ArrowRight")).toEqual({ kind: "select", index: 1 });
    expect(to(1, "ArrowRight")).toEqual({ kind: "select", index: 0 });
    expect(to(0, "ArrowLeft")).toEqual({ kind: "select", index: 1 });
    expect(to(1, "Home")).toEqual({ kind: "select", index: 0 });
    expect(to(0, "End")).toEqual({ kind: "select", index: 1 });
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
    stubStore({ [INSPECTOR_TAB_KEY]: "time" });
    expect(loadInspectorTab()).toBe("agents");
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
    expect(readFileSync(join(WEB_DIR, "App.tsx"), "utf8")).toMatch(/onSelectAgent=\{id => selectAgent\(id, false, false\)\}/);
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
    expect(out).toContain('<span class="insp-fig">50.0k / 200.0k · 25%</span>');
  });
  it("shows the context modal's body", () => {
    const out = withContext({});
    for (const word of ["ctx-window-row", "Cumulative usage", "Transcript composition", "CLAUDE.md files in scope"]) expect(out).toContain(word);
    const modal = readFileSync(join(WEB_DIR, "components/ContextModal.tsx"), "utf8");
    expect(modal).toMatch(/<ContextView agent=\{agent\} \/>/);
    expect(modal).toMatch(/export function ContextView/);
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

describe("the Time tab", () => {
  const reducer = ["reducer.ts", "types.ts", "graph-state.ts"].filter(f => existsSync(join(WEB_DIR, f)))
    .map(f => readFileSync(join(WEB_DIR, f), "utf8")).join("\n");
  it("is left out, because the client holds no turn start, waiting time or thinking time", () => {
    // A tool call has its two timestamps, the session a `waiting.since` for the
    // block it is in now; nothing records the waiting of a finished block, and
    // the thinking between tool calls is not an event. When a field for either
    // arrives, this test is the place to start the tab.
    expect(reducer).not.toMatch(/\b(waitedMs|turnStartedAt|thinkingMs|waitingMs|turnWaitMs)\b/);
    expect(INSPECTOR_TABS).not.toContain("time" as never);
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
    for (const f of ["components/Inspector.tsx", "inspector-tree.ts", "inspector-tab.ts"]) {
      const text = readFileSync(join(WEB_DIR, f), "utf8");
      expect(text, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i);
      expect(text, f).not.toContain("docs/design" + "-v4");
    }
  });
});

