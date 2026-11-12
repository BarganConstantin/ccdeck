// One meaning per glyph (critique 3, point 9). A ▷ in a panel header read
// "run" beside + and ↻; the card's context ring sat beside the Working mark, two
// circles meaning two things; and Accounts kept + and ↻ live while the tool
// they ask was missing. The ⓘ menu itself is opened in v4-panel-info.test.tsx,
// and the phone stage's "17% context" is pinned in v4-term-pane.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import AccountsHeader, { swapMissing } from "../components/AccountsHeader";
import type { AgentNodeData } from "../types";

const SPENT = { inputTokens: 30_000, outputTokens: 4_000, cacheReadTokens: 0, cacheCreateTokens: 0 };
const card = (over: Partial<AgentNodeData> & { onOpenContext?: (id: string) => void } = {}) => renderToStaticMarkup(
  createElement(ReactFlowProvider, null, createElement(AgentNode as never, {
    id: "s", selected: false,
    data: {
      sessionId: "s", label: "ccdeck", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 3,
      usage: SPENT, prompts: [], startedAt: Date.now(), model: "claude-opus-5",
      context: { currentContextTokens: 34_000 }, contextWindow: 200_000, onOpenContext: () => {},
      ...over,
    },
  } as never)));
const part = (html: string, cls: string) => new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`).exec(html)?.[1] ?? "";

describe("the card's context ring", () => {
  it("leaves the head, which keeps one circle: the state's", () => {
    const head = /<div class="head-right">([\s\S]*?)<\/div>/.exec(card())![1];
    expect(head).toContain('class="state-line"');
    expect(head).not.toContain("ctx-donut");
  });

  it("sits in the foot right after the token figure, with its percent as text and no dot between", () => {
    const foot = part(card(), "foot");
    expect(foot).toMatch(/<span class="tokens-meta"[^>]*><b>[^<]+<\/b> tok<\/span><button type="button" class="ctx-donut"/);
    expect(foot).toMatch(/<span class="ctx-donut-pct">17%<\/span><\/button>/);
    // Its name still says the number and where the press leads.
    expect(foot).toMatch(/aria-label="Context 17% of 200,000 tokens — show breakdown"/);
  });

  it("stays on the card when there is no token figure, after a dot like any other item", () => {
    const foot = part(card({ usage: { ...SPENT, inputTokens: 0, outputTokens: 0 } }), "foot");
    expect(foot).not.toContain("tokens-meta");
    expect(foot).toMatch(/<span class="foot-sep" aria-hidden="true">·<\/span><button type="button" class="ctx-donut"/);
  });

  it("is not drawn with nothing used, on a subagent, or with no breakdown to open", () => {
    for (const over of [
      { context: { currentContextTokens: 0 } },
      { kind: "subagent" },
      { onOpenContext: undefined },
    ] as const) expect(card(over as never), JSON.stringify(over)).not.toContain("ctx-donut");
  });
});

describe("the accounts header while claude-swap is missing", () => {
  const header = (noSwap: boolean) => renderToStaticMarkup(createElement(AccountsHeader, {
    canShare: true, onAdd: () => {}, onShareSet: () => {}, onReload: () => {},
    pressProps: () => ({}), reloading: false, noSwap,
    closeButton: createElement("button", { type: "button", className: "glyph-btn ap-close", "aria-label": "Close" }),
  }));

  it("draws only the close: no ⓘ, no +, no share, no ↻", () => {
    const right = /<div class="ap-header-right">([\s\S]*)<\/div><\/div>$/.exec(header(true))![1];
    expect(right).toBe('<button type="button" class="glyph-btn ap-close" aria-label="Close"></button>');
  });

  it("draws them all once it is there, the ⓘ first and the close last", () => {
    const html = header(false);
    const at = (s: string) => html.indexOf(s);
    expect(at("panel-info")).toBeGreaterThan(-1);
    expect(at("panel-info")).toBeLessThan(at("ap-add"));
    expect(at("ap-add")).toBeLessThan(at("ap-refresh"));
    expect(at("ap-refresh")).toBeLessThan(at("ap-close"));
    expect(html).not.toContain("film-icon");
  });

  it("is missing while it is not installed or still installing, and only then", () => {
    expect(swapMissing({ ok: false, reason: "no_cswap" })).toBe(true);
    expect(swapMissing({ ok: false, reason: "cswap_installing" })).toBe(true);
    for (const data of [null, undefined, { ok: true }, { ok: false, reason: "no_accounts" },
      { ok: false, reason: "cswap_refused" }, { ok: false, reason: "EACCES" }]) {
      expect(swapMissing(data), JSON.stringify(data)).toBe(false);
    }
    // The panel asks it of the roster it holds.
    const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/<AccountsHeader [\s\S]*?noSwap=\{swapMissing\(data\)\} \/>/);
  });
});
