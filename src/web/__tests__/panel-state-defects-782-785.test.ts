// Four defects in the running page, all of the same family: state that is
// correct in isolation and wrong in the order it is read.
//
//   #784  the usage headline overshot for a moment on every reading
//   #782  Browser Watch marked episodes read four times a second
//   #783  a hidden tool category could become unreachable
//   #785  clicking a session's name silently switched auto-fit off for good
//
// Three of the four are one-line changes and none of them can be seen without a
// DOM, which this suite does not have. What CAN be checked is the rule each one
// rests on, and where that rule is a pure function it is called rather than
// matched — the panel's source-selection moved into usage-from-ccusage.ts in
// 3.6.1 precisely so this file could do that.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { panelFigures, rangeView, type Board, type Delta, type Landed, type UsageRange } from "../usage-from-ccusage";
import { boardBySession, liveDelta, type CountableAgent } from "../live-delta";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/UsagePanel.tsx");
const app = read("../App.tsx");
const watchModal = read("../components/BrowserWatchModal.tsx");
const clusters = read("../components/SessionClusters.tsx");

const root = (id: string, input: number): CountableAgent => ({
  kind: "root", sessionId: id, model: "claude-opus-5",
  usage: {
    inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheCreate1hTokens: 0, cacheCreate5mTokens: 0, reasoningOutputTokens: 0,
  },
} as never);

const RANGE = (tokens: number): UsageRange => ({
  ok: true,
  totals: { totalCost: 10, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: tokens },
} as unknown as UsageRange);

const BOARD: Board = { cost: { total: 1 }, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreateTokens: 1, sum: 2 };
const NONE: Delta = { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };

describe("#784 — the reading and the point it is measured from", () => {
  it("travel together, so no pairing of new-with-old is representable", () => {
    // The defect was an ORDERING one: the baseline lived in a ref written by an
    // effect and read by a memo, both keyed on the reading — and React runs the
    // memo during render and the effect after commit. On the render where a new
    // reading arrived the memo held the previous baseline, so the delta covered
    // a minute the new reading already contained.
    //
    // With the baseline inside `landed`, the wrong pairing cannot be built:
    // there is one object and one setter.
    const at1000 = boardBySession([root("s1", 1000)]);
    const landed: Landed = { period: "today", data: RANGE(1000), baseline: at1000 };
    const view = rangeView(landed, "today");
    expect(view.baseline).toBe(at1000);

    // Nothing has happened since the reading, so the delta is nothing and the
    // headline is exactly the reading. This is the render that used to overshoot.
    const delta = liveDelta(view.baseline, boardBySession([root("s1", 1000)]));
    expect(delta.inputTokens).toBe(0);
    expect(panelFigures(view.data, BOARD, delta).inputTokens).toBe(1000);
  });

  it("still adds what the canvas gained after the reading", () => {
    // The other direction, so the fix cannot be "always zero".
    const landed: Landed = { period: "today", data: RANGE(1000), baseline: boardBySession([root("s1", 1000)]) };
    const view = rangeView(landed, "today");
    const delta = liveDelta(view.baseline, boardBySession([root("s1", 1600)]));
    expect(delta.inputTokens).toBe(600);
    expect(panelFigures(view.data, BOARD, delta).inputTokens).toBe(1600);
  });

  it("reports no delta at all before the first reading, baseline and all", () => {
    const view = rangeView(null, "today");
    expect(view.baseline).toBeNull();
    expect(liveDelta(view.baseline, boardBySession([root("s1", 1000)])).inputTokens).toBe(0);
    expect(panelFigures(view.data, BOARD, NONE).fromRange).toBe(false);
  });

  it("is wired that way in the panel, with no effect left to be one render late", () => {
    expect(panel).toContain("setLanded({ period: want, data: d, baseline: takeBaseline() });");
    expect(panel).toContain("liveDelta(baseline, boardBySession(state.agents.values(), now))");
    expect(panel, "the baseline is back in a ref an effect writes").not.toContain("baselineRef.current =");
    // And the snapshot handed to the hook must be stable, or the fetch re-runs
    // on every 250ms tick — which would be a far louder bug than the one fixed.
    expect(panel).toContain("const takeBaseline = useCallback(() => boardNowRef.current(), []);");
  });
});

describe("#782 — when Browser Watch marks episodes read", () => {
  it("is on unmount, which is what the comment always claimed", () => {
    // `[onSeen]` with a fresh arrow from App, which re-renders every 250ms:
    // the cleanup WAS the loop. The badge cleared on open rather than on close,
    // any episode the 10s poll added while reading was stamped seen before it
    // was ever badged, and localStorage was written four times a second.
    expect(watchModal).toContain("useEffect(() => () => onSeenRef.current(Date.now()), []);");
    expect(watchModal, "the callback identity is a dependency again")
      .not.toContain("useEffect(() => () => onSeen(Date.now()), [onSeen]);");
    // The ref is what makes the empty dependency list correct rather than a
    // stale-closure bug: the effect reads the latest callback at unmount.
    expect(watchModal).toContain("onSeenRef.current = onSeen;");
  });
});

describe("#783 — the tool-category filter", () => {
  it("keeps its bar on screen while anything is hidden", () => {
    // Hide a category, let the canvas turn over — it evicts finished sessions
    // on a timer — and the bar was gone while the filter was still applied.
    // Every bubble suppressed, no chip to press, and Clear does not reset it:
    // a page reload was the only way back.
    expect(app).toContain("{(presentCats.length > 1 || hiddenCats.size > 0) && (");
    expect(app, "the bar is gated on what is present alone again")
      .not.toContain("{presentCats.length > 1 && (");
  });

  it("still applies the filter downstream, so the bar is not merely decorative", () => {
    // If this stopped being true the bar would be a control over nothing, and
    // the case above would pass over a feature that had quietly been removed.
    expect(app).toContain("hiddenCategories={hiddenCats}");
  });
});

describe("#785 — a camera move the deck made itself", () => {
  it("is stamped, so it cannot read as the user grabbing the canvas", () => {
    // `fitView`'s animation emits `onMove` with no source event, and
    // `isUserViewportGesture` falls back to "was there a pointerdown recently"
    // — which there was, because the click asking for the fit landed on
    // `<main onPointerDownCapture={markCanvasInput}>`. Unstamped, the deck read
    // its own move as a gesture, called disableAutoFit() and persisted it.
    expect(clusters).toContain("rf.fitView({ padding: 0.3, duration: 500, nodes });");
    expect(clusters).toContain("onFit?.();");
    expect(app).toContain("<SessionClusters onFit={() => { lastFitTimeRef.current = Date.now(); }} />");
  });

  it("stamps after the fit and inside the try, the way App's own focusSession does", () => {
    // A fit that threw moved no camera and has nothing to disown; stamping
    // before it would suppress a genuine gesture that arrived in the meantime.
    const fit = clusters.indexOf("rf.fitView({ padding: 0.3, duration: 500, nodes });");
    const stamp = clusters.indexOf("onFit?.();");
    const catchAt = clusters.indexOf("} catch {}", fit);
    expect(fit).toBeGreaterThan(-1);
    expect(stamp, "the stamp is before the fit").toBeGreaterThan(fit);
    expect(stamp, "the stamp is outside the try").toBeLessThan(catchAt);
    // The pattern it mirrors, one file over.
    expect(app).toContain("lastFitTimeRef.current = Date.now();");
  });
});
