// The canvas beside the open git view keeps framing the selected session
// whatever moves under it: the board re-packing for a new window width, a side
// column opening, a reopen while the camera is still on its way back. And what
// the panel covers leaves the Tab order — cluster names as well as cards.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";

const view = sourceOf("components/GitView.tsx");
const reframe = sourceOf("use-reframe.ts");

describe("a window resize that re-packs the board", () => {
  it("frames for the open view from the new arrangement, before the auto-fit's own answer", () => {
    const at = reframe.indexOf("saveLayout(positionsRef.current, pinnedRef.current);");
    const after = reframe.slice(at, reframe.indexOf("if (autoFitDisabledRef.current)", at));
    expect(after).toMatch(/if \(frameForGitView\(0\)\) return;/);
  });
});

describe("the canvas changing size under the open view", () => {
  it("is watched while the view is open: the box is measured again and the camera frames again", () => {
    const at = view.indexOf("const ro = new ResizeObserver(");
    expect(at).toBeGreaterThan(-1);
    const effect = view.slice(view.lastIndexOf("useEffect(", at), view.indexOf("}, [want]);", at));
    expect(effect).toMatch(/if \(!want \|\| !canvas \|\| typeof ResizeObserver === "undefined"\) return;/);
    expect(effect).toMatch(/setBox\(prev => \(sameBox\(prev, measured\) \? prev : measured\)\);\s*frame\(0\);/);
    expect(effect).toMatch(/return \(\) => \{ ro\.disconnect\(\); cancelAnimationFrame\(raf\); \};/);
  });
});

describe("the camera given back on close", () => {
  it("is taken on every open, a sheet's too, so widening past 1100px and closing still gives it back", () => {
    expect(view).not.toMatch(/if \(opening && !sheet\) savedViewport\.current/);
    expect(view).toMatch(/savedViewport\.current = back \?\? rf\.getViewport\(\);/);
  });

  it("is the one a close was taking it back to when the view reopens on the way, not the camera mid-flight", () => {
    // Keyed on the close's own camera move, not on a time: a loaded machine
    // can take far longer than the animation to land it, and while no other
    // move (a fit, a focus, the reader's pan) has superseded it, where it was
    // going is the camera to give back.
    expect(view).toMatch(/const back = restoring\.current && cameraEpochRef\.current === restoring\.current\.epoch \? restoring\.current\.to : null;/);
    expect(view).toMatch(/restoring\.current = \{ to: savedViewport\.current, epoch: moveCamera\(savedViewport\.current, duration\) \};/);
    expect(view).not.toMatch(/until: performance\.now\(\)/);
    // The deck's camera epoch: every move it makes and the reader's own pans bump it.
    expect(sourceOf("App.tsx")).toMatch(/<GitView[^>]*cameraEpochRef=\{cameraEpochRef\}/);
  });
});

describe("what the panel covers", () => {
  it("takes the session clusters' name tags it covers out of the Tab order, as it does cards", () => {
    expect(view).toMatch(/for \(const el of canvas\.querySelectorAll<HTMLElement>\("\.cluster-label"\)\) \{/);
    expect(view).toMatch(/const left = rect\.left \+ x \+ \(\(r\.left - rect\.left - was\.x\) \/ was\.zoom\) \* zoom;/);
    // Read before the camera moves: until it lands, the tags are drawn with the old one.
    expect(view).toMatch(/const was = rf\.getViewport\(\);\s*moveCamera\(plan\.viewport, duration\);/);
  });
});

describe("following the selection to a folder git cannot read", () => {
  it("steps back when the view's own read finds no repository, before the server said so on the card", () => {
    expect(view).toMatch(/if \(!request\.open \|\| away \|\| !UNREADABLE\.has\(data\.state\)\) return;\s*onClose\("pointer"\);\s*window\.dispatchEvent\(new CustomEvent\("gitview:unreadable", \{ detail: agent\.id \}\)\);/);
  });
});
