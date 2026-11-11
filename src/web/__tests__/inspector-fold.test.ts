// Usage and This machine while the Inspector is open on the Board (owner,
// 2026-11-11 critique): every open panel folds to its header line, the two
// stack in the home slots beside the Inspector, a press on a folded header
// opens that panel again, and closing the Inspector gives every panel back as
// it was. The fold is never stored; Workspace's column and a phone's sheets
// are left alone. The rule is a pure function and run as a table; the hook,
// the panel's place and the folded header run under fake-react; the fit, the
// minimap and App's wiring are read where they live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

const { all, mount, one, textOf } = await import("./fake-react");
const { NO_FOLDS, nextFolds, useInspectorFold, withInspectorFold } = await import("../inspector-fold");
const { PLACE_KEYS, fitMinimap, usePanelPlace } = await import("../panel-place");
const { default: PanelFoldHead, quotaFoldLine } = await import("../components/PanelFoldHead");
const { t } = await import("../i18n");
type PanelDock = import("../side-column").PanelDock;
type Folds = import("../inspector-fold").Folds;

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let store: Map<string, string>;
let phone = false;
beforeEach(() => {
  store = new Map();
  phone = false;
  const g = globalThis as Record<string, unknown>;
  g.window = {
    innerWidth: 1280, innerHeight: 800,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    dispatchEvent() { return true; },
    addEventListener() {},
    removeEventListener() {},
  };
  g.document = { querySelector: () => null, querySelectorAll: () => [] };
  g.requestAnimationFrame = () => 0;
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.requestAnimationFrame;
});

const both: Folds = { usage: true, machine: true };
const usageOnly: Folds = { usage: true, machine: false };

describe("the rule", () => {
  it("folds every open panel when the Inspector opens, and only those", () => {
    expect(nextFolds(NO_FOLDS, { on: true, wasOn: false, open: both, wasOpen: both })).toEqual(both);
    expect(nextFolds(NO_FOLDS, { on: true, wasOn: false, open: usageOnly, wasOpen: usageOnly })).toEqual(usageOnly);
  });

  it("gives every panel back when the Inspector closes", () => {
    expect(nextFolds(both, { on: false, wasOn: true, open: both, wasOpen: both })).toEqual(NO_FOLDS);
  });

  it("opens a panel unfolded when its door opens it while the Inspector is open", () => {
    const folds = nextFolds(usageOnly, { on: true, wasOn: true, open: both, wasOpen: usageOnly });
    expect(folds, "the machine panel just opened; Usage stays folded").toEqual(usageOnly);
  });

  it("keeps a closing panel folded for its exit, and unfolds it when it opens again", () => {
    const closing = nextFolds(both, { on: true, wasOn: true, open: usageOnly, wasOpen: both });
    expect(closing).toEqual(both);
    expect(nextFolds(closing, { on: true, wasOn: true, open: both, wasOpen: usageOnly })).toEqual(usageOnly);
  });
});

describe("the hook", () => {
  function Harness(p: { on: boolean; open: Folds }) {
    return useInspectorFold(p.on, p.open);
  }
  type Out = ReturnType<typeof useInspectorFold>;

  it("folds when the Inspector opens and restores when it closes; closed panels stay closed", () => {
    const view = mount(Harness, { on: false, open: usageOnly });
    const out = () => view.tree as Out;
    expect(out().folds).toEqual(NO_FOLDS);
    view.rerender({ on: true, open: usageOnly });
    expect(out().folds, "Usage was open: folded; This machine was closed: nothing").toEqual(usageOnly);
    view.rerender({ on: false, open: usageOnly });
    expect(out().folds, "Usage open again, as it was").toEqual(NO_FOLDS);
  });

  it("opens a folded panel from its header, until the Inspector closes", () => {
    const view = mount(Harness, { on: false, open: both });
    const out = () => view.tree as Out;
    view.rerender({ on: true, open: both });
    expect(out().folds).toEqual(both);
    out().unfold("machine");
    expect(out().folds).toEqual(usageOnly);
    view.rerender({ on: true, open: both });
    expect(out().folds, "a re-render does not fold it again").toEqual(usageOnly);
  });

  it("is never stored", () => {
    const view = mount(Harness, { on: false, open: both });
    view.rerender({ on: true, open: both });
    expect(store.size).toBe(0);
  });
});

describe("the dock a panel is told", () => {
  const dock = (mode: PanelDock["mode"], folded = false): PanelDock => ({
    mode, folded, fold() {}, unfold() {}, popOut() {}, dock() {},
  });

  it("carries the fold on the Board, with the press that opens it", () => {
    const opened: string[] = [];
    const told = withInspectorFold(dock("board"), true, () => opened.push("usage"));
    expect(told.folded).toBe(true);
    told.unfold();
    expect(opened).toEqual(["usage"]);
    expect(withInspectorFold(dock("board"), false, () => {}).folded).toBe(false);
  });

  it("leaves Workspace's column and its popped-out parts as they are", () => {
    for (const mode of ["docked", "float"] as const) {
      const own = dock(mode);
      expect(withInspectorFold(own, true, () => {})).toBe(own);
    }
  });
});

describe("the panel's place while folded", () => {
  function Place(p: { dock?: PanelDock }) {
    return usePanelPlace(PLACE_KEYS.usage, p.dock);
  }
  type Out = ReturnType<typeof usePanelPlace>;
  const board = (folded: boolean): PanelDock => ({ mode: "board", folded, fold() {}, unfold() {}, popOut() {}, dock() {} });
  const placed = JSON.stringify({ edge: "left", x: 200, y: 300 });

  it("is its header in the column: no place, no grip, the fold marked; the place is kept", () => {
    store.set(PLACE_KEYS.usage, placed);
    const open = mount(Place, { dock: board(false) }).tree as Out;
    expect(open.panel["data-place"]).toBe("left");
    expect(open.grip).toHaveProperty("data-grip");
    const folded = mount(Place, { dock: board(true) }).tree as Out;
    expect(folded.tucked).toBe(true);
    expect(folded.panel["data-fold"]).toBe("inspector");
    expect(folded.panel["data-place"]).toBeUndefined();
    expect(folded.grip).toEqual({});
    expect(store.get(PLACE_KEYS.usage), "the place waits for it to open").toBe(placed);
  });

  it("opens where it was put", () => {
    store.set(PLACE_KEYS.usage, placed);
    const view = mount(Place, { dock: board(true) });
    view.rerender({ dock: board(false) });
    expect((view.tree as Out).panel["data-place"]).toBe("left");
    expect((view.tree as Out).panel["data-fold"]).toBeUndefined();
  });

  it("leaves a phone's sheet alone", () => {
    phone = true;
    const out = mount(Place, { dock: board(true) }).tree as Out;
    expect(out.tucked).toBe(false);
    expect(out.panel["data-fold"]).toBeUndefined();
  });

  it("leaves Workspace's own fold as it was", () => {
    const docked: PanelDock = { ...board(true), mode: "docked" };
    const out = mount(Place, { dock: docked }).tree as Out;
    expect(out.tucked).toBe(false);
    expect(out.panel["data-fold"]).toBe("");
  });
});

describe("the folded header", () => {
  it("is one button with aria-expanded, the title, the line and a chevron, that opens the panel", () => {
    let opened = 0;
    const view = mount(PanelFoldHead, { title: "Usage", summary: "5h 14% · 7d 40%", onOpen: () => { opened++; } });
    const buttons = all(view.tree, el => el.type === "button");
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button.props["aria-expanded"]).toBe(false);
    expect(textOf(button)).toBe("Usage5h 14% · 7d 40%");
    expect(one(button, el => el.props.className === "side-sum")).not.toBeNull();
    // The button goes with the fold, so the keys go on to the open panel's close.
    let focused = "";
    const frames: (() => void)[] = [];
    (globalThis as Record<string, unknown>).requestAnimationFrame = (f: () => void) => { frames.push(f); return 1; };
    const panel = { querySelector: (sel: string) => ({ focus: () => { focused = sel; } }) };
    (button.props.onClick as (e: unknown) => void)({ currentTarget: { closest: (sel: string) => (sel === "aside" ? panel : null) } });
    expect(opened).toBe(1);
    for (const f of frames) f();
    expect(focused).toBe(".up-close, .sd-close");
  });

  it("names the machine panel's landmark by its title alone", () => {
    const view = mount(PanelFoldHead, { title: "This machine", titleId: "sd-title", headingClass: "sd-title", summary: "CPU 14% · 13.9 GB", onOpen: () => {} });
    const title = one(view.tree, el => el.props.id === "sd-title");
    expect(textOf(title)).toBe("This machine");
    expect((view.tree as { type: string; props: { className: string } }).type).toBe("h2");
  });

  it("says Usage's quota as the bars print it, or nothing without a 5-hour reading", () => {
    expect(quotaFoldLine({ ok: true, session5hPct: 14.4, week7dPct: 40 }, t)).toBe("5h 14% · 7d 40%");
    expect(quotaFoldLine({ ok: true, session5hPct: 0.2, week7dPct: null }, t)).toBe("5h < 1%");
    expect(quotaFoldLine({ ok: false }, t)).toBeNull();
    expect(quotaFoldLine(null, t)).toBeNull();
  });

  it("is drawn by both panels on the Board, the spend line where there is no quota", () => {
    const usage = code("components/UsagePanel.tsx");
    expect(usage).toMatch(/\{place\.tucked && dock \? \(\s*<PanelFoldHead title=\{t\("usage\.title"\)\} summary=\{quotaFoldLine\(quota, t\) \?\? spendLine\} onOpen=\{dock\.unfold\} \/>/);
    const machine = code("components/MachinePanel.tsx");
    expect(machine).toMatch(/\{place\.tucked && dock \? \(\s*<div className="sd-head">\s*<PanelFoldHead title=\{t\("insights\.machine\.title"\)\} titleId="sd-title" headingClass="sd-title" summary=\{summary\} onOpen=\{dock\.unfold\} \/>/);
  });
});

describe("the fit and the minimap", () => {
  it("fits and zooms in the board the open panels leave: a folded one is not counted", () => {
    const frame = code("use-layout-frame.ts");
    expect(frame).toContain(`const open = ':not(.leaving):not([data-fold="inspector"])';`);
    expect(frame).toContain("document.querySelectorAll(`.sysdetail${open}, .usage-panel${open}`)");
    expect(frame).toMatch(/\}, \[machinePhase, usagePhase, usagePanelOpen, detailShown, canvasSize\.w, folds\.usage, folds\.machine\]\);/);
    expect(code("App.tsx")).toContain("useLayoutFrame({ canvasRef, canvasSize, machinePhase, usagePhase, usagePanelOpen, detailShown, folds: inspectorFold.folds })");
  });

  function minimap(panels: { left: number; bottom: number; fold?: string }[]) {
    const style = new Map<string, string>();
    const map = { offsetWidth: 142, getBoundingClientRect: () => ({ top: 660 }) };
    const canvas = {
      style: { setProperty: (k: string, v: string) => { style.set(k, v); } },
      setAttribute() {}, removeAttribute() {},
      getBoundingClientRect: () => ({ left: 40, right: 880 }),
      querySelector: () => map,
    };
    (globalThis as Record<string, unknown>).document = {
      querySelector: (sel: string) => (sel === ".canvas-wrap" ? canvas : null),
      querySelectorAll: () => panels.map(p => ({
        offsetLeft: p.left, offsetWidth: 320, offsetParent: null,
        getAttribute: (n: string) => (n === "data-fold" ? p.fold ?? null : null),
        getBoundingClientRect: () => ({ bottom: p.bottom }),
      })),
    };
    fitMinimap();
    return style.get("--minimap-in");
  }

  it("keeps the minimap in its corner beside the folded headers at the top", () => {
    expect(minimap([{ left: 552, bottom: 88, fold: "inspector" }, { left: 552, bottom: 134, fold: "inspector" }])).toBe("0px");
  });

  it("steps it past an open panel, and past a folded header that reaches down to it", () => {
    expect(minimap([{ left: 552, bottom: 700 }])).toBe("328px");
    expect(minimap([{ left: 552, bottom: 655, fold: "inspector" }])).toBe("328px");
  });
});

describe("App's wiring and the sheet", () => {
  const app = code("App.tsx");

  it("folds while the Inspector shows on a desktop, and stacks the slots on the Board alone", () => {
    expect(app).toContain("const inspectorFold = useInspectorFold(!phone && detailShown, { usage: usagePanelOpen, machine: machinePanelOpen });");
    expect(app).toContain("const foldStack = !phone && !inWorkspace && detailShown;");
    expect(app).toContain('data-fold-stack={foldStack ? "" : undefined}');
    expect(app).toMatch(/usage: withInspectorFold\(side\.dock\.usage, inspectorFold\.folds\.usage, \(\) => inspectorFold\.unfold\("usage"\)\)/);
    expect(app).toMatch(/machine: withInspectorFold\(side\.dock\.machine, inspectorFold\.folds\.machine, \(\) => inspectorFold\.unfold\("machine"\)\)/);
  });

  it("draws the column and the folded header for the Board alone, not for Workspace or a phone", () => {
    const sheet = read("styles/panel-place.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const board = ".ws-side { display: contents; }";
    const block = sheet.slice(sheet.indexOf(board) + board.length);
    const selectors = [...block.matchAll(/([^{}]+)\{/g)].map(m => m[1]!.trim()).filter(s => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(5);
    for (const sel of selectors) expect(sel, sel).toMatch(/\[data-fold-stack\]|\[data-fold="inspector"\]|^\.fold-head/);
    expect(sheet).toMatch(/\.app\[data-fold-stack\] \.ws-side \{[^}]*gap: 8px;/);
    expect(sheet).toMatch(/\.app \[data-fold="inspector"\] > :is\(\.up-body, \.sd-body\) \{ display: none; \}/);
    // The fit's stack is the column's flex while it is up.
    expect(code("panel-place.ts")).toContain("if (document.querySelector(STACK_ON)) return;");
  });

  it("has its two lines in all ten languages, with English's placeholders", () => {
    const LANGS = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
    const holes = (text: string, k: string) => {
      const m = new RegExp(`"shell\\.side\\.${k}": "([^"]*)"`).exec(text);
      expect(m, k).not.toBeNull();
      return [...m![1]!.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
    };
    const en = read("i18n/areas/shell/en.ts");
    for (const lang of LANGS) {
      const text = read(`i18n/areas/shell/${lang}.ts`);
      for (const k of ["quotaSum", "quota5h"]) expect(holes(text, k), `${lang} ${k}`).toEqual(holes(en, k));
    }
  });
});
