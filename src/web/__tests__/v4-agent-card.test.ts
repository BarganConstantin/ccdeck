// V4's agent card (its Figma kit, Agent / Card 58:918), the detail face only:
// 256 wide on --panel; a head of who (the name, then the model as plain mono
// text) and the state (the face's mark and a sentence-case word); one task
// line; a mono foot of cost · time … and the sub-agent count. Everything else
// the card shows stays, and the card's shadow, session stripe and state borders
// are the owner's and the session's, not this restyle's.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { cardState, stateMarkKind } from "../node-face";
import { agentAriaLabel } from "../agent-copy";
import { footDropped, footDroppable, footNotchOnResize, nextFootNotch, nextSqueeze } from "../card-row-squeeze";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";

// Selector lists are one per line in the sheet; read each as one line.
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

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const SPENT = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheCreateTokens: 0 };
const T = (over: Partial<AgentNodeData>) => ({
  sessionId: "s", label: "billing-api", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 3,
  usage: NO_USAGE, prompts: [], startedAt: Date.now(), ...over,
}) as unknown as AgentNodeData;
const html = (over: Partial<AgentNodeData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: "s", data: T(over), selected: false } as never)));

describe("V4's card frame", () => {
  it("is 256 wide plus the size setting, with the minimum kept and the maximum in step", () => {
    expect(decl(".agent-node", "width")).toBe("calc(256px + var(--ui-card-increase, 0px))");
    expect(decl(".agent-node", "min-width")).toBe("calc(220px + var(--ui-card-increase, 0px))");
    expect(decl(".agent-node", "max-width")).toBe("calc(256px + var(--ui-card-increase, 0px))");
  });
  it("is a column with a 2px gap, 8px above and below scaled by the density, 10px at the sides", () => {
    expect(decl(".agent-node", "flex-direction")).toBe("column");
    expect(decl(".agent-node", "gap")).toBe("2px");
    // The left side is 4px wider than V4's 10: the session stripe sits there.
    // CHANGED ON PURPOSE (browser round 2): 8px * --ui-space gave 5.6px at Compact,
    // not Figma's 8. The vertical padding is 8 at Compact (space 0.7) and 10 at
    // Default (space 1, what the card has had), and keeps growing with density.
    const v = "calc(8px + (var(--ui-space, 1) - 0.7) * 20px / 3)";
    expect(decl(".agent-node", "padding")).toBe(`${v} 10px ${v} 14px`);
    const at = (space: number) => 8 + (space - 0.7) * 20 / 3;
    expect([0.3, 0.5, 0.7, 1, 1.4].map(x => +at(x).toFixed(2))).toEqual([5.33, 6.67, 8, 10, 12.67]);
  });
  it("fills with --panel and keeps the 1px --line edge and the node corner", () => {
    expect(decl(".agent-node", "background")).toBe("var(--panel)");
    expect(decl(".agent-node", "border")).toBe("1px solid var(--line)");
    expect(decl(".agent-node", "border-radius")).toBe("var(--r-node)");
  });
});

describe("what the restyle does not touch", () => {
  it("keeps the shadow and its hover lift (an open owner decision)", () => {
    expect(decl(".agent-node", "box-shadow")).toBe("var(--shadow-1)");
    expect(decl(".agent-node:hover", "box-shadow")).toBe("var(--shadow-2)");
  });
  it("keeps the session stripe: the session's identity on the board", () => {
    expect(decl(".agent-node .accent-stripe", "width")).toBe("4px");
    expect(decl(".agent-node .accent-stripe", "background")).toBe("var(--accent)");
    expect(decl(".agent-node .accent-stripe", "opacity")).toBe("0.7");
    expect(node).toContain('<span className="accent-stripe" />');
  });
  it("keeps the state borders exactly", () => {
    expect(decl(".agent-node.state-active", "border-color")).toBe("var(--inflight)");
    expect(decl(".agent-node.state-done", "border-color")).toBe("rgba(134,239,172,0.5)");
    expect(decl(".agent-node.state-err", "border-color")).toBe("rgba(252,165,165,0.6)");
  });
});

describe("the head", () => {
  it("sets the name at 13/20 and 600 in --text", () => {
    const label = ".agent-node .title .label";
    expect(decl(label, "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(label, "line-height")).toBe("calc(20px + var(--ui-text-increase, 0px))");
    expect(decl(label, "font-weight")).toBe("600");
    expect(decl(label, "color")).toBe("var(--text)");
  });
  it("sets the model, and the other markers, as plain mono 11/14 in --muted", () => {
    const rule = ".agent-node .title .model-text, .agent-node .title .synth-tag";
    expect(decl(rule, "font-family")).toBe("var(--font-mono)");
    expect(decl(rule, "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(decl(rule, "line-height")).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(decl(rule, "font-weight")).toBe("400");
    expect(decl(rule, "color")).toBe("var(--muted)");
    // Plain: no pill rules on the detail face.
    expect(body(rule)).not.toMatch(/border|background|padding/);
    expect(body(".agent-node .synth-tag")).not.toMatch(/border|background|width|height/);
  });
  it("aligns the name and its words on the baseline, 6px apart, and spaces the head 6px", () => {
    expect(decl(".agent-node .title", "align-items")).toBe("baseline");
    expect(decl(".agent-node .title", "gap")).toBe("6px");
    expect(decl(".agent-node .head", "justify-content")).toBe("space-between");
    expect(decl(".agent-node .head", "gap")).toBe("6px");
  });
  it("draws the model as text with no chip class and no family tint", () => {
    const out = html({ model: "claude-opus-5-5", effort: "high" });
    expect(out).toMatch(/<span class="model-text" title="claude-opus-5-5\neffort: high">Opus 5\.5 · high<\/span>/);
    expect(out).not.toContain("model-chip");
    expect(out).not.toContain("data-family");
    expect(node).not.toContain("model-chip");
    expect(html({ provider: "codex" })).toContain('<span class="model-text" title="OpenAI Codex — no model reported yet">Codex</span>');
  });
  it("puts the model after the name and the state after both", () => {
    const out = html({ model: "claude-opus-5-5" });
    expect(out.indexOf('class="label"')).toBeLessThan(out.indexOf('class="model-text"'));
    expect(out.indexOf('class="model-text"')).toBeLessThan(out.indexOf('class="state-line"'));
  });
});

describe("the state, from one mapping shared with the faces at a distance", () => {
  const rows: [string, Partial<AgentNodeData>, string, string, string, string][] = [
    ["active", { state: "active" }, "Working", "active", "--inflight", "live"],
    ["done", { state: "done" }, "Done", "done", "--ok", "done"],
    ["err", { state: "err" }, "Failed", "err", "--err", "err"],
    ["a turn that stopped on an error", { state: "done", stopFailure: { kind: "other" } as never }, "Failed", "err", "--err", "err"],
    ["blocked on a permission", { state: "active", waiting: { kind: "permission", since: 1 } as never }, "Waiting", "waiting", "--warn", "alert"],
  ];
  // CHANGED ON PURPOSE: these read cardState().token. The token is gone (dead:
  // the CSS colours by data-tone), so they read the tone and check the colour
  // the sheet gives that tone.
  for (const [name, over, word, tone, token, mark] of rows) {
    it(`${name}: ${word} in ${token}`, () => {
      const s = cardState(T(over));
      expect(s.word).toBe(word);
      expect(s.tone).toBe(tone);
      expect(s).not.toHaveProperty("token");
      expect(decl(`.agent-node .state-line[data-tone="${tone}"] .state-word`, "color")).toBe(`var(${token})`);
      expect(s.mark).toBe(mark);
    });
  }
  it("takes the three marks from stateMarkKind, the faces' own", () => {
    for (const state of ["active", "done", "err"] as const) expect(cardState(T({ state })).mark).toBe(stateMarkKind(state));
  });
  it("leaves an idle prompt as the state it is: it is not alarming", () => {
    expect(cardState(T({ state: "done", waiting: { kind: "idle", since: 1 } as never })).word).toBe("Done");
  });
  it("sets each word in its token at 12/16 and 500, with a 14px mark", () => {
    expect(decl(".agent-node .state-line", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".agent-node .state-line", "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(".agent-node .state-line", "font-weight")).toBe("500");
    expect(decl(".agent-node .state-line", "gap")).toBe("4px");
    expect(decl(".agent-node .state-line .state-mark, .agent-node .state-line .alert-mark", "width")).toBe("14px");
    expect(decl('.agent-node .state-line[data-tone="active"] .state-word', "color")).toBe("var(--inflight)");
    expect(decl('.agent-node .state-line[data-tone="done"] .state-word', "color")).toBe("var(--ok)");
    expect(decl('.agent-node .state-line[data-tone="err"] .state-word', "color")).toBe("var(--err)");
    expect(decl('.agent-node .state-line[data-tone="waiting"] .state-word', "color")).toBe("var(--warn)");
  });
  it("breathes the Working mark on the deck's live tempo and pulses nothing else", () => {
    expect(decl('.agent-node .state-line[data-tone="active"] .state-mark', "animation")).toBe("pulse var(--pulse-live) infinite");
    expect(sheet).not.toMatch(/\.state-line\[data-tone="(?:waiting|done|err)"\][^{]*\{[^}]*animation/);
  });
  it("draws the word and the mark in the markup", () => {
    const out = html({ state: "active" });
    expect(out).toMatch(/<span class="state-line" data-tone="active"><svg class="state-mark" data-kind="live"[^>]*>[\s\S]*?<\/svg><span class="state-word">Working<\/span><\/span>/);
    expect(out).not.toContain("state-pill");
  });
});

describe("the task line", () => {
  it("is one line of 12/16 in --text-secondary, cut with an ellipsis", () => {
    const t = ".agent-node .task-line";
    expect(decl(t, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(t, "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(t, "color")).toBe("var(--text-secondary)");
    expect(decl(t, "white-space")).toBe("nowrap");
    expect(decl(t, "text-overflow")).toBe("ellipsis");
  });
  it("says what the session-name row said for a root, and what the sub row said for a subagent", () => {
    expect(html({ sessionName: "Billing rewrite" })).toContain('<div class="task-line" title="Billing rewrite">Billing rewrite</div>');
    expect(html({ kind: "subagent", cwdBasename: "shop" })).toContain(">subagent · shop</div>");
  });
  it("is absent for a root with neither a name nor a title", () => {
    expect(html({})).not.toContain("task-line");
  });
});

describe("the foot", () => {
  it("is mono 11/14 in --text-secondary, with a --muted dot between items", () => {
    expect(decl(".agent-node .foot", "font-family")).toBe("var(--font-mono)");
    expect(decl(".agent-node .foot", "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(decl(".agent-node .foot", "line-height")).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(decl(".agent-node .foot", "color")).toBe("var(--text-secondary)");
    expect(decl(".agent-node .foot", "gap")).toBe("0 6px");
    expect(decl(".agent-node .foot .foot-sep", "color")).toBe("var(--muted)");
  });
  it("closes with the sub-agent count after a spacer, in the same grammar (no agents glyph in the icon set)", () => {
    expect(decl(".agent-node .foot .spawn-badge", "margin-left")).toBe("auto");
    expect(decl(".agent-node .foot .spawn-badge", "color")).toBe("var(--text-secondary)");
    expect(sheet).not.toMatch(/(?:^|\})\s*\.spawn-badge\s*\{/);
  });
  it("reads cost · time · tools · tokens, then the sub-agent count", () => {
    const out = html({ toolCount: 5, usage: SPENT, model: "claude-opus-5-5", childCount: 2 });
    const foot = /<div class="foot">([\s\S]*?)<\/div>/.exec(out)![1];
    const at = (s: string) => foot.indexOf(s);
    expect(at("cost-meta")).toBeGreaterThan(-1);
    expect(at("cost-meta")).toBeLessThan(at('class="time"'));
    expect(at('class="time"')).toBeLessThan(at("<b>5</b> tools"));
    expect(at("<b>5</b> tools")).toBeLessThan(at("tokens-meta"));
    expect(at("tokens-meta")).toBeLessThan(at("spawn-badge"));
    expect(foot).toContain('<span class="foot-sep" aria-hidden="true">·</span>');
    expect(foot.endsWith("→ 2</span>")).toBe(true);
  });
  it("starts at the clock when there is no cost, and has no dot before the first item", () => {
    const foot = /<div class="foot">([\s\S]*?)<\/div>/.exec(html({}))![1];
    expect(foot.startsWith('<span class="time"')).toBe(true);
  });
});

describe("no new colour literals", () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
  it("writes the card's new rules in tokens only", () => {
    for (const sel of [
      ".agent-node .head", ".agent-node .head-right", ".agent-node .state-line",
      ".agent-node .state-line .state-mark, .agent-node .state-line .alert-mark",
      '.agent-node .state-line[data-tone="active"] .state-word', '.agent-node .state-line[data-tone="done"] .state-word',
      '.agent-node .state-line[data-tone="err"] .state-word', '.agent-node .state-line[data-tone="waiting"] .state-word',
      '.agent-node .state-line[data-tone="active"] .state-mark',
      ".agent-node .title", ".agent-node .title .label", ".agent-node .title .model-text, .agent-node .title .synth-tag",
      ".agent-node .time", ".agent-node .task-line", ".agent-node .foot", ".agent-node .foot b", ".agent-node .foot .foot-sep",
      ".agent-node .foot .inflight-meta", ".agent-node .foot .failed-meta", ".agent-node .foot .spawn-badge",
    ]) expect(body(sel), sel).not.toMatch(LITERAL);
    expect(body(".agent-node")).not.toMatch(LITERAL);
  });
  it("writes the component without one", () => {
    // Strings only: the commentary quotes issue numbers like #2155.
    expect(node).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]|rgba?\(/);
  });
});

describe("review fixes", () => {
  it("names the card's state in its accessible name with the word the card shows", () => {
    const cases: [Partial<AgentNodeData>, string][] = [
      [{ state: "active" }, "Working"],
      [{ state: "done" }, "Done"],
      [{ state: "err" }, "Failed"],
      [{ state: "done", stopFailure: { kind: "login", error: "authentication_failed", message: "", at: 1 } as never }, "Failed"],
      [{ state: "active", waiting: { kind: "permission", since: 1, message: "Claude needs your permission" } as never }, "Waiting"],
    ];
    for (const [over, word] of cases) {
      expect(cardState(T(over)).word).toBe(word);
      expect(agentAriaLabel(T(over), 0), word).toContain(`, ${word}`);
      expect(html(over)).toContain(`>${word}</span>`);
    }
  });

  it("gives the rows Figma does not draw one shared top spacing, and no margin of their own", () => {
    const rows = [".waiting-row", ".stop-row", ".continued-row", ".approval-blind-row", ".plan-row", ".tool-spark-row"];
    expect(decl(`.agent-node :is(${rows.join(", ")})`, "margin-top")).toBe("calc(4px * var(--ui-space, 1))");
    for (const r of rows) {
      const sel = r === ".tool-spark-row" ? r : `.agent-node ${r}`;
      expect(body(sel), sel).not.toMatch(/margin(-top)?\s*:/);
    }
    expect(body(".agent-node .foot")).not.toMatch(/margin/);
    expect(decl(".agent-node", "gap")).toBe("2px");
  });

  it("says child session on the face of a Codex child (a root with a parent)", () => {
    expect(html({ provider: "codex", parentId: "p" } as never)).toContain(">child session</div>");
    expect(html({ provider: "codex" } as never)).not.toContain("child session");
    expect(html({})).not.toContain('class="task-line"');
  });

  it("keeps the clock's box to its text: tabular figures, no minimum width", () => {
    expect(decl(".agent-node .time", "font-variant-numeric")).toBe("tabular-nums");
    expect(body(".agent-node .time")).not.toMatch(/min-width/);
  });

  it("has no single-child fragment around the cost", () => {
    expect(node).not.toContain("React.Fragment");
  });
});

describe("browser round 2", () => {
  it("draws the ask line as plain mono 12/16 text: no border, no fill, no pill, one line", () => {
    const row = ".agent-node .waiting-row";
    expect(decl(row, "font-family")).toBe("var(--font-mono)");
    expect(decl(row, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(row, "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(row, "font-weight")).toBe("400");
    expect(decl(row, "white-space")).toBe("nowrap");
    expect(body(row)).not.toMatch(/border|background|padding|radius/);
    expect(decl(".agent-node .waiting-row.permission", "color")).toBe("var(--warn)");
    expect(body(".agent-node .waiting-row.permission")).not.toMatch(/border/);
    expect(body(".agent-node .waiting-row.idle")).not.toMatch(/border/);
    expect(decl(".agent-node .waiting-said", "text-overflow")).toBe("ellipsis");
    expect(decl(".agent-node .waiting-row b", "font-weight")).toBe("400");
  });

  it("gives the model text and then the name a visible floor, in that order", () => {
    // min(6ch, max-content) is not valid CSS (a math function takes no keyword),
    // so the floor is min(6ch, 100%): "Opus..." stays readable on a long name.
    expect(decl(".agent-node .title .model-text", "min-width")).toBe("min(6ch, 100%)");
    expect(decl(".agent-node .title .label", "min-width")).toBe("min(8ch, 100%)");
  });

  it("drops the effort when the model text OR the name is cut and that would uncut it", () => {
    const m = { effortWidth: 40, max: 1 };
    expect(nextSqueeze(0, { ...m, overflow: 0, modelOverflow: 30 })).toBe(1);
    expect(nextSqueeze(0, { ...m, overflow: 0, modelOverflow: 40 })).toBe(1);
    expect(nextSqueeze(0, { ...m, overflow: 0, modelOverflow: 41 })).toBe(0);
    expect(nextSqueeze(0, { ...m, overflow: 0, modelOverflow: 0 })).toBe(0);
    expect(nextSqueeze(0, { ...m, overflow: 25, modelOverflow: 0 })).toBe(1);
    expect(nextSqueeze(0, { ...m, overflow: 90, modelOverflow: 90 })).toBe(0);
  });

  it("keeps the foot on one line", () => {
    expect(decl(".agent-node .foot", "flex-wrap")).toBe("nowrap");
  });

  describe("the foot's squeeze", () => {
    const all = { tokens: true, inflight: true, tools: true };
    it("drops tokens first, then in-flight, then the tool count", () => {
      expect(footDroppable(all)).toEqual(["tokens", "inflight", "tools"]);
      expect([...footDropped(0, all)]).toEqual([]);
      expect([...footDropped(1, all)]).toEqual(["tokens"]);
      expect([...footDropped(2, all)]).toEqual(["tokens", "inflight"]);
      expect([...footDropped(3, all)]).toEqual(["tokens", "inflight", "tools"]);
    });
    it("skips items the foot does not hold, so no notch is wasted", () => {
      const some = { tokens: false, inflight: false, tools: true };
      expect(footDroppable(some)).toEqual(["tools"]);
      expect([...footDropped(1, some)]).toEqual(["tools"]);
    });
    it("never offers cost, time, the failed count or the sub-agent count to drop", () => {
      expect(footDroppable(all)).toEqual(["tokens", "inflight", "tools"]);
      const out = html({ toolCount: 5, usage: SPENT, model: "claude-opus-5-5", childCount: 2, toolErrorCount: 1 });
      for (const kept of ["cost-meta", 'class="time"', "failed-meta", "spawn-badge"]) expect(out).toContain(kept);
      expect(node).not.toMatch(/dropped\.has\("(?:cost|time|failed|spawn)/);
    });
    it("steps down one notch per overflowing measure and stops when nothing is left", () => {
      expect(nextFootNotch(0, { overflow: 12, max: 3 })).toBe(1);
      expect(nextFootNotch(2, { overflow: 1, max: 3 })).toBe(3);
      expect(nextFootNotch(3, { overflow: 40, max: 3 })).toBe(3);
      expect(nextFootNotch(1, { overflow: 0, max: 3 })).toBe(1);
    });
    it("starts again when the card gets wider, and keeps its notch when it narrows", () => {
      expect(footNotchOnResize(2, { from: 200, to: 256 })).toBe(0);
      expect(footNotchOnResize(2, { from: 256, to: 220 })).toBe(2);
      expect(footNotchOnResize(2, { from: 256, to: 256 })).toBe(2);
    });
    it("draws every item at notch 0 (the server markup)", () => {
      const out = html({ toolCount: 5, usage: SPENT });
      expect(out).toContain("tokens-meta");
      expect(out).toContain("<b>5</b> tools");
    });
  });
});
