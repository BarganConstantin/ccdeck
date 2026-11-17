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
//
// CHANGED ON PURPOSE (V4 top-10 #2): the card draws no model, so it draws no
// effort, and the head has nothing left to give up. The squeeze this file
// pinned (effortWillUncut, nextSqueeze, rowAt, maxSqueeze, squeezeOnResize)
// and the label measurement that drove it are gone; the name ellipsizes in
// CSS alone. What still stands is what the tooltip and the accessible name
// say, the task line being the one cut piece, and the head's shrink order for
// what is left in it. The tooltip, the list, the peek and the Inspector keep
// the model and its effort.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import * as rowSqueeze from "../card-row-squeeze";
import { agentAriaLabel, subRowTitle } from "../agent-copy";
import type { AgentNodeData } from "../types";
import { sheetRules } from "./sheet-cascade";

const body = (sel: string) => sheetRules().filter(r => r.media == null && r.selectors.includes(sel)).map(r => r.body).join("\n");
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const src = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");

// CHANGED ON PURPOSE (V4 top-10 #2): "when the effort gives way" and "the
// squeeze starts again when the name gets wider" pinned the head's squeeze, a
// notch that dropped the effort when that could uncut the name and reset when
// the name got wider. The head holds the name and the state alone now.
describe("the head's squeeze, retired with the model", () => {
  it("leaves card-row-squeeze.ts the foot's squeeze alone", () => {
    for (const gone of ["effortWillUncut", "maxSqueeze", "nextSqueeze", "rowAt", "squeezeOnResize"]) {
      expect(gone in rowSqueeze, gone).toBe(false);
    }
    for (const kept of ["footDroppable", "footDropped", "nextFootNotch", "footNotchOnResize"]) {
      expect(typeof (rowSqueeze as Record<string, unknown>)[kept], kept).toBe("function");
    }
  });

  it("measures nothing in the head: no label ref, no squeeze state, no observer on the name", () => {
    expect(src).not.toMatch(/labelRef|modelRef|setSqueeze|setLabelWidth|squeezeOnResize/);
    expect(src).not.toMatch(/titleRef/);
    expect(src).not.toMatch(/folderCut/);
    // The foot still measures itself (card-row-squeeze.ts's other half).
    expect(src).toMatch(/footRef/);
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

  // CHANGED ON PURPOSE (V4's Agent / Card). These two cases pinned the second
  // row: a subagent's folder in a piece of its own AHEAD of the model chip, and
  // the folder the only piece cut short so the chip was never pushed off. The
  // kind and folder are the task line on a row of their own.
  // CHANGED ON PURPOSE (V4 top-10 #2): this also held the model in the head
  // ("sonnet 5.5 · medium"). The card draws no model now; the task line's
  // tooltip still names it.
  it("puts a subagent's kind and folder on the task line, and no model on the card", () => {
    const html = card({ cwdBasename: "customer-onboarding", model: "claude-sonnet-5-5", effort: "medium" });
    expect(html).toMatch(/<div class="task-line" title="subagent · customer-onboarding · sonnet 5\.5">subagent · customer-onboarding<\/div>/);
    expect(html).not.toContain("model-text");
    expect(html).not.toContain("sonnet 5.5 · medium");
  });

  // CHANGED ON PURPOSE: this also pinned the model text as `flex: none`.
  // CHANGED ON PURPOSE (V4 top-10 #2): one line cut with an ellipsis → two
  // lines clamped, because one line cut most tasks after four words.
  it("cuts the task line short at two lines", () => {
    const task = body(".agent-node .task-line");
    expect(task).toMatch(/-webkit-line-clamp:\s*2;/);
    expect(task).toMatch(/(?:^|[;\s])line-clamp:\s*2;/);
    expect(task).toMatch(/overflow:\s*hidden;/);
    expect(task).not.toMatch(/white-space:\s*nowrap;/);
    // The name is the head's one piece that gives way.
    expect(body(".agent-node .title .label")).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it("still says the kind where the row has dropped it: in its tooltip and the card's name", () => {
    const a = { kind: "root", childCount: 1, model: "claude-opus-5-5", usage: NO_USAGE, tools: [], label: "billing-api", state: "active", startedAt: 0 } as unknown as AgentNodeData;
    expect(subRowTitle(a)).toMatch(/^session · → 1 · opus 5\.5/);
    expect(agentAriaLabel(a, 0)).toContain("session");
  });
});

describe("the head's shrink order", () => {
  // CHANGED ON PURPOSE (V4's Agent / Card): this pinned a floor of about eight
  // characters on the name. That floor held a short name's box open, so a
  // marker started a gap after "infra" rather than 6px after it.
  it("gives the name no floor of its own, so a marker follows a short name closely", () => {
    const label = body(".agent-node .title .label");
    expect(label).toMatch(/min-width:\s*0;/);
    expect(label).not.toMatch(/min\(8ch/);
    expect(body(".agent-node")).toMatch(/min-width:\s*calc\(220px/);
  });

  // CHANGED ON PURPOSE (V4 top-10 #2): "gives the model text way first" held
  // the model text to a 6ch floor and a far larger shrink factor than the
  // name. The model text and its rule are gone.
  it("has no model text left to give way", () => {
    expect(body(".agent-node .title .model-text")).toBe("");
  });

  it("keeps the restored and ? tags whole", () => {
    expect(body(".agent-node .title .synth-tag")).toMatch(/flex:\s*none;/);
    expect(body(".agent-node .title .synth-tag")).toMatch(/white-space:\s*nowrap;/);
  });
});
