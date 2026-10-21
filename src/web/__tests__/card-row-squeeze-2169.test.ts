// What a busy card's model row gives up, and in what order (#2169).
//
// #2155 put the effort in the model chip and dropped it on any row it did not
// fit. A busy card has about 176px for "session → 1 Opus 5.5 · xhigh", and a
// browser check of nine busy cards found the effort on four of them: every
// session that had started a subagent lost it. The owner chose the order: the
// kind word goes first, because the spawn badge, the edge to the session and
// the card's accessible name already say it; then the effort, which the
// tooltip, the list, the peek and the details panel keep. A subagent's folder
// had a bug of its own from before #2155: as one run of text the row
// ellipsised at its end, so "subagent · customer-onboarding" pushed the model
// chip off the card entirely. Now only the folder is cut short.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { maxSqueeze, nextSqueeze, rowAt } from "../card-row-squeeze";
import { agentAriaLabel, subRowTitle } from "../agent-copy";
import type { AgentNodeData } from "../types";
import { cascade, el, selects, sheetRules } from "./sheet-cascade";

const body = (sel: string) => sheetRules().filter(r => r.media == null && r.selectors.includes(sel)).map(r => r.body).join("\n");
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

/** Paint after paint, as the card does: measure, step down, measure again. */
function settle(max: number, tooWide: (row: { kind: boolean; effort: boolean }) => boolean): number {
  let squeeze = 0;
  for (let paint = 0; paint < 5; paint++) {
    const next = nextSqueeze(squeeze, { overflowing: tooWide(rowAt(squeeze)), folderCut: false, max });
    if (next === squeeze) break;
    squeeze = next;
  }
  return squeeze;
}

describe("the order a tight row gives way in", () => {
  it("drops the kind word before the effort", () => {
    // "session → 1 Opus 5.5 · xhigh" needs 208px of 176: without "session " it fits.
    const squeeze = settle(2, row => row.kind);
    expect(rowAt(squeeze)).toEqual({ kind: false, effort: true });
  });

  it("drops the effort only when the row is still too wide without the kind word", () => {
    const squeeze = settle(2, row => row.kind || row.effort);
    expect(rowAt(squeeze)).toEqual({ kind: false, effort: false });
  });

  it("keeps the whole row where it fits", () => {
    expect(rowAt(settle(2, () => false))).toEqual({ kind: true, effort: true });
  });

  it("never steps past the model, however tight the row stays", () => {
    // The model has no notch: a row still too wide at the last one stays there.
    expect(settle(2, () => true)).toBe(2);
    expect(settle(1, () => true)).toBe(1);
  });

  it("gives up nothing on a row with no chip to protect, and nothing past the kind word with no effort", () => {
    expect(maxSqueeze({ model: null, provider: "claude" })).toBe(0);
    expect(maxSqueeze({ model: null, provider: "codex" })).toBe(1);
    expect(maxSqueeze({ model: "claude-opus-5-5", effort: null })).toBe(1);
    expect(maxSqueeze({ model: "claude-opus-5-5", effort: "xhigh" })).toBe(2);
  });

  it("counts a folder cut short as a tight row, so the folder is the last to give way", () => {
    expect(nextSqueeze(0, { overflowing: false, folderCut: true, max: 2 })).toBe(1);
    expect(nextSqueeze(1, { overflowing: false, folderCut: true, max: 2 })).toBe(2);
    expect(nextSqueeze(2, { overflowing: false, folderCut: true, max: 2 })).toBe(2);
  });
});

describe("the row the card draws", () => {
  const card = (over: Partial<AgentNodeData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
    createElement(AgentNode as never, {
      id: "s",
      data: {
        sessionId: "s", label: "Plan", kind: "subagent", state: "active", childCount: 0, tools: [],
        usage: NO_USAGE, startedAt: Date.now(), ...over,
      },
      selected: false,
    } as never)));

  it("puts a subagent's folder in a piece of its own, ahead of the chip", () => {
    const html = card({ cwdBasename: "customer-onboarding", model: "claude-sonnet-5-5", effort: "medium" });
    expect(html).toMatch(/<span>subagent<\/span><span class="sub-folder">· customer-onboarding<\/span><span class="model-chip"[^>]*>Sonnet 5\.5 · medium<\/span>/);
  });

  it("cuts only the folder short; every other piece keeps its width", () => {
    expect(body(".agent-node .sub-details")).toMatch(/display:\s*flex;/);
    expect(body(".agent-node .sub-details > *")).toMatch(/flex-shrink:\s*0;/);
    const folder = body(".agent-node .sub-details > .sub-folder");
    expect(folder).toMatch(/flex-shrink:\s*1;/);
    expect(folder).toMatch(/min-width:\s*0;/);
    expect(folder).toMatch(/text-overflow:\s*ellipsis;/);
    // Whatever leads once the kind word is gone starts at the edge, not indented,
    // the folder included; after the kind word the folder keeps its gap.
    const row = [el("div", ["agent-node"]), el("span", ["sub-details"])];
    const margin = (classes: string[], states: string[] = []) => cascade(s => selects(s, [...row, el("span", classes, { states })]), "margin-left", 1440);
    expect(margin(["sub-folder"], ["first-child"])).toBe("0");
    expect(margin(["model-chip"], ["first-child"])).toBe("0");
    expect(margin(["spawn-badge"], ["first-child"])).toBe("0");
    expect(margin(["sub-folder"])).toBe("1ch");
  });

  it("still says the kind where the row has dropped it: in its tooltip and the card's name", () => {
    const a = { kind: "root", childCount: 1, model: "claude-opus-5-5", usage: NO_USAGE, tools: [], label: "billing-api", state: "active", startedAt: 0 } as unknown as AgentNodeData;
    expect(subRowTitle(a)).toMatch(/^session · → 1 · Opus 5\.5/);
    expect(agentAriaLabel(a, 0)).toContain("session");
  });

  it("measures again when the row's width changes, before the frame is painted", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/new ResizeObserver\(/);
    // Into a state the reset hangs on: a reset alone is lost on a row still at
    // the top notch, which then keeps a kind word it no longer has room for.
    expect(src).toMatch(/flushSync\(\(\) => setRowWidth\(width\)\)/);
    expect(src).toMatch(/useBeforePaint\(\(\) => \{ setSqueeze\(0\); \}, \[[^\]]*, rowWidth\]\)/);
    expect(src).toMatch(/folderCut: !!folder && folder\.scrollWidth > folder\.clientWidth,/);
  });
});
