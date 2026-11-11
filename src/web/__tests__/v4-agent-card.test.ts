// V4's agent card (its Figma kit, Agent / Card), the detail face only:
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
import { cardState, markBesideFailures, stateMarkKind } from "../node-face";
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
    // CHANGED ON PURPOSE (V4's Figma, Agent / Card): the left side was 4px wider
    // than V4's 10 for the session stripe; the stripe is gone, so it is 10 too.
    // (Seen in the browser: 8px * --ui-space gave 5.6px at Compact, not Figma's 8.
    // The vertical padding is 8 at Compact (space 0.7) and 10 at Default (space
    // 1, what the card has had), and keeps growing with density.)
    // V4 draws the 1px edge inside the 8 and 10, so CSS pads 1px less on each
    // side to land on the same outer box.
    const v = "calc(8px + (var(--ui-space, 1) - 0.7) * 20px / 3 - 1px)";
    expect(decl(".agent-node", "padding")).toBe(`${v} calc(10px - 1px)`);
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
  // CHANGED ON PURPOSE (owner decision, V4's Agent / Card): no shadow at rest or
  // under the pointer in either theme, and no session stripe: hue stays on the
  // wires. These replace the tests that held the shadow, its lift, the stripe
  // and the three state borders.
  it("has no shadow, at rest or lifted, and the hover is a tint", () => {
    expect(decl(".agent-node", "box-shadow")).toBe("none");
    expect(sheet).not.toMatch(/(?:^|\})\s*[^{}]*\.agent-node:hover\s*\{[^}]*box-shadow/);
    expect(decl(".agent-node:hover", "background")).toBe("color-mix(in srgb, var(--text) 6%, var(--panel))");
  });
  it("has no session stripe", () => {
    expect(sheet).not.toMatch(/\.agent-node \.accent-stripe/);
    expect(node).not.toContain("accent-stripe");
    expect(html({})).not.toContain("accent-stripe");
  });
  it("edges every state in --line and only Waiting in --warn, in every theme", () => {
    expect(decl(".agent-node", "border")).toBe("1px solid var(--line)");
    expect(decl(".agent-node[data-alarm]", "border-color")).toBe("var(--warn)");
    // No rule names a card's state edge (a :where(), a list, a theme prefix)
    // and sets border-color.
    const edges = [...sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(m => /\.agent-node\.state-(?:active|done|err)\b(?!\s*>)/.test(m[1]) && /border-color/.test(m[2]))
      .map(m => m[1].trim());
    expect(edges).toEqual([]);
    expect(html({ state: "active", waiting: { kind: "permission", since: 1 } as never })).toMatch(/class="agent-node state-active" data-alarm=""/);
    expect(html({ state: "done", waiting: { kind: "idle", since: 1 } as never })).not.toMatch(/agent-node[^>]*data-alarm/);
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
    expect(out).toMatch(/<span class="model-text" title="claude-opus-5-5\neffort: high">opus 5\.5 · high<\/span>/);
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
    // Design recommendations (2026-11-09): a session never given a prompt is
    // Ready, as its list group says, where it said Working with nothing at work.
    ["never given a prompt", { state: "active", toolCount: 0, prompts: [] }, "Ready", "ready", "--muted", "idle"],
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

describe("Ready, a session not yet given a prompt", () => {
  it("is Ready only before the first prompt and the first tool, and only on a root at rest", () => {
    expect(cardState(T({ toolCount: 0, prompts: [] })).word).toBe("Ready");
    expect(cardState(T({ toolCount: 0, prompts: [{ text: "go", at: 1 }] as never })).word).toBe("Working");
    expect(cardState(T({ toolCount: 1, prompts: [] })).word).toBe("Working");
    expect(cardState(T({ kind: "subagent", toolCount: 0, prompts: [] } as never)).word).toBe("Working");
    expect(cardState(T({ toolCount: 0, prompts: [], job: { id: "j", state: "working", detail: "", updatedAt: 1 } } as never)).word).toBe("Working");
    expect(cardState(T({ state: "done", toolCount: 0, prompts: [] })).word).toBe("Done");
    expect(cardState(T({ toolCount: 0, prompts: [], waiting: { kind: "permission", since: 1 } as never })).word).toBe("Waiting");
  });

  it("draws the hollow ring and the word in --muted, nothing breathing", () => {
    const out = html({ toolCount: 0, prompts: [] });
    expect(out).toMatch(/<span class="state-line" data-tone="ready"><svg class="state-mark" data-kind="idle"[^>]*>[\s\S]*?<\/svg><span class="state-word">Ready<\/span><\/span>/);
    expect(sheet).not.toMatch(/\.state-line\[data-tone="ready"\][^{]*\{[^}]*animation/);
  });

  it("wears the quiet edge, not Working's, on a variable the face's border reads before the state's", () => {
    expect(html({ toolCount: 0, prompts: [] })).toMatch(/class="agent-node state-active ready"/);
    expect(html({ toolCount: 1, prompts: [] })).not.toMatch(/class="agent-node[^"]*\bready\b/);
    expect(decl(".agent-node.ready > .lod-face", "--lod-ready")).toBe("color-mix(in srgb, var(--muted) 60%, transparent)");
    expect(sheet).toContain("border: 1px solid var(--lod-alarm, var(--lod-ready, var(--lod-edge, var(--line))));");
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
  it("is absent for a root with neither a name, a title nor a prompt", () => {
    expect(html({})).not.toContain("task-line");
  });
  // V4's Agent / Card: every root carries its prompt line, and most sessions
  // (every Codex one) have no name or title to put there.
  it("says the first prompt's first line for a root with neither a name nor a title", () => {
    expect(html({ firstPrompt: "Add rate limiting to the public API" }))
      .toContain('<div class="task-line" title="Add rate limiting to the public API">Add rate limiting to the public API</div>');
    const two = html({ firstPrompt: "Fix the flaky test\nIt fails on CI only" });
    expect(two).toMatch(/<div class="task-line" title="Fix the flaky test\nIt fails on CI only">Fix the flaky test<\/div>/);
    // A name or a title still wins over the prompt.
    expect(html({ sessionTitle: "Rate limits", firstPrompt: "Add rate limiting" })).toContain(">Rate limits</div>");
    // The far face's one line says the same (CHANGED ON PURPOSE, owner's
    // critique 2026-11-11: it was the face's title line).
    expect(html({ firstPrompt: "Add rate limiting" })).toContain('<span class="lod-name">Add rate limiting</span>');
  });
  it("says what a subagent's spawning call said it is for, and the kind and folder without one", () => {
    const out = html({ kind: "subagent", label: "Explore", cwdBasename: "web-api", spawnCall: { id: "t1", description: "Find every public route" } });
    expect(out).toMatch(/<div class="task-line" title="Find every public route\nsubagent · web-api">Find every public route<\/div>/);
    expect(html({ kind: "subagent", cwdBasename: "web-api", spawnCall: { id: "t1" } })).toContain(">subagent · web-api</div>");
    expect(html({ kind: "subagent", cwdBasename: "web-api" })).toContain(">subagent · web-api</div>");
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
  // CHANGED ON PURPOSE (V4's Figma, Agent / Card): the sub-agent count is the
  // number and the kit's Agents icon, 4px apart, at the foot's end (the spacer
  // is the end group's auto margin), no longer "→ N".
  it("closes with the sub-agent count and the Agents icon after a spacer", () => {
    expect(decl(".agent-node .foot .foot-end", "margin-left")).toBe("auto");
    expect(decl(".agent-node .foot .spawn-badge", "color")).toBe("var(--text-secondary)");
    expect(decl(".agent-node .foot .spawn-badge", "gap")).toBe("4px");
    expect(sheet).not.toMatch(/(?:^|\})\s*\.spawn-badge\s*\{/);
  });
  // CHANGED ON PURPOSE (V4's Figma, Agent / Card): the foot no longer prints
  // "5 tools" or "1 err"; the tool icons' tooltip says both, as do the card's
  // accessible name and the Inspector.
  it("reads cost · time · tokens, then the sub-agent count, with no tools or err words", () => {
    const out = html({ toolCount: 5, toolErrorCount: 1, usage: SPENT, model: "claude-opus-5-5", childCount: 2 });
    const foot = /<div class="foot">([\s\S]*?)<\/div>/.exec(out)![1];
    const at = (s: string) => foot.indexOf(s);
    expect(at("cost-meta")).toBeGreaterThan(-1);
    expect(at("cost-meta")).toBeLessThan(at('class="time"'));
    expect(at('class="time"')).toBeLessThan(at("tokens-meta"));
    expect(foot).not.toMatch(/\btools?\b|\berr\b|failed-meta/);
    expect(at("tokens-meta")).toBeLessThan(at("spawn-badge"));
    expect(foot).toContain('<span class="foot-sep" aria-hidden="true">·</span>');
    expect(foot).toMatch(/<span class="foot-end"><span class="spawn-badge"[^>]*>2<svg[^>]*>[\s\S]*<\/svg><\/span><\/span>$/);
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
      ".agent-node .foot .inflight-meta", ".agent-node .foot .spawn-badge",
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
      [{ state: "active", toolCount: 0, prompts: [] }, "Ready"],
    ];
    for (const [over, word] of cases) {
      expect(cardState(T(over)).word).toBe(word);
      expect(agentAriaLabel(T(over), 0), word).toContain(`, ${word}`);
      expect(html(over)).toContain(`>${word}</span>`);
    }
  });

  // CHANGED ON PURPOSE (V4's Figma, Agent / Card): the ask row (waiting, and a
  // stop with its reason) is drawn, so it sits on the column's 2px gap alone
  // (that is what makes a Waiting card 88); the activity row is gone. The rows
  // Figma still does not draw share the 4px top spacing.
  it("gives the rows Figma does not draw one shared top spacing, and the ask row none", () => {
    const rows = [".continued-row", ".approval-blind-row", ".plan-row"];
    expect(decl(`.agent-node :is(${rows.join(", ")})`, "margin-top")).toBe("calc(4px * var(--ui-space, 1))");
    for (const r of [...rows, ".waiting-row", ".stop-row"]) expect(body(`.agent-node ${r}`), r).not.toMatch(/margin(-top)?\s*:/);
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

describe("fixes found in the browser", () => {
  it("draws the ask line as plain mono 12/16 text: no border, no fill, no pill, one line", () => {
    const row = ".agent-node .waiting-row";
    expect(decl(row, "font-family")).toBe("var(--font-mono)");
    expect(decl(row, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(row, "line-height")).toBe("calc(16px + var(--ui-text-increase, 0px))");
    expect(decl(row, "font-weight")).toBe("400");
    expect(decl(row, "white-space")).toBe("nowrap");
    expect(body(row)).not.toMatch(/border|background|padding|radius/);
    // One Waiting colour in V4: the row itself is --warn, so a
    // permission ask and an idle prompt read alike, and no kind recolours it.
    expect(decl(row, "color")).toBe("var(--warn)");
    expect(sheet).not.toMatch(/\.waiting-row\.(permission|idle)\b/);
    expect(decl(".agent-node .waiting-said", "text-overflow")).toBe("ellipsis");
    // CHANGED ON PURPOSE (V4's Agent / Card): no clock in the row, so no rule
    // for one.
    expect(sheet).not.toMatch(/\.waiting-row b\b/);
  });

  // CHANGED ON PURPOSE (V4's Agent / Card): the name has no floor of its own.
  // min(8ch, 100%) held a short name's box at 8ch, so the model started about
  // 25px after "infra" instead of 6px.
  it("gives the model text a visible floor, and the name none, so the model follows the name", () => {
    // min(6ch, max-content) is not valid CSS (a math function takes no keyword),
    // so the floor is min(6ch, 100%): "opus..." stays readable on a long name.
    expect(decl(".agent-node .title .model-text", "min-width")).toBe("min(6ch, 100%)");
    expect(decl(".agent-node .title .label", "min-width")).toBe("0");
    // The model still gives way first.
    expect(decl(".agent-node .title .model-text", "flex")).toBe("0 100 auto");
    expect(decl(".agent-node .title .label", "flex")).toBe("0 1 auto");
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

  // CHANGED ON PURPOSE (V4's Agent / Card): the tool count left the foot, so
  // the squeeze has two items to drop, not three.
  describe("the foot's squeeze", () => {
    const all = { tokens: true, inflight: true };
    it("drops tokens first, then in-flight", () => {
      expect(footDroppable(all)).toEqual(["tokens", "inflight"]);
      expect([...footDropped(0, all)]).toEqual([]);
      expect([...footDropped(1, all)]).toEqual(["tokens"]);
      expect([...footDropped(2, all)]).toEqual(["tokens", "inflight"]);
    });
    it("skips items the foot does not hold, so no notch is wasted", () => {
      const some = { tokens: false, inflight: true };
      expect(footDroppable(some)).toEqual(["inflight"]);
      expect([...footDropped(1, some)]).toEqual(["inflight"]);
    });
    it("never offers the tool icons, cost, time or the sub-agent count to drop", () => {
      expect(footDroppable(all)).toEqual(["tokens", "inflight"]);
      const tools = [{ id: "r1", name: "Read", inputPreview: "", startedAt: 1, endedAt: 2 }];
      const out = html({ tools: tools as never, toolCount: 5, usage: SPENT, model: "claude-opus-5-5", childCount: 2, toolErrorCount: 1 });
      for (const kept of ["foot-tools", "cost-meta", 'class="time"', "spawn-badge"]) expect(out).toContain(kept);
      expect(node).not.toMatch(/dropped\.has\("(?:cost|time|tools|spawn)/);
    });
    it("says the call and failure counts in the tool icons' tooltip", () => {
      const tools = [{ id: "r1", name: "Read", inputPreview: "", startedAt: 1, endedAt: 2 }];
      expect(html({ tools: tools as never, toolCount: 5, toolErrorCount: 2 })).toMatch(/<span class="foot-tools" title="[^"]*\n5 tools, 2 failed">/);
      expect(html({ tools: tools as never, toolCount: 1 })).toMatch(/<span class="foot-tools" title="[^"]*\n1 tool">/);
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
      const tools = [{ id: "b1", name: "Bash", inputPreview: "", startedAt: 1 }];
      const out = html({ tools: tools as never, toolCount: 5, usage: SPENT });
      expect(out).toContain("tokens-meta");
      expect(out).toContain("inflight-meta");
    });
  });
});

// V4's Agent / Card, Waiting and Failed: the ask row is the call (or the
// question) in mono Signal/Waiting with no dot and no clock, and the stop row
// is its reason with no dot.
describe("the ask row and the stop row", () => {
  const SAID = "Claude needs your permission to use Bash";
  const block = (over: object) => ({ kind: "permission", message: SAID, since: Date.now() - 322_000, ...over }) as never;
  const row = (out: string, cls: string) => new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)</div>`).exec(out)?.[1];
  it("reads a permission prompt as the call it is most likely about, with no dot and no clock", () => {
    const out = html({ state: "active", waiting: block({ tool: { name: "Bash", preview: "npm test -- rate-limit" } }) });
    expect(row(out, "waiting-row")).toBe('<span class="waiting-said">Bash · npm test -- rate-limit</span>');
    expect(out).not.toMatch(/ap-pulse|waiting-dot/);
    expect(row(out, "waiting-row")).not.toMatch(/<b>|\d+m \d\ds/);
  });
  it("keeps Claude Code's sentence, the hedge on the guess and the wait in the tooltip", () => {
    const out = html({ state: "active", waiting: block({ tool: { name: "Bash", preview: "npm test -- rate-limit" } }) });
    expect(out).toMatch(new RegExp(`<div class="waiting-row" title="${SAID}\\nLikely on: npm test -- rate-limit\\nBlocked for 5m 2\\ds`));
  });
  it("says the call's name alone without a preview, the sentence without a call, the question, and Your turn", () => {
    expect(row(html({ waiting: block({ tool: { name: "WebFetch", preview: "" } }) }), "waiting-row")).toBe('<span class="waiting-said">WebFetch</span>');
    expect(row(html({ waiting: block({}) }), "waiting-row")).toBe(`<span class="waiting-said">${SAID}</span>`);
    const asked = "paycore needs your input: merge both branches to main, or just one?";
    expect(row(html({ waiting: block({ kind: "asked", message: asked, tool: { name: "Bash", preview: "git merge" } }) }), "waiting-row"))
      .toBe(`<span class="waiting-said">${asked}</span>`);
    expect(row(html({ state: "done", waiting: block({ kind: "idle", message: "Claude is waiting for your input" }) }), "waiting-row"))
      .toBe('<span class="waiting-said">Your turn</span>');
  });
  it("draws the failed card's reason with no dot", () => {
    const out = html({ state: "done", stopFailure: { kind: "usage-limit", error: "rate_limit", message: "", at: 1 } as never });
    const stop = /<div class="stop-row"[^>]*>([\s\S]*?)<\/div>/.exec(out)![1];
    expect(stop).toMatch(/^<span class="stop-said">[^<]+<\/span>/);
    expect(stop).not.toContain("waiting-dot");
  });
});

// CHANGED ON PURPOSE (owner's critique, 2026-11-11, point 3): below the detail
// tier a card's face drew its name, a signal line and a title line, and the
// narrowest face drew the state's word alone. Every face below the detail tier
// is one task line and a status now: the mark and the word, Working, Done,
// Waiting or "1 failed". The word is never cut: without room it wraps to the
// line the row clips, and the mark says the state by its shape and colour.
// The cluster's pill names the session. How it measures is checked in a
// browser; this pins the markup and the rules.
describe("the face below the detail tier", () => {
  const face = (over: Partial<AgentNodeData>) => {
    const out = html(over);
    const at = out.indexOf('class="lod-face"');
    return out.slice(out.lastIndexOf("<div", at));
  };
  const css = read("../styles/agent-node.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const notice = "<task-notification>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";

  it("draws one line: the mark, the task, the word", () => {
    expect(face({ state: "active", prompts: [{ at: 1, text: "Add rate limiting" }] }))
      .toMatch(/<div class="lod-line" data-status="active"><svg class="state-mark" data-kind="live"[\s\S]*?<\/svg><span class="lod-name">Add rate limiting<\/span><span class="lod-state">Working<\/span><\/div><\/div>/);
    expect(face({ state: "active", toolCount: 0 })).toContain('<span class="lod-state">Ready</span>');
    expect(face({ state: "done" })).toContain('<span class="lod-state">Done</span>');
    expect(face({ state: "err" })).toMatch(/data-status="err"[\s\S]*<span class="lod-state">Failed<\/span>/);
    for (const gone of ["lod-id", "lod-title", "lod-signal", "lod-inline", "lod-long"]) expect(face({ state: "active" })).not.toContain(gone);
  });

  it("says the task a person last asked, never a background task's notice, else the title", () => {
    const prompts = [{ at: 1, text: "Fix login" }, { at: 2, text: "Now the logout" }, { at: 3, text: notice }];
    expect(face({ prompts })).toContain('<span class="lod-name">Now the logout</span>');
    expect(face({ prompts: [{ at: 3, text: notice }], firstPrompt: notice, sessionTitle: "Rate limits" }))
      .toContain('<span class="lod-name">Rate limits</span>');
    expect(face({})).toContain('<span class="lod-name">billing-api</span>');
    // A subagent: what its spawning call said it is for, else its name.
    expect(face({ kind: "subagent", label: "Explore", spawnCall: { id: "t1", description: "Find every public route" } }))
      .toContain('<span class="lod-name">Find every public route</span>');
    expect(face({ kind: "subagent", label: "Explore" })).toContain('<span class="lod-name">Explore</span>');
  });

  it("says Waiting with the alert mark in place of the state's on a session blocked on you", () => {
    const out = face({ state: "active", waiting: { kind: "permission", since: 1, message: "Claude needs your permission to use Bash" } as never });
    expect(out).toMatch(/<div class="lod-line" data-status="waiting"><svg class="alert-mark"[\s\S]*?<span class="lod-state">Waiting<\/span>/);
    expect(out).not.toContain('class="state-mark"');
  });

  it("keeps the task to one cut line and the word whole: a row one line tall that wraps and clips", () => {
    const rule = (sel: string) => {
      const at = css.indexOf(`\n${sel} {`);
      expect(at, sel).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    const line = rule(".lod-line");
    for (const d of ["flex: none;", "flex-wrap: wrap;", "align-content: flex-start;", "overflow: hidden;", "height: calc(14px + var(--ui-text-increase, 0px));"]) expect(line).toContain(d);
    const name = rule(".lod-name");
    for (const d of ["text-overflow: ellipsis;", "white-space: nowrap;", "min-width: 50%;"]) expect(name).toContain(d);
    const word = rule(".lod-state");
    expect(word).toContain("flex: none;");
    expect(word).not.toMatch(/text-overflow|overflow:/);
    expect(css).toMatch(/\.lod-line\[data-status="waiting"\] \.lod-state \{ color: var\(--warn\); \}/);
    expect(css).toMatch(/\.lod-line\[data-status="err"\] \.lod-state \{ color: var\(--err\); \}/);
  });

  it("gives the task a line of its own and the status the one under it where the face has room for two", () => {
    const at = css.indexOf("@container lod (min-height: 28px)");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("\n}\n", at));
    expect(block).toMatch(/\.lod-line \{ height: calc\(2 \* \(14px \+ var\(--ui-text-increase, 0px\)\)\); \}/);
    expect(block).toMatch(/\.lod-name \{ order: -1; flex-basis: 100%; \}/);
    // The old per-height and narrowest queries are gone: one face at both distances.
    expect(css).not.toMatch(/@container lod \((?:max-height|max-width)/);
  });

  it("draws no \"now\" note and no dotted tie beside the face, and both at the detail tier", () => {
    const hidden = /\.canvas-wrap\[data-lod="compact"\] \.react-flow__node-recapNote, \.canvas-wrap\[data-lod="overview"\] \.react-flow__node-recapNote, \.canvas-wrap\[data-lod="compact"\] \.react-flow__edge-recapTie, \.canvas-wrap\[data-lod="overview"\] \.react-flow__edge-recapTie \{\s*visibility: hidden;\s*\}/;
    expect(sheet).toMatch(hidden);
    // Hidden, not removed: the note keeps its box, so nothing moves with the distance.
    expect(sheet).not.toMatch(/react-flow__(?:node-recapNote|edge-recapTie)[^{]*\{[^}]*display: none/);
    expect(sheet).not.toMatch(/data-lod="detail"\][^{]*react-flow__(?:node-recapNote|edge-recapTie)/);
  });
});

// Owner 2026-11-10 critique: a finished card whose calls failed drew done's
// green tick beside "1 failed", the mark saying success and the words failure.
// Where the face can say the count, the mark follows the worst state.
describe("a face never draws the tick beside a failure count", () => {
  const face = (over: Partial<AgentNodeData>) => {
    const out = html(over);
    const at = out.indexOf('class="lod-face"');
    return out.slice(out.lastIndexOf("<div", at));
  };
  const mark = (out: string) => /<div class="lod-line"[^>]*><svg class="state-mark" data-kind="(\w+)"/.exec(out)?.[1];

  it("draws the cross on a finished card whose calls failed, and the count where the word goes", () => {
    const out = face({ state: "done", toolErrorCount: 1 });
    expect(mark(out)).toBe("err");
    // Never "Done" beside the cross.
    expect(out).toMatch(/data-status="err"[\s\S]*<span class="lod-state">1 failed<\/span>/);
  });

  it("keeps the tick when nothing failed, and the live ring on a card still at work", () => {
    expect(mark(face({ state: "done" }))).toBe("done");
    expect(mark(face({ state: "active", toolErrorCount: 2 }))).toBe("live");
    expect(face({ state: "active", toolErrorCount: 2 })).toContain('<span class="lod-state">Working</span>');
  });

  it("is one rule, shared with the navigator", () => {
    expect(markBesideFailures("done", 1)).toBe("err");
    expect(markBesideFailures("done", 0)).toBe("done");
    expect(markBesideFailures("live", 3)).toBe("live");
    expect(markBesideFailures("idle", 0)).toBe("idle");
  });
});
