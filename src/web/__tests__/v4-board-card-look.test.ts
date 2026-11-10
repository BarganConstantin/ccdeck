// The Board's card and its chips as V4's Figma draws them: the Agent / Card
// (flat, a --line edge, the state label in its colour, a foot of tool icons,
// cost and time), the auto-fit chip, the re-arrange undo, the drag trash, the
// category filter, the cost tooltip and the recap note.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { CostTipBody } from "../components/CostTip";
import { agentCostTip, costChip } from "../card-cost";
import { FOOT_TOOL_ICONS, recentToolKinds } from "../card-tool-icons";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*\n\s*/g, ", ");
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector));
  return m?.[1].replace(/\s+/g, " ");
};
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const node = read("../components/AgentNode.tsx");
const costTip = read("../components/CostTip.tsx");
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
const TEXT = (n: number) => `calc(${n}px + var(--ui-text-increase, 0px))`;

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const SPENT = { inputTokens: 12_400, outputTokens: 8_100, cacheReadTokens: 3_200_000, cacheCreateTokens: 96_000 };
const T = (over: Partial<AgentNodeData>) => ({
  sessionId: "s", label: "web-api", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: NO_USAGE, prompts: [], startedAt: Date.now(), ...over,
}) as unknown as AgentNodeData;
const html = (over: Partial<AgentNodeData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: "s", data: T(over), selected: false } as never)));
const call = (name: string, startedAt: number) => ({ id: name + startedAt, name, inputPreview: "", startedAt });

describe("the card's box", () => {
  it("is 256 wide, a column with a 2px gap, padded 8 and 10 with no stripe's extra", () => {
    expect(decl(".agent-node", "width")).toBe("calc(256px + var(--ui-card-increase, 0px))");
    expect(decl(".agent-node", "flex-direction")).toBe("column");
    expect(decl(".agent-node", "gap")).toBe("2px");
    // V4 draws the card's 1px edge inside its 8 and 10, so each side of the
    // padding is 1px less than the frame's: the measured card is V4's 70 (88
    // with an ask or a failure) with its edge, not 72 and 90.
    expect(decl(".agent-node", "padding")).toBe("calc(8px + (var(--ui-space, 1) - 0.7) * 20px / 3 - 1px) calc(10px - 1px)");
  });
  it("is --panel on a 1px --line edge at the node radius, with no shadow in either theme", () => {
    expect(decl(".agent-node", "background")).toBe("var(--panel)");
    expect(decl(".agent-node", "border")).toBe("1px solid var(--line)");
    expect(decl(".agent-node", "border-radius")).toBe("var(--r-node)");
    expect(decl(".agent-node", "box-shadow")).toBe("none");
    expect(sheet).not.toMatch(/data-color-scheme="light"\]\s*\.agent-node\s*\{[^}]*box-shadow/);
  });
  it("has no stripe element and no state border; only Waiting edges in --warn", () => {
    expect(html({})).not.toContain("accent-stripe");
    expect(decl(".agent-node[data-alarm]", "border-color")).toBe("var(--warn)");
    expect(sheet).not.toMatch(/\.agent-node\.state-(?:active|done|err)\s*\{/);
  });
  it("keeps the selected card's ring, which is token based", () => {
    const ring = body(".react-flow__node.rf-selected .agent-node");
    expect(ring).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(ring).not.toMatch(/rgba?\(|#[0-9a-f]{3}/i);
  });
});

describe("the state label", () => {
  const tones: [string, string][] = [["active", "--inflight"], ["waiting", "--warn"], ["done", "--ok"], ["err", "--err"]];
  for (const [tone, token] of tones) {
    it(`${tone}: the word and the 14px glyph are ${token}`, () => {
      expect(decl(`.agent-node .state-line[data-tone="${tone}"] .state-word`, "color")).toBe(`var(${token})`);
      expect(decl(`.agent-node .state-line[data-tone="${tone}"] .state-mark`, "color")).toBe(`var(${token})`);
    });
  }
  it("is 12/16 at 500 with a 4px gap, and the glyph is the kit's state glyph", () => {
    expect(decl(".agent-node .state-line", "font-size")).toBe(TEXT(12));
    expect(decl(".agent-node .state-line", "font-weight")).toBe("500");
    expect(decl(".agent-node .state-line", "gap")).toBe("4px");
    expect(node).toContain("KitStateGlyph");
    expect(html({ state: "err" })).toMatch(/<svg class="state-mark" data-kind="err" width="14" height="14"/);
  });
});

describe("70 and 88", () => {
  it("draws the head, the prompt, the foot: no sparkline row, no stripe, no extra line", () => {
    expect(node).not.toContain("tool-spark");
    expect(sheet).not.toMatch(/\.tool-spark/);
    expect(decl(".agent-node .task-line", "line-height")).toBe(TEXT(16));
    expect(decl(".agent-node .foot", "line-height")).toBe(TEXT(14));
    expect(decl(".agent-node .title .label", "line-height")).toBe(TEXT(20));
  });
  it("puts the ask row on the column's gap alone, 16 high, for Waiting and for a Failed card with a reason", () => {
    for (const row of [".agent-node .waiting-row", ".agent-node .stop-row"]) {
      expect(decl(row, "line-height"), row).toBe(TEXT(16));
      expect(decl(row, "font-family"), row).toBe("var(--font-mono)");
      expect(decl(row, "font-size"), row).toBe(TEXT(12));
      expect(decl(row, "white-space"), row).toBe("nowrap");
      expect(body(row), row).not.toMatch(/margin|padding|border|background/);
    }
    expect(decl(".agent-node .waiting-row", "color")).toBe("var(--warn)");
    expect(decl(".agent-node .stop-row", "color")).toBe("var(--err)");
    const failed = html({ state: "done", stopFailure: { kind: "usage-limit", error: "rate_limit", message: "", at: 1 } as never });
    expect(failed).toContain('class="stop-row"');
    expect(failed).toContain('class="state-line" data-tone="err"');
  });
});

describe("the foot", () => {
  const tools = [call("Read", 1), call("Bash", 2), call("WebSearch", 3), call("Task", 4), call("Edit", 5)];
  it("names at most three kinds, the latest first, from the calls the card holds", () => {
    expect(FOOT_TOOL_ICONS).toBe(3);
    // Edit is the latest call, so its kind leads; Read (the oldest) is the
    // same kind and does not take a second place.
    expect(recentToolKinds(tools)[0]).toBe("file");
    expect(recentToolKinds(tools)).toHaveLength(3);
    expect(new Set(recentToolKinds(tools)).size).toBe(3);
    expect(recentToolKinds([call("Read", 1), call("Edit", 2), call("Write", 3)])).toEqual(["file"]);
    expect(recentToolKinds([])).toEqual([]);
  });
  it("draws them as 14px icons before the cost, and nothing for a card with no calls", () => {
    const out = html({ tools: tools as never, toolCount: 5, usage: SPENT, model: "claude-opus-5-5" });
    const foot = /<div class="foot">([\s\S]*?)<\/div>/.exec(out)![1];
    const icons = /<span class="foot-tools"[^>]*>([\s\S]*?)<\/span>/.exec(foot)![1];
    expect((icons.match(/<svg/g) ?? []).length).toBe(3);
    expect(icons).toContain('width="14" height="14"');
    expect(foot.indexOf("foot-tools")).toBeLessThan(foot.indexOf("cost-meta"));
    expect(html({})).not.toContain("foot-tools");
    expect(decl(".agent-node .foot .foot-tools", "gap")).toBe("2px");
    expect(decl(".agent-node .foot .foot-tools", "color")).toBe("var(--muted)");
  });
  it("is centred with a 6px gap, and keeps cost, time and the dot in mono", () => {
    expect(decl(".agent-node .foot", "align-items")).toBe("center");
    expect(decl(".agent-node .foot", "gap")).toBe("0 6px");
    expect(decl(".agent-node .foot", "font-family")).toBe("var(--font-mono)");
  });
  it("ends with the sub-agent count and the Agents icon", () => {
    expect(decl(".agent-node .foot .foot-end", "margin-left")).toBe("auto");
    const out = html({ childCount: 3 });
    expect(out).toMatch(/<span class="spawn-badge"[^>]*>3<svg/);
  });
});

// CHANGED ON PURPOSE (V4's Agent / Card draws no button in the foot): the ※ pin
// that put a note away and brought it back is gone from the card. The note
// still opens by itself, its × puts it away, and the Inspector's Recap section
// reads the same note whole, so nothing the pin showed is out of reach.
describe("no recap pin on the card", () => {
  it("draws no pin in the foot, and the sheet holds no rule for one", () => {
    expect(node).not.toContain("recap-pin");
    expect(node).not.toContain("toggleRecapDismissed");
    expect(sheet).not.toMatch(/\.recap-pin/);
    const plan = { items: [{ text: "Read the spec", status: "in_progress" }, { text: "Ship it", status: "pending" }], at: 1 };
    const out = html({ state: "done", recap: { text: "Rate limiting is in.", at: 5 }, plan } as never);
    expect(out).not.toMatch(/recap-pin|glyph-btn|aria-expanded/);
  });
  it("leaves the note's own close on the note, and the note whole in the Inspector", () => {
    const note = read("../components/RecapNoteNode.tsx");
    expect(note).toContain('t("board.node.hideRecap")');
    expect(note).toMatch(/dismissRecap\(/);
    const detail = read("../components/Detail.tsx");
    expect(detail).toMatch(/const note = sessionNoteShown\(agent\);/);
    expect(detail).toContain('<p className="detail-recap" title={noteSource(note)}>{note.text}</p>');
  });
});

describe("the chips over the board", () => {
  it("auto-fit: 124 x 24, the control radius, --panel on --line-soft, 8px apart", () => {
    const chip = ".autofit-chip";
    expect(decl(chip, "height")).toBe("24px");
    expect(decl(chip, "box-sizing")).toBe("border-box");
    expect(decl(chip, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(chip, "background")).toBe("var(--panel)");
    expect(decl(chip, "border")).toBe("1px solid var(--line-soft)");
    expect(decl(chip, "gap")).toBe("8px");
    expect(decl(chip, "padding")).toBe("3px 3px 3px calc(10px - 1px)");
    expect(decl(chip, "color")).toBe("var(--text-secondary)");
    expect(decl(chip, "font-size")).toBe(TEXT(12));
    expect(decl(".autofit-resume", "color")).toBe("var(--accent)");
    expect(decl(".autofit-resume", "font-weight")).toBe("500");
    expect(decl(".autofit-resume", "height")).toBe("16px");
    // The label sits on the strip's own padding, so the button adds none; its
    // hit area (and hover wash) is the ::after, 4px past the text on each side.
    expect(decl(".autofit-resume", "padding")).toBe("0");
    expect(decl(".autofit-resume::after", "inset")).toBe("-4px -4px");
    expect(decl(".autofit-resume::after", "z-index")).toBe("-1");
    // 58 + 8 + 44 inside 10 + 4 and the two edges.
    expect(58 + 8 + 44 + 10 + 4).toBe(124);
  });
  it("re-arrange undo: 189 x 24, Undo as a quiet accent button, then the key cap", () => {
    const strip = ".rearrange-undo";
    expect(decl(strip, "height")).toBe("24px");
    expect(decl(strip, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(strip, "background")).toBe("var(--panel)");
    expect(decl(strip, "border")).toBe("1px solid var(--line-soft)");
    expect(decl(strip, "gap")).toBe("8px");
    expect(decl(strip, "padding")).toBe("3px calc(8px - 1px) 3px calc(10px - 1px)");
    expect(decl(".rearrange-undo-act", "color")).toBe("var(--accent)");
    expect(decl(".rearrange-undo-act", "font-weight")).toBe("500");
    // As the chip's Resume: no padding of its own, the hit area 4px past the
    // word on each side, under the text.
    expect(decl(".rearrange-undo-act", "padding")).toBe("0");
    expect(decl(".rearrange-undo-act::after", "inset")).toBe("-4px -4px");
    expect(decl(".rearrange-undo-act::after", "z-index")).toBe("-1");
    const src = read("../components/RearrangeUndo.tsx");
    expect(src).toContain("<Kbd>{undoChordLabel(platformName())}</Kbd>");
    expect(src.indexOf("</button>")).toBeLessThan(src.indexOf("<Kbd>"));
    expect(10 + 100 + 8 + 29 + 8 + 26 + 8 + 0).toBe(189);
  });
  it("drag trash: 360 x 58, a dashed --line edge, two centred lines, --err when armed", () => {
    const z = ".drag-trash-zone";
    expect(decl(z, "width")).toBe("360px");
    expect(decl(z, "height")).toBe("58px");
    expect(decl(z, "border")).toBe("1px dashed var(--line)");
    expect(decl(z, "border-radius")).toBe("var(--r-node)");
    expect(decl(z, "background")).toBe("var(--panel)");
    expect(decl(z, "flex-direction")).toBe("column");
    expect(decl(z, "gap")).toBe("2px");
    expect(decl(z, "box-shadow")).toBeUndefined();
    expect(decl(".drag-trash-zone.over", "border-color")).toBe("var(--err)");
    expect(decl(".drag-trash-text", "font-size")).toBe(TEXT(13));
    expect(decl(".drag-trash-text", "line-height")).toBe(TEXT(20));
    expect(decl(".drag-trash-text", "font-weight")).toBe("500");
    expect(decl(".drag-trash-text", "color")).toBe("var(--text-secondary)");
    expect(decl(".drag-trash-hint", "color")).toBe("var(--muted)");
    expect(decl(".drag-trash-hint", "line-height")).toBe(TEXT(16));
    expect(read("../components/DragTrashZone.tsx")).not.toContain("<svg");
  });
  it("drag trash says what the drop does: it takes the card off the board and the session runs on", () => {
    const en = read("../i18n/areas/board/en.ts");
    expect(en).toContain('"board.trash.drop": "Drop here to remove from the board"');
    expect(en).toContain('"board.trash.keepsRunning": "The session keeps running"');
  });
  // CHANGED ON PURPOSE (V4's Figma): the category filter was a 32px bordered
  // slab of accent-outlined pills; it is a legend on the canvas now. The new
  // look is pinned whole in v4-tool-legend.test.ts; these keep the numbers
  // this file has always held the board's chips to.
  it("category legend: no box, 24 round items 2px apart, an 8px dot in the category's colour", () => {
    const bar = ".cat-filter-bar";
    expect(decl(bar, "min-height")).toBeUndefined();
    expect(decl(bar, "border")).toBe("0");
    expect(decl(bar, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(bar, "background")).toBe("none");
    expect(decl(bar, "gap")).toBe("2px");
    const item = ".cat-filter";
    expect(decl(item, "height")).toBe("var(--ctl-h-sm)");
    expect(decl(item, "border-radius")).toBe("var(--r-pill)");
    expect(decl(item, "padding")).toBe("0 8px 0 6px");
    expect(decl(item, "gap")).toBe("6px");
    expect(decl(item, "font-size")).toBe(TEXT(12));
    expect(decl(".cat-filter .cat-dot", "width")).toBe("8px");
    expect(decl(".cat-filter .cat-dot", "height")).toBe("8px");
    for (const c of ["file", "shell", "web", "agent", "task", "plan", "mcp"]) {
      expect(decl(`.cat-filter.cat-${c} .cat-dot`, "background")).toBe(`var(--cat-${c})`);
    }
  });
  it("category legend items: no fill and no stroke, shown in --text-secondary, hidden a hollow dot in --text-dim", () => {
    expect(decl(".cat-filter", "background")).toBe("none");
    expect(decl(".cat-filter", "border")).toBe("0");
    expect(decl(".cat-filter", "color")).toBe("var(--text-secondary)");
    expect(decl(".cat-filter.off", "color")).toBe("var(--text-dim)");
    expect(decl(".cat-filter.off .cat-dot", "background")).toBe("transparent");
    expect(decl(".cat-filter.off .cat-dot", "border")).toBe("1.5px solid var(--text-dim)");
    expect(decl(".cat-filter:hover", "background")).toBe("var(--ctl-fill)");
    expect(decl(".cat-filter:hover", "color")).toBe("var(--text)");
    const src = read("../components/CategoryFilterBar.tsx");
    expect(src).toContain("aria-pressed={!off}");
    expect(src).toContain('<span className="cat-dot" aria-hidden="true" />');
  });
  it("writes none of them with a colour literal, and every hover under the mouse query", () => {
    for (const sel of [".autofit-chip", ".autofit-resume", ".rearrange-undo", ".rearrange-undo-act", ".drag-trash-zone", ".cat-filter-bar", ".cat-filter", ".cat-filter.off", ".cat-filter.off .cat-dot", ".cat-filter-sep", ".cat-filter-all", ".cat-filter-tools", ".cost-tip", ".recap-note"]) {
      expect(body(sel), sel).not.toMatch(LITERAL);
    }
    const css = sheetText();
    for (const sel of [".autofit-resume:hover", ".rearrange-undo-act:hover", ".cat-filter:hover", ".cat-filter-all:hover", ".cat-filter-tools:hover"]) {
      const at = css.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      expect(css.lastIndexOf("@media (hover: hover) and (pointer: fine)", at), sel).toBeGreaterThan(css.lastIndexOf("\n}\n", at));
    }
  });
});

describe("the cost tooltip", () => {
  const data = T({ model: "claude-opus-5-5", usage: SPENT, startedAt: Date.now() - 600_000 });
  it("is a 320 box on --panel with a --line edge, the overlay radius and shadow", () => {
    const t = ".cost-tip";
    expect(decl(t, "width")).toBe("320px");
    expect(decl(t, "padding")).toBe("12px");
    expect(decl(t, "gap")).toBe("8px");
    expect(decl(t, "flex-direction")).toBe("column");
    expect(decl(t, "background")).toBe("var(--panel)");
    expect(decl(t, "border")).toBe("1px solid var(--line)");
    expect(decl(t, "border-radius")).toBe("var(--r-overlay)");
    expect(decl(t, "box-shadow")).toBe("var(--shadow-overlay)");
    expect(decl(".cost-tip-title", "color")).toBe("var(--text-secondary)");
    expect(decl(".cost-tip-row", "min-height")).toBe("18px");
    expect(decl(".cost-tip-row", "gap")).toBe("16px");
    expect(decl(".cost-tip-label", "color")).toBe("var(--muted)");
    expect(decl(".cost-tip-value", "color")).toBe("var(--text)");
    expect(decl(".cost-tip-rule", "border-top")).toBe("1px solid var(--line-soft)");
  });
  it("holds the model, one row per kind of token as tokens x rate = dollars, the rule, total", () => {
    const tip = agentCostTip(data, "$0.42/min");
    expect(tip.sections).toHaveLength(1);
    expect(tip.sections[0].title).toBe("model: claude-opus-5-5");
    const labels = tip.sections[0].rows.map(r => r.label);
    expect(labels.slice(0, 3)).toEqual(["input", "output", "cache read"]); // CHANGED ON PURPOSE (owner 2026-11-10 critique): spelled out, not "cache r"
    for (const r of tip.sections[0].rows) expect(r.value).toMatch(/^[\d.]+[kM]? × \$[\d.]+\/MTok = .+$/);
    const out = renderToStaticMarkup(createElement(CostTipBody, { tip }));
    expect(out).toContain("cost-tip-rule");
    expect(out.indexOf("cost-tip-rule")).toBeGreaterThan(out.lastIndexOf("cache"));
    expect(out).toContain(">total<");
    expect(out).toContain(">burn<");
    expect(out).toContain("$0.42/min");
  });
  it("leaves burn out when the deck has no per-minute rate for the session", () => {
    const out = renderToStaticMarkup(createElement(CostTipBody, { tip: agentCostTip(data, null) }));
    expect(out).not.toContain(">burn<");
  });
  it("says the tier only when the deck priced a long prompt", () => {
    expect(agentCostTip(data).sections[0].title).not.toContain("prompt >100K");
  });
  it("has a no-rate variant: the model line and the sentence, no rows, no total", () => {
    const unlisted = T({ model: "gpt-6-codex", usage: { ...NO_USAGE, inputTokens: 900, outputTokens: 1500 } });
    const chip = costChip(unlisted);
    expect(chip?.kind).toBe("unpriced");
    const out = renderToStaticMarkup(createElement(CostTipBody, { tip: chip!.tip }));
    expect(out).toContain("model: gpt-6-codex");
    expect(out).toContain("No published rate in this build. The tokens are counted, the dollars are not.");
    expect(out).not.toContain("cost-tip-row");
    expect(out).not.toContain("cost-tip-rule");
    expect(decl(".cost-tip-norate", "color")).toBe("var(--muted)");
    expect(decl(".cost-tip-norate", "line-height")).toBe(TEXT(16));
  });
  it("opens on keyboard focus and after the hint wait under a mouse, closes on Escape, and is described by id", () => {
    expect(costTip).toContain("FIRST_HINT_DELAY_MS");
    expect(costTip).toMatch(/onFocus=\{e => \{ if \(e\.currentTarget\.matches\(":focus-visible"\)\) show\(0\); \}\}/);
    expect(costTip).toMatch(/e\.pointerType === "mouse"/);
    expect(costTip).toContain('modalStack.push(hide, 0, "popover")');
    expect(costTip).toContain("aria-describedby={open ? id : undefined}");
    expect(costTip).toContain('role="tooltip"');
    expect(costTip).toContain("tabIndex={0}");
  });
  it("replaces the native title on the cost chip", () => {
    expect(node).not.toMatch(/className="cost-(?:meta|unpriced)" title=/);
    expect(node).toContain('<CostChipTip key="cost" className="cost-meta" tip={cost.tip}>');
  });
});

describe("the recap note", () => {
  it("is 240 wide, 8 and 10 inside, 4 apart, on --panel with a --line-soft edge, flat, no hue", () => {
    const n = ".recap-note";
    expect(decl(n, "width")).toBe("calc(240px + var(--ui-card-increase, 0px))");
    // V4's 8 and 10 include the 1px edge Figma draws inside, so CSS pads 1px less.
    expect(decl(n, "padding")).toBe("calc(8px - 1px) calc(10px - 1px)");
    expect(decl(n, "gap")).toBe("4px");
    expect(decl(n, "border-radius")).toBe("var(--r-node)");
    expect(decl(n, "background")).toBe("var(--panel)");
    expect(decl(n, "border-color")).toBe("var(--line-soft)");
    expect(decl(n, "box-shadow")).toBe("none");
    expect(body(n)).not.toMatch(/color-mix/);
  });
  it("has a 24 head: recap in 500 11/14 --muted, the age in mono, a spacer, the close icon button", () => {
    expect(decl(".recap-note-head", "height")).toBe("24px");
    expect(decl(".recap-note-head", "gap")).toBe("6px");
    expect(decl(".recap-note-mark", "font-weight")).toBe("500");
    expect(decl(".recap-note-mark", "color")).toBe("var(--muted)");
    expect(decl(".recap-note-age", "font-family")).toBe("var(--font-mono)");
    expect(decl(".recap-note-age", "line-height")).toBe(TEXT(14));
    expect(decl(".recap-note-text", "color")).toBe("var(--text-secondary)");
    expect(decl(".recap-note-text", "line-height")).toBe(TEXT(16));
    const src = read("../components/RecapNoteNode.tsx");
    expect(src).toContain('<KitIcon name="close" />');
    expect(src).toContain('t("board.node.hideRecap")');
  });
});
