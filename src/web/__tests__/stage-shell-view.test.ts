// The stage in the deck, as drawn (components/terminal/StageShell.tsx): the
// navigator in the canvas's place at the width the geometry gave it, the stage
// over the cell's right-hand side at a whole number of columns, the parts the
// morph moves, and the rule for when an unseen stage may be uncovered.
//
// Rendered to markup inside React Flow's provider (the navigator reads its
// store, the dock its camera), with no DOM: what is pinned is the shape the
// sheet and the motion rely on, not the motion itself — stage-morph.test.ts
// and use-stage.test.ts hold that.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import { StageDock, StageNavigator, showable, REVEAL_WAIT_MS } from "../components/terminal/StageShell";
import { initialShell, type ShellState, type StageTarget } from "../stage-shell";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { Stage } from "../use-stage";
import type { Asks } from "../use-asks";
import type { GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import type { Palette } from "../palette";

const html = (el: ReactElement) => renderToStaticMarkup(createElement(ReactFlowProvider, null, el));

const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });

/** A stage as use-stage.ts hands it to the shell, open on `target`. */
function stageOn(target: StageTarget, over: Partial<ShellState> = {}, g = geometry): Stage {
  const noop = vi.fn();
  return {
    enabled: true,
    shell: { ...initialShell(), phase: "open", target, ...over },
    geometry: g, cell: ASSUMED_CELL, expanded: false, firstRun: false, said: "",
    navRef: { current: null }, keysRef: { current: null },
    onNodeClick: vi.fn(), followSession: vi.fn(), switchTo: noop, openFromButton: noop, openTile: noop, launch: noop,
    onLaunched: noop, focusPane: noop, release: noop, close: noop, closed: noop, failed: noop, reveal: noop,
    revealed: noop, announce: noop, openPopover: noop, newSessionFrom: noop, closePopover: noop, onCols: noop,
    onColsReset: noop, toggleExpand: noop, firstRunDone: noop, onCell: noop, loadTerminalPrefs: noop,
  } as unknown as Stage;
}

const paycore = {
  id: "s1", sessionId: "s1", kind: "root", label: "paycore", state: "active", tools: [], prompts: [],
  startedAt: 0, provider: "claude", cwd: "/w/paycore",
} as unknown as AgentNodeData;

const asks: Asks = {
  view: { track: [], position: null, resumed: null, next: null, clear: false, arrival: null },
  said: "", startAsks: vi.fn(), nextAsk: vi.fn(),
};

function dock(stage: Stage) {
  return html(createElement(StageDock, {
    stage,
    stateRef: { current: { agents: new Map([["s1", paycore]]) } as unknown as GraphState },
    canvasRef: { current: null },
    now: 1_000_000,
    palette: {} as Palette,
    asks,
    waitingSessions: [],
  }));
}

describe("the stage beside the board", () => {
  it("is a whole number of columns wide, over the cell's right-hand side", () => {
    const out = dock(stageOn({ kind: "session", id: "s1" }));
    expect(out).toContain('class="stage-dock"');
    expect(out).toContain(`--stage-w:${geometry.stageW}px`);
    expect(geometry.stageW).toBe(1004);
    expect(out).toContain('data-phase="open"');
    expect(out, "at rest it is not cut by a window").not.toContain("data-morph");
  });

  it("holds the session's stage, named for the session, with the parts the morph moves", () => {
    const out = dock(stageOn({ kind: "session", id: "s1" }));
    expect(out).toContain('aria-label="Terminal — paycore"');
    expect(out).toMatch(/<div class="stage-in">/);
    expect(out).toMatch(/<span class="stage-edge" aria-hidden="true"><\/span>/);
    expect(out).toMatch(/<span class="stage-rider" aria-hidden="true">paycore<\/span>/);
    expect(out).toMatch(/<div class="stage-ground" aria-hidden="true"><\/div>/);
  });

  it("is cut by the window while it waits, opens and closes", () => {
    for (const phase of ["waiting", "opening", "closing"] as const) {
      expect(dock(stageOn({ kind: "session", id: "s1" }, { phase })), phase).toContain("data-morph");
    }
  });

  it("lets presses through for the double-click window", () => {
    expect(dock(stageOn({ kind: "session", id: "s1" }, { grace: true }))).toContain("data-grace");
  });

  it("draws nothing before the cell has been measured", () => {
    expect(dock(stageOn({ kind: "session", id: "s1" }, {}, null as never))).toBe("");
  });

  it("is the empty stage, with New session its one action, when nothing is on it", () => {
    const out = dock(stageOn({ kind: "empty" }));
    expect(out).toContain('aria-label="Terminal — Nothing on the stage"');
    expect(out).toContain('id="ts-empty-new-session"');
  });
});

describe("the navigator in the canvas", () => {
  it("is as wide as the geometry leaves it", () => {
    const out = html(createElement(StageNavigator, { stage: stageOn({ kind: "session", id: "s1" }) }));
    expect(out).toContain('class="stage-nav"');
    expect(out).toContain(`--nav-w:${geometry.navW}px`);
    expect(out).toContain('class="board-nav"');
    expect(out).toContain('id="nav-new-session"');
  });

  it("is not there when the stage takes the whole cell", () => {
    const takeover = stageGeometry({ appW: 600, bodyH: 600, cellW: 8, cellH: 18, expanded: false, narrow: true, storedCols: null });
    expect(takeover.takeover).toBe(true);
    expect(html(createElement(StageNavigator, { stage: stageOn({ kind: "session", id: "s1" }, {}, takeover) }))).toBe("");
  });
});

describe("when an unseen stage may be uncovered", () => {
  it("is when a session's pane is up, or the card that says why there is none", () => {
    for (const kind of ["live", "not-attachable", "tmux-installing", "tmux-missing", "ended", "detached", "error"] as const) {
      expect(showable(kind, "session"), kind).toBe(true);
    }
  });

  it("is never on an attach still in flight", () => {
    expect(showable("attaching", "session")).toBe(false);
  });

  it("is never on the empty phase every session starts in before it is told what to show", () => {
    expect(showable("empty", "session")).toBe(false);
    expect(showable("empty", "launch")).toBe(false);
    expect(showable("empty", "empty"), "the empty stage's own card is what it shows").toBe(true);
  });

  it("is from a new session's starting line on", () => {
    expect(showable("starting", "launch")).toBe(true);
    expect(showable("starting", "session")).toBe(false);
  });

  it("waits past the 300ms a pane may take before a card is worth drawing, and not much longer", () => {
    expect(REVEAL_WAIT_MS).toBeGreaterThan(300);
    expect(REVEAL_WAIT_MS).toBeLessThanOrEqual(500);
  });
});
