// V4's board header (its Figma Board › bhead 22:14910): the strip across the top
// of the canvas cell with five figures. The CSS is read the way v4-bars.test.ts
// reads it; the figures are driven through the pure module with made-up agents,
// so no DOM is needed. Tokens only: no hex or rgba in the new sheet.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOARD_HEAD_LABELS, BOARD_HEAD_NONE, boardHeadFigures, boardHeadShown, doneToday, startOfLocalDay,
} from "../board-header";
import { boardRect } from "../board-rect";
import { heldReading } from "../use-canvas-size";
import { boardScopeTitle } from "../board-usage";
import { MISSING_PRICE_NOTE } from "../reported-cost";
import type { AgentNodeData, TokenUsage, WaitingBlock } from "../types";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const own = read("../styles/board-header.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector`, within
 *  `scope` (the whole sheet by default): last one wins, as the cascade has it. */
function decls(selector: string, scope = sheet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).includes(selector)) continue;
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[d[1]] = d[2].replace(/\s+/g, " ");
  }
  return out;
}
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;

const NOW = new Date(2026, 10, 1, 15, 30, 0).getTime(); // Sunday 1 Nov, 15:30 local
const TODAY = new Date(2026, 10, 1, 9, 0, 0).getTime();
const YESTERDAY = new Date(2026, 9, 31, 23, 59, 0).getTime();

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, ...over,
});
function agent(id: string, over: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    id, sessionId: id, label: id, kind: "root", state: "active", startedAt: TODAY, tools: [],
    usage: usage(), ...over,
  } as AgentNodeData;
}
const block = (kind: WaitingBlock["kind"], since: number): WaitingBlock => ({ kind, since } as WaitingBlock);
const PRICED = { model: "claude-opus-5", usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000 }) };
const UNPRICED = { model: "no-such-model-9", usage: usage({ inputTokens: 5000, outputTokens: 5000 }) };

describe("the strip's geometry, word for word from the Figma", () => {
  const head = decls(".board-head", own);
  it("is 56 tall by the token, padded 0 24, 24 apart, centred, flat over --bg and a --line rule", () => {
    expect(head["height"]).toBe("var(--board-head-h)");
    expect(head["box-sizing"]).toBe("border-box");
    expect(head["padding"]).toBe("0 24px");
    expect(head["gap"]).toBe("24px");
    expect(head["align-items"]).toBe("center");
    expect(head["background"]).toBe("var(--bg)");
    expect(head["border-bottom"]).toBe("1px solid var(--line)");
  });
  it("declares the token as 56px once, in tokens.css, for every density", () => {
    expect(decls(":root", read("../styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, ""))["--board-head-h"]).toBe("56px");
    expect(read("../styles/reading.css")).not.toContain("--board-head-h");
  });
  it("never wraps and never scrolls", () => {
    expect(head["white-space"]).toBe("nowrap");
    expect(head["overflow"]).toBe("hidden");
    expect(head["flex"]).toBe("none");
  });
  it("sets a stat as a column with no gap, number mono 18/24 600 over a label 12/16 400 in --muted", () => {
    expect(decls(".bh-stat", own)["flex-direction"]).toBe("column");
    expect(decls(".bh-stat", own)["gap"]).toBe("0");
    const num = decls(".bh-num", own);
    expect(num["font-family"]).toBe("var(--font-mono)");
    expect(num["font-size"]).toBe(INC(18));
    expect(num["line-height"]).toBe("24px");
    expect(num["font-weight"]).toBe("600");
    expect(num["color"]).toBe("var(--text)");
    const label = decls(".bh-label", own);
    expect(label["font-size"]).toBe(INC(12));
    expect(label["line-height"]).toBe("16px");
    expect(label["font-weight"]).toBe("400");
    expect(label["color"]).toBe("var(--muted)");
  });
  it("colours a waiting count --warn and a dash --muted, by attribute", () => {
    expect(decls('.bh-num[data-tone="warn"]', own)["color"]).toBe("var(--warn)");
    expect(decls('.bh-num[data-tone="none"]', own)["color"]).toBe("var(--muted)");
  });
  it("has no hex or rgba of its own, and no motion", () => {
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(own).not.toMatch(/transition|animation|@keyframes/);
  });
});

describe("narrow boards drop stats, last first, in a container query on the strip", () => {
  it("drops the fifth below 640, the fourth below 500, the third below 400, the second below 200, never the first", () => {
    const queries = [...own.matchAll(/@container\s+board-head\s*\(max-width:\s*(\d+)px\)\s*\{([^]*?)\}\s*\}/g)]
      .map(m => [Number(m[1]), m[2].match(/nth-child\((\d)\)/)![1]]);
    expect(queries).toEqual([[640, "5"], [500, "4"], [400, "3"], [200, "2"]]);
    expect(decls(".board-head", own)["container-type"]).toBe("inline-size");
    expect(own).toMatch(/\.bh-stat:nth-child\(5\)\s*\{\s*display:\s*none/);
    expect(own).not.toMatch(/\.bh-stat:nth-child\(1\)/);
  });
  it("keeps each threshold above what the stats it keeps need with 30% longer text", () => {
    // The widths the browser check measured (cpjob probe-bhead-sweep, Chromium,
    // Compact and Default alike) for the first five, four, three and two stats,
    // as drawn and with every label and number 30% longer. The stylesheet's
    // comment quotes the same numbers (this test reads the sheet without its
    // comments); a change to the labels re-measures them.
    const measured = [
      { limit: 640, need: 492, longer: 636 },
      { limit: 500, need: 364, longer: 472 },
      { limit: 400, need: 272, longer: 356 },
      { limit: 200, need: 147, longer: 195 },
    ];
    for (const { limit, need, longer } of measured) {
      expect(limit).toBeGreaterThan(longer);
      expect(limit / need).toBeGreaterThanOrEqual(1.3);
    }
  });
});

describe("what is moved under the strip, through one custom property", () => {
  it("lifts the cell's top-edge overlay by --board-head-top, set only while the strip is drawn", () => {
    expect(decls(".canvas-wrap[data-board-head]", own)["--board-head-top"]).toBe("var(--board-head-h)");
    expect(decls(".cat-filter-bar")["top"]).toBe("calc(14px + var(--board-head-top, 0px))");
  });
  it("lets the board take what the strip leaves, as a column", () => {
    expect(decls(".canvas-wrap[data-board-head]", own)["display"]).toBe("flex");
    expect(decls(".canvas-wrap[data-board-head]", own)["flex-direction"]).toBe("column");
    const flow = decls(".canvas-wrap[data-board-head] > .react-flow", own);
    expect(flow["flex"]).toBe("1 1 0");
    expect(flow["min-height"]).toBe("0");
  });
  it("hides under the terminal stage while it covers the cell, with the other canvas overlays", () => {
    for (const phase of ["opening", "open", "closing"]) {
      expect(read("../styles/stage-shell.css")).toContain(`.canvas-wrap[data-stage="${phase}"] > .board-head`);
    }
  });
  it("keeps every other overlay in the cell clear of the strip by their own anchors", () => {
    // Bottom-anchored or inside React Flow's own pane, so nothing to move.
    for (const sel of [".autofit-chip", ".canvas-notices", ".drag-trash-zone"]) {
      expect(decls(sel)["bottom"], sel).toBeDefined();
      expect(decls(sel)["top"], sel).toBeUndefined();
    }
  });
});

describe("the labels", () => {
  it("are the five, in order; the last is the board's, not the day's", () => {
    expect([...BOARD_HEAD_LABELS]).toEqual(["Waiting on you", "Working", "Done on this board", "Longest wait", "Spent on this board"]);
  });
});

describe("Waiting on you and Working", () => {
  it("count permission and question blocks, not idle prompts, as sessions", () => {
    const agents = [
      agent("a", { waiting: block("permission", NOW - 60_000) }),
      agent("b", { waiting: block("asked", NOW - 30_000) }),
      agent("c", { state: "done", waiting: block("idle", NOW - 90_000) }),
      agent("d"),
    ];
    const f = boardHeadFigures(agents, NOW, true);
    expect(f.waiting).toBe(2);
    // a and b are active but already counted as waiting; c is done; d works.
    expect(f.working).toBe(1);
  });
  it("count a session with a background job and subagents once", () => {
    const agents = [
      agent("s"),
      agent("s::t1", { kind: "subagent", sessionId: "s" }),
      agent("s::t2", { kind: "subagent", sessionId: "s", state: "done" }),
    ];
    expect(boardHeadFigures(agents, NOW, true).working).toBe(1);
  });
});

describe("Done on this board", () => {
  it("counts roots whose turn ended today, local time", () => {
    const agents = [
      agent("t1", { state: "done", endedAt: TODAY }),
      agent("t2", { state: "done", endedAt: NOW - 1000 }),
      agent("y", { state: "done", endedAt: YESTERDAY }),
      agent("e", { state: "err", endedAt: TODAY }),
      agent("r", { state: "active", endedAt: TODAY }),
      agent("sub", { kind: "subagent", state: "done", endedAt: TODAY }),
      agent("noend", { state: "done" }),
    ];
    expect(doneToday(agents, NOW)).toBe(2);
  });
  it("starts the day at local midnight", () => {
    expect(new Date(startOfLocalDay(NOW)).getHours()).toBe(0);
    expect(startOfLocalDay(NOW)).toBeLessThanOrEqual(NOW);
    expect(NOW - startOfLocalDay(NOW)).toBeLessThan(24 * 3600_000 + 3600_000);
    expect(doneToday([agent("m", { state: "done", endedAt: startOfLocalDay(NOW) })], NOW)).toBe(1);
    expect(doneToday([agent("m", { state: "done", endedAt: startOfLocalDay(NOW) - 1 })], NOW)).toBe(0);
  });
  it("carries the board-scope tooltip the usage panel carries", () => {
    expect(boardHeadFigures([agent("a")], NOW, true).scopeTitle).toBe(boardScopeTitle(true));
    expect(boardHeadFigures([agent("a")], NOW, false).scopeTitle).toBe(boardScopeTitle(false));
  });
});

describe("Longest wait", () => {
  it("is the oldest block, in the card's clock format", () => {
    const agents = [
      agent("a", { waiting: block("permission", NOW - 61_000) }),
      agent("b", { waiting: block("asked", NOW - (6 * 60 + 42) * 1000) }),
    ];
    expect(boardHeadFigures(agents, NOW, true).longestWait).toBe("6m 42s");
  });
  it("is null with nobody waiting (an idle prompt is not a wait)", () => {
    expect(boardHeadFigures([agent("a")], NOW, true).longestWait).toBeNull();
    expect(boardHeadFigures([agent("i", { state: "done", waiting: block("idle", NOW - 5000) })], NOW, true).longestWait).toBeNull();
  });
  it("ticks with the clock it is handed", () => {
    const agents = [agent("a", { waiting: block("permission", NOW) })];
    expect(boardHeadFigures(agents, NOW + 5000, true).longestWait).toBe("5s");
    expect(boardHeadFigures(agents, NOW + 65_000, true).longestWait).toBe("1m 05s");
  });
});

describe("Spent on this board", () => {
  it("is the panel's board figure through the panel's formatter", () => {
    const f = boardHeadFigures([agent("a", PRICED), agent("b", PRICED)], NOW, true);
    expect(f.spent).toMatch(/^\$\d/);
    expect(f.spent).not.toContain("+");
    expect(f.spentTitle).toBe(f.scopeTitle);
  });
  it("is a floor, with the unpriced note, where one model has no rate", () => {
    const f = boardHeadFigures([agent("a", PRICED), agent("b", UNPRICED)], NOW, true);
    expect(f.spent).toMatch(/\+$/);
    expect(f.spentTitle).toBe(`${f.scopeTitle}\n${MISSING_PRICE_NOTE}`);
  });
  it("is null (a dash) where every model is unpriced, with the same note", () => {
    const f = boardHeadFigures([agent("b", UNPRICED)], NOW, true);
    expect(f.spent).toBeNull();
    expect(f.spentTitle).toContain(MISSING_PRICE_NOTE);
    expect(BOARD_HEAD_NONE).toBe("—");
  });
  it("owes no '+' and no note for a fresh agent that has spent nothing", () => {
    const fresh = agent("fresh", { model: undefined, usage: usage() });
    const f = boardHeadFigures([agent("a", PRICED), fresh], NOW, true);
    expect(f.spent).toMatch(/^\$\d/);
    expect(f.spent).not.toContain("+");
    expect(f.spentTitle).toBe(f.scopeTitle);
  });
  it("is null with no tokens at all", () => {
    expect(boardHeadFigures([agent("a")], NOW, true).spent).toBeNull();
  });
});

describe("the board's rectangle, not the cell's", () => {
  const rect = (top: number) => ({ top } as DOMRect);
  const fake = (attr: boolean, top: number, board?: number) => ({
    hasAttribute: (n: string) => attr && n === "data-board-head",
    querySelector: (sel: string) => (sel === ":scope > .react-flow" && board != null ? { getBoundingClientRect: () => rect(board) } : null),
    getBoundingClientRect: () => rect(top),
  }) as unknown as Element;
  it("is the cell's React Flow child under data-board-head, and the cell otherwise", () => {
    expect(boardRect(fake(true, 0, 56)).top).toBe(56);
    expect(boardRect(fake(false, 0, 56)).top).toBe(0);
    expect(boardRect(fake(true, 0)).top).toBe(0);
  });
  it("is what the four framing sites read", () => {
    for (const [file, n, from] of [
      ["../use-camera.ts", 1, "./board-rect"], ["../use-agent-focus.ts", 1, "./board-rect"],
      ["../components/terminal/StageShell.tsx", 1, "../../board-rect"], ["../use-stage.ts", 2, "./board-rect"],
    ] as const) {
      const src = read(file);
      expect(src.match(/boardRect\(/g)?.length, file).toBe(n);
      expect(src, file).toContain(`from "${from}"`);
    }
    expect(read("../use-camera.ts")).not.toMatch(/pane\.getBoundingClientRect/);
    expect(read("../use-agent-focus.ts")).not.toMatch(/pane\.getBoundingClientRect/);
  });
});

describe("a remeasure goes through the held reading", () => {
  it("replaces a reading held while the column moves, and the board height wins when it settles", () => {
    let clock = 0;
    const settleAt = 100;
    const timers: { run: () => void; id: number }[] = [];
    let nextId = 1;
    const taken: [number, number][] = [];
    const reading = heldReading({
      settleAt: () => settleAt, now: () => clock,
      take: (w, h) => taken.push([w, h]),
      schedule: run => { const id = nextId++; timers.push({ run, id }); return id; },
      cancel: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    });
    reading.read(800, 900); // the observer: the cell's old height, held
    reading.read(800, 844); // the remeasure: the strip arrived, the board is the cell less 56
    expect(taken).toEqual([]); // nothing re-packs mid-move
    clock = 100;
    for (const t of timers.splice(0)) t.run();
    expect(taken).toEqual([[800, 844]]);
  });
  it("is how both the observer and the remeasure read, the pane ref at once, from a layout effect", () => {
    const src = read("../use-canvas-size.ts");
    expect(src).toMatch(/const width = el\.clientWidth, height = el\.clientHeight - headH\(\);\s*paneSizeRef\.current = \{ width, height \};\s*reading\.read\(width, height\);/);
    expect(src).not.toMatch(/setCanvasSize\(prev => \(prev\.w === el\.clientWidth/);
    expect(src).toContain("useLayoutEffect(() => {\n    const el = canvasRef.current;");
  });
});

describe("the memo, the layout effect and the inset in App", () => {
  const app = read("../App.tsx");
  it("remeasures before paint", () => {
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{ remeasureCanvas\(\); \}, \[boardHeadOn, remeasureCanvas\]\)/);
  });
  it("keeps the still figures on the map's revision and hands in the waiting sessions", () => {
    expect(app).toMatch(/boardHeadBase\(.*singleKeys, waitingSessions\)/);
    expect(app).toMatch(/\[boardHeadOn, singleKeys, waitingSessions, stateRef\.current, stateRef\.current\.revision\]/);
    expect(app).toMatch(/boardHeadLongest\(waitingSessions, now\)/);
  });
  it("hands the right inset to the strip, the way the heroes get it", () => {
    expect(app).toContain("headInset={railInsetRef.current}");
    expect(read("../components/CanvasMain.tsx")).toContain("<BoardHeader {...head} reservedRight={headInset} />");
    expect(read("../components/BoardHeader.tsx")).toContain("paddingRight: `calc(24px + ${reservedRight}px)`");
  });
});

describe("when it is drawn", () => {
  it("not on an empty board, not on a phone", () => {
    expect(boardHeadShown(0, false)).toBe(false);
    expect(boardHeadShown(3, true)).toBe(false);
    expect(boardHeadShown(1, false)).toBe(true);
  });
  it("a zero is the resting number: --warn is set from the count, above zero only", () => {
    const src = read("../components/BoardHeader.tsx");
    expect(src).toMatch(/tone=\{waiting > 0 \? "warn" : undefined\}/);
    expect(boardHeadFigures([agent("a")], NOW, true).waiting).toBe(0);
  });
  it("is the canvas cell's first child, and App hands the cell plain figures", () => {
    const main = read("../components/CanvasMain.tsx");
    expect(main.indexOf("<BoardHeader")).toBeGreaterThan(0);
    expect(main.indexOf("<BoardHeader")).toBeLessThan(main.indexOf("{children}"));
    expect(main).toContain('data-board-head={head ? "" : undefined}');
    expect(read("../App.tsx")).toMatch(/boardHeadShown\(agentCount, phone\)/);
  });
});

describe("the component", () => {
  const src = read("../components/BoardHeader.tsx");
  it("is memoised, named, and takes figures not the agents map", () => {
    expect(src).toContain("export default memo(BoardHeader)");
    expect(src).toContain('aria-label="Board summary"');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*(\/\/|\{\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/agents|useState|useEffect|setInterval|fetch\(/);
  });
  it("reads number then label in each stat, with no live region", () => {
    expect(src.indexOf("bh-num")).toBeLessThan(src.indexOf("bh-label"));
    expect(src).not.toMatch(/aria-live|role="status"|role="alert"/);
  });
  it("leaves the waiting trend undrawn", () => {
    expect(src).toMatch(/waiting trend/);
    expect(src).not.toMatch(/<svg|<canvas/);
  });
});

describe("the module stays out of the lazy chunk", () => {
  it("imports no terminal, navigator or xterm module, and no DOM", () => {
    const lazyOnly = [/terminal\//, /BoardNavigator/, /navigator-flip/, /board-navigator/, /stage-morph/, /use-terminal-session/, /terminal-protocol/, /xterm/];
    for (const file of ["../board-header.ts", "../components/BoardHeader.tsx"]) {
      const specs = [...read(file).matchAll(/^import[^;]*from "([^"]+)"/gm)].map(m => m[1]);
      expect(specs.filter(s => lazyOnly.some(re => re.test(s))), file).toEqual([]);
    }
    expect(read("../board-header.ts")).not.toMatch(/document\.|window\.|from "react"/);
  });
});
