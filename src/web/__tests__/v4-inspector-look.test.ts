// The Inspector, its Time tab and the title block as V4's Figma draws them:
// header and tabs boxes, the fold, the title block's type,
// section labels, row heights, the state the rail and the pane share, the Time
// tab's split colours and waterfall geometry, the tool icons, and the argument
// without its braces.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inspector, { EmptyInspector } from "../components/Inspector";
import Detail from "../components/Detail";
import { TimeBody } from "../components/InspectorTime";
import { cardStatus } from "../inspector-state";
import { paneStatus } from "../inspector-status-pane";
import { boardFactsFor } from "../components/terminal/stage-board";
import { stageStatusFrom } from "../components/terminal/stage-model";
import { plainArg, toolIconName, type SessionTurn } from "../inspector-time";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";
import { WEB_DIR } from "./client-source";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
function parse(text: string): Rule[] {
  const out: Rule[] = [];
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
        out.push({ media, selectors: prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return out;
}
const rules = parse(css);
function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;
const src = (file: string) => readFileSync(join(WEB_DIR, file), "utf8");

const USAGE = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheCreateTokens: 0 };
const A = (id: string, over: Partial<AgentNodeData> = {}) => ({
  id, sessionId: "s", label: id, kind: id === "s" ? "root" : "subagent", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: USAGE, prompts: [], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;

describe("the header and the tabs", () => {
  it("is 36 tall with a --line-soft rule, padded 0 6 0 8, no title text", () => {
    expect(decl(".insp-h", "height")).toBe("var(--pane-head-h)");
    expect(decl(".insp-h", "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(".insp-h", "padding")).toBe("0 6px 0 8px");
  });
  // CHANGED ON PURPOSE (V4's Figma): the chosen tab has no shadow, and an unselected tab's icon is --text-secondary.
  it("draws each tab 20 tall, padding 0 8 0 6, gap 4, --r-ctl; the chosen one --panel with no shadow, 600 --text", () => {
    expect(decl(".insp-tab", "height")).toBe("20px");
    expect(decl(".insp-tab", "padding")).toBe("0 8px 0 6px");
    expect(decl(".insp-tab", "gap")).toBe("4px");
    expect(decl(".insp-tab", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".insp-tab", "font-weight")).toBe("500");
    expect(decl(".insp-tab", "color")).toBe("var(--muted)");
    expect(decl('.insp-tab[aria-selected="true"]', "background")).toBe("var(--panel)");
    expect(decl('.insp-tab[aria-selected="true"]', "box-shadow")).toBeUndefined();
    expect(decl('.insp-tab[aria-selected="true"]', "font-weight")).toBe("600");
    expect(decl(".insp-tab .glyph", "color")).toBe("var(--text-secondary)");
    expect(decl('.insp-tab[aria-selected="true"] .glyph', "color")).toBe("var(--text)");
  });
  it("wears the kit's Agents, Time and Context icons, Context not the gauge", () => {
    const code = src("components/Inspector.tsx");
    expect(code).toContain('<KitIcon name="agents"');
    expect(code).toContain('<KitIcon name="time"');
    expect(code).toContain('<KitIcon name="context"');
    expect(code).not.toContain("CapacityGlyph");
  });
  // CHANGED ON PURPOSE (V4's Figma): the Fold points right (›), so fold and unfold never point the same way; the folded tab's button is ‹.
  it("ends in a 24x24 Fold named 'Fold the Inspector' with the kit's chevron-right, in the column and in the sheet", () => {
    const out = renderToStaticMarkup(createElement(Inspector, { selected: A("s"), agents: new Map([["s", A("s")]]), onSelectAgent: () => {}, onClose: () => {}, detail: null }));
    expect(out).toContain('aria-label="Fold the Inspector"');
    expect(decl(".detail .insp-fold", "width")).toBe("24px");
    expect(decl(".detail .insp-fold", "height")).toBe("24px");
    expect(src("components/Inspector.tsx")).toContain('<KitIcon name="chevron-right" />');
    expect(src("components/Inspector.tsx")).not.toContain('<KitIcon name="chevron-left" />');
    // Drawn in the Workspace column too: nothing hides it any more.
    expect(css).not.toMatch(/\.insp-fold\s*\{\s*display:\s*none/);
  });
  it("folds the Inspector alone in the Workspace column: the list and the pane stay, D or an inspect opens it again", () => {
    const app = src("App.tsx");
    const fold = app.slice(app.indexOf("const foldInspector"), app.indexOf("}, [setDetailOpen]);", app.indexOf("const foldInspector")));
    expect(fold).toContain("setInspectorFolded(true)");
    expect(fold).toContain("setDetailOpen(false)");
    // Zoom folds the list and the Inspector together; the Fold is not Zoom.
    expect(fold).not.toMatch(/toggleExpand|expanded/);
    expect(app).toMatch(/inWorkspace && inspectorColumn && !inspectorFolded && !\(detailOpen && selected\)/);
    expect(app).toContain("onClose={foldInspector}");
    // CHANGED ON PURPOSE (V4's Figma): the sheet from 1100 to 1319 folds the same way, to its tab.
    expect(app).toContain("onClose={inWorkspace && (inspectorColumn || inspectorSheet) ? foldInspector :");
    expect(app).toMatch(/useEffect\(\(\) => \{ if \(detailOpen\) setInspectorFolded\(false\); \}, \[detailOpen\]\)/);
  });
});

describe("the body and the title block", () => {
  // CHANGED ON PURPOSE (V4's Figma): every tab's body is 8 under the header, 12 at the sides and foot, with a gap of 8.
  it("pads the body 8 12 12 with a gap of 8", () => {
    expect(decl(".insp-b", "padding")).toBe("8px 12px 12px");
    expect(decl(".insp-b", "gap")).toBe("8px");
  });
  it("sets the name 600 14/20 --text, the meta line 400 12/16 --muted, the spend mono 600 18/24 --text", () => {
    expect(decl(".detail-hero .hero-title", "font-size")).toBe(INC(14));
    expect(decl(".detail-hero .hero-title", "line-height")).toBe("20px");
    expect(decl(".detail-hero .hero-title", "font-weight")).toBe("600");
    expect(decl(".detail-hero .hero-title", "color")).toBe("var(--text)");
    expect(decl(".detail-hero .hero-meta", "font-size")).toBe(INC(12));
    expect(decl(".detail-hero .hero-meta", "line-height")).toBe("16px");
    expect(decl(".detail-hero .hero-meta", "color")).toBe("var(--muted)");
    expect(decl(".detail-hero .hero-cost-value", "font-family")).toBe("var(--font-mono)");
    expect(decl(".detail-hero .hero-cost-value", "font-size")).toBe(INC(18));
    expect(decl(".detail-hero .hero-cost-value", "line-height")).toBe("24px");
    expect(decl(".detail-hero .hero-cost-value", "font-weight")).toBe("600");
    expect(decl(".detail-hero .hero-cost-label", "font-size")).toBe(INC(12));
  });
  it("draws the state as a 14px kit glyph, not a pill", () => {
    const out = renderToStaticMarkup(createElement(Detail, { agent: A("s"), now: 2000 }));
    expect(out).toContain('class="hero-state"');
    expect(out).not.toContain("state-pill");
    expect(out).toMatch(/class="hero-state"[^>]*><svg[^>]*width="14"/);
  });
  // CHANGED ON PURPOSE (V4's Figma): the three are V4's Quiet button, `button.btn` unchanged (28 high,
  // 13/500 --text-secondary, r8, 12 in), 8 apart, and stay on a running session.
  it("keeps Export JSON, Remove and Recap, at the foot of the body as V4's Quiet buttons", () => {
    const out = renderToStaticMarkup(createElement(Detail, { agent: A("s"), now: 2000, onExportSession: () => {}, onRemove: () => {} }));
    expect(out.lastIndexOf('class="hero-actions"')).toBeGreaterThan(out.lastIndexOf('class="detail-section"'));
    expect(out).toContain("Export JSON");
    expect(out).toContain('class="btn"');
    expect(out).not.toContain("hero-action-btn");
    expect(decl(".detail .hero-action-btn", "font-size")).toBeUndefined();
    expect(decl(".detail .hero-action-btn", "color")).toBeUndefined();
    expect(decl(".detail .hero-action-btn", "padding")).toBeUndefined();
    expect(decl("button.btn", "font-size")).toBe(INC(13));
    expect(decl("button.btn", "font-weight")).toBe("500");
    expect(decl("button.btn", "color")).toBe("var(--text-secondary)");
    expect(decl("button.btn", "padding")).toBe("0 12px");
    expect(decl("button.btn", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".detail .hero-actions", "gap")).toBe("8px");
  });
  it("sets the empty Inspector 600 13/20 --text-secondary over 400 12/16 --muted, centred, padded 8 12 12 with a gap of 4", () => {
    expect(decl(".insp-none-title", "font-size")).toBe(INC(13));
    expect(decl(".insp-none-title", "color")).toBe("var(--text-secondary)");
    expect(decl(".insp-none", "padding")).toBe("8px 12px 12px");
    expect(decl(".insp-none", "gap")).toBe("4px");
    const out = renderToStaticMarkup(createElement(EmptyInspector));
    expect(out).toContain("No session in focus");
    expect(out).toContain("Open one from the list.");
  });
});

describe("the sections", () => {
  it("sets a label 600 12/16 --text-secondary in a 20-high row, sentence case, no letter-spacing", () => {
    expect(decl(".detail h3:not(.ctx-section-title)", "font-size")).toBe(INC(12));
    expect(decl(".detail h3:not(.ctx-section-title)", "font-weight")).toBe("600");
    expect(decl(".detail h3:not(.ctx-section-title)", "color")).toBe("var(--text-secondary)");
    expect(decl(".detail h3:not(.ctx-section-title)", "text-transform")).toBe("none");
    expect(decl(".detail h3:not(.ctx-section-title)", "letter-spacing")).toBe("0");
    expect(decl(".detail-section h3", "height")).toBe("20px");
  });
  it("sets a count beside a label mono 400 11/14 --muted, no pill", () => {
    expect(decl(".detail-section h3 .section-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".detail-section h3 .section-count", "font-size")).toBe(INC(11));
    expect(decl(".detail-section h3 .section-count", "line-height")).toBe("14px");
    expect(decl(".detail-section h3 .section-count", "color")).toBe("var(--muted)");
    expect(decl(".detail-section h3 .section-count", "border")).toBeUndefined();
  });
  it("draws plan rows 22 high with a 14px state glyph each, 'now' mono 11/14 --inflight", () => {
    expect(decl(".detail .plan-item", "min-height")).toBe("22px");
    expect(decl(".detail .plan-mark", "width")).toBe("14px");
    expect(decl(".detail .plan-now", "color")).toBe("var(--inflight)");
    expect(decl(".detail .plan-now", "font-size")).toBe(INC(11));
    const agent = A("s", { plan: { items: [{ id: "1", text: "Add it", status: "completed" }, { id: "2", text: "Test it", status: "in_progress", active: "Testing it" }, { id: "3", text: "Doc it", status: "pending" }] } } as Partial<AgentNodeData>);
    const out = renderToStaticMarkup(createElement(Detail, { agent, now: 2000 }));
    expect(out.match(/class="plan-mark"/g)).toHaveLength(3);
    expect(out).toMatch(/class="plan-mark"[^>]*><svg/);
  });
  it("sets the activity counts mono 12/16 with a gap of 12 and the pills --ctl-fill, --r-pill, padding 1 6, mono 400 11/14 --text-secondary", () => {
    expect(decl(".activity-counters", "font-family")).toBe("var(--font-mono)");
    expect(decl(".activity-counters", "gap")).toBe("12px");
    expect(decl(".activity-counters .ac-live", "color")).toBe("var(--inflight)");
    expect(decl(".activity-counters .ac-err", "color")).toBe("var(--err)");
    expect(decl(".cat-chip", "background")).toBe("var(--ctl-fill)");
    expect(decl(".cat-chip", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".cat-chip", "padding")).toBe("1px 6px");
    expect(decl(".cat-chip", "font-size")).toBe(INC(11));
    expect(decl(".cat-chip", "color")).toBe("var(--text-secondary)");
  });
  it("sets identity and token rows label 400 12/16 --muted, value mono 12/16 --text", () => {
    expect(decl(".detail .row .k", "color")).toBe("var(--muted)");
    expect(decl(".detail .row .v", "font-family")).toBe("var(--font-mono)");
    expect(decl(".detail .row .v", "font-size")).toBe(INC(12));
    expect(decl(".tokens-grid .k", "color")).toBe("var(--muted)");
    expect(decl(".tokens-grid b", "font-family")).toBe("var(--font-mono)");
  });
  it("sets prompts 400 12/16 --text-secondary", () => {
    expect(decl(".prompt-text", "font-size")).toBe(INC(12));
    expect(decl(".prompt-text", "line-height")).toBe("16px");
    expect(decl(".prompt-text", "color")).toBe("var(--text-secondary)");
  });
  it("draws tool-call rows 24 high: the name 500 12/16, the argument mono 400 11/14 --muted with an ellipsis", () => {
    expect(decl("button.tool.clickable", "height")).toBe("24px");
    expect(decl("button.tool.clickable .name", "font-weight")).toBe("500");
    expect(decl("button.tool.clickable .tool-arg", "font-family")).toBe("var(--font-mono)");
    expect(decl("button.tool.clickable .tool-arg", "font-size")).toBe(INC(11));
    expect(decl("button.tool.clickable .tool-arg", "color")).toBe("var(--muted)");
    expect(decl("button.tool.clickable .tool-arg", "text-overflow")).toBe("ellipsis");
    const agent = A("s", { tools: [{ id: "t1", name: "WebFetch", inputPreview: '{"url":"https://x.dev"}', startedAt: 1100, endedAt: 1200, ok: true }] } as Partial<AgentNodeData>);
    const out = renderToStaticMarkup(createElement(Detail, { agent, now: 2000 }));
    expect(out).toContain('<span class="tool-arg">https://x.dev</span>');
    expect(out).not.toMatch(/tool-arg">\{/);
  });
});

describe("the state the Inspector names", () => {
  const fresh = A("s", { prompts: [], lastTurnEndAt: null } as Partial<AgentNodeData>);
  it("is the pane's own sentence for a session's root: ready for a first prompt, not Working", () => {
    const agents = new Map([["s", fresh]]);
    const pane = stageStatusFrom(boardFactsFor(fresh, []), 5000);
    expect(pane.phrase).toBe("ready");
    const status = paneStatus(fresh, agents, 5000);
    expect(status.phrase).toBe("ready · for a first prompt");
    expect(status.glyph).toBe("idle");
    const out = renderToStaticMarkup(createElement(Detail, { agent: fresh, now: 5000, status }));
    expect(out).toContain('aria-label="ready · for a first prompt"');
    expect(out).not.toContain("Working");
  });
  it("reads working for a session with a prompt that is running", () => {
    const busy = A("s", { prompts: [{ text: "go", at: 1500 }] } as Partial<AgentNodeData>);
    const status = paneStatus(busy, new Map([["s", busy]]), 5000);
    expect(status.glyph).toBe("working");
    expect(status.phrase).toBe("working");
  });
  it("says what the card says for a subagent, and until the pane's functions have loaded", () => {
    expect(cardStatus(A("c", { state: "active" }))).toEqual({ glyph: "working", phrase: "working" });
    expect(cardStatus(A("c", { state: "done" })).glyph).toBe("done");
    expect(cardStatus(A("c", { state: "err" })).glyph).toBe("error");
  });
  it("is taken from the pane's functions, not a second rule, and loads them only in the Workspace", () => {
    const pane = src("inspector-status-pane.ts");
    expect(pane).toContain("stageStatusFrom(boardFactsFor(root, subagents)");
    // A dynamic import, so a visit with the terminal off never loads the stage (terminal-stage-lazy.test.ts).
    expect(src("inspector-state.ts")).toMatch(/import\("\.\/inspector-status-pane"\)/);
    expect(src("inspector-state.ts")).not.toMatch(/^import .*stage-/m);
    expect(src("components/DetailAside.tsx")).toContain("useInspectorStatus(");
    expect(src("App.tsx")).toMatch(/workspace=\{inWorkspace\}/);
  });
});

describe("the Time tab", () => {
  const turn: SessionTurn = { open: true, totalMs: 434_000, claudeMs: 8800, machineMs: 3000, youMs: 402_000 };
  const table = {
    start: 0, end: 36_000,
    rows: [
      { key: "c:s:1", name: "Read", arg: "src/routes.ts", depth: 0, group: false, under: [], from: 0, to: 300, waitingSince: null },
      { key: "g:k", name: "Explore", arg: "find it", depth: 0, group: true, under: [], from: 1000, to: 19_000, waitingSince: null },
      { key: "c:k:2", name: "Grep", arg: "limiter", depth: 1, group: false, under: ["g:k"], from: 2000, to: 2700, waitingSince: null },
      { key: "c:s:3", name: "Bash", arg: "npm test", depth: 0, group: false, under: [], from: 30_000, to: null, waitingSince: 30_000 },
    ],
  };
  const out = renderToStaticMarkup(createElement(TimeBody, { turn, table, now: 36_000 }));
  it("heads with 'Where the time went' 600 13/20 --text and 'this turn' 400 --muted", () => {
    expect(out).toContain('<span class="insp-title">Where the time went</span><span class="insp-qual">this turn</span>');
    expect(decl(".insp-head", "font-size")).toBe(INC(13));
    expect(decl(".insp-head", "line-height")).toBe("20px");
    expect(decl(".insp-title", "font-weight")).toBe("600");
  });
  it("sets the stats 2 x 2, gap 6 / 12, the label 400 12/16 --muted, the value mono 500 14/20, Waiting on you --warn", () => {
    expect(decl(".insp-time-stats", "gap")).toBe("6px 12px");
    expect(decl(".insp-time-stat dt", "color")).toBe("var(--muted)");
    expect(decl(".insp-time-stat dd", "font-family")).toBe("var(--font-mono)");
    expect(decl(".insp-time-stat dd", "font-size")).toBe(INC(14));
    expect(decl(".insp-time-stat dd", "font-weight")).toBe("500");
    expect(decl('.insp-time-stat[data-tone="warn"] dd', "color")).toBe("var(--warn)");
  });
  it("draws the split bar 6 high, radius 3, the track --text at 6%, the lanes in the deck's order at --warn 55%, --accent 34% and 14%", () => {
    expect(decl(".insp-time-bar", "height")).toBe("6px");
    expect(decl(".insp-time-bar", "border-radius")).toBe("3px");
    expect(decl(".insp-time-bar", "background")).toBe("color-mix(in srgb, var(--text) 6%, transparent)");
    expect(decl('.insp-time-bar i[data-lane="you"]', "background")).toBe("color-mix(in srgb, var(--warn) 55%, transparent)");
    expect(decl('.insp-time-bar i[data-lane="claude"]', "background")).toBe("color-mix(in srgb, var(--accent) 34%, transparent)");
    expect(decl('.insp-time-bar i[data-lane="machine"]', "background")).toBe("color-mix(in srgb, var(--accent) 14%, transparent)");
    expect(out.indexOf('data-lane="you"')).toBeLessThan(out.indexOf('data-lane="claude"'));
    expect(out.indexOf('data-lane="claude"')).toBeLessThan(out.indexOf('data-lane="machine"'));
    expect(out).toContain("<b>93%</b> of this turn was waiting on you");
  });
  it("draws the waterfall: an axis 20 high, rows 24, a 124 name column", () => {
    expect(decl(".insp-time-axis", "height")).toBe("20px");
    // The column's name is a word, 12/16 in the UI face; only the ticks are mono 11/14.
    expect(decl(".insp-time-axis", "font-family")).toBeUndefined();
    expect(decl(".insp-time-axis", "font-size")).toBe(INC(12));
    expect(decl(".insp-time-axis", "line-height")).toBe("16px");
    expect(decl(".insp-time-ticks", "font-family")).toBe("var(--font-mono)");
    expect(decl(".insp-time-ticks", "font-size")).toBe(INC(11));
    expect(decl(".insp-time-ticks", "line-height")).toBe("14px");
    expect(decl(".insp-time-axis", "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(".insp-time-row", "height")).toBe("24px");
    expect(decl(".insp-time-row", "grid-template-columns")).toBe("124px minmax(0, 1fr)");
    expect(decl(".insp-time-axis", "grid-template-columns")).toBe("124px minmax(0, 1fr)");
  });
  it("places the chevron at x 5, the icon at x 24 and the name at x 44, a child 14 further", () => {
    expect(decl(".insp-time-name", "padding-left")).toBe("calc(5px + var(--depth, 0) * 14px)");
    expect(decl(".insp-time-slot", "width")).toBe("12px");
    expect(decl(".insp-time-slot", "margin-right")).toBe("7px");
    expect(decl(".insp-time-icon", "width")).toBe("14px");
    expect(decl(".insp-time-icon", "margin-right")).toBe("6px");
    expect(5 + 12 + 7).toBe(24);
    expect(24 + 14 + 6).toBe(44);
    expect(out).toContain('style="--depth:1"');
  });
  it("draws a chevron only on the row that folds, in a slot every row has", () => {
    expect(out.match(/class="insp-time-slot"/g)).toHaveLength(4);
    expect(out.match(/class="insp-time-fold"/g)).toHaveLength(1);
  });
  it("sets the argument mono 400 11/14 --muted, right-aligned with an ellipsis, the name 500 12/16 --text", () => {
    expect(decl(".insp-time-arg", "text-align")).toBe("right");
    expect(decl(".insp-time-arg", "text-overflow")).toBe("ellipsis");
    expect(decl(".insp-time-arg", "font-size")).toBe(INC(11));
    expect(decl(".insp-time-op", "font-weight")).toBe("500");
    expect(decl(".insp-time-op", "color")).toBe("var(--text)");
  });
  it("draws the turn-span bar 10 high, --text at 16%, radius 3 (1 for a thin one), the subagent --accent at 14% with an inset edge at 40%", () => {
    expect(decl(".insp-time-span", "height")).toBe("10px");
    expect(decl(".insp-time-span", "background")).toBe("color-mix(in srgb, var(--text) 16%, transparent)");
    expect(decl(".insp-time-span", "border-radius")).toBe("3px");
    expect(decl(".insp-time-span[data-thin]", "border-radius")).toBe("1px");
    expect(decl(".insp-time-span[data-group]", "background")).toBe("color-mix(in srgb, var(--accent) 14%, transparent)");
    expect(decl(".insp-time-span[data-group]", "box-shadow")).toBe("inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent)");
    expect(out).toContain("data-thin");
  });
  it("puts the duration in the lane, right of the bar, and not in the name column", () => {
    expect(out).toMatch(/class="insp-time-lane"[^>]*><i class="insp-time-span"[^>]*><\/i><span class="insp-time-took"/);
    expect(decl(".insp-time-took", "position")).toBe("absolute");
    expect(decl(".insp-time-took", "color") ?? decl(".insp-time-arg, .insp-time-took", "color")).toBeDefined();
  });
  it("labels the waiting row with a chip: --panel, radius 3, mono 11/14 --warn", () => {
    expect(out).toContain("waiting on you · 6.0s");
    expect(decl(".insp-time-wait", "background")).toBe("var(--panel)");
    expect(decl(".insp-time-wait", "border-radius")).toBe("3px");
    expect(decl(".insp-time-wait", "color")).toBe("var(--warn)");
  });
  it("wears the kit's icon by kind of tool", () => {
    expect(["Read", "Edit", "Write"].map(n => toolIconName(n))).toEqual(["file", "file", "file"]);
    expect(["Search", "Grep", "Glob"].map(n => toolIconName(n))).toEqual(["search", "search", "search"]);
    expect(toolIconName("Bash")).toBe("terminal");
    expect(toolIconName("Explore", true)).toBe("agents");
    expect(out).toContain('data-icon="terminal"');
    expect(out).toContain('data-icon="agents"');
  });
  it("shows an argument as its first string, never the braces", () => {
    expect(plainArg('{"url":"https://x.dev"}')).toBe("https://x.dev");
    expect(plainArg('{"n":3,"pattern":"limiter","path":"src"}')).toBe("limiter");
    expect(plainArg('{"file_path":"/a/b.ts","old')).toBe("/a/b.ts");
    expect(plainArg("npm test")).toBe("npm test");
    expect(plainArg('{"n":3}')).toBe("");
  });
  it("closes with the note that waiting is part of the turn", () => {
    expect(out).toContain("Waiting on you is part of the turn. It never counts as Claude or machine time.");
  });
});
