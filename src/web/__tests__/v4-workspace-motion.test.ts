// V4's motion spec, the Workspace table: Board to Workspace and back, ✕ on a
// pane, Zoom, the stage's open and its close during the open, the divider's
// double click, Usage and Machine arriving and leaving, and where they sit.
// The sheets and sources are read for what only they can say (a duration is a
// token, a travel has a reduced-motion answer, a key is at once); the pure
// parts are run (the view switch, the turn-around of a close, the pinned box).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { easeOut, easeOutInverse, FLIP_CLOSE_MS, FLIP_OPEN_MS, flipFrame, planFlip, runFlip, runTween, type FlipFrame } from "../navigator-flip";
import { canCrossfade, PIN_ATTR, pinBoard, runSwitch, SWITCH_ATTR, unpinBoard } from "../view-switch";
import { LOADER_DELAY_MS, LOADER_EXIT_MS, LOADER_MIN_SHOWN_MS } from "../use-waiting-loader";
import { SNAP_MS } from "../components/terminal/Divider";
import { HEIGHT_HOLD_MS } from "../panel-place";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const workspace = strip(read("styles/workspace.css"));
const panels = strip(read("styles/machine-panel.css"));
const shell = strip(read("styles/stage-shell.css"));
const terminal = strip(read("styles/terminal-stage.css"));
const tokens = strip(read("styles/tokens.css"));

/** A rule's body, by an exact selector (first match). */
function rule(text: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^{}]*)\\}`).exec(text);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+)`).exec(body)?.[1].replace(/\s+/g, " ").trim();

describe("Board to Workspace and back", () => {
  /** A page of just the parts runSwitch touches. */
  function page(withTransition: boolean) {
    const attrs = new Set<string>();
    const log: string[] = [];
    const doc = {
      hidden: false,
      documentElement: {
        setAttribute: (n: string) => { attrs.add(n); },
        removeAttribute: (n: string) => { attrs.delete(n); },
      },
    } as unknown as Document & { startViewTransition?: unknown };
    if (withTransition) {
      (doc as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
        log.push("transition");
        cb();
        return { finished: Promise.resolve() };
      };
    }
    return { doc, attrs, log };
  }

  it("is a crossfade by pointer: the old view is kept and faded, the update runs inside it", async () => {
    const { doc, attrs, log } = page(true);
    expect(canCrossfade(doc)).toBe(true);
    runSwitch("pointer", () => log.push("update"), doc);
    expect(log).toEqual(["transition", "update"]);
    expect(attrs.has(SWITCH_ATTR), "marked while it is drawn").toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(attrs.has(SWITCH_ATTR), "and unmarked when it is over").toBe(false);
  });

  it("is one frame by key: no transition is asked for, the update is done before it returns", () => {
    const { doc, log } = page(true);
    runSwitch("key", () => log.push("update"), doc);
    expect(log).toEqual(["update"]);
  });

  it("switches at once where the page cannot crossfade, or is not being drawn", () => {
    const none = page(false);
    expect(canCrossfade(none.doc)).toBe(false);
    runSwitch("pointer", () => none.log.push("update"), none.doc);
    expect(none.log).toEqual(["update"]);
    const hidden = page(true);
    (hidden.doc as { hidden: boolean }).hidden = true;
    expect(canCrossfade(hidden.doc)).toBe(false);
  });

  it("holds the crossfade on Fast and the deck's curve, and keeps it under reduced motion (it moves nothing)", () => {
    const old = rule(workspace, ":root[data-view-switch]::view-transition-group(root)");
    expect(decl(old, "animation-duration")).toBe("var(--dur-fast)");
    expect(decl(rule(workspace, ":root[data-view-switch]::view-transition-new(root)"), "animation-timing-function")).toBe("var(--ease)");
    // No reduced-motion block touches it: the fade stays, it moves nothing.
    for (const m of workspace.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)) {
      let depth = 1, i = m.index! + m[0].length;
      while (depth && i < workspace.length) { if (workspace[i] === "{") depth++; else if (workspace[i] === "}") depth--; i++; }
      expect(workspace.slice(m.index!, i)).not.toContain("view-transition");
    }
  });

  it("never narrows the Board: the canvas is pinned at the box it had, and the pane measures its own cell", () => {
    const set = new Map<string, string>();
    const attrs = new Set<string>();
    const app = {
      style: { setProperty: (n: string, v: string) => { set.set(n, v); }, removeProperty: (n: string) => { set.delete(n); } },
      setAttribute: (n: string) => { attrs.add(n); },
      removeAttribute: (n: string) => { attrs.delete(n); },
    } as unknown as HTMLElement;
    const canvas = { getBoundingClientRect: () => ({ left: 328, top: 40, width: 1112, height: 820 }) } as unknown as HTMLElement;
    pinBoard(app, canvas);
    expect(attrs.has(PIN_ATTR)).toBe(true);
    expect(Object.fromEntries(set)).toEqual({ "--board-l": "328px", "--board-t": "40px", "--board-w": "1112px", "--board-h": "820px" });
    unpinBoard(app);
    expect(attrs.has(PIN_ATTR)).toBe(false);
    expect(set.size).toBe(0);
    // A canvas with no box (not laid out) is not pinned at nothing.
    pinBoard(app, { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } as unknown as HTMLElement);
    expect(attrs.has(PIN_ATTR)).toBe(false);
    const pin = rule(workspace, '.app[data-view="workspace"][data-pin] .canvas-wrap');
    expect(decl(pin, "position")).toBe("fixed");
    for (const [prop, v] of [["left", "--board-l"], ["top", "--board-t"], ["width", "--board-w"], ["height", "--board-h"]]) {
      expect(decl(pin, prop)).toBe(`var(${v})`);
    }
    const stage = code("use-stage.ts");
    expect(stage).toContain('document.querySelector<HTMLElement>(".ws-cell")');
    expect(stage).toMatch(/const el = cellElement\(\);\s*if \(!el\) return;/);
  });

  it("pins the canvas before the view changes, and releases it as the view leaves", () => {
    const app = code("App.tsx");
    const switchView = app.slice(app.indexOf("const switchView = useCallback("), app.indexOf("const switchViewRef"));
    expect(switchView).toContain("runSwitch(how, () => {");
    expect(switchView.indexOf("pinBoard(")).toBeLessThan(switchView.indexOf("viewState.set(next)"));
    expect(switchView.indexOf("unpinBoard(")).toBeLessThan(switchView.indexOf("viewState.set(next)"));
    // A key is a key: the chord and the pane's ✕ read the last input.
    expect(app).toContain('switchViewRef.current(workspaceRef.current ? "board" : "workspace", "key")');
    expect(app).toContain('switchView("board", lastInputWasKey() ? "key" : "pointer")');
  });

  it("is laid out in the commit that draws it: the list and the pane open in layout effects", () => {
    expect(code("use-left-column.ts")).toMatch(/useLayoutEffect\(\(\) => \{\s*const was = wasRef\.current;/);
    expect(code("use-stage.ts")).toMatch(/const enteredRef = useRef\(false\);\s*useLayoutEffect\(\(\) => \{/);
  });

  it("stops every other transition across the switch, so the new view is drawn in its final state", () => {
    const body = rule(workspace, ":root[data-view-switch] .app :is(.left-column, .left-column > *, .detail, .stage-dock, .stage-in, .usage-panel, .sysdetail, .ts-stage .ts-card)");
    expect(decl(body, "transition")).toBe("none");
    expect(decl(body, "animation")).toBe("none");
  });
});

describe("✕ on a pane", () => {
  it("brings the empty pane in on Fast as a transition, at once by key", () => {
    expect(decl(rule(workspace, ".ts-stage[data-fill][data-empty] .ts-card"), "transition")).toBe("opacity var(--dur-fast) var(--ease)");
    expect(workspace).toMatch(/@starting-style \{\s*\.ts-stage\[data-fill\]\[data-empty\] \.ts-card \{ opacity: 0; \}/);
    expect(decl(rule(workspace, ':root[data-motion="instant"] .ts-stage[data-fill][data-empty] .ts-card'), "transition")).toBe("none");
  });

  it("lets the terminal host go out in 70, as it did", () => {
    expect(rule(terminal, ".ts-host")).toContain("opacity 70ms linear");
  });
});

describe("Zoom", () => {
  it("folds in 200 and unfolds on Move, both on the stage's curve, in one pane refit", () => {
    expect(tokens).toMatch(/--dur-stage-out:\s*200ms/);
    expect(tokens).toMatch(/--dur-move:\s*240ms/);
    const fold = workspace.indexOf('[data-zoom] :is(.left-column, .detail, .usage-panel, .sysdetail) {');
    const text = workspace.slice(fold);
    expect(text).toContain("transform var(--dur-stage-out) var(--ease-stage)");
    expect(text).toContain("transform var(--dur-move) var(--ease-stage)");
  });

  it("crossfades over 140 under reduced motion, with no travel", () => {
    expect(tokens).toMatch(/--dur-xfade:\s*140ms;/);
    const reduced = workspace.slice(workspace.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("transform: none;");
    expect(reduced).toContain("opacity var(--dur-xfade) var(--ease)");
  });

  it("is at once by key", () => {
    expect(workspace).toMatch(/:root\[data-motion="instant"\] \.app\[data-view="workspace"\]\[data-zoom\] :is\(\.left-column, \.detail, \.usage-panel, \.sysdetail\) \{ transition: none; \}/);
  });
});

describe("the stage's open", () => {
  it("starts on the press: no reveal timer, no wait for the pane", () => {
    const src = code("components/terminal/StageShell.tsx");
    expect(src).not.toContain("REVEAL_WAIT_MS");
    expect(src).not.toMatch(/setTimeout\([^)]*reveal/);
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(shell\.phase === "waiting"\) stage\.reveal\(\);/);
  });

  it("keeps the morph's numbers", () => {
    expect(FLIP_OPEN_MS).toBe(280);
    expect(FLIP_CLOSE_MS).toBe(200);
    expect(code("navigator-flip.ts")).toContain("export const WORDS_IN_FROM = 0.45;");
  });

  it("fades the terminal host in over 150 once its seed is parsed", () => {
    expect(rule(terminal, ".ts-host[data-shown]")).toContain("animation: ts-body-in 150ms var(--ease)");
  });

  it("makes the attaching card wait as a loader does: 150 before it shows, 300 at least, then out", () => {
    expect(LOADER_DELAY_MS).toBe(150);
    expect(LOADER_MIN_SHOWN_MS).toBe(300);
    expect(LOADER_EXIT_MS).toBe(150);
    const body = code("components/terminal/StageBody.tsx");
    expect(body).toContain("useWaitingLoader(attaching)");
    expect(body).toMatch(/wait\.draw \? <StateCard/);
    const card = rule(terminal, ".ts-card[data-timed]");
    expect(decl(card, "transition")).toBe("opacity var(--dur-fast) var(--ease)");
    expect(decl(rule(terminal, '.ts-card[data-timed="out"]'), "transition-duration")).toBe("var(--dur-exit)");
  });

  it("is a crossfade without travel under reduced motion, and no morph by key", () => {
    const src = code("components/terminal/StageShell.tsx");
    expect(src).toContain('tokenMs("--dur-xfade")');
    expect(src).toContain('document.documentElement.dataset.motion === "instant"');
    // Reduced: the navigator is faded, never folded, so no frame has neither.
    expect(src).toMatch(/nav && flow && !geo\.takeover && !reduced/);
    expect(src).toContain("navEl.style.opacity = String(f.stage)");
  });
});

describe("a close during the open", () => {
  it("turns around from the current frame: the close starts where the open stood", () => {
    // The inverse of the curve is the curve's inverse.
    for (const x of [0.05, 0.2, 0.5, 0.8, 0.95]) expect(easeOutInverse(easeOut(x))).toBeCloseTo(x, 4);
    expect(easeOutInverse(0)).toBe(0);
    expect(easeOutInverse(1)).toBe(1);
  });

  describe("on the clock", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
    afterEach(() => vi.useRealTimers());

    const tile = { id: "s1", board: { x: 40, y: 40, w: 200, h: 100 }, nav: { x: 400, y: 60, w: 160, h: 60 } };
    const plan = (direction: "open" | "close") => planFlip({
      board: new Map([[tile.id, tile.board]]), nav: new Map([[tile.id, tile.nav]]), direction, reduced: false,
    });

    it("draws, on its first frame, the frame the open drew last", async () => {
      const opening: FlipFrame[] = [];
      const open = runFlip(plan("open"), f => opening.push(f));
      vi.advanceTimersByTime(110);
      open.cancel();
      const last = opening.at(-1)!;
      expect(last.fold).toBeGreaterThan(0.2);
      expect(last.fold).toBeLessThan(0.95);
      const closing: FlipFrame[] = [];
      const close = runFlip(plan("close"), f => closing.push(f), undefined, easeOutInverse(1 - last.fold));
      expect(closing[0].fold, "no jump to the open stage").toBeCloseTo(last.fold, 3);
      vi.advanceTimersByTime(FLIP_CLOSE_MS);
      await expect(close.finished).resolves.toBe(true);
      expect(closing.at(-1)!.fold).toBe(0);
    });

    it("runs a tween from part of the way along, and still ends at 1", async () => {
      const raws: number[] = [];
      const run = runTween(200, raw => raws.push(raw), undefined, 0.5);
      expect(raws[0]).toBeCloseTo(0.5, 5);
      vi.advanceTimersByTime(120);
      await expect(run.finished).resolves.toBe(true);
      expect(raws.at(-1)).toBe(1);
      // Half of the 200 is left to run.
      expect(raws.length).toBeLessThan(10);
    });

    it("leaves a close from rest as it was", () => {
      const raws: number[] = [];
      runTween(200, raw => raws.push(raw));
      expect(raws[0]).toBe(0);
    });
  });

  it("has the header's ✕ answer from the first frame, except under the card a double click is aimed at", () => {
    expect(rule(shell, ".stage-dock[data-grace] .ts-head button:not([data-over-origin])")).toContain("pointer-events: auto");
  });

  it("has the flip fold take where to start", () => {
    expect(code("components/BoardNavigator.tsx")).toContain("}, undefined, opts.from);");
  });
});

describe("the divider's double click", () => {
  it("snaps back on Move and the stage's curve, only while data-snap is held", () => {
    expect(SNAP_MS).toBeGreaterThan(240);
    const body = rule(shell, ".app[data-snap] .stage-dock,\n.app[data-snap] .stage-in,\n.app[data-snap] .stage-nav");
    expect(decl(body, "transition")).toBe("width var(--dur-move) var(--ease-stage)");
    const reduced = shell.slice(shell.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("transition: none;");
  });

  it("is asked for by the double click alone: dragging is 1:1 and a key is at once", () => {
    const src = code("components/terminal/Divider.tsx");
    expect(src).toMatch(/if \(step === "reset"\) \{ p\.onReset\(\); return; \}/);
  });
});

describe("Usage and Machine, arriving and leaving", () => {
  it("come in from their edge: 12px in x on Move, the opacity over 180 after 40, on the stage's curve", () => {
    const both = rule(panels, ".usage-panel,\n.sysdetail");
    // The 180 is the one the left column's arriving panel uses, not a second literal.
    expect(decl(both, "transition")).toBe("transform var(--dur-move) var(--ease-stage), opacity var(--accounts-fade-in) var(--ease-stage) var(--delay-step)");
    expect(panels).not.toMatch(/--panel-(x?fade)/);
    expect(panels).toMatch(/@starting-style \{\s*\.usage-panel,\s*\.sysdetail \{ opacity: 0; transform: translateX\(12px\); \}/);
  });

  it("leave on opacity alone, on Fast, and a reopen turns around (transitions, not keyframes)", () => {
    const out = rule(panels, ".sysdetail.leaving,\n.usage-panel.leaving");
    expect(decl(out, "transition")).toBe("opacity var(--dur-fast) var(--ease-stage)");
    expect(decl(out, "opacity")).toBe("0");
    expect(panels).not.toContain("@keyframes rail-in");
    expect(panels).not.toContain("@keyframes rail-out");
    expect(strip(read("styles/usage-panel.css"))).not.toMatch(/animation:\s*rail-/);
    expect(strip(read("styles/canvas-motion.css"))).not.toMatch(/\.usage-panel/);
  });

  it("are at once by a key, and a crossfade over the one reduced token without travel under reduced motion", () => {
    expect(panels).toContain(':root[data-motion="instant"] :is(.usage-panel, .sysdetail) { transition: none; }');
    const reduced = panels.slice(panels.indexOf("@media (prefers-reduced-motion: reduce) {\n  .usage-panel,"));
    expect(reduced).toContain("transition: opacity var(--dur-xfade) var(--ease);");
    expect(reduced).toMatch(/@starting-style \{\s*\.usage-panel,\s*\.sysdetail \{ transform: none; \}/);
  });

  it("hold a height for the readings to arrive (the behaviour is run in panel-height.test.ts)", () => {
    expect(HEIGHT_HOLD_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("where Usage and Machine sit in Workspace", () => {
  it("start below the strip rows and the pane's header, so no pane button or Inspector head is under them", () => {
    expect(workspace).toContain("--ws-head: calc(var(--topbar-h) + var(--rating-h, 0px) + var(--pane-head-h));");
    const base = rule(workspace, '.app[data-view="workspace"] :is(.usage-panel, .sysdetail):not([data-place])');
    expect(decl(base, "top")).toBe("calc(var(--ws-head) + 8px)");
    expect(decl(base, "max-height")).toBe("calc(100vh - var(--ws-head) - 16px - var(--status-room, 0px))");
  });

  it("are the Inspector's column from 1320 only while it exists: under its head, above the status bar, right edge at the window", () => {
    const wide = workspace.slice(workspace.indexOf("@media (min-width: 1320px)"));
    const body = rule(wide, '.app[data-view="workspace"]:has(.detail) :is(.usage-panel, .sysdetail):not([data-place])');
    expect(decl(body, "top")).toBe("var(--ws-head)");
    expect(decl(body, "right")).toBe("0");
    expect(decl(body, "max-height")).toBe("var(--ws-col-h)");
    expect(workspace).toContain("--ws-col-h: calc(100vh - var(--ws-head) - var(--status-room, 0px));");
    // The column rule never reaches a folded Inspector: no .detail, no column.
    expect(wide).not.toMatch(/\.app\[data-view=\"workspace\"\] :is\(\.usage-panel/);
  });

  it("share the column when both are open: Usage above, Machine below, half each", () => {
    const wide = workspace.slice(workspace.indexOf("@media (min-width: 1320px)"));
    const machine = rule(wide, '.app[data-view="workspace"]:has(.detail) .sysdetail.shifted:not([data-place])');
    expect(decl(machine, "top")).toBe("calc(var(--ws-head) + var(--ws-col-h) / 2)");
    expect(decl(machine, "max-height")).toBe("calc(var(--ws-col-h) / 2)");
    const usage = rule(wide, '.app[data-view="workspace"]:has(.detail):has(.sysdetail.shifted:not(.leaving):not([data-place])) .usage-panel:not([data-place])');
    expect(decl(usage, "max-height")).toBe("calc(var(--ws-col-h) / 2 - 8px)");
  });

  it("keep a place the reader gave them, and fold with Zoom", () => {
    expect(workspace).not.toMatch(/\[data-place\]\) \{[^}]*!important/);
    expect(workspace).toContain('[data-zoom="fold"] :is(.detail, .usage-panel, .sysdetail) { transform: translateX(100%); opacity: 0; visibility: hidden; }');
    // Zoom's overlays start below the strip row too.
    expect(rule(workspace, '.app[data-view="workspace"][data-zoom] .detail')).toContain("top: calc(var(--topbar-h) + var(--rating-h, 0px))");
  });
});

describe("the switch's mark has one owner", () => {
  /** A page whose view transition is run by the test: the callback waits for `run()`, `finished` for `end()`. */
  function deferred() {
    const attrs = new Set<string>();
    const transitions: { run: () => void; end: () => void }[] = [];
    const doc = {
      hidden: false,
      documentElement: { setAttribute: (n: string) => { attrs.add(n); }, removeAttribute: (n: string) => { attrs.delete(n); } },
      startViewTransition(cb: () => void) {
        let end = () => {};
        const finished = new Promise<void>(r => { end = r; });
        transitions.push({ run: cb, end });
        return { finished };
      },
    } as unknown as Document;
    return { doc, attrs, transitions };
  }

  it("runs the update inside the transition, after the old picture is kept, not before", () => {
    const { doc, transitions } = deferred();
    const log: string[] = [];
    runSwitch("pointer", () => log.push("update"), doc);
    expect(log, "nothing is updated until the browser has the old picture").toEqual([]);
    transitions[0].run();
    expect(log).toEqual(["update"]);
  });

  it("lets a newer switch keep the mark when an older transition ends (the browser skips it)", async () => {
    const { doc, attrs, transitions } = deferred();
    runSwitch("pointer", () => {}, doc);
    runSwitch("pointer", () => {}, doc);
    transitions[0].end();
    await Promise.resolve();
    await Promise.resolve();
    expect(attrs.has(SWITCH_ATTR), "the older one's end must not clear the newer one's mark").toBe(true);
    transitions[1].end();
    await Promise.resolve();
    await Promise.resolve();
    expect(attrs.has(SWITCH_ATTR)).toBe(false);
  });

  it("clears a key switch's mark after its beat, and a newer switch cancels that beat", () => {
    vi.useFakeTimers();
    try {
      const { doc, attrs } = deferred();
      runSwitch("key", () => {}, doc);
      expect(attrs.has(SWITCH_ATTR)).toBe(true);
      vi.advanceTimersByTime(59);
      expect(attrs.has(SWITCH_ATTR)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(attrs.has(SWITCH_ATTR)).toBe(false);
      // A pointer switch within the beat of a key one: the old timer is gone.
      runSwitch("key", () => {}, doc);
      vi.advanceTimersByTime(30);
      runSwitch("pointer", () => {}, doc);
      vi.advanceTimersByTime(100);
      expect(attrs.has(SWITCH_ATTR), "the pointer switch's mark outlives the old timer").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not clicked through during the crossfade, and the empty pane does not fade inside it", () => {
    expect(workspace).toContain(":root[data-view-switch]::view-transition { pointer-events: none; }");
    expect(workspace).toMatch(/:root\[data-view-switch\] \.app :is\([^)]*\.ts-stage \.ts-card\)/);
    expect(decl(rule(terminal, ".ts-card[data-timed]"), "pointer-events")).toBe("none");
  });
});

