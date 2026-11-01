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
import { effortWillUncut, maxSqueeze, nextSqueeze, rowAt, squeezeOnResize } from "../card-row-squeeze";
import { agentAriaLabel, subRowTitle } from "../agent-copy";
import type { AgentNodeData } from "../types";
import { sheetRules } from "./sheet-cascade";

const body = (sel: string) => sheetRules().filter(r => r.media == null && r.selectors.includes(sel)).map(r => r.body).join("\n");
const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

// CHANGED ON PURPOSE (review of V4's Agent / Card). The suite pinned a two-notch
// squeeze (kind word, then effort) driven by "the row overflows or a folder is
// cut". The kind word left the head and the folder has its own line, so the
// first notch drew nothing, and the effort dropped from nearly every card
// because any overflow dropped it. The squeeze is 0 or 1 now, and the effort
// goes only when that can uncut the name.
describe("when the effort gives way", () => {
  it("drops the effort only when that can uncut the name: the overflow is no larger than the effort", () => {
    expect(effortWillUncut(10, 40)).toBe(true);
    expect(effortWillUncut(40, 40)).toBe(true);
    expect(effortWillUncut(41, 40)).toBe(false);
  });

  it("keeps the effort when the name is not cut at all", () => {
    expect(effortWillUncut(0, 40)).toBe(false);
    expect(effortWillUncut(-3, 40)).toBe(false);
  });

  it("steps down once and never past the last notch", () => {
    const m = { overflow: 10, effortWidth: 40, max: 1 };
    expect(nextSqueeze(0, m)).toBe(1);
    expect(nextSqueeze(1, m)).toBe(1);
    expect(nextSqueeze(0, { ...m, overflow: 90 })).toBe(0);
  });

  it("draws the effort at notch 0 and not at notch 1; the model has no notch", () => {
    expect(rowAt(0)).toEqual({ effort: true });
    expect(rowAt(1)).toEqual({ effort: false });
  });

  it("has something to give up only with a model and an effort", () => {
    expect(maxSqueeze({ model: null })).toBe(0);
    expect(maxSqueeze({ model: "claude-opus-5-5", effort: null })).toBe(0);
    expect(maxSqueeze({ model: "claude-opus-5-5", effort: "xhigh" })).toBe(1);
    // A Codex session with no model yet has a word, not an effort, to protect.
    expect(maxSqueeze({ model: null, effort: "high" })).toBe(0);
  });
});

describe("the squeeze starts again when the name gets wider", () => {
  it("resets when a sibling went away and the name grew", () => {
    expect(squeezeOnResize(1, { from: 120, to: 160, selfInflicted: false })).toBe(0);
  });

  it("does not reset for the widening that dropping the effort itself caused", () => {
    expect(squeezeOnResize(1, { from: 120, to: 150, selfInflicted: true })).toBe(1);
  });

  it("keeps its notch when the name narrowed", () => {
    expect(squeezeOnResize(1, { from: 160, to: 120, selfInflicted: false })).toBe(1);
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
  // model is plain text in the head now and the kind and folder are the task
  // line on a row of their own, so they no longer share a row and the folder
  // cannot take the model with it. They pin that instead: the model leaves the
  // task line, and the task line is the one piece that is cut.
  it("puts a subagent's kind and folder on the task line, and the model in the head", () => {
    const html = card({ cwdBasename: "customer-onboarding", model: "claude-sonnet-5-5", effort: "medium" });
    expect(html).toMatch(/<div class="task-line" title="subagent · customer-onboarding · Sonnet 5\.5">subagent · customer-onboarding<\/div>/);
    expect(html).toMatch(/<span class="model-text"[^>]*>Sonnet 5\.5 · medium<\/span>/);
    expect(html.indexOf('class="model-text"')).toBeLessThan(html.indexOf('class="task-line"'));
  });

  // CHANGED ON PURPOSE: this also pinned the model text as `flex: none`. It is
  // the head piece that gives way first now (see "the head's shrink order"), so
  // only the task line is pinned here as the row's own cut.
  it("cuts the task line short with an ellipsis", () => {
    const task = body(".agent-node .task-line");
    expect(task).toMatch(/white-space:\s*nowrap;/);
    expect(task).toMatch(/overflow:\s*hidden;/);
    expect(task).toMatch(/text-overflow:\s*ellipsis;/);
    // The name is the head's one piece that gives way, ahead of the model.
    expect(body(".agent-node .title .label")).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it("still says the kind where the row has dropped it: in its tooltip and the card's name", () => {
    const a = { kind: "root", childCount: 1, model: "claude-opus-5-5", usage: NO_USAGE, tools: [], label: "billing-api", state: "active", startedAt: 0 } as unknown as AgentNodeData;
    expect(subRowTitle(a)).toMatch(/^session · → 1 · Opus 5\.5/);
    expect(agentAriaLabel(a, 0)).toContain("session");
  });

  it("measures again when the NAME's width changes, before the frame is painted", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");
    // CHANGED ON PURPOSE: this observed the head (.title), whose width does not
    // change when a sibling goes away, and reset on any change. It observes the
    // label itself and resets only when the label gets wider (squeezeOnResize).
    expect(src).toMatch(/const el = labelRef\.current;[\s\S]{0,300}new ResizeObserver\(/);
    expect(src).not.toMatch(/titleRef/);
    expect(src).toMatch(/setSqueeze\(s => squeezeOnResize\(s, change\)\);/);
    expect(src).toMatch(/setLabelWidth\(change\.to\);/);
    // CHANGED ON PURPOSE: this pinned a cut folder counting as a tight row and
    // the head's reset on its width. The measurement is the label's overflow
    // against the effort's width, and the reset on data no longer lists width.
    expect(src).toMatch(/overflow: label\.scrollWidth - label\.clientWidth,/);
    expect(src).toMatch(/useBeforePaint\(\(\) => \{ setSqueeze\(0\); \}, \[data\.effort, data\.model, otherModels\.length, data\.label, data\.kind, squeezeMax\]\)/);
    expect(src).not.toMatch(/folderCut/);
  });
});

describe("the head's shrink order", () => {
  it("keeps the name a floor of about eight characters", () => {
    expect(body(".agent-node .title .label")).toMatch(/min-width:\s*min\(8ch,\s*100%\);/);
  });

  it("gives the model text way first: a 6ch floor, a far larger shrink factor, its own ellipsis", () => {
    const model = body(".agent-node .title .model-text");
    // CHANGED ON PURPOSE (browser round 2): the model text had no floor and its
    // box collapsed to 0px on a long name, so no ellipsis showed. It keeps 6ch.
    expect(model).toMatch(/min-width:\s*min\(6ch,\s*100%\);/);
    expect(model).toMatch(/text-overflow:\s*ellipsis;/);
    expect(model).toMatch(/overflow:\s*hidden;/);
    const shrink = (b: string) => Number(/flex:\s*\d+\s+(\d+)\s/.exec(b)?.[1] ?? /flex-shrink:\s*(\d+)/.exec(b)?.[1]);
    expect(shrink(model)).toBeGreaterThanOrEqual(10 * Math.max(1, shrink(body(".agent-node .title .label"))));
  });

  it("keeps the restored and ? tags whole", () => {
    expect(body(".agent-node .title .synth-tag")).toMatch(/flex:\s*none;/);
    expect(body(".agent-node .title .synth-tag")).toMatch(/white-space:\s*nowrap;/);
  });
});
