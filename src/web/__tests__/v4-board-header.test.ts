// V4's board header (its Figma Board › bhead): the strip across the top
// of the canvas cell. CHANGED ON PURPOSE (design recommendations, 2026-11-09):
// five figures became two. Waiting on you, Working and Done on this board
// repeated the top bar's three counts a line above, and its Done counted other
// sessions than the top bar's; the strip keeps the longest wait and the board's
// spend. The CSS is read the way v4-bars.test.ts reads it; the figures are
// driven through the pure module with made-up agents, so no DOM is needed.
// Tokens only: no hex or rgba in the new sheet.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOARD_HEAD_LABEL_MSGS, BOARD_HEAD_NONE, boardHeadFigures, boardHeadShown,
} from "../board-header";
import { boardRect } from "../board-rect";
import { heldReading } from "../use-canvas-size";
import { boardScopeTitle } from "../board-usage";
import { MISSING_PRICE_NOTE } from "../reported-cost";
import type { AgentNodeData, TokenUsage, WaitingBlock } from "../types";
import { sheetText } from "./sheet-source";
import { en } from "../i18n/en";

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
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a figure at 16.
    expect(num["font-size"]).toBe(INC(16));
    expect(num["line-height"]).toBe("24px");
    expect(num["font-weight"]).toBe("600");
    expect(num["color"]).toBe("var(--text)");
    const label = decls(".bh-label", own);
    expect(label["font-size"]).toBe(INC(12));
    expect(label["line-height"]).toBe("16px");
    expect(label["font-weight"]).toBe("400");
    expect(label["color"]).toBe("var(--muted)");
  });
  it("colours a dash --muted, by attribute, and has no waiting count left to colour --warn", () => {
    expect(decls('.bh-num[data-tone="none"]', own)["color"]).toBe("var(--muted)");
    expect(own).not.toContain('[data-tone="warn"]');
  });
  it("has no hex or rgba of its own, and no motion", () => {
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(own).not.toMatch(/transition|animation|@keyframes/);
  });
});

describe("a narrow board drops the second stat, in a container query on the strip", () => {
  it("drops the second below 280, never the first", () => {
    const queries = [...own.matchAll(/@container\s+board-head\s*\(max-width:\s*(\d+)px\)\s*\{([^]*?)\}\s*\}/g)]
      .map(m => [Number(m[1]), m[2].match(/nth-child\((\d)\)/)![1]]);
    expect(queries).toEqual([[280, "2"]]);
    expect(decls(".board-head", own)["container-type"]).toBe("inline-size");
    expect(own).toMatch(/\.bh-stat:nth-child\(2\)\s*\{\s*display:\s*none/);
    expect(own).not.toMatch(/\.bh-stat:nth-child\(1\)/);
  });
  it("keeps the threshold above what the two stats need with 30% longer text", () => {
    // The widths the browser check measured (Chromium, the isolated deck of the
    // 2026-11-09 design recommendations) for the two stats, as drawn and with
    // every label and number 30% longer. The stylesheet's comment quotes the
    // same numbers (this test reads the sheet without its comments); a change
    // to the labels re-measures them.
    const measured = [
      { limit: 280, need: 204, longer: 273 },
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
  it("are the two, in order; the last is the board's, not the day's", () => {
    // CHANGED ON PURPOSE (the UI in every language): the labels are keys, and
    // English maps them to the same words.
    expect([...BOARD_HEAD_LABEL_MSGS]).toEqual(["board.header.longest", "board.header.spent"]);
    expect(BOARD_HEAD_LABEL_MSGS.map(key => en[key])).toEqual(["Longest wait", "Spent on this board"]);
  });
  it("no longer count sessions: the top bar's counts are the one place they are said", () => {
    const keys = Object.keys(en);
    for (const gone of ["board.header.waiting", "board.header.working", "board.header.done"]) expect(keys).not.toContain(gone);
    const f = boardHeadFigures([agent("a", { waiting: block("permission", NOW - 60_000) }), agent("d"), agent("e", { state: "done", endedAt: TODAY })], NOW, true);
    expect(Object.keys(f).sort()).toEqual(["longestWait", "spent", "spentTitle"]);
  });
});

describe("the board-scope tooltip", () => {
  it("is the one the usage panel carries, on Spent", () => {
    expect(boardHeadFigures([agent("a")], NOW, true).spentTitle).toBe(boardScopeTitle(true));
    expect(boardHeadFigures([agent("a")], NOW, false).spentTitle).toBe(boardScopeTitle(false));
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
    expect(f.spentTitle).toBe(boardScopeTitle(true));
  });
  it("is a floor, with the unpriced note, where one model has no rate", () => {
    const f = boardHeadFigures([agent("a", PRICED), agent("b", UNPRICED)], NOW, true);
    expect(f.spent).toMatch(/\+$/);
    expect(f.spentTitle).toBe(`${boardScopeTitle(true)}\n${MISSING_PRICE_NOTE}`);
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
    expect(f.spentTitle).toBe(boardScopeTitle(true));
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

describe("the board without its summary strip", () => {
  it("leaves the canvas free of the summary and its reserved space", () => {
    expect(read("../components/CanvasMain.tsx")).not.toContain("<BoardHeader");
    expect(read("../components/CanvasMain.tsx")).not.toContain("data-board-head=");
    expect(read("../App.tsx")).not.toContain("boardHeadBase(");
  });
});

describe("when it is drawn", () => {
  it("not on an empty board, not on a phone", () => {
    expect(boardHeadShown(0, false)).toBe(false);
    expect(boardHeadShown(3, true)).toBe(false);
    expect(boardHeadShown(1, false)).toBe(true);
  });
  it("draws the longest wait and the spend, a dash where either has nothing to say", () => {
    const src = read("../components/BoardHeader.tsx");
    expect(src).toMatch(/<Stat value=\{longestWait \?\? BOARD_HEAD_NONE\} label=\{lLongest\} tone=\{longestWait == null \? "none" : undefined\} \/>/);
    expect(src).toMatch(/<Stat value=\{spent \?\? BOARD_HEAD_NONE\} label=\{lSpent\} tone=\{spent == null \? "none" : undefined\} title=\{spentTitle\} \/>/);
    expect((src.match(/<Stat /g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/"warn"/);
  });

});

describe("the component", () => {
  const src = read("../components/BoardHeader.tsx");
  it("is memoised, named, and takes figures not the agents map", () => {
    expect(src).toContain("export default memo(BoardHeader)");
    // CHANGED ON PURPOSE (the UI in every language): named by its key.
    expect(src).toContain('aria-label={t("board.header.summary")}');
    expect(en["board.header.summary"]).toBe("Board summary");
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
