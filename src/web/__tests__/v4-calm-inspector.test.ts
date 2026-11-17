// V4 top-10 #6: the Inspector reads as one calm block. For one selected
// session it used to open on an "Agents ⓘ no subagents" head, put a
// three-colour spend bar with no legend in the title block, then set the token
// table, the identity, the earlier prompts and every tool call one under the
// other, and end on three equal outlined buttons. Now the body is the title
// block and what a person reads (the note, the plan, what they typed); the
// record is one shut "Details" row at the end, the bar keyed by the token rows
// inside it, and Export and Remove are the title block's ⋯.
//
// The presses (the ⋯ menu, Escape, the remembered Details) are in
// v4-calm-inspector-press.test.ts, which runs the components on fake-react.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inspector from "../components/Inspector";
import Detail from "../components/Detail";
import { INSPECTOR_DETAILS_KEY } from "../inspector-tab";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";

const USAGE = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 400, cacheCreateTokens: 100 };
const A = (id: string, over: Partial<AgentNodeData> = {}) => ({
  id, sessionId: "s", label: id, kind: id === "s" ? "root" : "subagent", state: "active", childCount: 0, toolCount: 0,
  tools: [], usage: USAGE, model: "claude-sonnet-4-5", startedAt: 1000, cwd: "/home/u/proj",
  prompts: [{ text: "Look at the CI", at: 1500 }, { text: "Ship it", at: 2000 }],
  plan: { items: [{ id: "1", text: "Add it", status: "completed" }, { id: "2", text: "Test it", status: "in_progress" }] },
  ...over,
}) as unknown as AgentNodeData;
const mapOf = (...agents: AgentNodeData[]) => new Map(agents.map(a => [a.id, a]));
const detailOf = (agent: AgentNodeData, over: Record<string, unknown> = {}) => createElement(Detail, {
  agent, now: 30_000, onOpenTool: () => {}, onShowSummary: () => {}, onExportSession: () => {}, onRemove: () => {}, ...over,
});
const panel = (selected: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData>) =>
  renderToStaticMarkup(createElement(Inspector, { selected, agents, onSelectAgent: () => {}, onClose: () => {}, detail: detailOf(selected) }));
const heroOf = (html: string) => {
  const at = html.indexOf('<header class="detail-hero">');
  return html.slice(at, html.indexOf("</header>", at));
};

/** The sheet's declarations for one exact selector, comments stripped. */
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
function decl(selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map(s => s.trim().replace(/\s+/g, " "));
    if (!sels.includes(selector)) continue;
    const hit = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(m[2]);
    if (hit) found = hit[1];
  }
  return found;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("the Agents head", () => {
  it("is not drawn for a session with no subagents: the body starts with the title block", () => {
    const root = A("s");
    const out = panel(root, mapOf(root));
    expect(out).not.toContain("insp-head");
    expect(out).not.toContain("insp-tree");
    expect(out).not.toContain("no subagents");
    expect(out).toMatch(/<div role="tabpanel" id="insp-panel-agents"[^>]*><div class="insp-detail"><header class="detail-hero">/);
  });

  it("comes back with the tree for a session with subagents, title, info mark and count first", () => {
    const root = A("s", { childCount: 1 });
    const out = panel(root, mapOf(root, A("c1", { parentId: "s", startedAt: 3000 })));
    expect(out).toContain('<span class="insp-title">Agents</span>');
    expect(out).toContain('class="insp-info"');
    expect(out).toContain('<span class="insp-qual">1 subagent</span>');
    expect(out.indexOf('class="insp-head"')).toBeLessThan(out.indexOf('class="insp-tree"'));
    expect(out.indexOf('class="insp-tree"')).toBeLessThan(out.indexOf('class="detail-hero"'));
  });
});

describe("the title block", () => {
  const out = renderToStaticMarkup(detailOf(A("s")));
  const hero = heroOf(out);

  it("keeps the name, the state, the meta line with its model, and the spend figure with its word", () => {
    expect(hero).toContain('class="hero-state"');
    expect(hero).toContain('class="hero-title"');
    expect(hero).toMatch(/<div class="hero-meta">[\s\S]*class="model-chip"/);
    expect(hero).toMatch(/<span class="hero-cost-value">[^<]+<\/span><span class="hero-cost-label">spend<\/span>/);
  });

  it("draws no cost bar: the split is under Details", () => {
    expect(hero).not.toContain("cost-bar");
    expect(out.indexOf('class="cost-bar"')).toBeGreaterThan(out.indexOf('<details class="detail-more">'));
  });

  it("ends its first line with the ⋯, a menu button named More actions", () => {
    const line = /<div class="hero-line">([\s\S]*?)<\/div>/.exec(hero)![1];
    expect(line).toMatch(/<button type="button" id="[^"]+-more" class="glyph-btn hero-more" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded="false"><svg[^>]*><path d="M3\.5 7H3\.51M7 7H7\.01M10\.5 7H10\.51"><\/path><\/svg><\/button>$/);
    expect(decl(".detail-hero .hero-more", "margin-left")).toBe("auto");
  });

  it("draws no ⋯ when the panel was given neither Export nor Remove", () => {
    const bare = renderToStaticMarkup(detailOf(A("s"), { onExportSession: undefined, onRemove: undefined }));
    expect(bare).not.toContain("hero-more");
  });
});

describe("the body, top to bottom", () => {
  it("is the title block, the note, the plan, the earlier prompts, then one shut Details", () => {
    const out = renderToStaticMarkup(detailOf(A("s")));
    const at = (needle: string) => {
      const i = out.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('<header class="detail-hero">'), at(">Now "), at(">Plan "), at(">Earlier prompts "),
      at('<details class="detail-more">'), at(">Tokens<"), at(">Identity<"), at(">Tool calls "),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Shut, and nothing after it.
    expect(out).toMatch(/<details class="detail-more"><summary>/);
    expect(out.endsWith("</details>")).toBe(true);
  });

  it("names the row Details, with the tool calls it holds counted at its end", () => {
    const calls = renderToStaticMarkup(detailOf(A("s", { toolCount: 42 })));
    expect(calls).toMatch(/<summary><svg class="detail-more-chev"[^>]*>[\s\S]*?<\/svg><span>Details<\/span><span class="detail-more-count">42 tool calls<\/span><\/summary>/);
    const none = renderToStaticMarkup(detailOf(A("s")));
    expect(none).toMatch(/<span>Details<\/span><\/summary>/);
  });

  it("keeps the record inside: the bar over the four token rows, the identity, every call", () => {
    const out = renderToStaticMarkup(detailOf(A("s")));
    const inside = out.slice(out.indexOf('<div class="detail-more-body">'));
    expect(inside).toMatch(/<h3>Tokens<\/h3><div class="cost-bar" role="img"[\s\S]*?<\/div><div class="tokens-grid">/);
    expect(inside).toContain('<span class="k">cwd</span>');
    expect(inside).toContain(">Tool calls <");
  });

  it("opens Details on the first render when this browser left them open", () => {
    const data: Record<string, string> = { [INSPECTOR_DETAILS_KEY]: "1" };
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => data[k] ?? null, setItem: () => {} } });
    expect(renderToStaticMarkup(detailOf(A("s")))).toContain('<details class="detail-more" open="">');
  });
});

describe("the token rows key the bar", () => {
  const out = renderToStaticMarkup(detailOf(A("s")));

  it("lead each label with its band's swatch: in, out, cache read, cache write", () => {
    const keys = [...out.matchAll(/<span class="k tk-key (tk-\w+)">([^<]+)<\/span>/g)].map(m => [m[1], m[2]]);
    expect(keys).toEqual([["tk-in", "in"], ["tk-out", "out"], ["tk-cr", "cache read"], ["tk-cw", "cache write"]]);
  });

  it("paints each swatch from the very token its band reads, never a colour of its own", () => {
    const pairs = [["tk-in", "cb-input"], ["tk-out", "cb-output"], ["tk-cr", "cb-cache-r"], ["tk-cw", "cb-cache-w"]] as const;
    for (const [swatch, band] of pairs) {
      const colour = decl(`.tokens-grid .${swatch}::before`, "background");
      expect(colour, swatch).toMatch(/^var\(--usage-[a-z]+\)$/);
      expect(colour, swatch).toBe(decl(`.cost-bar .${band}`, "background"));
    }
  });

  it("draws the swatch 8 square, on the deck's corner ladder, beside the label", () => {
    expect(decl(".tokens-grid .tk-key::before", "width")).toBe("8px");
    expect(decl(".tokens-grid .tk-key::before", "height")).toBe("8px");
    expect(decl(".tokens-grid .tk-key::before", "border-radius")).toBe("0");
    expect(decl(".tokens-grid .tk-key::before", "content")).toBe('""');
  });

  it("keeps the swatches their own colour under a Contrast theme, as the bar's bands are", () => {
    const forced = /@media \(forced-colors: active\) \{([\s\S]*)/.exec(css)?.[1] ?? "";
    expect(forced).toMatch(/\.tokens-grid \.tk-key::before,[\s\S]*?\{ forced-color-adjust: none; \}/);
  });
});

describe("the Details row's look", () => {
  it("is a quiet 13px --muted row under a --line hairline, with no box round it", () => {
    expect(decl(".detail-more", "border-top")).toBe("1px solid var(--line)");
    expect(decl(".detail-more", "border")).toBeUndefined();
    expect(decl(".detail-more", "background")).toBeUndefined();
    expect(decl(".detail-more > summary", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".detail-more > summary", "color")).toBe("var(--muted)");
    expect(decl(".detail-more > summary", "display")).toBe("flex");
    expect(decl(".detail-more > summary", "cursor")).toBe("pointer");
    expect(decl(".detail-more > summary", "list-style")).toBe("none");
    expect(decl(".detail-more > summary::-webkit-details-marker", "display")).toBe("none");
  });

  it("turns its chevron down while open, and draws no ring of its own over the shared one", () => {
    expect(decl(".detail-more[open] > summary .detail-more-chev", "transform")).toBe("rotate(90deg)");
    expect(decl(".detail-more > summary:focus-visible", "outline")).toBeUndefined();
    expect(decl(".detail-more > summary", "outline")).toBeUndefined();
  });

  it("takes the 32px floor under a coarse pointer", () => {
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(coarse).toMatch(/\.detail-more > summary \{ min-height: 32px; \}/);
  });
});
