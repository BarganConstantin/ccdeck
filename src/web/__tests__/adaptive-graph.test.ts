// The adaptive session graph: the canvas draws a different card at each of
// three distances instead of the full card shrunk until it says nothing.
//
// At the zoom a real board settles into — 0.27 for seven sessions on a
// 1440x900 window, measured on the sandbox deck this was built against — the
// far tier drew each card as a LIVE or DONE pill and one character of its name,
// a waiting session's row at 3px, and every subagent's name nowhere. What
// replaces it is decided by the size a card has on screen (semantic-zoom.ts),
// drawn as a face in screen pixels inside the card's unchanged box (NodeFace),
// summarised per branch (node-face.ts), and read at 1:1 on demand (the peek and
// the focus). The pure halves are tested directly; the wiring, which needs a
// canvas, is pinned by reading the source, the way canvas-keyboard.test.ts does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CARD_BODY_PX, COMPACT_ENTER, COMPACT_EXIT, DEFAULT_CARD, DETAIL_ENTER_PX, DETAIL_ENTER_ZOOM, DETAIL_EXIT_PX,
  DETAIL_EXIT_ZOOM, FOCUS_MAX_ZOOM, FOCUS_MIN_ZOOM, fitZoomForDrawnLanes, nextLod, referenceCard, type LodMode,
} from "../semantic-zoom";
import { branchLong, branchShort, branchSummaries, faceSignal, stateMarkKind, type BranchSummary } from "../node-face";
import { focusViewport, unionBox } from "../focus-camera";
import { hidePeek, peekedId, showPeek } from "../components/SessionPeek";
import type { AgentNodeData, ToolCall, WaitingBlock } from "../types";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const app = read("../App.tsx");
const node = read("../components/AgentNode.tsx");
const clusters = read("../components/SessionClusters.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("which card is drawn is decided by what it measures on screen", () => {
  const detailEnter = DETAIL_ENTER_PX / CARD_BODY_PX;
  const detailExit = DETAIL_EXIT_PX / CARD_BODY_PX;
  const compactEnter = Math.max(COMPACT_ENTER.width / DEFAULT_CARD.width, COMPACT_ENTER.height / DEFAULT_CARD.height);
  const compactExit = Math.max(COMPACT_EXIT.width / DEFAULT_CARD.width, COMPACT_EXIT.height / DEFAULT_CARD.height);

  it("lands where the sizes say on a first frame", () => {
    expect(nextLod(null, 1)).toBe("detail");
    expect(nextLod(null, detailEnter + 0.001)).toBe("detail");
    expect(nextLod(null, detailEnter - 0.001)).toBe("compact");
    expect(nextLod(null, compactEnter + 0.001)).toBe("compact");
    expect(nextLod(null, compactEnter - 0.001)).toBe("overview");
    expect(nextLod(null, 0.2)).toBe("overview");
  });

  it("keeps each band's thresholds in the order the modes are in", () => {
    // Enter above exit, and every compact threshold below every detail one —
    // otherwise a band would be empty and a mode could be skipped past.
    expect(detailEnter).toBeGreaterThan(detailExit);
    expect(compactEnter).toBeGreaterThan(compactExit);
    expect(detailExit).toBeGreaterThan(compactEnter);
  });

  it("does not flip back and forth while a zoom rests near a threshold", () => {
    // A trackpad settling: ±2% around each threshold, from each side.
    for (const [start, around] of [["detail", detailExit], ["compact", detailEnter], ["compact", compactExit], ["overview", compactEnter]] as const) {
      let mode: LodMode = start === "detail" ? "detail" : start === "compact" ? "compact" : "overview";
      const seen = new Set<LodMode>();
      for (const k of [1.004, 0.996, 1.01, 0.99, 1.002, 0.998, 1.008, 0.992]) {
        // Stay inside the band: never cross the far threshold.
        const z = around * k;
        mode = nextLod(mode, z);
        seen.add(mode);
      }
      expect(seen.size, `${start} around ${around.toFixed(3)} flipped: ${[...seen]}`).toBeLessThanOrEqual(2);
    }
    // And the exact cases the band exists for.
    expect(nextLod("detail", (detailEnter + detailExit) / 2)).toBe("detail");
    expect(nextLod("compact", (detailEnter + detailExit) / 2)).toBe("compact");
    expect(nextLod("compact", (compactEnter + compactExit) / 2)).toBe("compact");
    expect(nextLod("overview", (compactEnter + compactExit) / 2)).toBe("overview");
  });

  it("jumps straight to the mode that holds on a fit across several bands", () => {
    expect(nextLod("detail", 0.25)).toBe("overview");
    expect(nextLod("overview", 0.9)).toBe("detail");
  });

  it("holds its mode on a zoom it cannot use", () => {
    expect(nextLod("compact", 0)).toBe("compact");
    expect(nextLod("overview", Number.NaN)).toBe("overview");
    expect(nextLod(null, -1)).toBe("detail");
  });

  it("asks the smallest card, so a tall root cannot keep a short subagent in a mode it cannot draw", () => {
    const tall = { width: 260, height: 155 };
    const small = { width: 220, height: 103 };
    expect(referenceCard([tall, small, { width: 240, height: 126 }])).toEqual(small);
    // At 0.44 a 155-tall card holds two lines; a 103-tall one does not.
    expect(nextLod("compact", 0.44, tall)).toBe("compact");
    expect(nextLod("compact", 0.42, referenceCard([tall, small]))).toBe("overview");
  });

  it("does not let a card caught mid-mount drag the reference down", () => {
    expect(referenceCard([{ width: 220, height: 4 }, { width: 260, height: 126 }]).height).toBeGreaterThanOrEqual(72);
    expect(referenceCard([])).toEqual(DEFAULT_CARD);
    expect(referenceCard([{ width: 0, height: 0 }])).toEqual(DEFAULT_CARD);
  });
});

describe("the fit keeps room for the bubbles only where they are drawn", () => {
  it("reserves the lane when the fit lands on the full card", () => {
    expect(fitZoomForDrawnLanes(0.8, 1)).toBe(0.8);
    expect(fitZoomForDrawnLanes(DETAIL_ENTER_ZOOM, 0.9)).toBe(DETAIL_ENTER_ZOOM);
  });

  it("frames the drawn board where the bubbles are hidden", () => {
    // The board beside the machine panel after R: 0.36 with the lane, 0.49
    // without, and nothing drawn in the lane at either.
    expect(fitZoomForDrawnLanes(0.357, 0.49)).toBe(0.49);
    expect(nextLod(null, 0.49), "the bare fit must land where the bubbles are hidden").not.toBe("detail");
  });

  it("never lets the bare fit reach a zoom where the bubbles come back", () => {
    // Between the two: bare would be the full card, whose bubbles the bare
    // fit left no room for. Held under the zoom the full card is left at, so
    // no mode the canvas is in draws them — and never below the safe fit.
    const z = fitZoomForDrawnLanes(0.5, 0.9);
    expect(z).toBeLessThan(DETAIL_EXIT_ZOOM);
    expect(nextLod("detail", z)).not.toBe("detail");
    expect(fitZoomForDrawnLanes(0.62, 0.9)).toBe(0.62);
  });

  it("is what fitLeft frames with", () => {
    expect(app).toContain("const zoom = fitZoomForDrawnLanes(fitWith(TOOL_LANE_ALLOWANCE), fitWith(0));");
  });
});

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: Math.random().toString(16).slice(2), name: "Bash", inputPreview: "", startedAt: 0, ...over,
});
const agent = (over: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id: "s1", sessionId: "s1", label: "vcrm-core", kind: "root", state: "active", startedAt: 0,
  tools: [], prompts: [], toolCount: 0, childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  ...over,
});
const words = {
  sayWaiting: (w: WaitingBlock) => (w.kind === "idle" ? "Your turn" : w.message),
  describeCall: (t: ToolCall) => ({ name: t.name, subject: t.name === "Edit" ? "styles.css" : null }),
};

describe("a branch is summarised, never replaced", () => {
  const subs = [
    agent({ id: "s1::a", kind: "subagent", state: "active" }),
    agent({ id: "s1::b", kind: "subagent", state: "active", tools: [tool({ ok: false }), tool({ ok: true })] }),
    agent({ id: "s1::c", kind: "subagent", state: "done" }),
    agent({ id: "s1::d", kind: "subagent", state: "done", exitAt: 1 }),
    agent({ id: "s2::a", sessionId: "s2", kind: "subagent", state: "done" }),
  ];

  it("counts the subagents that are staying on the canvas, per session", () => {
    const b = branchSummaries([agent(), ...subs]);
    expect(b.get("s1")).toEqual({ total: 3, live: 2, done: 1, err: 0, failed: 1 });
    expect(b.get("s2")).toEqual({ total: 1, live: 0, done: 1, err: 0, failed: 0 });
    // A root is not its own branch.
    expect(branchSummaries([agent()]).size).toBe(0);
  });

  it("says it as a summary, in the card's own notation", () => {
    const b: BranchSummary = { total: 5, live: 3, done: 2, err: 0, failed: 0 };
    expect(branchLong(b)).toBe("5 subagents · 3 live · 2 done");
    expect(branchShort(b)).toBe("→ 5 · 3 live");
    expect(branchLong({ total: 1, live: 0, done: 1, err: 0, failed: 0 })).toBe("1 subagent · 1 done");
    expect(branchShort({ total: 3, live: 0, done: 3, err: 0, failed: 0 })).toBe("→ 3 · done");
  });
});

describe("a small face says one thing, in the order a reader would want it", () => {
  const permission: WaitingBlock = { kind: "permission", message: "Claude needs your permission to use Bash", since: 0 };
  const asked: WaitingBlock = { kind: "asked", message: "paycore needs your input: merge both?", since: 0 };
  const idle: WaitingBlock = { kind: "idle", message: "Claude is waiting for your input", since: 0 };
  const branch: BranchSummary = { total: 4, live: 2, done: 2, err: 0, failed: 0 };
  const failing = [tool({ ok: false, endedAt: 1 }), tool({ ok: false, endedAt: 1 })];
  const open = [tool({ name: "Read", endedAt: 1 }), tool({ name: "Edit" })];

  it("puts a session blocked on a human before everything", () => {
    const s = faceSignal(agent({ waiting: permission, tools: failing }), branch, words)!;
    expect(s).toEqual({ tone: "warn", long: permission.message, short: "Needs you" });
    expect(faceSignal(agent({ waiting: asked }), undefined, words)).toMatchObject({ tone: "warn", short: "Asked you" });
  });

  it("gives a finished turn the quiet tone, not the alarm", () => {
    expect(faceSignal(agent({ state: "done", waiting: idle, tools: failing }), branch, words))
      .toEqual({ tone: "idle", long: "Your turn", short: "Your turn" });
  });

  it("then failures, then the branch, then the call still open", () => {
    expect(faceSignal(agent({ tools: failing }), branch, words)).toMatchObject({ tone: "err", short: "2 failed" });
    expect(faceSignal(agent({ tools: open }), branch, words)).toMatchObject({ tone: "muted", short: "→ 4 · 2 live" });
    expect(faceSignal(agent({ tools: open }), undefined, words)).toEqual({ tone: "muted", long: "Edit · styles.css", short: "Edit" });
  });

  it("says nothing about a quiet card, and nothing about a finished card's calls", () => {
    expect(faceSignal(agent(), undefined, words)).toBeNull();
    expect(faceSignal(agent({ state: "done", tools: open }), undefined, words)).toBeNull();
  });

  it("never gives a subagent the session's block", () => {
    // Only the root carries `waiting`; a subagent copy would print it twice.
    expect(faceSignal(agent({ kind: "subagent", waiting: permission }), undefined, words)).toBeNull();
  });

  it("draws each state as its own shape", () => {
    expect(stateMarkKind("active")).toBe("live");
    expect(stateMarkKind("done")).toBe("done");
    expect(stateMarkKind("err")).toBe("err");
  });
});

describe("a focus frames the session where nobody is covering it", () => {
  const pane = { width: 1080, height: 850 };
  const noRail = { top: 56, left: 72, bottom: 32, right: 32 };
  const screen = (vp: { x: number; y: number; zoom: number }, b: { x: number; y: number; width: number; height: number }) => ({
    left: b.x * vp.zoom + vp.x, right: (b.x + b.width) * vp.zoom + vp.x,
    top: b.y * vp.zoom + vp.y, bottom: (b.y + b.height) * vp.zoom + vp.y,
  });

  it("centres a session that fits, in the frame left over by the insets", () => {
    const context = { x: 1000, y: 500, width: 600, height: 300 };
    const vp = focusViewport({ pane, insets: noRail, context, anchor: { x: 1000, y: 600, width: 240, height: 110 } });
    expect(vp.zoom).toBe(FOCUS_MAX_ZOOM);
    const s = screen(vp, context);
    const midX = noRail.left + (pane.width - noRail.left - noRail.right) / 2;
    const midY = noRail.top + (pane.height - noRail.top - noRail.bottom) / 2;
    expect((s.left + s.right) / 2).toBeCloseTo(midX, 5);
    expect((s.top + s.bottom) / 2).toBeCloseTo(midY, 5);
  });

  it("never zooms below the full card or above 1:1", () => {
    const huge = { x: 0, y: 0, width: 9000, height: 9000 };
    const tiny = { x: 0, y: 0, width: 50, height: 20 };
    expect(focusViewport({ pane, insets: noRail, context: huge, anchor: tiny }).zoom).toBe(FOCUS_MIN_ZOOM);
    expect(focusViewport({ pane, insets: noRail, context: tiny, anchor: tiny }).zoom).toBe(FOCUS_MAX_ZOOM);
    expect(nextLod("overview", FOCUS_MIN_ZOOM), "a focus must land on the full card").toBe("detail");
  });

  it("keeps the card itself whole when its session is too big to fit", () => {
    // A root at the left end of an eight-subagent session: the root lands at
    // the frame's left edge, and its subagents run off to the right.
    const context = { x: 0, y: 0, width: 1600, height: 1400 };
    const root = { x: 0, y: 640, width: 260, height: 126 };
    const vp = focusViewport({ pane, insets: noRail, context, anchor: root });
    const s = screen(vp, root);
    expect(s.left).toBeCloseTo(noRail.left, 5);
    expect(s.right).toBeLessThanOrEqual(pane.width - noRail.right);
    expect(s.top).toBeGreaterThanOrEqual(noRail.top);
    expect(s.bottom).toBeLessThanOrEqual(pane.height - noRail.bottom);
  });

  it("keeps the card clear of the rail of floating panels", () => {
    // The machine and usage panels over the right 580px of the canvas.
    const rail = { ...noRail, right: 580 + 32 };
    const context = { x: 0, y: 0, width: 700, height: 130 };
    const anchor = { x: 440, y: 0, width: 260, height: 126 };
    const s = screen(focusViewport({ pane, insets: rail, context, anchor }), anchor);
    expect(s.right).toBeLessThanOrEqual(pane.width - rail.right + 1e-6);
    expect(s.left).toBeGreaterThanOrEqual(rail.left - 1e-6);
  });

  it("unions boxes, and has nothing to say about none", () => {
    expect(unionBox([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }]))
      .toEqual({ x: 0, y: -5, width: 25, height: 15 });
    expect(unionBox([])).toBeNull();
  });
});

describe("the peek opens on a pause, swaps at once, and closes only its own card", () => {
  beforeEach(() => { vi.useFakeTimers(); hidePeek(); });
  afterEach(() => { hidePeek(); vi.useRealTimers(); });
  const el = {} as Element;

  it("waits out a pointer crossing on its way somewhere else", () => {
    showPeek("a", el);
    expect(peekedId()).toBeNull();
    hidePeek("a");
    vi.advanceTimersByTime(500);
    expect(peekedId()).toBeNull();
  });

  it("opens after the pause, and moves to the next card without one", () => {
    showPeek("a", el);
    vi.advanceTimersByTime(200);
    expect(peekedId()).toBe("a");
    showPeek("b", el);
    expect(peekedId()).toBe("b");
  });

  it("ignores a late leave from the card it already moved off", () => {
    showPeek("a", el);
    vi.advanceTimersByTime(200);
    showPeek("b", el);
    hidePeek("a");
    expect(peekedId()).toBe("b");
  });

  it("opens at once for the keyboard", () => {
    showPeek("a", el, "focus");
    expect(peekedId()).toBe("a");
  });
});

describe("the canvas wiring the pure halves depend on", () => {
  it("never makes a card subscribe to the viewport", () => {
    // The mode is an attribute on the canvas and the zoom a variable on it; a
    // card that re-rendered per pinch frame would cost every card every frame.
    expect(node).not.toMatch(/useViewport|useStore\(/);
    expect(app).toMatch(/nextLod\(lodRef\.current, vp\.zoom, lodCard\(\)\)/);
    expect(app).toMatch(/if \(mode !== lodRef\.current\) \{/);
    expect(app).toContain('data-lod={lod}');
  });

  it("draws the face in every card and hides it from assistive technology", () => {
    expect(node).toContain('<NodeFace data={data} title={data.kind === "root" ? naming.face : undefined} />');
    expect(node).toMatch(/className="lod-face"[\s\S]{0,200}aria-hidden/);
    expect(css).toMatch(/\.lod-face \{ display: none; \}/);
  });

  it("keeps the card's own rows in their box below the full card", () => {
    expect(css).toMatch(/\.canvas-wrap\[data-lod="compact"\] \.agent-node > :not\(\.lod-face\),\s*\.canvas-wrap\[data-lod="overview"\] \.agent-node > :not\(\.lod-face\) \{\s*visibility: hidden;\s*\}/);
  });

  it("scales edges by the mode, not by a width of their own", () => {
    expect(app).toContain("strokeWidth: `calc(${selectedWidth}px * var(--edge-k, 1))`");
    expect(css).toMatch(/\.canvas-wrap\[data-lod="overview"\] \{ --edge-k: calc\(0\.85 \/ var\(--zoom, 1\)\); \}/);
  });

  it("stops drawing the bubbles once they cannot be read", () => {
    expect(css).toMatch(/\.canvas-wrap\[data-lod="compact"\] \.tool-burst,[^{]*\.canvas-wrap\[data-lod="overview"\] \.tool-conn \{\s*visibility: hidden;\s*\}/);
  });

  it("sends every single-card camera move through focusAgent", () => {
    // fitView over one node centred on the whole pane — under the panels — and
    // zoomed to 1.6. None is left.
    expect(app).not.toMatch(/rf\.fitView\(\{[^}]*nodes: \[/);
    expect(clusters).not.toContain("rf.fitView(");
    expect(app).toMatch(/selectAgent\(id, e\.shiftKey, false\);\s*if \(e\.shiftKey\) return;/);
    expect(app).toMatch(/setDetailOpen\(false\);\s*window\.setTimeout\(\(\) => \{ try \{ focusAgent\(id\); \} catch \{\} \}, 80\);\s*\} else \{\s*focusAgent\(id\);/);
    expect(app).toMatch(/if \(e\.key === "z" \|\| e\.key === "Z"\) \{\s*if \(primarySelectedIdRef\.current\) focusAgent\(primarySelectedIdRef\.current\);/);
  });

  it("lets no fit's late correction undo a newer camera move", () => {
    expect(app).toMatch(/const epoch = \+\+cameraEpochRef\.current;\s*applyViewport\(want, duration\);/);
    expect(app).toMatch(/if \(cameraEpochRef\.current !== epoch\) return;/);
  });

  it("opens the peek only where the card cannot say it itself", () => {
    expect(app).toMatch(/if \(lodRef\.current == null \|\| lodRef\.current === "detail"\) return;\s*showPeek\(n\.id, e\.currentTarget as Element\);/);
    expect(app).toContain('if (mode === "detail") hidePeek();');
    // And for the keyboard, not only the pointer.
    expect(app).toMatch(/el\.matches\(":focus-visible"\)\) showPeek\(id, el, "focus"\)/);
  });

  it("peeks a recap note as well as a card", () => {
    // The note is the other node that is unreadable at a distance.
    expect(app).toMatch(/if \(\(n\.type !== "agent" && n\.type !== "recapNote"\) \|\| draggingRef\.current\) return;/);
    expect(app).toContain("recapFor={peekRecap}");
    const peek = read("../components/SessionPeek.tsx");
    expect(peek).toContain('if (r) return <RecapPeek key={t.id} r={r} anchor={t.anchor} bounds={bounds} />;');
    expect(peek).toContain('<p className="recap-peek-text">{r.recap.text}</p>');
  });

  it("marks a blocked session on the one label that is 1× at every zoom", () => {
    expect(clusters).toContain('data-alarm={c.alarm ? "" : undefined}');
    expect(clusters).toContain('<span className="cluster-label-said">waiting on you: </span>');
    expect(css).toMatch(/\.cluster-label\[data-alarm\] \{\s*border-color: var\(--warn\);\s*\}/);
  });
});
