// The empty board shows the welcome hero, not the machinery (V4 critique,
// round 3). With no session the top bar's counts, the canvas bar's board
// controls, the minimap, the Auto-fit chip and the status bar's keys are not
// drawn; the Command Panel's button stays (its empty stage starts a session),
// and the character stands in the minimap's corner. All of them read one
// answer, board-empty.ts, and come back with the first session.
//
// Rendered, not read, wherever the part can be drawn on its own: each one is
// drawn once from a deck with no session and once from a deck with one.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReactFlowProvider } from "reactflow";
import { BoardEmptyContext, boardIsEmpty } from "../board-empty";
import { initialState, type GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import { statusViewFor } from "../status-hints";
import { fitMinimap } from "../panel-place";
import { BoardMinimap } from "../components/BoardFlow";
import CanvasControls from "../components/CanvasControls";
import CanvasMain from "../components/CanvasMain";
import StatusBar from "../components/StatusBar";
import { ReadoutGroup } from "../components/TopbarReadouts";
import { en } from "../i18n/en";
import { sheetText } from "./sheet-source";

// React Flow's bar draws nothing until it has mounted, which a server render
// never does: drawn here as the panel it is, around the same buttons.
vi.mock("reactflow", async importOriginal => {
  const actual = await importOriginal<typeof import("reactflow")>();
  return {
    ...actual,
    Controls: ({ children }: { children?: ReactNode }) => createElement("div", { className: "react-flow__controls" }, children),
  };
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const noop = () => {};

/** A deck with `n` sessions on it. */
function deck(n: number): GraphState {
  const state = initialState();
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    state.agents.set(id, { id, sessionId: id, kind: "root", state: "active", label: id } as unknown as AgentNodeData);
  }
  return state;
}

/** `part` drawn inside App's answer for a deck with `n` sessions. */
const drawn = (n: number, part: ReactElement, flow = false) => {
  const tree = createElement(BoardEmptyContext.Provider, { value: boardIsEmpty(deck(n)) }, part);
  return renderToStaticMarkup(flow ? createElement(ReactFlowProvider, null, tree) : tree);
};

const stripped = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rule whose selector list holds exactly `selector`. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
    if (!sels.includes(selector)) continue;
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[d[1]] ??= d[2].replace(/\s+/g, " ");
  }
  return out;
}

describe("the one answer", () => {
  it("is empty with no session and not with one", () => {
    expect(boardIsEmpty(deck(0))).toBe(true);
    expect(boardIsEmpty(deck(1))).toBe(false);
  });

  it("is App's, handed down once, and the hero reads it too", () => {
    const app = read("../App.tsx");
    expect(app).toContain("const boardEmpty = boardIsEmpty(stateRef.current);");
    expect(app).toContain("<BoardEmptyContext.Provider value={boardEmpty}>");
    expect(app).toMatch(/const emptyHero = \(reservedRight: number\) => boardEmpty \?/);
    // No second count of the sessions decides emptiness anywhere else.
    expect(app).not.toMatch(/agentCount (?:===|>) 0|agents\.size === 0/);
  });

  it("keeps everything drawn for a part drawn outside App", () => {
    expect(renderToStaticMarkup(createElement(StatusBar, { stageOpen: false, zoomedOut: false, version: "1.0.0" })))
      .toContain("statusbar-hint");
  });
});

describe("the top bar's counts", () => {
  const readouts = (n: number) => drawn(n, createElement(ReadoutGroup, {
    versionCheck: { version: "1.0.0", notice: null, noticeOpen: false, showNotice: noop, versionChecking: false, loadVersion: noop },
    welcome: { chipVersion: null, openReleaseNotes: noop },
    desktopUpdate: { readyAppUpdate: null },
    pause: { paused: false, pauseGate: { size: 0, dropped: 0 } },
    announcements: { blockedSaid: "", watchSaid: "", incidentSaid: "" },
    notify: { notifySaid: null },
    waitingSessions: [],
    waitingCursorRef: { current: null },
    focusSession: noop,
    live: true,
    now: 1_790_550_000_000,
    incidents: [],
    counts: { working: 0, done: 0 },
    children: createElement("div", { className: "actions" }, "search-field"),
  } as unknown as Parameters<typeof ReadoutGroup>[0]));

  it("are not drawn with no session; the wordmark and the end group stay", () => {
    const html = readouts(0);
    expect(html).not.toContain('class="counts"');
    expect(html).not.toContain("count-pill");
    expect(html).toContain("<h1>ccdeck</h1>");
    expect(html).toContain("search-field");
  });

  it("come back with the first session: waiting, working, done", () => {
    const html = readouts(1);
    expect(html).toContain('class="counts"');
    expect(html.match(/class="count-pill /g)).toHaveLength(3);
    expect(html).toContain("search-field");
  });
});

describe("the canvas bar", () => {
  const bar = (n: number, onTerminal?: (button: Element | null) => void) => drawn(n, createElement(CanvasControls, {
    autoFitDisabled: false, enableAutoFitAndRefit: noop, paused: false,
    pauseGate: { size: 0, dropped: 0 } as never, togglePause: noop,
    handleRelayout: noop, requestClear: noop, setKeyHelpOpen: noop, zoomBy: noop, zoomReset: noop, onTerminal,
  }), true);
  const boardControls = [
    en["board.controls.zoomOut"], en["board.controls.zoomIn"], en["board.controls.recenter"],
    en["board.controls.arrangeLabel"], en["board.pill.pause"], en["board.controls.clearLabel"], en["board.controls.keysLabel"],
  ];

  it("keeps only the Command Panel's button with no session", () => {
    const html = bar(0, noop);
    expect(html).toContain("react-flow__controls");
    expect(html).toContain(`aria-label="${en["board.controls.openPanel"]}"`);
    for (const name of boardControls) expect(html, name).not.toContain(`aria-label="${name}"`);
    expect(html).not.toContain("data-zoom-level");
    expect(html).not.toContain("react-flow__controls-divider");
  });

  it("is not drawn at all with no session and no Command Panel", () => {
    expect(bar(0)).toBe("");
  });

  it("comes back whole with the first session", () => {
    const html = bar(1, noop);
    for (const name of [...boardControls, en["board.controls.openPanel"]]) expect(html, name).toContain(`aria-label="${name}"`);
    expect(html.match(/react-flow__controls-divider/g)).toHaveLength(2);
    expect(bar(1)).toContain(`aria-label="${en["board.controls.zoomOut"]}"`);
  });
});

describe("the minimap", () => {
  const map = (n: number) => drawn(n, createElement(BoardMinimap, {
    nodeColor: () => "#000",
    palette: { "--minimap-mask": "rgba(0,0,0,.5)", "--line": "#333" } as never,
  }), true);

  it("is not drawn with no session", () => {
    expect(map(0)).toBe("");
  });

  it("comes back with the first session", () => {
    expect(map(1)).toContain("react-flow__minimap");
  });

  it("is the board's own, and the Auto-fit chip waits for a session too", () => {
    const board = read("../components/BoardFlow.tsx");
    expect(board).toContain("<BoardMinimap nodeColor={minimapNodeFill} palette={palette} />");
    expect(board).toContain("{autoFitDisabled && !empty && <AutoFitChip");
  });
});

describe("the character, without the minimap", () => {
  const main = (n: number) => drawn(n, createElement(CanvasMain, {
    canvasRef: { current: null }, bubbling: false, dragging: false,
    trash: { trashDragging: false, trashState: "idle", trashPhase: "gone", trashZoneRef: { current: null }, trashLabel: "" },
    zoom: { lod: "detail", lodRef: { current: "detail" } },
    viewport: { markCanvasInput: noop },
    stateRef: { current: deck(n) },
    peek: { peekAgent: noop, peekLabel: noop, peekPeers: () => [], peekRecap: noop, peekBounds: noop },
    children: null,
  } as unknown as Parameters<typeof CanvasMain>[0]));

  it("is told the board is empty by the canvas, and only then", () => {
    expect(main(0)).toMatch(/<main [^>]*data-empty=""/);
    expect(main(1)).not.toContain("data-empty");
  });

  it("stays on the board whatever the count", () => {
    const board = read("../components/BoardFlow.tsx");
    expect(board).toMatch(/^\s*<RadioExperience fm=\{fm\}/m);
  });

  it("stands on the bar's foot line in the minimap's corner, left of the Command Panel's button", () => {
    const empty = decls(".canvas-wrap[data-empty] .fm");
    expect(empty["--fm-y"]).toBe("0px");
    expect(empty["bottom"]).toBe("var(--board-controls-edge)");
    expect(decls(".canvas-wrap[data-empty]:has(.react-flow__controls) .fm")["right"])
      .toBe("calc(var(--board-controls-edge) + var(--minimap-in, 0px) + var(--board-controls-btn) + 4px + var(--board-controls-gap))");
    // With a session it is back on the minimap's ledge, as before.
    expect(decls(".fm")["--fm-y"]).toBe("calc(-1 * (var(--minimap-h) + var(--board-controls-room) - var(--flow-gutter)))");
  });

  it("still steps in past an open panel with no minimap to measure", () => {
    const g = globalThis as Record<string, unknown>;
    const style = new Map<string, string>();
    const cell = {
      style: { setProperty: (k: string, v: string) => { style.set(k, v); } },
      setAttribute: noop, removeAttribute: noop,
      getBoundingClientRect: () => ({ left: 40, right: 1400 }),
      querySelector: (sel: string) => (sel === ".fm" ? { offsetWidth: 142 } : null),
    };
    g.document = {
      querySelector: (sel: string) => (sel === ".canvas-wrap" ? cell : null),
      querySelectorAll: () => [{ offsetLeft: 1400 - 8 - 320, offsetWidth: 320, getAttribute: () => null }],
    };
    g.window = { matchMedia: () => ({ matches: false }) };
    try {
      fitMinimap();
    } finally {
      delete g.document;
      delete g.window;
    }
    expect(style.get("--minimap-in")).toBe("328px");
  });
});

describe("the status bar", () => {
  const bar = (n: number, over: Partial<Parameters<typeof StatusBar>[0]> = {}) =>
    drawn(n, createElement(StatusBar, { stageOpen: false, zoomedOut: false, viewChord: "workspace", version: "3.82.3", ...over }));

  it("names no key with no session, and keeps the version", () => {
    const html = bar(0);
    expect(html).not.toContain("statusbar-hint");
    expect(html).not.toContain("statusbar-who");
    expect(html).toContain("v3.82.3");
  });

  it("names the board's keys again with the first session", () => {
    const html = bar(1);
    expect(html).toContain("statusbar-who");
    expect(html).toContain(en["board.status.cards"]);
    expect(html).toContain("v3.82.3");
  });

  it("drops the deck's keys too, and keeps a pane's", () => {
    const base = { stageOpen: true, onCard: false, zoomedOut: false, singleKeys: true, platform: "Linux", viewChord: "board" as const };
    expect(statusViewFor({ ...base, pane: null, empty: true })).toEqual({ layer: "deck", label: "", hints: [] });
    expect(statusViewFor({ ...base, pane: null }).hints.length).toBeGreaterThan(0);
    const pane = statusViewFor({ ...base, pane: "site", empty: true });
    expect(pane.layer).toBe("terminal");
    expect(pane.hints.length).toBeGreaterThan(0);
  });
});
