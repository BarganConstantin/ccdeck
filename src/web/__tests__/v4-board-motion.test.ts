// V4's motion spec for the Board: the camera, a session joining, re-arranging, a
// card leaving, the tool bursts, Land, the board's tooltip and a busy board.
// Three layers, as the rest of the suite reads motion: the numbers held to the
// sheet's tokens, the sheet read for the mechanisms the spec names, and the
// camera driven through mocked React Flow so the tween's curve, its
// interruption and its zoom steps are watched rather than assumed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

vi.mock("react", async orig => ({
  ...(await orig<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));

/** The d3 pane, reduced to what the camera calls: a zoom transform with the
 *  two relative builders, a selection that can make a transition and be
 *  interrupted, and a zoom behaviour that records what it is handed. */
const pane = vi.hoisted(() => {
  class T {
    constructor(public k: number, public x: number, public y: number) {}
    scale(k: number) { return new T(this.k * k, this.x, this.y); }
    translate(x: number, y: number) { return new T(this.k, this.x + this.k * x, this.y + this.k * y); }
  }
  const made: { duration: number; ease: (t: number) => number }[] = [];
  const selection = {
    property: () => new T(1, 0, 0),
    transition: () => {
      const rec = { duration: -1, ease: ((t: number) => t) as (t: number) => number };
      made.push(rec);
      return { duration: (ms: number) => { rec.duration = ms; return { ease: (fn: (t: number) => number) => { rec.ease = fn; return { rec }; } }; } };
    },
    interrupt: vi.fn(),
  };
  const zoom = { transform: vi.fn(), scaleTo: vi.fn() };
  return { T, made, selection, zoom };
});
const rf = vi.hoisted(() => ({ setViewport: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }));
vi.mock("reactflow", () => ({
  useReactFlow: () => rf,
  useStoreApi: () => ({ getState: () => ({ d3Zoom: pane.zoom, d3Selection: pane.selection, minZoom: 0.2, maxZoom: 2 }) }),
}));

const { useCamera } = await import("../use-camera");
const { easeOut } = await import("../navigator-flip");
const { CAMERA_FAST_MS, CAMERA_SLOW_MS } = await import("../viewport-motion");

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); pane.made.length = 0; });

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${WEB}${p}`, "utf8");
const stripped = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read("styles/tokens.css");
const token = (name: string) => Number.parseFloat(new RegExp(`--${name}:\\s*([\\d.]+)ms`).exec(tokens)![1]);

describe("the camera's numbers are the sheet's", () => {
  it("rides the stage curve the stage does", async () => {
    const { STAGE_EASE } = await import("../motion-ease");
    const { FLIP_EASE } = await import("../navigator-flip");
    expect([...STAGE_EASE]).toEqual([...FLIP_EASE]);
  });

  it("takes Slow for a fit, a recenter, a jump, F and Z, and Fast for a zoom step", () => {
    expect(CAMERA_SLOW_MS).toBe(token("dur-slow"));
    expect(CAMERA_FAST_MS).toBe(token("dur-fast"));
  });

  it("asks every fit, focus and undo for Slow and none for a number of its own", () => {
    for (const file of ["use-auto-fit.ts", "use-auto-fit-switch.ts", "use-reframe.ts", "use-board-layout.ts"]) {
      expect(stripped(file), file).not.toMatch(/fitLeft\(\d/);
    }
    expect(stripped("use-board-layout.ts")).toMatch(/moveCamera\(kept\.viewport, CAMERA_SLOW_MS\)/);
    expect(stripped("use-agent-focus.ts")).toMatch(/const FOCUS_MS = CAMERA_SLOW_MS;/);
    // Round 3 adds who asked (the auto-fit, or a Fit all that still holds)
    // after the duration.
    expect(stripped("use-camera.ts")).toMatch(/fitLeft = useCallback\(\(duration = CAMERA_SLOW_MS, reach: FitReach = fitAllHeldRef\.current \? "all" : "auto"\)/);
    expect(stripped("use-camera.ts")).toMatch(/fitAllHeldRef\.current = true;\s*fitLeft\(CAMERA_SLOW_MS, "all"\);/);
  });

  it("opens already fitted: no duration, no glide", () => {
    expect(stripped("components/BoardFlow.tsx")).toMatch(/fitViewOptions=\{\{ padding: 0\.25 \}\}/);
    expect(read("components/BoardFlow.tsx")).not.toMatch(/OPENING_FIT_MS/);
  });
});

describe("the first paint is still", () => {
  it("jumps every fit while the board is opening and glides Slow after", async () => {
    const { fitDuration, OPENING_STILL_MS } = await import("../use-auto-fit");
    const opened = 10_000;
    expect(fitDuration(opened, opened)).toBe(0);
    expect(fitDuration(opened, opened + OPENING_STILL_MS - 1)).toBe(0);
    expect(fitDuration(opened, opened + OPENING_STILL_MS)).toBe(CAMERA_SLOW_MS);
    // A board that has not opened yet has nothing to keep still.
    expect(fitDuration(0, opened)).toBe(CAMERA_SLOW_MS);
  });

  it("opens when the first session is on the board, not when the deck mounts", async () => {
    const { layoutSignature, signatureHasAgents } = await import("../layout-signature");
    expect(signatureHasAgents(layoutSignature([], 0, new Set(), 0, 0))).toBe(false);
    expect(signatureHasAgents("")).toBe(false);
    expect(signatureHasAgents("a|b>a#sv2.1")).toBe(true);
    const code = stripped("use-auto-fit.ts");
    expect(code).toMatch(/if \(!openedAtRef\.current && signatureHasAgents\(layoutSig\)\) openedAtRef\.current = Date\.now\(\);/);
  });

  // Three triggers since the round-2 critique: the drift watchdog, a layout
  // signature that moved, and the first flow into columns (fitSoon).
  it("sends every trigger's fit through the opening's duration", () => {
    const code = stripped("use-auto-fit.ts").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    expect(code).toMatch(/const fit = \(\) => fitLeft\(fitDuration\(openedAtRef\.current, Date\.now\(\)\)\);/);
    expect(code.match(/\bfit\(\);/g)).toHaveLength(4);
    expect(code).not.toMatch(/fitLeft\(\);/);
  });
});

describe("the camera tween", () => {
  const move = () => {
    vi.stubGlobal("document", { hidden: false });
    const camera = useCamera();
    camera.moveCamera({ x: 100, y: 50, zoom: 0.5 }, CAMERA_SLOW_MS);
    return camera;
  };

  it("runs on the stage curve, not d3's own cubic in-out, for the time it was asked", () => {
    move();
    expect(pane.zoom.transform).toHaveBeenCalledTimes(1);
    expect(pane.made).toHaveLength(1);
    expect(pane.made[0].duration).toBe(CAMERA_SLOW_MS);
    for (const t of [0.1, 0.35, 0.5, 0.8]) expect(pane.made[0].ease(t)).toBeCloseTo(easeOut(t), 10);
    // --ease-stage is steep at the start; cubic in-out is not.
    expect(pane.made[0].ease(0.2)).toBeGreaterThan(0.3);
  });

  it("is stopped where it stands when the reader takes the camera, once", () => {
    const camera = move();
    const epoch = camera.cameraEpochRef.current;
    camera.takeOver();
    expect(pane.selection.interrupt).toHaveBeenCalledTimes(1);
    expect(camera.cameraEpochRef.current).toBe(epoch + 1);
    // What follows reads as the reader's gesture, not as the tail of the fit.
    expect(camera.lastFitTimeRef.current).toBe(0);
    // Nothing is running any more, so a second press changes nothing.
    camera.takeOver();
    expect(pane.selection.interrupt).toHaveBeenCalledTimes(1);
  });

  it("does nothing to a camera that is not moving", () => {
    vi.stubGlobal("document", { hidden: false });
    const camera = useCamera();
    camera.takeOver();
    expect(pane.selection.interrupt).not.toHaveBeenCalled();
    expect(camera.cameraEpochRef.current).toBe(0);
  });

  it("does not tween under reduced motion: it puts the pane there at once", () => {
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const camera = useCamera();
    camera.moveCamera({ x: 100, y: 50, zoom: 0.5 }, CAMERA_SLOW_MS);
    expect(pane.made).toHaveLength(0);
    expect(pane.zoom.transform.mock.calls[0][0]).toBe(pane.selection);
  });

  it("steps the zoom in Fast on the same curve, and a second press adds to the first", () => {
    vi.stubGlobal("document", { hidden: false });
    const camera = useCamera();
    camera.zoomBy(1.2);
    expect(pane.made[0].duration).toBe(CAMERA_FAST_MS);
    expect(pane.made[0].ease(0.3)).toBeCloseTo(easeOut(0.3), 10);
    expect(pane.zoom.scaleTo.mock.calls[0][1]).toBeCloseTo(1.2, 10);
    // The pane has not moved in this mock; the second press still builds on the goal.
    camera.zoomBy(1.2);
    expect(pane.zoom.scaleTo.mock.calls[1][1]).toBeCloseTo(1.44, 10);
  });

  it("holds a zoom step to the pane's range, and leaves auto-fit's stamp cleared so it is the reader's", () => {
    vi.stubGlobal("document", { hidden: false });
    const camera = useCamera();
    camera.zoomBy(10);
    expect(pane.zoom.scaleTo.mock.calls[0][1]).toBe(2);
    expect(camera.lastFitTimeRef.current).toBe(0);
  });

  it("resets to 100% in Fast", () => {
    vi.stubGlobal("document", { hidden: false });
    const camera = useCamera();
    camera.zoomReset();
    expect(pane.made[0].duration).toBe(CAMERA_FAST_MS);
    expect(pane.zoom.scaleTo.mock.calls[0][1]).toBe(1);
  });
});

describe("the canvas hands a press or a wheel to the camera", () => {
  it("takes the camera on pointer down and on the wheel, and not on the release", () => {
    const code = stripped("use-canvas-viewport.ts");
    expect(code).toMatch(/e\?\.type === "pointerdown" \|\| e\?\.type === "wheel"\) takeOver\(\)/);
    expect(stripped("components/CanvasMain.tsx")).toMatch(/onPointerDownCapture=\{markCanvasInput\}/);
  });
});

describe("a session joins, a card leaves", () => {
  it("joins with opacity and 0.96 to 1 in Base, from @starting-style, only on a live board", () => {
    expect(sheet).toMatch(/@starting-style\s*\{\s*\.canvas-wrap\[data-live\] \.react-flow__node \.agent-node\s*\{\s*opacity:\s*0;\s*transform:\s*scale\(var\(--enter-scale\)\);\s*\}\s*\}/);
    expect(sheet).toMatch(/opacity var\(--dur-base\) var\(--ease\),\s*transform var\(--dur-base\) var\(--ease\);/);
    expect(sheet).not.toMatch(/nodeSpawn|nodeExit|edgeExit/);
    // The canvas carries the flag only once the log has replayed and the cards have settled.
    expect(stripped("App.tsx")).toMatch(/joins=\{historyReplayed && settled\}/);
    expect(stripped("components/CanvasMain.tsx")).toMatch(/data-live=\{joins \? "" : undefined\}/);
  });

  it("moves its neighbours in Slow on the stage curve, armed after the card has existed 600ms", () => {
    const rule = /(?:^|\n)\.react-flow__node\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(rule).toMatch(/transition:\s*transform calc\(var\(--node-armed\) \* var\(--dur-slow\)\) var\(--ease-stage\), opacity var\(--dur-base\) var\(--ease\);/);
    expect(rule).toMatch(/animation:\s*node-arm 1ms steps\(1, end\) 600ms forwards;/);
    expect(sheet).toMatch(/@property --node-armed\s*\{[^}]*initial-value:\s*0;/);
  });

  it("leaves with its opacity in Exit, then lets the neighbours close up after a hold", () => {
    const exiting = /\.react-flow__node\.rf-exiting \.agent-node\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(exiting).toMatch(/opacity:\s*0;/);
    expect(exiting).toMatch(/transition:\s*opacity var\(--dur-exit\) var\(--ease\);/);
    expect(exiting).not.toMatch(/transform|filter|animation|scale/);
    expect(sheet).toMatch(/\.canvas-wrap\s*\{\s*--leave-hold:\s*100ms;\s*\}/);
    expect(sheet).toMatch(/\.canvas-wrap\.closing \.react-flow__node\s*\{\s*transition-delay:\s*var\(--leave-hold\), 0s;/);
    // The card is removed when its Exit fade ends, so the gap waits only the
    // hold above, not an invisible card.
    const exitMs = Number(/--dur-exit:\s*(\d+)ms/.exec(read("styles/tokens.css"))![1]);
    expect(read("visibility.ts")).toMatch(new RegExp(`EXIT_ANIM_MS = ${exitMs};`));
  });

  it("says the gap is closing only when a card has gone", () => {
    const code = stripped("use-bubble-animation.ts");
    expect(code).toMatch(/if \(!visible\.has\(id\)\) \{ gone = true; break; \}/);
    expect(code).toMatch(/const BUBBLE_MS = 400;/);
  });

  it("fades under reduced motion: no scale on the way in, no travel for a push", () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/.exec(stripped("styles/canvas-motion.css"))![0];
    expect(reduced).toMatch(/\.react-flow__node\s*\{\s*transition:\s*opacity var\(--dur-base\) var\(--ease\);\s*animation:\s*none;/);
    expect(reduced).toMatch(/@starting-style\s*\{\s*\.canvas-wrap\[data-live\] \.react-flow__node \.agent-node\s*\{\s*transform:\s*none;/);
  });
});

describe("re-arrange and its undo strip", () => {
  it("shows the strip 400 after R and keeps the offer the 7 seconds the spec says", async () => {
    const mod = await import("../rearrange-undo");
    expect(mod.REARRANGE_UNDO_SHOW_MS).toBe(token("dur-slow"));
    expect(mod.REARRANGE_UNDO_MS).toBe(7_000 + mod.REARRANGE_UNDO_SHOW_MS);
    expect(mod.REARRANGE_UNDO_EXIT_MS).toBe(token("dur-exit"));
  });

  it("enters and leaves with opacity and 8px of y as transitions, the exit without the wait", () => {
    const strip = /(?:^|\n)\.rearrange-undo\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(strip).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\) var\(--dur-slow\), translate var\(--dur-base\) var\(--ease\) var\(--dur-slow\);/);
    expect(sheet).toMatch(/@starting-style\s*\{\s*\.rearrange-undo\s*\{\s*opacity:\s*0;\s*translate:\s*0 8px;/);
    const leaving = /\.rearrange-undo\.leaving\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(leaving).toMatch(/opacity:\s*0;/);
    expect(leaving).toMatch(/translate:\s*0 8px;/);
    expect(leaving).toMatch(/transition-duration:\s*var\(--dur-exit\);/);
    expect(leaving).toMatch(/transition-delay:\s*0s;/);
    expect(sheet).not.toMatch(/rearrangeUndo(In|Out|FadeIn|FadeOut)/);
  });

  it("moves the cards of a re-arrange as every push does, and the session boxes with them", () => {
    const box = /(?:^|\n)\.cluster-card\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(box).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\), transform calc\(var\(--node-armed\) \* var\(--dur-slow\)\) var\(--ease-stage\);/);
    expect(box).not.toMatch(/transition:[^;]*\b(width|height)\b/);
  });
});

describe("the tool bursts", () => {
  it("rise in Base, leave in Exit, and fail by changing colour in Fast", async () => {
    expect(sheet).toMatch(/@keyframes burst-rise\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(4px\);/);
    const burst = /(?:^|\n)\.tool-burst\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(burst).toMatch(/animation:\s*burst-rise var\(--dur-base\) var\(--ease\) backwards;/);
    expect(burst).toMatch(/transition:\s*border-color var\(--dur-fast\) var\(--ease\), background-color var\(--dur-fast\) var\(--ease\), opacity var\(--dur-base\) var\(--ease\);/);
    expect(sheet).toMatch(/\.tool-burst\.fading\s*\{\s*opacity:\s*0;\s*transition:\s*opacity var\(--dur-exit\) var\(--ease\);/);
    expect(read("burst-layout.ts")).toMatch(/const FADE_MS = 150;/);
    expect(token("dur-exit")).toBe(150);
  });

  it("has no blur, no box-shadow in motion, no shake and nothing above scale 1", () => {
    for (const gone of ["bubble-spawn", "bubble-done-flash", "bubble-err-shake", "bubble-fade-move", "bubble-fade-out", "emoji-wobble", "mark-pop"]) {
      expect(sheet, gone).not.toContain(gone);
    }
    const bursts = stripped("styles/tool-bursts.css");
    const keyframes = [...bursts.matchAll(/@keyframes[^{]+\{([\s\S]*?\n\})/g)].map(m => m[1]).join("\n");
    expect(keyframes).not.toMatch(/blur|brightness|box-shadow|shake|scale\(1\.\d/);
    for (const m of bursts.matchAll(/transition:\s*([^;]+);/g)) expect(m[1], m[0]).not.toMatch(/box-shadow|filter/);
  });
});

describe("Land on the board", () => {
  it("washes the card with the accent at 16%, fading out over Base, once, as a transition", () => {
    const wash = /\.agent-node::after\s*\{([^}]*)\}/.exec(sheet)![1];
    expect(wash).toMatch(/background:\s*color-mix\(in srgb, var\(--accent\) 16%, transparent\);/);
    expect(wash).toMatch(/opacity:\s*0;/);
    expect(wash).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease\);/);
    expect(sheet).toMatch(/\.agent-node\[data-land\]::after\s*\{\s*opacity:\s*1;\s*transition:\s*none;/);
    // A colour: reduced motion has nothing to take away, so no rule touches it.
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/.exec(stripped("styles/canvas-motion.css"))![0];
    expect(reduced).not.toMatch(/data-land|::after/);
  });

  it("is given by the one door n, W, a notification and ⌘K share, after the camera has arrived", () => {
    const code = stripped("use-agent-focus.ts");
    expect(code).toMatch(/window\.setTimeout\(\(\) => landOnCard\(sessionId\), landDelayMs\(FOCUS_MS\)\)/);
  });

  it("lands at once when the camera jumps", async () => {
    const { landDelayMs } = await import("../card-land");
    vi.stubGlobal("document", { hidden: false });
    expect(landDelayMs()).toBe(CAMERA_SLOW_MS);
    vi.stubGlobal("document", { hidden: true });
    expect(landDelayMs()).toBe(0);
    vi.stubGlobal("document", { hidden: false });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(landDelayMs()).toBe(0);
  });
});

describe("the board's tooltip", () => {
  it("is the deck's: the cost tip waits 450, skips the wait for the next one, and goes after a 100 grace", () => {
    const tip = stripped("components/CostTip.tsx");
    expect(tip).toMatch(/if \(wait <= 0 \|\| hintSkipsWait\(\)\) reveal\(\);/);
    expect(tip).toMatch(/window\.setTimeout\(hide, HINT_GRACE_MS\)/);
    expect(tip).toMatch(/onPointerLeave=\{leave\}/);
    expect(tip).toMatch(/data-instant=\{instant \|\| undefined\}/);
  });

  it("comes with opacity and 4px in Fast, and with opacity only under reduced motion", () => {
    expect(sheet).toMatch(/\.cost-tip\s*\{\s*transition:\s*opacity var\(--dur-fast\) var\(--ease\), transform var\(--dur-fast\) var\(--ease\);\s*\}/);
    expect(sheet).toMatch(/@starting-style\s*\{\s*\.cost-tip\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(-4px\);/);
    expect(sheet).toMatch(/\.cost-tip\[data-instant\]\s*\{\s*transition:\s*none;/);
    expect(sheet).toMatch(/\.cost-tip\s*\{\s*transition:\s*opacity var\(--dur-fast\) var\(--ease\);\s*\}\s*@starting-style\s*\{\s*\.cost-tip\s*\{\s*transform:\s*none;/);
  });
});

describe("a busy board animates only transform and opacity", () => {
  const board = ["react-flow.css", "canvas.css", "canvas-motion.css", "tool-bursts.css", "agent-node.css", "session-clusters.css", "context-modal.css", "search-and-banners.css"]
    .map(f => ({ f, css: stripped(`styles/${f}`) }));

  it("transitions no box-shadow or filter on the board's rules", () => {
    for (const { f, css } of board) {
      for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
        expect(m[1], `${f}: ${m[0]}`).not.toMatch(/box-shadow|filter|backdrop-filter/);
      }
    }
  });

  it("eases no width or height on the session box", () => {
    const clusters = stripped("styles/session-clusters.css");
    for (const m of clusters.matchAll(/transition:\s*([^;]+);/g)) expect(m[1]).not.toMatch(/\b(width|height)\b/);
  });

  it("runs dashflow on a wire whose session is working, never on a selected idle one", () => {
    expect(sheet).not.toMatch(/\.rf-edge-selected \.react-flow__edge-path\s*\{[^}]*animation/);
    expect(stripped("canvas-flow.ts")).toMatch(/animated: a\.state === "active" && !fading,/);
  });

  it("leaves a card with a fade on its wire too, in Exit", () => {
    expect(stripped("canvas-flow.ts")).toMatch(/\.\.\.\(fading \? \{ "--edge-transition": "opacity var\(--dur-exit\) var\(--ease\)" \} : null\)/);
    expect(stripped("canvas-flow.ts")).toMatch(/const effectiveOpacity = fading\s*\? 0/);
  });

  it("puts every hover on the board behind the media query", () => {
    for (const { f, css } of board) {
      let depth = 0;
      const stack: boolean[] = [];
      let start = 0;
      for (let i = 0; i < css.length; i++) {
        if (css[i] === "{") {
          const prelude = css.slice(start, i).trim();
          stack.push(/^@media[^{]*hover:\s*hover/.test(prelude));
          if (prelude.includes(":hover") && !prelude.startsWith("@") && !stack.slice(0, -1).some(Boolean)) {
            expect.fail(`${f}: ${prelude.slice(0, 80)} is not behind (hover: hover)`);
          }
          depth++;
          start = i + 1;
        } else if (css[i] === "}") {
          stack.pop();
          depth--;
          start = i + 1;
        } else if (css[i] === ";") start = i + 1;
      }
      expect(depth, f).toBe(0);
    }
  });
});
